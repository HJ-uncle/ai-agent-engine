import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext, Message, Tool } from '../../agent-context/types.js'
import type { LLMAdapter, LLMAdapterOptions } from '../../llm-adapter/types.js'
import { workspaceManager } from '../../../workspace/index.js'
import { ReActStrategy } from '../react.js'
import { ToolRegistry } from '../../tool-registry/registry.js'
import { loadToolsTool } from '../../../tools/model-tool-loading.js'

vi.mock('../../../storage/todo/index.js', () => ({ TodoStore: class { async list() { return [] } } }))

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

function fixture(projected: boolean) {
  vi.stubEnv('ENABLE_LONG_TERM_MEMORY', 'false')
  vi.spyOn(workspaceManager, 'getPaths').mockReturnValue(['/model-projection-test'])
  const messages: Message[] = []
  const requests: LLMAdapterOptions[] = []
  const calls: string[] = []
  const parameters = { type: 'object' as const, additionalProperties: false,
    properties: { value: { type: 'integer' as const, minimum: 1, maximum: 3 } }, required: ['value'] }
  const make = (name: string): Tool => ({ name, description: `Canonical documentation for ${name}`,
    parameters, async execute() { throw new Error('The model-facing object must not execute itself') } })
  const canonical = [make('projection_first')]
  const tools = {
    list: () => canonical,
    ...(projected ? { listForModel: () => canonical.map(tool => ({ ...tool, description: `简述：${tool.name}` })) } : {}),
    has: (name: string) => canonical.some(tool => tool.name === name),
    executionMode: () => 'serial' as const,
    execute: vi.fn(async (name: string) => {
      calls.push(name)
      if (name === 'projection_first') canonical.push(make('projection_second'))
      return { success: true, output: `Executed ${name} through registry` }
    }),
  }
  const ctx = {
    tenantId: 'projection-test', sessionId: 'projection-session', toolProfile: 'general',
    workspaceDir: '/model-projection-test', memoryScopes: [], tools,
    history: { append: vi.fn(async (message: Message) => { messages.push(message); return message.id ?? 'saved' }),
      getHistory: vi.fn(async () => [...messages]), getRawTokenCount: vi.fn(async () => 0) },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as AgentContext
  const llm: LLMAdapter = {
    model: 'scripted-projection', provider: 'scripted', countTokens: () => 0, complete: vi.fn(),
    stream: vi.fn(async function* (_history, options) {
      if (!options) throw new Error('Missing model options')
      requests.push(options)
      if (requests.length <= 2) yield { done: true, toolCalls: [{ index: 0, id: `projection-call-${requests.length}`,
        name: requests.length === 1 ? 'projection_first' : 'projection_second', args: '{"value":2}' }] }
      else yield { done: true, content: 'Both operations completed.' }
    }),
  }
  return { tools, calls, requests, parameters, ctx, llm, messages, run: async () => {
    for await (const _frame of new ReActStrategy(llm, { maxIterations: 4 }).run('Run both authorized operations.', ctx)) { /* consume actual loop */ }
  } }
}

describe('model tool projection through actual ReAct requests', () => {
  it('requires a new request with the loaded schema before executing a deferred call, including the same load batch', async () => {
    const f = fixture(true)
    const registry = new ToolRegistry()
    const execute = vi.fn(async () => ({ success: true, output: 'Created in the authorized workspace' }))
    const office: Tool = { name: 'office_document', description: 'Full office contract', parameters: f.parameters, execute }
    registry.register(office, { description: office.description, parameters: office.parameters })
    registry.register(loadToolsTool)
    f.ctx.tools = registry
    f.llm.stream = vi.fn(async function* (_history, options) {
      f.requests.push(options!)
      if (f.requests.length === 1) yield { done: true, toolCalls: [
        { index: 0, id: 'load-office', name: 'load_tools', args: '{"names":["office_document"]}' },
        { index: 1, id: 'premature-office', name: 'office_document', args: '{"value":2}' },
      ] }
      else if (f.requests.length === 2) yield { done: true, toolCalls: [
        { index: 0, id: 'actual-office', name: 'office_document', args: '{"value":2}' },
      ] }
      else yield { done: true, content: 'Done' }
    })
    await f.run()
    expect(f.requests[0].tools?.map(tool => tool.name)).toEqual(['load_tools'])
    expect(f.requests[1].tools?.find(tool => tool.name === 'office_document')?.parameters).toEqual(f.parameters)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(f.messages.find(message => message.role === 'tool' && message.toolCallId === 'premature-office')?.content).toContain('TOOL_NOT_LOADED')
    expect(registry.list().some(tool => tool.name === 'office_document')).toBe(true)
  })

  it('refreshes compact definitions after registration while dispatch stays in the authoritative registry', async () => {
    const f = fixture(true)
    await f.run()
    expect(f.requests).toHaveLength(3)
    expect(f.requests[0].tools?.map(tool => tool.name)).toEqual(['projection_first'])
    expect(f.requests[1].tools?.map(tool => tool.name)).toEqual(['projection_first', 'projection_second'])
    for (const request of f.requests) for (const tool of request.tools ?? []) {
      expect(tool.description).toBe(`简述：${tool.name}`)
      expect(tool.parameters).toEqual(f.parameters)
    }
    expect(f.calls).toEqual(['projection_first', 'projection_second'])
    expect(f.tools.list()[0].description).toBe('Canonical documentation for projection_first')
  })

  it('retains compatibility with registries that do not offer a model projection', async () => {
    const f = fixture(false)
    await f.run()
    expect(f.requests).toHaveLength(3)
    expect(f.requests[0].tools?.[0].description).toBe('Canonical documentation for projection_first')
    expect(f.calls).toEqual(['projection_first', 'projection_second'])
  })
})
