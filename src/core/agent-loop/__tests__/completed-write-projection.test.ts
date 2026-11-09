import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext, Message, Tool } from '../../agent-context/types.js'
import type { LLMAdapter, LLMAdapterOptions } from '../../llm-adapter/types.js'
import { OpenAIAdapter } from '../../llm-adapter/openai.js'
import { ToolRegistry } from '../../tool-registry/registry.js'
import { workspaceManager } from '../../../workspace/index.js'
import { trustBuiltinTool } from '../../../security/tool-policy.js'
import { loadToolsTool } from '../../../tools/model-tool-loading.js'
import { searchHistoryTool } from '../../../tools/get-context/search-history-tool.js'
import { ReActStrategy } from '../react.js'

vi.mock('../../../storage/todo/index.js', () => ({ TodoStore: class { async list() { return [] } } }))
vi.mock('../../../storage/results/index.js', () => ({ finalResults: {
  stalePaths: async () => [], prepare: async () => undefined, retainToolImages: async () => [],
}, TOOL_RESULT_IMAGE_ASSETS: '__aetherResultImageAssets' }))
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals() })

const data = '原始写入正文🙂\r\n"quoted"\\path\n'.repeat(600)
const writeArgs = { path: 'report.md', data, expectedHash: 'missing' }
const hash = 'sha256:' + 'a'.repeat(64)
type Case = 'write' | 'greeting' | 'short' | 'untrusted-write' | 'untrusted-recovery' | 'recovery' | 'closeout' | 'finalize'
function fixture(kind: Case) {
  vi.stubEnv('ENABLE_LONG_TERM_MEMORY', 'false')
  vi.spyOn(workspaceManager, 'getPaths').mockReturnValue(['/completed-write-test'])
  const persisted: Message[] = [], requests: Array<{ history: Message[]; options: LLMAdapterOptions }> = [], wire: any[] = []
  const registry = new ToolRegistry()
  const write: Tool = { name: 'write_file', description: 'Write once.', parameters: { type: 'object' },
    execute: vi.fn(async () => ({ success: true, output: `Written report.md\nexpectedHash: ${hash}`, metadata: { fileMutationApplied: true } })) }
  registry.register(kind === 'untrusted-write' ? write : trustBuiltinTool(write), { description: write.description, parameters: write.parameters })
  const read: Tool = trustBuiltinTool({ name: 'read_file', description: 'Inspect.', parameters: { type: 'object' },
    execute: async args => ({ success: true, output: `Observed ${(args as { path: string }).path}` }) }, 'readonly')
  registry.register(read, { description: read.description, parameters: read.parameters })
  const recovery: Tool = kind === 'untrusted-recovery' ? { ...searchHistoryTool } : trustBuiltinTool(searchHistoryTool, 'readonly')
  registry.register(recovery, { description: recovery.description, parameters: recovery.parameters })
  registry.register(loadToolsTool)
  if (kind === 'closeout') registry.register(trustBuiltinTool({ name: 'deliver_files', description: 'Register results.',
    parameters: { type: 'object' }, execute: async () => ({ success: true, output: 'Registered report.md' }) }))
  const load = vi.spyOn(registry, 'loadForModel')
  const ctx = { tenantId: 'completed-write', sessionId: 'projection', rootRunId: 'run', turnId: 'turn', toolProfile: 'general',
    tokenBudget: 200_000, workspaceDir: '/completed-write-test', memoryScopes: [], tools: registry,
    history: { append: vi.fn(async (message: Message) => { persisted.push(message); return message.id ?? 'saved' }),
      getHistory: async () => [...persisted], getFullHistory: async () => [...persisted], getRawTokenCount: async () => 0,
      getArchive: async () => ({ backend: 'jsonl', messages: [...persisted] }) },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as AgentContext
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
    wire.push(JSON.parse(String(init?.body)))
    return Response.json({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
  }))
  const adapter = new OpenAIAdapter('test-model', 'test-key', 'http://model.invalid', true)
  const llm: LLMAdapter = { model: 'scripted', provider: 'scripted', countTokens: () => 0, complete: vi.fn(),
    stream: async function* (history, options) {
      requests.push({ history, options: options! })
      // Exercise the actual provider serializer with a local fetch stub, then
      // supply the deterministic response for the real ReAct loop to execute.
      await adapter.complete(history, options)
      const index = requests.length
      let call: { name: string; args: Record<string, unknown> } | undefined
      if (kind !== 'greeting') {
        if (index === 1) call = { name: 'write_file', args: kind === 'short' ? { ...writeArgs, data: 'short' } : writeArgs }
        else if (index === 2 || index === 3) call = { name: 'read_file', args: { path: `evidence-${index}.md` } }
        else if (index === 4 && kind === 'recovery') call = { name: 'search_history', args: {
          messageId: persisted.find(message => message.toolCall?.name === 'write_file')!.id!, toolArguments: true, contentOffset: 0, limit: 1 } }
        else if (index === 4 && kind === 'closeout') call = { name: 'deliver_files', args: { items: [{ path: 'report.md' }] } }
      }
      if (call) yield { done: true, toolCalls: [{ index: 0, id: `call-${index}`, name: call.name, args: JSON.stringify(call.args) }] }
      else yield { done: true, content: 'Completed.' }
    } }
  return { persisted, requests, wire, load, write, run: async () => {
    for await (const _frame of new ReActStrategy(llm, { maxIterations: kind === 'finalize' ? 4 : 6,
      finalizeOnLimit: kind === 'finalize' }).run(kind === 'greeting' ? 'Hello.' : 'Create the requested report and verify it.', ctx)) { /* consume */ }
  } }
}
function wireWriteArgs(request: any): Record<string, unknown> {
  const call = request.messages.flatMap((message: any) => message.tool_calls ?? []).find((item: any) => item.function.name === 'write_file')
  return JSON.parse(call.function.arguments)
}

