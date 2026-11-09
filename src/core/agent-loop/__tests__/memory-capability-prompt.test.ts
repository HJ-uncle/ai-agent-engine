// Covers communication and memory instructions delivered through real ReAct
// requests. A fake adapter cannot establish generated response quality.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext, Message } from '../../agent-context/types.js'
import type { LLMAdapter, LLMAdapterOptions } from '../../llm-adapter/types.js'
import { workspaceManager } from '../../../workspace/index.js'
import { ReActStrategy, type ReActOptions } from '../react.js'

vi.mock('../../../storage/todo/index.js', () => ({ TodoStore: class { async list() { return [] } } }))

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

function fixture(profile: AgentContext['toolProfile'], toolRounds = 0) {
  vi.stubEnv('ENABLE_LONG_TERM_MEMORY', 'true')
  vi.spyOn(workspaceManager, 'getPaths').mockReturnValue(['/memory-prompt-project'])
  const history: Message[] = []
  const requests: LLMAdapterOptions[] = []
  const definitions = ['read_file', 'remember', 'recall', 'search_history'].map(name => ({
    name, description: `Full ${name} tool schema`, parameters: { type: 'object', properties: {} },
  }))
  const ctx = {
    tenantId: 'memory-prompt', sessionId: 'memory-prompt-session',
    rootRunId: 'memory-prompt-run', turnId: 'memory-prompt-turn', toolProfile: profile,
    workspaceDir: '/memory-prompt-project', memoryScopes: ['session'],
    // Resolved server scopes must override a stale compatibility selector.
    memoryScope: 'global',
    history: {
      append: vi.fn(async (message: Message) => { history.push(message); return message.id ?? 'saved' }),
      getHistory: vi.fn(async () => [...history]), getRawTokenCount: vi.fn(async () => 0),
    },
    tools: {
      list: () => definitions, has: (name: string) => definitions.some(tool => tool.name === name),
      executionMode: () => 'serial', execute: vi.fn(async () => ({ success: true, output: 'Read complete.' })),
    },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as AgentContext
  const llm: LLMAdapter = {
    model: 'test', provider: 'test', complete: vi.fn(), countTokens: () => 0,
    stream: vi.fn(async function* (_messages, options) {
      if (!options) throw new Error('ReAct did not provide request options')
      requests.push(options)
      if (requests.length <= toolRounds) {
        yield { done: true, toolCalls: [{ index: 0, id: `read-${requests.length}`, name: 'read_file', args: '{}' }] }
      } else yield { done: true, content: 'Done.' }
    }),
  }
  const run = async (options: ReActOptions = {}, input = 'Explain the available memory capabilities.') => {
    for await (const _frame of new ReActStrategy(llm, {
      maxIterations: toolRounds + 2, systemPrompt: 'Caller instructions.', ...options,
    }).run(input, ctx)) { /* capture real model request assembly */ }
  }
  return { ctx, requests, run }
}

function snapshot(options: LLMAdapterOptions) {
  const tail = options.requestContext!.split('## 本次模型请求环境\n')[1]
  return JSON.parse(tail.split('\n\n')[0])
}

function expectSinglePolicy(options: LLMAdapterOptions) {
  expect(options.requestContext!.split('## 本次模型请求环境')).toHaveLength(2)
  expect(options.requestContext!.split('### 当前记忆能力（内部执行状态）')).toHaveLength(2)
  expect(options.systemPrompt).toContain('Caller instructions.')
  expect(options.systemPrompt).toContain('Internal capability guidance only')
  expect(options.systemPrompt).toContain('mention it only when asked or task-relevant')
  expect(options.systemPrompt).toContain('Chat history is independent and not deleted by memory switches')
  expect(options.systemPrompt).toContain('Never claim a memory was saved without a successful write receipt')
}

function expectUserCommunication(options: LLMAdapterOptions) {
  const prompt = options.systemPrompt!
  expect(prompt.split('## Execution')).toHaveLength(2)
  expect(prompt).toContain('Speak plainly, conclusion first, with detail appropriate to the question')
  expect(prompt).toContain('ordinary chat, capability introductions, or explanations supported by supplied material, answer directly')
  expect(prompt).toContain('no directory/rule scans, plans or tools')
  expect(prompt).toContain('Describe capabilities briefly or with 3–5 everyday examples')
  expect(prompt).toContain('only when asked, blocked, authorization is necessary, or choices/reliability depend on them')
  expect(prompt).toContain('Mention relevant limits and next steps')
  expect(prompt).toContain('Report actual failures and required unchecked work')
  expect(prompt).toContain('Do not volunteer memory, permission, verification or external-software caveats')
  expect(prompt).toContain('For execution tasks:')
  expect(prompt).not.toContain('- 先读适用且未提供的 AGENTS.md / AE.md')
  expect(prompt).not.toContain('- 交付真实文件、用法、已做验证和未验证项')
}

describe('memory capabilities at the shared ReAct request boundary', () => {
  it.each(['general', 'code'] as const)('%s delivers everyday capability-introduction instructions together with the internal memory guard', async profile => {
    const f = fixture(profile)
    await f.run({}, '你可以帮我做什么？')
    expect(f.requests).toHaveLength(1)
    const request = f.requests[0]
    expect(snapshot(request)).toMatchObject({ profile, permissions: { memoryScopes: ['session'] } })
    expectUserCommunication(request)
    expectSinglePolicy(request)
    expect(request.requestContext).toContain('global memory is off. Never claim cross-session preferences/decisions will be remembered')
    expect(request.tools?.map(tool => tool.name)).toEqual(['read_file', 'remember', 'recall', 'search_history'])
  })

  it.each(['general', 'code'] as const)('%s tells the model that registered remember does not enable cross-session memory', async profile => {
    const f = fixture(profile)
    await f.run()
    expect(f.requests).toHaveLength(1)
    const request = f.requests[0]
    expect(request.tools?.map(tool => tool.name)).toContain('remember')
    expect(snapshot(request)).toMatchObject({ profile, permissions: { memoryScopes: ['session'] } })
    expect(request.requestContext).toContain('save/recall within this session')
    expect(request.requestContext).toContain('global memory is off. Never claim cross-session preferences/decisions will be remembered')
    expect(request.systemPrompt).toContain('Registered memory tools do not enable global memory')
    expect(request.requestContext).not.toContain('Only global memory enabled')
    expect(request.requestContext).not.toContain('Session and global memory enabled')
    expectSinglePolicy(request)
    expect(f.ctx.tools.execute).not.toHaveBeenCalled()
  })

  it('refreshes resolved scopes across runs in the same session without retaining the previous capability statement', async () => {
    const f = fixture('general')
    const resolvedScopes: NonNullable<AgentContext['memoryScopes']>[] = [['session'], ['global', 'session'], ['global'], []]
    // The HTTP boundary resolves a fresh policy for each new or resumed run.
    // ReAct intentionally takes a context snapshot when a run begins.
    for (const scopes of resolvedScopes) {
      f.ctx.memoryScopes = scopes
      await f.run()
    }
    expect(f.requests).toHaveLength(4)
    expect(f.ctx.tools.execute).not.toHaveBeenCalled()
    expect(f.requests.map(request => snapshot(request).permissions.memoryScopes))
      .toEqual([['session'], ['session', 'global'], ['global'], []])
    const statements = [
      'Only session memory enabled',
      'Session and global memory enabled',
      'Only global memory enabled',
      'Long-term memory is off',
    ]
    f.requests.forEach((request, index) => {
      expectSinglePolicy(request)
      expect(request.requestContext).toContain(statements[index])
      statements.filter((_, other) => other !== index).forEach(statement => {
        expect(request.requestContext).not.toContain(statement)
      })
      expect(snapshot(request).registryVersion).toBe(snapshot(f.requests[0]).registryVersion)
      expect(request.tools?.map(tool => tool.name)).toContain('remember')
    })
    expect(f.requests[1].requestContext).toContain('new memories default to session only, never auto-promote globally')
    expect(f.requests[2].requestContext).toContain('new writes use global memory; session memory is off')
    expect(f.requests[3].requestContext).toContain('Do not claim to save, automatically remember, or remember preferences/decisions across sessions')
  })

  it('honors server-disabled memory in the finalization request even when resolved scopes and the registry still contain memory', async () => {
    const f = fixture('code', 1)
    f.ctx.memoryScopes = ['session', 'global']
    f.ctx.tools.execute = vi.fn(async () => {
      vi.stubEnv('ENABLE_LONG_TERM_MEMORY', 'false')
      return { success: true, output: 'Read complete.' }
    })
    await f.run({ maxIterations: 2, finalizeOnLimit: true })
    expect(f.requests).toHaveLength(2)
    expect(f.requests[0].requestContext).toContain('Session and global memory enabled')
    expect(f.ctx.tools.list().map(tool => tool.name)).toContain('remember')
    expect(f.ctx.memoryScopes).toEqual(['session', 'global'])
    const finalization = f.requests[1]
    expect(finalization.requestStage).toBe('finalization')
    expect(finalization.tools).toEqual([])
    expect(snapshot(finalization)).toMatchObject({ toolCount: 0, permissions: { memoryScopes: [] } })
    expect(finalization.requestContext).toContain('Long-term memory is off')
    expect(finalization.requestContext).not.toContain('Session and global memory enabled')
    expectUserCommunication(finalization)
    expectSinglePolicy(finalization)
  })
})
