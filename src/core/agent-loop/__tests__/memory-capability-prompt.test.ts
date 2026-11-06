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
  const tail = options.systemPrompt!.split('## 本次模型请求环境\n')[1]
  return JSON.parse(tail.slice(tail.indexOf('\n') + 1).split('\n\n')[0])
}

function expectSinglePolicy(options: LLMAdapterOptions) {
  expect(options.systemPrompt!.split('## 本次模型请求环境')).toHaveLength(2)
  expect(options.systemPrompt!.split('### 当前记忆能力（内部执行状态）')).toHaveLength(2)
  expect(options.systemPrompt).toContain('Caller instructions.')
  expect(options.systemPrompt).toContain('这段仅用于约束执行和判断能力，不是必答章节')
  expect(options.systemPrompt).toContain('除非用户询问记忆或当前任务确实依赖记忆范围，不主动说明这些设置')
  expect(options.systemPrompt).toContain('聊天历史与长期记忆独立；记忆开关不删除聊天历史')
  expect(options.systemPrompt).toContain('没有成功写入回执，不声称已经记住')
}

function expectUserCommunication(options: LLMAdapterOptions) {
  const prompt = options.systemPrompt!
  expect(prompt.split('### 面向用户的表达')).toHaveLength(2)
  expect(prompt).toContain('直接对用户说话，用日常语言说明能帮他完成什么、结果是什么')
  expect(prompt).toContain('已有信息足够时直接回答')
  expect(prompt).toContain('不要为了介绍自己而扫描目录、读取项目规则、启动计划或调用工具')
  expect(prompt).toContain('3–5 个简短的日常任务示例，按真实可用能力表述')
  expect(prompt).toContain('只有用户问到、当前操作确实受阻、涉及必要授权，或影响用户选择与结果可信度时')
  expect(prompt).toContain('才简短说明相关限制和可行下一步')
  expect(prompt).toContain('真实失败和本次未完成的必要检查仍须如实说明')
  expect(prompt).toContain('普通介绍不附记忆开关、工作区权限、验收纪律或外部软件限制清单')
  expect(prompt).toContain('以下规则只在相关执行任务中适用，不是每次回复都要输出的章节')
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
    expect(request.systemPrompt).toContain('全局记忆未启用，不得声称能跨会话记住偏好或决策')
    expect(request.tools?.map(tool => tool.name)).toEqual(['read_file', 'remember', 'recall', 'search_history'])
  })

  it.each(['general', 'code'] as const)('%s tells the model that registered remember does not enable cross-session memory', async profile => {
    const f = fixture(profile)
    await f.run()
    expect(f.requests).toHaveLength(1)
    const request = f.requests[0]
    expect(request.tools?.map(tool => tool.name)).toContain('remember')
    expect(snapshot(request)).toMatchObject({ profile, permissions: { memoryScopes: ['session'] } })
    expect(request.systemPrompt).toContain('仅在当前会话内保存和参考记忆')
    expect(request.systemPrompt).toContain('全局记忆未启用，不得声称能跨会话记住偏好或决策')
    expect(request.systemPrompt).toContain('不把已注册的记忆工具等同于全局记忆已开启')
    expect(request.systemPrompt).not.toContain('本次仅启用全局记忆')
    expect(request.systemPrompt).not.toContain('本次会话记忆与全局记忆均已启用')
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
      '本次仅启用会话记忆',
      '本次会话记忆与全局记忆均已启用',
      '本次仅启用全局记忆',
      '本次长期记忆未启用',
    ]
    f.requests.forEach((request, index) => {
      expectSinglePolicy(request)
      expect(request.systemPrompt).toContain(statements[index])
      statements.filter((_, other) => other !== index).forEach(statement => {
        expect(request.systemPrompt).not.toContain(statement)
      })
      expect(snapshot(request).registryVersion).toBe(snapshot(f.requests[0]).registryVersion)
      expect(request.tools?.map(tool => tool.name)).toContain('remember')
    })
    expect(f.requests[1].systemPrompt).toContain('新增记忆默认只写入当前会话，不自动提升为跨会话记忆')
    expect(f.requests[2].systemPrompt).toContain('新增记忆写入全局；会话记忆未启用')
    expect(f.requests[3].systemPrompt).toContain('不得声称会保存、自动记住或跨会话记住偏好或决策')
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
    expect(f.requests[0].systemPrompt).toContain('本次会话记忆与全局记忆均已启用')
    expect(f.ctx.tools.list().map(tool => tool.name)).toContain('remember')
    expect(f.ctx.memoryScopes).toEqual(['session', 'global'])
    const finalization = f.requests[1]
    expect(finalization.requestStage).toBe('finalization')
    expect(finalization.tools).toEqual([])
    expect(snapshot(finalization)).toMatchObject({ toolCount: 0, permissions: { memoryScopes: [] } })
    expect(finalization.systemPrompt).toContain('本次长期记忆未启用')
    expect(finalization.systemPrompt).not.toContain('本次会话记忆与全局记忆均已启用')
    expectUserCommunication(finalization)
    expectSinglePolicy(finalization)
  })
})
