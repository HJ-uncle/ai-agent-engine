import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext, Message } from '../../agent-context/types.js'
import type { LLMAdapter, LLMAdapterOptions } from '../../llm-adapter/types.js'
import { workspaceManager } from '../../../workspace/index.js'
import { prepareCodegraphRequestContext } from '../../codegraph-prompt.js'
import { ReActStrategy, type ReActOptions } from '../react.js'

vi.mock('../../codegraph-prompt.js', () => ({ prepareCodegraphRequestContext: vi.fn() }))
vi.mock('../../../storage/todo/index.js', () => ({ TodoStore: class { async list() { return [] } } }))

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks() })

const header = '# 代码图索引（codegraph）'
const schema = { type: 'object', properties: { action: { type: 'string', enum: ['status', 'files'] }, path: { type: 'string' } }, required: ['action', 'path'] }

function fixture(exposeSchema = true) {
  const history: Message[] = []
  const requestHistories: Message[][] = []
  const requests: LLMAdapterOptions[] = []
  const roots = vi.spyOn(workspaceManager, 'getPaths').mockReturnValue(['/first-indexed-project'])
  const catalogue = [
    { name: 'load_tools', description: 'Load deferred definitions', parameters: { type: 'object', properties: {} } },
    { name: 'read_file', description: 'Read a bounded file', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
    { name: 'codegraph', description: 'Query an existing graph', parameters: schema },
  ]
  const loaded = new Set(['load_tools', 'read_file'])
  const tools = {
    list: () => catalogue,
    listForRequest: () => catalogue.filter(tool => loaded.has(tool.name)),
    has: (name: string) => catalogue.some(tool => tool.name === name),
    hasModelToolLoader: () => true,
    loadForModel: vi.fn((names: readonly string[]) => { for (const name of names) loaded.add(name); return [...names] }),
    executionMode: () => 'readonly' as const,
    execute: vi.fn(async () => ({ success: true, output: 'Verified entry point.' })),
  }
  const ctx = {
    tenantId: 'codegraph-discovery', sessionId: 'graph-session', rootRunId: 'graph-run', turnId: 'graph-turn',
    toolProfile: 'general', workspaceDir: '/private', memoryScopes: [], tools,
    history: { append: vi.fn(async (message: Message) => { history.push(message); return message.id ?? 'saved' }),
      getHistory: vi.fn(async () => [...history]), getRawTokenCount: vi.fn(async () => 0) },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as AgentContext
  vi.mocked(prepareCodegraphRequestContext).mockImplementation(async context => {
    // Loading occurs after yielding: sampling the schemas before awaiting this
    // helper would omit the graph on the very first model request.
    await Promise.resolve()
    if (exposeSchema) context.tools.loadForModel?.(['codegraph'])
    return `${header}\nQuery codegraph status/files with explicit path ${JSON.stringify(workspaceManager.getPaths(context)[0])}.`
  })
  const llm: LLMAdapter = { model: 'graph-test', provider: 'mock', complete: vi.fn(), countTokens: () => 0,
    stream: vi.fn(async function* (messages, options) {
      requests.push(options!)
      requestHistories.push(structuredClone(messages))
      if (requests.length === 1) yield { done: true, toolCalls: [{ index: 0, id: 'read-entry', name: 'read_file', args: '{"path":"README.md"}' }] }
      else yield { done: true, content: 'Entry point verified.' }
    }) }
  const run = async (options: ReActOptions = {}) => {
    for await (const _frame of new ReActStrategy(llm, { maxIterations: 3, systemPrompt: 'Read-only project investigation.', ...options })
      .run('Investigate the current project structure.', ctx)) { /* exercise actual request assembly */ }
  }
  return { ctx, tools, roots, requests, history, requestHistories, run }
}

describe('codegraph discovery at the shared ReAct request boundary', () => {
  it('offers the asynchronously discovered schema on the first request and keeps its hint out of system/history', async () => {
    const f = fixture()
    await f.run()
    expect(f.requests).toHaveLength(2)
    expect(f.requests[0].tools?.find(tool => tool.name === 'codegraph')).toMatchObject({ parameters: schema })
    expect(f.requests[0].requestContext).toContain(header)
    expect(f.requests[0].requestContext).toContain('Query codegraph status/files with explicit path "/first-indexed-project"')
    expect(f.requests[0].systemPrompt).not.toContain(header)
    expect(f.requests[1].systemPrompt).toBe(f.requests[0].systemPrompt)
    expect(JSON.stringify(f.history)).not.toContain(header)
    expect(JSON.stringify(f.requestHistories)).not.toContain(header)
    expect(f.tools.loadForModel).toHaveBeenCalledWith(['codegraph'])
  })

  it('refreshes the codegraph root after workspace changes without altering the static system prefix', async () => {
    const f = fixture()
    f.tools.execute.mockImplementation(async () => {
      f.roots.mockReturnValue(['/replacement-indexed-project'])
      return { success: true, output: 'Workspace binding updated for the continuation.' }
    })
    await f.run()
    expect(f.requests).toHaveLength(2)
    expect(f.requests[0].requestContext).toContain('Query codegraph status/files with explicit path "/first-indexed-project"')
    expect(f.requests[1].requestContext).toContain('Query codegraph status/files with explicit path "/replacement-indexed-project"')
    expect(f.requests[1].requestContext).not.toContain('/first-indexed-project')
    expect(f.requests[1].systemPrompt).toBe(f.requests[0].systemPrompt)
    expect(f.requests[1].tools?.some(tool => tool.name === 'codegraph')).toBe(true)
  })

  it('removes graph-call guidance when finalization removes the callable schemas', async () => {
    const f = fixture()
    await f.run({ maxIterations: 2, finalizeOnLimit: true })
    expect(f.requests).toHaveLength(2)
    expect(f.requests[0].requestContext).toContain(header)
    expect(f.requests[1]).toMatchObject({ requestStage: 'finalization', tools: [] })
    expect(f.requests[1].requestContext).not.toContain(header)
    expect(f.requests[1].requestContext).not.toContain('Query codegraph status/files')
    expect(f.requests[1].systemPrompt).not.toContain(header)
  })

  it('drops the previous root hint when the next workspace has no index even if the schema remains loaded', async () => {
    const f = fixture()
    f.tools.execute.mockImplementation(async () => {
      f.roots.mockReturnValue(['/unindexed-project'])
      vi.mocked(prepareCodegraphRequestContext).mockResolvedValue('')
      return { success: true, output: 'Continued in a workspace without a graph index.' }
    })
    await f.run()
    expect(f.requests).toHaveLength(2)
    expect(f.requests[0].requestContext).toContain(header)
    expect(f.requests[1].tools?.some(tool => tool.name === 'codegraph')).toBe(true)
    expect(f.requests[1].requestContext).not.toContain(header)
    expect(f.requests[1].requestContext).not.toContain('/first-indexed-project')
    expect(f.requests[1].systemPrompt).toBe(f.requests[0].systemPrompt)
  })

  it('does not advertise graph queries when discovery has not exposed the schema', async () => {
    const f = fixture(false)
    await f.run()
    expect(f.requests).toHaveLength(2)
    expect(prepareCodegraphRequestContext).toHaveBeenCalled()
    for (const request of f.requests) {
      expect(request.tools?.some(tool => tool.name === 'codegraph')).toBe(false)
      expect(request.requestContext).not.toContain(header)
      expect(request.systemPrompt).not.toContain(header)
    }
  })
})
