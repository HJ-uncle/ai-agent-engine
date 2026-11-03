import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext, Message } from '../../agent-context/types.js'
import type { LLMAdapter, LLMAdapterOptions } from '../../llm-adapter/types.js'
import { setSecurityMode, clearSecurityMode } from '../../../security/policy-engine.js'
import { workspaceManager } from '../../../workspace/index.js'
import { ReActStrategy, type ReActOptions } from '../react.js'

vi.mock('../../../storage/todo/index.js', () => ({ TodoStore: class { async list() { return [] } } }))
const identity = { tenantId: 'request-environment', sessionId: 'request-session' }
afterEach(() => { clearSecurityMode(identity.tenantId, identity.sessionId); vi.restoreAllMocks(); vi.useRealTimers() })

function fixture() {
  const history: Message[] = []
  const requests: LLMAdapterOptions[] = []
  const parameters = { type: 'object', additionalProperties: false, required: ['path'], properties: {
    path: { type: 'string', description: '完整参数说明', minLength: 1 },
    mode: { type: 'string', enum: ['text', 'image'] },
  } }
  let definitions = [{ name: 'read_file', description: '完整工具说明，不应重复进系统提示', parameters }]
  const ctx = {
    ...identity, rootRunId: 'root-environment', turnId: 'turn-environment', toolProfile: 'general',
    workspaceDir: '/private', projectRoot: '/old-project', cwd: '/old-project',
    history: { append: vi.fn(async (message: Message) => { history.push(message); return message.id ?? 'saved' }),
      getHistory: vi.fn(async () => [...history]), getRawTokenCount: vi.fn(async () => 0) },
    tools: { list: () => definitions, has: () => true, executionMode: () => 'serial',
      execute: vi.fn(async () => ({ success: true, output: 'read content' })) },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as AgentContext
  const llm: LLMAdapter = { model: 'test', provider: 'test', complete: vi.fn(), countTokens: () => 0,
    stream: vi.fn(async function* (_messages, options) {
      requests.push(options!)
      if (requests.length === 1) yield { done: true, toolCalls: [{ index: 0, id: 'read-1', name: 'read_file', args: '{"path":"file.md"}' }] }
      else yield { done: true, content: 'Done.' }
    }) }
  const run = async (options: ReActOptions = {}) => {
    for await (const _frame of new ReActStrategy(llm, { maxIterations: 3, systemPrompt: 'Caller instructions.', ...options }).run('Read the file.', ctx)) { /* exercise real prompt assembly */ }
  }
  return { ctx, history, requests, parameters, run, replaceTools: (next: typeof definitions) => { definitions = next } }
}

function snapshot(options: LLMAdapterOptions) {
  const tail = options.systemPrompt!.split('## 本次模型请求环境\n')[1]
  return JSON.parse(tail.slice(tail.indexOf('\n') + 1).split('\n\n')[0])
}

describe('automatic environment at the shared ReAct request boundary', () => {
  it('updates roots, clock, permission and schemas after tool execution without an extra discovery call', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-03T00:00:00Z'))
    const paths = vi.spyOn(workspaceManager, 'getPaths').mockReturnValue(['/first-project', '/private'])
    const f = fixture()
    setSecurityMode(identity.tenantId, identity.sessionId, 'safe')
    f.ctx.tools.execute = vi.fn(async () => {
      vi.setSystemTime(new Date('2026-11-04T00:00:00Z'))
      paths.mockReturnValue(['/second-project', '/private'])
      setSecurityMode(identity.tenantId, identity.sessionId, 'standard')
      f.replaceTools([{ name: 'read_file', description: 'updated full description', parameters: { ...f.parameters, required: ['path', 'mode'] } }])
      return { success: true, output: 'read content' }
    })
    await f.run()
    expect(f.requests).toHaveLength(2)
    expect(snapshot(f.requests[0])).toMatchObject({ clock: { currentTime: '2026-11-03T00:00:00.000Z' },
      environment: { workspacePaths: ['/first-project', '/private'] }, permissions: { securityMode: 'safe' } })
    expect(snapshot(f.requests[1])).toMatchObject({ clock: { currentTime: '2026-11-04T00:00:00.000Z' },
      environment: { workspacePaths: ['/second-project', '/private'] }, permissions: { securityMode: 'standard' } })
    expect(snapshot(f.requests[0]).registryVersion).not.toBe(snapshot(f.requests[1]).registryVersion)
    expect(f.requests[0].tools?.[0]).toMatchObject({ description: '完整工具说明，不应重复进系统提示', parameters: f.parameters })
    expect(f.requests[1].tools?.[0].parameters.required).toEqual(['path', 'mode'])
    for (const options of f.requests) {
      expect(options.systemPrompt!.split('## 本次模型请求环境')).toHaveLength(2)
      expect(options.systemPrompt!.split('## Aether 公共执行协议')).toHaveLength(2)
      expect(options.systemPrompt).toContain('Caller instructions.')
      expect(options.systemPrompt).not.toMatch(/get_current_context|get_tool_details|get_time|完整参数说明|完整工具说明，不应重复进系统提示/)
      expect(options.systemPrompt).not.toContain('/old-project')
    }
    expect(f.ctx.tools.execute).toHaveBeenCalledTimes(1)
  })

  it('describes a finalization request with no available tools', async () => {
    vi.spyOn(workspaceManager, 'getPaths').mockReturnValue(['/project'])
    const f = fixture()
    await f.run({ maxIterations: 2, finalizeOnLimit: true })
    expect(f.requests).toHaveLength(2)
    expect(f.requests[1].requestStage).toBe('finalization')
    expect(f.requests[1].tools).toEqual([])
    expect(snapshot(f.requests[1]).toolCount).toBe(0)
    expect(snapshot(f.requests[1]).tools).toBeUndefined()
    expect(f.requests[1].systemPrompt!.split('## 本次模型请求环境')).toHaveLength(2)
  })

  it('rebuilds environment after history compaction while preserving full request schemas', async () => {
    const paths = vi.spyOn(workspaceManager, 'getPaths').mockReturnValue(['/before-compaction'])
    const f = fixture()
    f.ctx.modelCaps = { contextWindow: 8192 } as AgentContext['modelCaps']
    f.history.push({ id: 'old-context', role: 'assistant', content: 'old context '.repeat(4_000) })
    f.ctx.history.compress = vi.fn(async () => {
      const current = f.history.filter(message => message.role === 'user').at(-1)!
      f.history.splice(0, f.history.length, { role: 'system', content: 'Retained summary and constraints.' }, current)
      paths.mockReturnValue(['/after-compaction'])
      return { preTokens: 20_000, postTokens: 20 }
    })
    await f.run()
    expect(f.ctx.history.compress).toHaveBeenCalledTimes(1)
    expect(f.requests).toHaveLength(2)
    for (const options of f.requests) {
      expect(snapshot(options).environment.workspacePaths).toEqual(['/after-compaction'])
      expect(snapshot(options).clock.currentTime).toBeTruthy()
      expect(snapshot(options).permissions.securityMode).toBeTruthy()
      expect(options.tools?.[0].parameters).toEqual(f.parameters)
      expect(options.systemPrompt!.split('## 本次模型请求环境')).toHaveLength(2)
      expect(options.systemPrompt).not.toContain('old context ')
      expect(options.systemPrompt).not.toContain('完整参数说明')
    }
  })
})
