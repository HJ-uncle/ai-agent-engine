import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext, Message } from '../../agent-context/index.js'
import type { LLMAdapter, LLMAdapterOptions, LLMStreamChunk, LLMStreamDiagnostics } from '../../llm-adapter/types.js'
import type { RunOutcome } from '../../subagent/types.js'
import { RequestBudget } from '../../subagent/budget.js'
import { AnthropicAdapter } from '../../llm-adapter/anthropic.js'
import { ReActStrategy, type ReActOptions } from '../react.js'

vi.mock('../../../storage/todo/index.js', () => ({ TodoStore: class { async list() { return [] } } }))
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs() })
const empty = (): LLMStreamChunk => ({ done: true, finishReason: 'stop', promptTokens: 20, completionTokens: 108 })
const answer = (): LLMStreamChunk => ({ done: true, finishReason: 'stop', content: 'Verified remaining work.', promptTokens: 30, completionTokens: 5 })
const tool = (): LLMStreamChunk => ({ done: true, finishReason: 'tool_calls', toolCalls: [{ id: 'write-once', name: 'write_file', args: '{"path":"result.txt","content":"verified"}' }], promptTokens: 10, completionTokens: 10 })
const diag = (rawStopReason: LLMStreamDiagnostics['rawStopReason'], other = false): LLMStreamDiagnostics => ({
  schemaVersion: 1, protocol: 'anthropic', rawStopReason, eventTypes: { message_stop: 1 },
  blockTypes: other ? { other: 1 } : {}, deltaTypes: {}, finalBlockTypes: other ? { other: 1 } : {},
})
function fixture() {
  const history: Message[] = [], outcomes: RunOutcome[] = []
  const ctx = { tenantId: 'tenant', sessionId: 'session', rootRunId: 'root', turnId: 'turn',
    userMessageId: 'user', assistantMessageId: 'final', workspaceDir: '.', toolProfile: 'general',
    modelCaps: { contextWindow: 100_000 }, logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    history: { append: vi.fn(async (message: Message) => { history.push(message); return message.id }),
      getHistory: vi.fn(async () => [...history]), getFullHistory: vi.fn(async () => [...history]),
      microCompactToolResults: vi.fn(async () => ({ cleared: 0, freedTokens: 0 })),
      compress: vi.fn(async () => ({ preTokens: 0, postTokens: 0 })) },
    tools: { list: () => [], has: () => true, executionMode: () => 'serial',
      execute: vi.fn(async () => ({ success: true, output: 'File written exactly once.' })) },
    runObserver: { onUsage: vi.fn(), onOutcome: vi.fn(async (outcome: RunOutcome) => { outcomes.push(outcome) }) },
  } as unknown as AgentContext
  const llm: LLMAdapter = { model: 'unchanged-model', provider: 'fixture', complete: vi.fn(), countTokens: () => 0,
    stream: vi.fn(async function* () { yield answer() }) }
  async function run(options: ReActOptions = {}, onFrame?: (frame: string) => void, adapter = llm) {
    const frames: string[] = []
    for await (const frame of new ReActStrategy(adapter, options).run('Finish the approved task.', ctx)) {
      frames.push(frame); onFrame?.(frame)
    }
    return frames
  }
  return { ctx, llm, history, outcomes, run }
}

