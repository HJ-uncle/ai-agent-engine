import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext, Message, ToolCall, ToolResult } from '../../agent-context/index.js'
import type { LLMAdapter, LLMAdapterOptions, LLMStreamChunk } from '../../llm-adapter/types.js'
import type { RunOutcome } from '../../subagent/types.js'
import { ReActStrategy } from '../react.js'
import { estimateRequestInput } from '../finalization.js'
import { MUTATION_REPETITION_PROMPT } from '../tool-progress.js'

vi.mock('../../../storage/todo/index.js', () => ({ TodoStore: class { async list() { return [] } } }))
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

const mutation = (): ToolCall => ({ id: '', name: 'write_file', args: { path: 'private/module.ts', content: 'same' } })
const execute = (): ToolCall => ({ id: '', name: 'execute_cmd', args: { command: 'node', args: ['-v'] } })
const read = (): ToolCall => ({ id: '', name: 'read_file', args: { path: 'private/module.ts' } })
const hasNotice = (request: { options: LLMAdapterOptions }) => request.options.systemPrompt?.includes(MUTATION_REPETITION_PROMPT) ?? false

function fixture(calls: ToolCall[], profile: 'code' | 'general' = 'code') {
  const history: Message[] = []
  const requests: Array<{ messages: Message[]; options: LLMAdapterOptions }> = []
  const outcomes: RunOutcome[] = []
  let index = 0
  const ctx = {
    tenantId: 'tenant', sessionId: 'session', rootRunId: 'root', turnId: 'turn',
    userMessageId: 'user', assistantMessageId: 'assistant', workspaceDir: '.',
    toolProfile: profile, tokenBudget: 100_000, modelCaps: { contextWindow: 100_000 },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    history: {
      append: vi.fn(async (message: Message) => { history.push(message); return message.id ?? 'saved' }),
      getHistory: vi.fn(async () => [...history]), getFullHistory: vi.fn(async () => [...history]),
      microCompactToolResults: vi.fn(async () => ({ cleared: 0, freedTokens: 0 })),
      compress: vi.fn(async () => ({ preTokens: 0, postTokens: 0 })),
    },
    tools: {
      list: () => ['read_file', 'write_file', 'execute_cmd', 'task_status', 'command_output'].map(name => ({ name, description: name, parameters: { type: 'object' } })),
      has: () => true,
      executionMode: (name: string) => name === 'read_file' || name === 'command_output' ? 'readonly' : 'serial',
      preflight: vi.fn(async () => undefined as ToolResult | undefined),
      execute: vi.fn(async () => ({ success: true, output: 'done' })),
    },
    runObserver: { onOutcome: vi.fn(async (outcome: RunOutcome) => { outcomes.push(outcome) }), onToolStart: vi.fn(), onToolEnd: vi.fn() },
  } as unknown as AgentContext
  const llm: LLMAdapter = {
    model: 'model', provider: 'mock', complete: vi.fn(), countTokens: () => 0,
    stream: vi.fn(async function* (messages: Message[], options?: LLMAdapterOptions): AsyncGenerator<LLMStreamChunk> {
      requests.push({ messages: [...messages], options: options! })
      const call = calls[index++]
      if (call) yield { done: true, toolCalls: [{ ...call, id: `call-${index}`, args: JSON.stringify(call.args), index: 0 }], finishReason: 'tool_calls' }
      else yield { done: true, content: 'done', finishReason: 'stop' }
    }),
  }
  async function run() { for await (const _frame of new ReActStrategy(llm).run('Implement and verify the requested file.', ctx)) { /* consume */ } }
  return { ctx, llm, history, requests, outcomes, run }
}