describe('completed payload projection through real ReAct dispatch', () => {
  it('loads recovery only once an old long write can be projected and leaves durable history unchanged', async () => {
    const f = fixture('write')
    await f.run()
    expect(f.requests).toHaveLength(4)
    for (const request of f.requests.slice(0, 3)) expect(request.options.tools?.map(tool => tool.name)).not.toContain('search_history')
    expect(f.requests[3].options.tools?.map(tool => tool.name)).toContain('search_history')
    expect(f.load).toHaveBeenCalledTimes(1)
    expect(f.load).toHaveBeenCalledWith(['search_history'])
    expect(wireWriteArgs(f.wire[2]).data).toBe(data)
    expect(wireWriteArgs(f.wire[3]).data).toContain('Historical write payload omitted')
    expect(wireWriteArgs(f.wire[3]).data).toContain('"toolArguments":true')
    expect(JSON.stringify(f.wire[3])).toContain(hash)
    expect(f.persisted.find(message => message.toolCall?.name === 'write_file')!.toolCall!.args).toEqual(writeArgs)
    expect(f.write.execute).toHaveBeenCalledTimes(1)
    expect(f.write.execute).toHaveBeenCalledWith(writeArgs, expect.anything())
  })

  it.each(['greeting', 'short', 'untrusted-write', 'untrusted-recovery'] as const)('does not load or project for %s', async kind => {
    const f = fixture(kind)
    await f.run()
    expect(f.load).not.toHaveBeenCalled()
    expect(JSON.stringify(f.wire)).not.toContain('Historical write payload omitted')
    for (const request of f.requests) expect(request.options.tools?.map(tool => tool.name)).not.toContain('search_history')
  })

  it('executes explicit recovery against the original persisted arguments after projection', async () => {
    const f = fixture('recovery')
    await f.run()
    expect(f.requests).toHaveLength(5)
    const result = f.persisted.find(message => message.role === 'tool' && message.toolName === 'search_history')!
    expect(result.metadata.success).toBe(true)
    const page = JSON.parse(result.content as string).messages[0]
    expect(page.contentSource).toBe('tool_arguments')
    expect(page.content).toBe(JSON.stringify(writeArgs).slice(0, 2000))
    expect(page.nextContentOffset).toBe(2000)
    expect(page.content).not.toContain('Historical write payload omitted')
  })

  it.each(['closeout', 'finalize'] as const)('restores original args when %s removes the recovery tool', async kind => {
    const f = fixture(kind)
    await f.run()
    const last = f.requests.at(-1)!
    expect(last.options.tools?.map(tool => tool.name)).not.toContain('search_history')
    expect(wireWriteArgs(f.wire.at(-1)).data).toBe(data)
    expect(JSON.stringify(f.wire.at(-1))).not.toContain('Historical write payload omitted')
  })
})
