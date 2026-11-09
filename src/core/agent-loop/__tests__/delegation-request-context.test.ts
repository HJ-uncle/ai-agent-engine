import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext, Message } from '../../agent-context/types.js'
import type { LLMAdapter, LLMAdapterOptions } from '../../llm-adapter/types.js'
import { buildDelegationRequestContext } from '../../execution-protocol.js'
import { workspaceManager } from '../../../workspace/index.js'
import { ReActStrategy, type ReActOptions } from '../react.js'

vi.mock('../../codegraph-prompt.js', () => ({ prepareCodegraphRequestContext: vi.fn(async () => '') }))
vi.mock('../../../storage/todo/index.js', () => ({ TodoStore: class { async list() { return [] } } }))

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks() })

const header = '## 本轮协作决策'

function fixture(offeredNames: string[], catalogueNames = offeredNames) {
  const history: Message[] = []
  const requestHistories: Message[][] = []
  const requests: LLMAdapterOptions[] = []
  vi.spyOn(workspaceManager, 'getPaths').mockReturnValue(['/fixture-project'])
  const catalogue = [...new Set(['load_tools', 'read_file', ...catalogueNames])].map(name => ({
    name, description: `Fixture ${name}`, parameters: { type: 'object', properties: {} },
  }))
  const loaded = new Set(['load_tools', 'read_file', ...offeredNames])
  const tools = {
    list: () => catalogue,
    listForRequest: () => catalogue.filter(tool => loaded.has(tool.name)),
    has: (name: string) => catalogue.some(tool => tool.name === name),
    hasModelToolLoader: () => true,
    executionMode: () => 'readonly' as const,
    execute: vi.fn(async () => ({ success: true, output: 'Verified entry point.' })),
  }
  const ctx = {
    tenantId: 'delegation-context', sessionId: 'delegation-session', rootRunId: 'delegation-run', turnId: 'delegation-turn',
    toolProfile: 'general', workspaceDir: '/private', memoryScopes: [], tools,
    history: { append: vi.fn(async (message: Message) => { history.push(message); return message.id ?? 'saved' }),
      getHistory: vi.fn(async () => [...history]), getRawTokenCount: vi.fn(async () => 0) },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as AgentContext
  const llm: LLMAdapter = { model: 'delegation-test', provider: 'mock', complete: vi.fn(), countTokens: () => 0,
    stream: vi.fn(async function* (messages, options) {
      requests.push(options!)
      requestHistories.push(structuredClone(messages))
      if (requests.length === 1) yield { done: true, toolCalls: [{ index: 0, id: 'read-entry', name: 'read_file', args: '{"path":"README.md"}' }] }
      else yield { done: true, content: 'Entry point verified.' }
    }) }
  const run = async (options: ReActOptions = {}) => {
    for await (const _frame of new ReActStrategy(llm, { maxIterations: 3, systemPrompt: 'Read-only project investigation.', ...options })
      .run('深度调研一下这个项目。只读检查，最后在会话中给出结论。', ctx)) { /* exercise actual request assembly */ }
  }
  return { tools, loaded, requests, history, requestHistories, run }
}

describe('delegation decisions at the shared ReAct request boundary', () => {
  it.each(['subagent_start', 'subagent'])('guides a root with callable %s and reuse discovery', async start => {
    const f = fixture([start, 'subagent_directory'])
    const context = buildDelegationRequestContext({ list: f.tools.listForRequest })
    expect(context).toContain(header)
    expect(context).toContain('subagent_directory')
    expect(context).toContain(start)
    expect(context).toContain('builtinRole=research')
    await f.run()
    expect(f.requests).toHaveLength(2)
    for (const request of f.requests) {
      expect(request.tools?.some(tool => tool.name === start)).toBe(true)
      expect(request.requestContext).toContain(context)
      expect(request.systemPrompt).not.toContain(header)
    }
    expect(f.requests[1].systemPrompt).toBe(f.requests[0].systemPrompt)
    expect(JSON.stringify(f.history)).not.toContain(header)
    expect(JSON.stringify(f.requestHistories)).not.toContain(header)
  })

  it.each([{ offered: [] }, { offered: ['subagent_directory'] }])('does not ask a child with $offered to create workers', async ({ offered }) => {
    const f = fixture(offered)
    expect(buildDelegationRequestContext({ list: f.tools.listForRequest })).toBe('')
    await f.run()
    expect(f.requests).toHaveLength(2)
    for (const request of f.requests) expect(request.requestContext).not.toContain(header)
  })

  it('uses callable schemas rather than a deferred start in the full catalogue', async () => {
    const f = fixture(['subagent_directory'], ['subagent_directory', 'subagent_start'])
    expect(buildDelegationRequestContext(f.tools)).toContain(header)
    await f.run()
    expect(f.requests).toHaveLength(2)
    for (const request of f.requests) {
      expect(request.tools?.some(tool => tool.name === 'subagent_start')).toBe(false)
      expect(request.requestContext).not.toContain(header)
    }
  })

  it('drops a no-longer-callable delegation hint without changing the static prefix or saved history', async () => {
    const f = fixture(['subagent_start', 'subagent_directory'])
    f.tools.execute.mockImplementation(async () => {
      f.loaded.delete('subagent_start')
      return { success: true, output: 'Start is no longer offered for this continuation.' }
    })
    await f.run()
    expect(f.requests).toHaveLength(2)
    expect(f.requests[0].requestContext).toContain(header)
    expect(f.requests[1].requestContext).not.toContain(header)
    expect(f.requests[1].tools?.some(tool => tool.name === 'subagent_start')).toBe(false)
    expect(f.requests[1].systemPrompt).toBe(f.requests[0].systemPrompt)
    expect(f.requests[0].systemPrompt).not.toContain(header)
    expect(JSON.stringify(f.history)).not.toContain(header)
    expect(JSON.stringify(f.requestHistories)).not.toContain(header)
  })

  it('leaves explicitly selected collaborators to their own dispatch contract', async () => {
    const f = fixture(['subagent_start', 'subagent_directory', 'collaborator_dispatch'])
    expect(buildDelegationRequestContext({ list: f.tools.listForRequest })).toBe('')
    await f.run()
    expect(f.requests).toHaveLength(2)
    for (const request of f.requests) {
      expect(request.tools?.some(tool => tool.name === 'collaborator_dispatch')).toBe(true)
      expect(request.requestContext).not.toContain(header)
    }
  })

  it('removes the delegation decision when finalization removes every callable tool', async () => {
    const f = fixture(['subagent_start', 'subagent_directory'])
    await f.run({ maxIterations: 2, finalizeOnLimit: true })
    expect(f.requests).toHaveLength(2)
    expect(f.requests[0].requestContext).toContain(header)
    expect(f.requests[1]).toMatchObject({ requestStage: 'finalization', tools: [] })
    expect(f.requests[1].requestContext).not.toContain(header)
    expect(f.requests[1].requestContext).not.toContain('builtinRole=research')
    expect(f.requests[1].systemPrompt).not.toContain(header)
  })
})