describe('request-local repeated mutation advice', () => {
  it.each(['code', 'general'] as const)('is dispatched through the next %s ReAct request and disappears after changed evidence', async profile => {
    const f = fixture([mutation(), mutation(), mutation(), { ...mutation(), args: { path: 'module.ts', content: 'changed' } }], profile)
    await f.run()
    expect(f.requests.slice(0, 3).every(request => !request.options.systemPrompt?.includes(MUTATION_REPETITION_PROMPT))).toBe(true)
    expect(f.requests[3].options.systemPrompt).toContain(MUTATION_REPETITION_PROMPT)
    expect(f.requests[3].options.tools?.map(tool => tool.name)).toContain('write_file')
    expect(f.requests[3].options.requestInputTokenEstimate).toBe(estimateRequestInput(
      f.requests[3].messages, f.requests[3].options.systemPrompt, f.requests[3].options.tools!))
    expect(f.requests[3].options.requestInputTokenEstimate! + f.requests[3].options.maxTokens!).toBeLessThanOrEqual(100_000)
    expect(f.requests[4].options.systemPrompt ?? '').not.toContain(MUTATION_REPETITION_PROMPT)
    expect(f.history.some(message => String(message.content).includes(MUTATION_REPETITION_PROMPT))).toBe(false)
    expect(f.ctx.tools.preflight).toHaveBeenCalledTimes(4)
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'succeeded', stopReason: 'completed' })
  })

  it('keeps the configured positive failure limit as the only hard-stop path', async () => {
    vi.stubEnv('MAX_CONSECUTIVE_FAILURES', '2')
    const f = fixture([mutation(), mutation(), mutation(), mutation()])
    await f.run()
    expect(f.requests).toHaveLength(3)
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'failed', stopReason: 'repeated_failure' })
  })

  it.each(['code', 'general'] as const)('dispatches advice for alternating successful %s write and execute calls without changing base progress', async profile => {
    const f = fixture([mutation(), execute(), mutation(), execute(), mutation(), execute()], profile)
    await f.run()
    expect(f.requests.slice(0, 4).every(request => !request.options.systemPrompt?.includes(MUTATION_REPETITION_PROMPT))).toBe(true)
    expect(f.requests.slice(4).every(request => request.options.systemPrompt?.includes(MUTATION_REPETITION_PROMPT))).toBe(true)
    expect(f.requests[4].options.systemPrompt).not.toContain('private/module.ts')
    expect(f.requests.length).toBe(7)
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'succeeded', stopReason: 'completed' })
    expect(f.history.filter(message => message.role === 'tool')).toHaveLength(6)
    expect(f.history.some(message => String(message.content).includes(MUTATION_REPETITION_PROMPT))).toBe(false)
  })

  it('does not widen a configured finite stop to alternating operations', async () => {
    vi.stubEnv('MAX_CONSECUTIVE_FAILURES', '2')
    const f = fixture([mutation(), execute(), mutation(), execute(), mutation(), execute()])
    await f.run()
    expect(f.requests).toHaveLength(7)
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'succeeded', stopReason: 'completed' })
  })

  it('allows all successful repeated operations through the unlimited default', async () => {
    vi.stubEnv('MAX_CONSECUTIVE_FAILURES', undefined)
    const f = fixture(Array.from({ length: 80 }, (_, index) => index % 2 ? execute() : mutation()))
    await f.run()
    expect(f.requests).toHaveLength(81)
    expect(f.requests.slice(4).every(hasNotice)).toBe(true)
    expect(f.ctx.tools.execute).toHaveBeenCalledTimes(80)
    expect(f.outcomes).toEqual([expect.objectContaining({ status: 'succeeded', stopReason: 'completed' })])
  })

  it('clears on a new read but keeps identical read evidence across the original mutation epochs', async () => {
    const f = fixture([mutation(), execute(), read(), mutation(), read(), execute(), read(), mutation(), execute()])
    let reads = 0
    f.ctx.tools.execute = vi.fn(async name => ({ success: true, output: name === 'read_file' ? ++reads < 3 ? 'source v1' : 'source v2' : 'done' }))
    await f.run()
    expect(f.requests.map(hasNotice)).toEqual([false, false, false, false, false, false, true, false, false, true])
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'succeeded' })
  })

  it('clears the advisory on changed output while holding the exact command arguments constant', async () => {
    const f = fixture([mutation(), execute(), mutation(), execute(), execute()])
    let commands = 0
    f.ctx.tools.execute = vi.fn(async name => ({ success: true, output: name === 'execute_cmd' && ++commands === 3 ? 'new output' : 'done' }))
    await f.run()
    expect(f.requests.map(hasNotice)).toEqual([false, false, false, false, true, false])
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'succeeded' })
  })

  it.each(['plan_update', 'todo_list', 'todo_create', 'todo_update', 'todo_delete', 'command_output', 'task_status', 'task_list'])('clears advice at the %s control boundary', async name => {
    const control: ToolCall = { id: '', name, args: name === 'plan_update' ? { items: [] } : { id: 'job' } }
    const f = fixture([mutation(), execute(), mutation(), execute(), control, mutation(), execute()])
    f.ctx.tools.execute = vi.fn(async tool => ({ success: true,
      output: tool === 'task_status' ? '{"status":"running"}' : 'done',
      ...(tool === 'command_output' ? { metadata: { commandJob: { status: 'running' } } } : {}) }))
    await f.run()
    expect(f.requests.map(hasNotice)).toEqual([false, false, false, false, true, false, false, true])
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'succeeded' })
  })

  it.each(['permanent', 'transient'] as const)('clears advisory after a %s failure without altering its original retry accounting', async kind => {
    const f = fixture([mutation(), execute(), mutation(), execute(), execute(), mutation(), execute()])
    let commands = 0
    f.ctx.tools.execute = vi.fn(async name => name === 'execute_cmd' && ++commands === 3
      ? { success: false, output: kind === 'transient' ? 'temporary network timeout' : 'invalid arguments',
        ...(kind === 'transient' ? { metadata: { retryable: true } } : {}) }
      : { success: true, output: 'done' })
    await f.run()
    expect(f.requests.map(hasNotice)).toEqual([false, false, false, false, true, false, false, true])
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'succeeded' })
  })

  it('does not classify active task polls as repeated mutations', async () => {
    const f = fixture([
      { id: '', name: 'task_status', args: { id: 'job' } },
      { id: '', name: 'task_status', args: { id: 'job' } },
      { id: '', name: 'task_status', args: { id: 'job' } },
      mutation(),
    ])
    f.ctx.tools.execute = vi.fn(async (name: string) => name === 'task_status'
      ? { success: true, output: JSON.stringify({ status: 'running' }), metadata: { commandJob: { status: 'running' } } }
      : { success: true, output: 'done' })
    await f.run()
    expect(f.requests.some(request => request.options.systemPrompt?.includes(MUTATION_REPETITION_PROMPT))).toBe(false)
  })

  it('preserves a blocked permission outcome without changing access or injecting advice', async () => {
    const f = fixture([mutation()])
    f.ctx.onPending = vi.fn(async () => {})
    f.ctx.tools.preflight = vi.fn(async () => ({ success: false, output: 'Permission required', needsConfirmation: true,
      pendingAction: { type: 'fs_policy' } }))
    await f.run()
    expect(f.requests).toHaveLength(1)
    expect(f.requests[0].options.systemPrompt ?? '').not.toContain(MUTATION_REPETITION_PROMPT)
    expect(f.ctx.tools.execute).not.toHaveBeenCalled()
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'blocked' })
  })
})