describe('one empty terminal response recovery', () => {
  it('continues the same root from completed tool evidence without replaying the write', async () => {
    const f = fixture(), requests: LLMAdapterOptions[] = []
    f.llm.stream = vi.fn(async function* (messages: Message[], options?: LLMAdapterOptions) {
      requests.push(options!)
      if (requests.length === 1) yield tool()
      else if (requests.length === 2) yield empty()
      else {
        expect(messages.filter(m => m.role === 'user')).toHaveLength(1)
        expect(messages.filter(m => m.role === 'tool')).toMatchObject([{ toolCallId: 'write-once', metadata: { success: true } }])
        expect(messages.some(m => m.metadata?.emptyOutputRecovery)).toBe(false)
        expect(options?.systemPrompt).toContain('Do not repeat completed work or replay tools')
        yield answer()
      }
    })
    await f.run({ maxOutputTokens: 1024, thinkingEnabled: false })
    expect(requests).toHaveLength(3)
    expect(requests.every(o => o.maxTokens === 1024 && o.thinkingEnabled === false && o.model === 'unchanged-model')).toBe(true)
    expect(f.ctx.tools.execute).toHaveBeenCalledTimes(1)
    expect(f.history.filter(m => m.metadata?.emptyOutputRecovery)).toMatchObject([
      { metadata: { rootRunId: 'root', turnId: 'turn', partial: true, status: 'failed', stopReason: 'empty_output' }, usage: { promptTokens: 20, completionTokens: 108 } },
    ])
    expect(f.history.find(m => m.metadata?.emptyOutputRecovery)?.id).not.toBe('final')
    expect(f.history.at(-1)?.id).toBe('final')
    expect(f.outcomes).toEqual([{ status: 'succeeded', output: 'Verified remaining work.', stopReason: 'completed' }])
  })

  it('fails honestly after a second empty response and accounts for both requests', async () => {
    const f = fixture()
    f.llm.stream = vi.fn(async function* () { yield empty() })
    const frames = await f.run()
    expect(f.llm.stream).toHaveBeenCalledTimes(2)
    expect(f.ctx.tools.execute).not.toHaveBeenCalled()
    expect(f.outcomes).toMatchObject([{ status: 'failed', stopReason: 'empty_output', error: { code: 'EMPTY_OUTPUT' } }])
    expect(f.history.filter(m => m.role === 'assistant')).toHaveLength(2)
    const usage = frames.filter(frame => frame.startsWith('\x00__usage__')).at(-1)!
    expect(JSON.parse(usage.slice('\x00__usage__'.length))).toMatchObject({ promptTokens: 40, completionTokens: 216 })
  })

  it('does not reopen the one-shot allowance after a successful tool', async () => {
    const f = fixture(); let n = 0
    f.llm.stream = vi.fn(async function* () { yield ++n === 2 ? tool() : empty() })
    await f.run()
    expect(n).toBe(3)
    expect(f.ctx.tools.execute).toHaveBeenCalledTimes(1)
    expect(f.history.filter(m => m.metadata?.emptyOutputRecovery)).toHaveLength(1)
    expect(f.outcomes.at(-1)?.stopReason).toBe('empty_output')
  })

  it('retains the consumed recovery allowance when the same root is resumed', async () => {
    const f = fixture()
    f.history.push({ id: 'persisted-empty', role: 'assistant', content: '', metadata: {
      rootRunId: 'root', turnId: 'turn', partial: true, status: 'failed', stopReason: 'empty_output', emptyOutputRecovery: true,
    } })
    f.llm.stream = vi.fn(async function* (messages: Message[]) {
      expect(messages.some(m => m.id === 'persisted-empty')).toBe(false)
      yield empty()
    })
    await f.run()
    expect(f.llm.stream).toHaveBeenCalledTimes(1)
    expect(f.outcomes.at(-1)?.stopReason).toBe('empty_output')
  })

  it.each([
    ['nonterminal', { ...empty(), done: false }], ['missing-reason', { ...empty(), finishReason: undefined }],
    ['reasoning-only', { ...empty(), reasoningContent: 'private reasoning' }],
    ['length', { ...empty(), finishReason: 'length' }], ['error', { ...empty(), finishReason: 'error' }],
    ['refusal', { ...empty(), streamDiagnostics: diag('refusal') }],
    ['unknown-block', { ...empty(), streamDiagnostics: diag('end_turn', true) }],
    ['unknown-delta', { ...empty(), streamDiagnostics: { ...diag('end_turn'), deltaTypes: { other: 1 } } }],
  ] as Array<[string, LLMStreamChunk]>)('does not regenerate %s as a completed empty response', async (_name, chunk) => {
    const f = fixture()
    f.llm.stream = vi.fn(async function* () { yield chunk })
    await f.run()
    expect(f.llm.stream).toHaveBeenCalledTimes(1)
    expect(f.history.some(m => m.metadata?.emptyOutputRecovery)).toBe(false)
    expect(f.ctx.tools.execute).not.toHaveBeenCalled()
    expect(f.outcomes.at(-1)?.status).toBe('failed')
  })

  it('observes cancellation before the next dispatch', async () => {
    const f = fixture(), controller = new AbortController(); f.ctx.signal = controller.signal
    f.llm.stream = vi.fn(async function* () { yield empty() })
    await f.run({}, () => { if (f.history.some(m => m.metadata?.emptyOutputRecovery)) controller.abort() })
    expect(f.llm.stream).toHaveBeenCalledTimes(1)
    expect(f.outcomes.at(-1)?.status).toBe('cancelled')
  })

  it('does not dispatch recovery when evidence could not be persisted', async () => {
    const f = fixture(), original = f.ctx.history.append
    f.ctx.history.append = vi.fn(async (message, ctx) => {
      if (message.metadata?.emptyOutputRecovery) throw new Error('fixture disk unavailable')
      return original(message, ctx)
    })
    f.llm.stream = vi.fn(async function* () { yield empty() })
    await f.run()
    expect(f.llm.stream).toHaveBeenCalledTimes(1)
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'failed', error: { code: 'PERSISTENCE_ERROR' } })
  })

  it('keeps physical request spend authoritative', async () => {
    const f = fixture(), budget = new RequestBudget(100_000); f.ctx.requestBudget = budget
    f.ctx.onRequestAttempt = event => { budget.observe(event) }
    f.llm.stream = vi.fn(async function* (_messages, options) {
      await options!.onRequestAttempt!({ type: 'start', requestAttemptId: 'one', provider: 'fixture', model: 'unchanged-model', estimatedInputTokens: options!.requestInputTokenEstimate, maxOutputTokens: options!.maxTokens })
      await options!.onRequestAttempt!({ type: 'finish', requestAttemptId: 'one', provider: 'fixture', model: 'unchanged-model', outcome: 'succeeded', usage: { promptTokens: 99892, completionTokens: 108 } })
      yield { ...empty(), promptTokens: 99892 }
    })
    await f.run()
    expect(f.llm.stream).toHaveBeenCalledTimes(1)
    expect(budget.snapshot).toMatchObject({ charged: 100_000, reserved: 0, remaining: 0 })
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'failed', stopReason: 'budget' })
  })

  it('does not exceed an explicit iteration limit', async () => {
    const f = fixture(); f.llm.stream = vi.fn(async function* () { yield empty() })
    await f.run({ maxIterations: 1 })
    expect(f.llm.stream).toHaveBeenCalledTimes(1)
    expect(f.history.some(m => m.metadata?.emptyOutputRecovery)).toBe(false)
    expect(f.outcomes.at(-1)?.stopReason).toBe('empty_output')
  })

  it('recovers actual Anthropic empty-terminal SSE without changing provider configuration', async () => {
    const f = fixture(), bodies: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(String(init.body)))
      const frames = [{ type: 'message_start', message: { id: 'msg', type: 'message', role: 'assistant', model: 'same-model', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } },
        ...(bodies.length === 1 ? [] : [{ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Recovered answer.' } }, { type: 'content_block_stop', index: 0 }]),
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 108 } }, { type: 'message_stop' }]
      return new Response(frames.map(frame => 'event: ' + frame.type + '\ndata: ' + JSON.stringify(frame) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } })
    }))
    const adapter = new AnthropicAdapter('same-model', 'fixture-key', 'http://fixture.invalid')
    await f.run({ maxOutputTokens: 1024, thinkingEnabled: false }, undefined, adapter)
    expect(bodies).toHaveLength(2)
    expect(bodies.map(body => [body.model, body.max_tokens])).toEqual([['same-model', 1024], ['same-model', 1024]])
    expect(f.history.find(m => m.metadata?.emptyOutputRecovery)?.metadata?.responseDiagnostics).toMatchObject({
      providerStream: { rawStopReason: 'end_turn', blockTypes: {}, eventTypes: { message_start: 1, message_delta: 1, message_stop: 1 } },
    })
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'succeeded', output: 'Recovered answer.' })
  })
})
