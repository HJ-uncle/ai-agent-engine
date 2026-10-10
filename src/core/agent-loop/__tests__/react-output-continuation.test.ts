import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext, Message } from '../../agent-context/index.js'
import type { LLMAdapter, LLMAdapterOptions, LLMStreamChunk } from '../../llm-adapter/types.js'
import { RequestBudget } from '../../subagent/budget.js'
import type { RunOutcome } from '../../subagent/types.js'
import { ReActStrategy, type ReActOptions } from '../react.js'
import { estimateRequestInput } from '../finalization.js'
import { runInNewContext } from 'node:vm'

vi.mock('../../../storage/todo/index.js', () => ({ TodoStore: class { async list() { return [] } } }))
afterEach(() => vi.unstubAllEnvs())

function fixture() {
  const history: Message[] = []
  const outcomes: RunOutcome[] = []
  const ctx = {
    tenantId: 'tenant', sessionId: 'session', rootRunId: 'root', turnId: 'turn',
    userMessageId: 'user', assistantMessageId: 'assistant', workspaceDir: '.',
    modelCaps: { contextWindow: 100_000 }, toolProfile: 'code',
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    history: {
      append: vi.fn(async (message: Message) => {
        if (!history.some(existing => existing.id === message.id)) history.push(message)
        return message.id!
      }),
      getHistory: vi.fn(async () => [...history]), getFullHistory: vi.fn(async () => [...history]),
      microCompactToolResults: vi.fn(async () => ({ cleared: 0, freedTokens: 0 })),
      compress: vi.fn(async () => ({ preTokens: 0, postTokens: 0 })),
    },
    tools: {
      list: () => [], has: () => true, executionMode: () => 'serial',
      execute: vi.fn(async () => ({ success: true, output: 'file saved' })),
    },
    runObserver: {
      onOutput: vi.fn(), onUsage: vi.fn(),
      onOutcome: vi.fn(async (outcome: RunOutcome) => { outcomes.push(outcome) }),
    },
  } as unknown as AgentContext
  const llm: LLMAdapter = {
    model: 'model', provider: 'test', complete: vi.fn(), countTokens: () => 0,
    stream: vi.fn(async function* () { yield { done: true, content: 'done' } }),
  }
  async function run(options: ReActOptions = {}, onFrame?: (frame: string) => void) {
    const frames: string[] = []
    for await (const frame of new ReActStrategy(llm, options).run('Implement and verify the approved project.', ctx)) {
      frames.push(frame)
      onFrame?.(frame)
    }
    return frames
  }
  return { history, outcomes, ctx, llm, run }
}
const body = (frames: string[]) => frames.filter(frame => !frame.startsWith('\x00__')).join('')
const usage = (frames: string[]) => frames.filter(frame => frame.startsWith('\x00__usage__'))
  .map(frame => JSON.parse(frame.slice('\x00__usage__'.length)))

describe('single-response output limit continuation', () => {
  it('continues retained partial output and records each provider request exactly once', async () => {
    const f = fixture()
    f.ctx.inheritContext = false
    let calls = 0
    f.llm.stream = vi.fn(async function* (messages: Message[], options?: LLMAdapterOptions) {
      expect(options!.requestInputTokenEstimate).toBe(estimateRequestInput(messages, options!.systemPrompt, options!.tools!))
      if (++calls === 1) yield { done: true, content: 'First part; ', reasoningContent: 'first reasoning',
        finishReason: 'length' as const, promptTokens: 20, completionTokens: 10 }
      else {
        expect(messages.at(-1)).toMatchObject({ role: 'user', content: expect.stringContaining('starting exactly where the response stopped') })
        expect(messages.filter(message => message.role === 'assistant').map(message => message.content)).toEqual(['First part; '])
        yield { done: true, content: 'remaining work complete.', promptTokens: 40, completionTokens: 15 }
      }
    })
    const frames = await f.run()
    expect(body(frames)).toBe('First part; remaining work complete.')
    expect(f.outcomes).toEqual([{ status: 'succeeded', output: body(frames), stopReason: 'completed' }])
    expect(f.ctx.runObserver!.onOutput).toHaveBeenLastCalledWith(body(frames))
    const assistants = f.history.filter(message => message.role === 'assistant')
    expect(assistants).toHaveLength(2)
    expect(assistants[0]).toMatchObject({ conversationId: 'turn', content: 'First part; ',
      metadata: { outputContinuation: true, continuationIndex: 1 }, usage: { promptTokens: 20, completionTokens: 10 } })
    expect(assistants[1]).toMatchObject({ id: 'assistant', conversationId: 'turn', content: 'remaining work complete.',
      usage: { promptTokens: 40, completionTokens: 15 } })
    expect(new Set(assistants.map(message => message.id)).size).toBe(2)
    expect(usage(frames).at(-1)).toMatchObject({ promptTokens: 60, completionTokens: 25, totalTokens: 85 })
    expect(f.ctx.runObserver!.onUsage).toHaveBeenCalledTimes(2)
    expect(f.history.filter(message => message.role === 'user')).toHaveLength(1)
  })

  it('allows sustained progress without imposing a continuation count limit', async () => {
    const f = fixture()
    let calls = 0
    f.llm.stream = vi.fn(async function* () {
      calls++
      yield { done: true, content: `checkpoint-${calls};`, finishReason: calls <= 12 ? 'length' as const : 'stop' as const }
    })
    const frames = await f.run()
    expect(f.llm.stream).toHaveBeenCalledTimes(13)
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'succeeded', output: body(frames) })
    expect(f.history.filter(message => message.role === 'assistant')).toHaveLength(13)
  })

  it('stops genuinely unchanged length continuations without executing tools', async () => {
    const f = fixture()
    f.llm.stream = vi.fn(async function* () { yield { done: true, content: 'same unfinished output', finishReason: 'length' as const } })
    await f.run()
    expect(f.llm.stream).toHaveBeenCalledTimes(2)
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'failed', stopReason: 'output_limit', error: { code: 'OUTPUT_LIMIT' } })
    expect(f.ctx.tools.execute).not.toHaveBeenCalled()
  })

  it('treats an unchanged repeated body with different whitespace as no progress', async () => {
    const f = fixture()
    let calls = 0
    f.llm.stream = vi.fn(async function* () {
      yield { done: true, content: ++calls === 1 ? 'unchanged prefix and body' : '\nunchanged  prefix\nand body\n', finishReason: 'length' as const }
    })
    await f.run()
    expect(f.llm.stream).toHaveBeenCalledTimes(2)
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'failed', stopReason: 'output_limit' })
  })

  it.each([
    { format: 'JSON', segments: ['{"items":[{"name":"a', '\\"b","count":43}],', '"ok":true}'],
      evaluate: (content: string) => JSON.parse(content), expected: { items: [{ name: 'a"b', count: 43 }], ok: true } },
    { format: 'JavaScript', segments: ['function compute() { ret', 'urn 6 * 7; }\n', 'compute()'],
      evaluate: (content: string) => runInNewContext(content), expected: 42 },
  ])('preserves a parseable $format response across output boundaries without inserting separators', async ({ segments, evaluate, expected }) => {
    const f = fixture()
    let calls = 0
    f.llm.stream = vi.fn(async function* () {
      const content = segments[calls++]
      yield { done: true, content, finishReason: calls < segments.length ? 'length' as const : 'stop' as const }
    })
    const frames = await f.run()
    const persisted = f.history.filter(message => message.role === 'assistant').map(message => message.content).join('')
    expect(body(frames)).toBe(segments.join(''))
    expect(evaluate(body(frames))).toEqual(expected)
    expect(evaluate(persisted)).toEqual(expected)
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'succeeded', output: persisted })
  })

  it('does not retry a reasoning-only response that used all output capacity', async () => {
    const f = fixture()
    f.llm.stream = vi.fn(async function* () { yield { done: true, reasoningContent: 'unfinished reasoning', finishReason: 'length' as const } })
    await f.run()
    expect(f.llm.stream).toHaveBeenCalledTimes(1)
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'failed', stopReason: 'output_limit' })
  })

  it('preserves all emitted evidence when cancellation occurs in a continuation request', async () => {
    const f = fixture()
    const controller = new AbortController()
    f.ctx.signal = controller.signal
    let calls = 0
    f.llm.stream = vi.fn(async function* () {
      if (++calls === 1) yield { done: true, content: 'saved first part; ', finishReason: 'length' as const }
      else { yield { done: false, content: 'partial second part' }; controller.abort() }
    })
    const frames = await f.run()
    expect(f.outcomes).toEqual([{ status: 'cancelled', stopReason: 'cancelled', partialOutput: body(frames) }])
    expect(f.history.filter(message => message.role === 'assistant').map(message => message.content).join('')).toBe(body(frames))
    expect(f.history.find(message => message.id === 'assistant')).toMatchObject({ metadata: { status: 'cancelled' } })
  })

  it('honors cancellation between requests without dispatching another continuation', async () => {
    const f = fixture()
    const controller = new AbortController()
    f.ctx.signal = controller.signal
    f.llm.stream = vi.fn(async function* () { yield { done: true, content: 'saved first part', finishReason: 'length' as const } })
    const frames = await f.run({}, frame => { if (frame.startsWith('\x00__usage__')) controller.abort() })
    expect(f.llm.stream).toHaveBeenCalledTimes(1)
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'cancelled', partialOutput: body(frames) })
  })

  it('preserves earlier continuation segments when the provider fails before new output', async () => {
    const f = fixture()
    let calls = 0
    f.llm.stream = vi.fn(async function* () {
      if (++calls === 1) yield { done: true, content: 'retained evidence', finishReason: 'length' as const }
      else throw new Error('provider disconnected')
    })
    await f.run()
    expect(f.llm.stream).toHaveBeenCalledTimes(2)
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'failed', stopReason: 'provider_error', partialOutput: 'retained evidence' })
    expect(f.history.filter(message => message.role === 'assistant')).toHaveLength(1)
  })

  it('does not exceed an explicitly configured physical request budget while continuing', async () => {
    const f = fixture()
    const budget = new RequestBudget(100_000)
    f.ctx.requestBudget = budget
    f.ctx.onRequestAttempt = event => { budget.observe(event) }
    let calls = 0
    f.llm.stream = vi.fn(async function* (_messages, options) {
      const id = 'request-' + ++calls
      await options!.onRequestAttempt!({ type: 'start', requestAttemptId: id, provider: 'test', model: 'model',
        estimatedInputTokens: options!.requestInputTokenEstimate, maxOutputTokens: options!.maxTokens })
      await options!.onRequestAttempt!({ type: 'finish', requestAttemptId: id, provider: 'test', model: 'model',
        outcome: 'succeeded', usage: { promptTokens: 99_000, completionTokens: 1_000 } })
      yield { done: true, content: 'completed evidence', finishReason: 'length' as const, promptTokens: 99_000, completionTokens: 1_000 }
    })
    await f.run()
    expect(f.llm.stream).toHaveBeenCalledTimes(2)
    expect(budget.snapshot).toMatchObject({ charged: 100_000, reserved: 0, remaining: 0 })
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'failed', stopReason: 'budget', partialOutput: 'completed evidence',
      error: { code: 'TOKEN_BUDGET_EXCEEDED' } })
    expect(f.history.filter(message => message.role === 'assistant')).toHaveLength(1)
  })

  it('rechecks context admission and compacts before the continuation request', async () => {
    const f = fixture()
    f.ctx.modelCaps = { contextWindow: 6_000 }
    const firstPart = 'checkpoint '.repeat(3_000) + 'FINAL_ANCHOR=43'
    f.ctx.history.compress = vi.fn(async () => {
      f.history.splice(0, f.history.length, { id: 'summary', role: 'system',
        content: 'Approved project requires FINAL_ANCHOR=43. First response was interrupted by output capacity.' })
      return { preTokens: 10_000, postTokens: 100 }
    })
    let calls = 0
    f.llm.stream = vi.fn(async function* (messages, options) {
      expect(options!.requestInputTokenEstimate! + options!.maxTokens!).toBe(6_000)
      if (++calls === 1) yield { done: true, content: firstPart, finishReason: 'length' as const }
      else {
        expect(messages[0].content).toContain('FINAL_ANCHOR=43')
        expect(messages.at(-2)).toMatchObject({ role: 'assistant', content: expect.stringContaining('FINAL_ANCHOR=43') })
        expect(String(messages.at(-2)!.content).length).toBeLessThanOrEqual(2048)
        yield { done: true, content: '; finished verification.' }
      }
    })
    const frames = await f.run()
    expect(f.ctx.history.compress).toHaveBeenCalledTimes(1)
    expect(f.llm.stream).toHaveBeenCalledTimes(2)
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'succeeded', output: body(frames) })
  })

  it('does not execute or resubmit tool calls cut off by an output limit', async () => {
    const f = fixture()
    f.llm.stream = vi.fn(async function* () {
      yield { done: true, content: 'attempted write', finishReason: 'length' as const,
        toolCalls: [{ id: 'incomplete-write', name: 'write_file', args: '{"path":"', index: 0 }] }
    })
    const frames = await f.run()
    expect(f.llm.stream).toHaveBeenCalledTimes(1)
    expect(f.ctx.tools.execute).not.toHaveBeenCalled()
    expect(frames.filter(frame => frame.startsWith('\x00__tool_result__'))).toHaveLength(1)
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'failed', stopReason: 'output_limit' })
  })

  it('can call remaining tools after a continuation without repeating previous response text', async () => {
    const f = fixture()
    let calls = 0
    f.llm.stream = vi.fn(async function* () {
      if (++calls === 1) yield { done: true, content: 'remaining work: ', finishReason: 'length' as const }
      else if (calls === 2) yield { done: true, content: 'verify once; ',
        toolCalls: [{ id: 'verify', name: 'read_file', args: '{"path":"result.ts"}', index: 0 }] }
      else yield { done: true, content: 'verified.' }
    })
    const frames = await f.run()
    expect(body(frames)).toBe('remaining work: verify once; verified.')
    expect(f.ctx.tools.execute).toHaveBeenCalledTimes(1)
    expect(f.history.filter(message => message.role === 'assistant').map(message => message.content).join('')).toBe(body(frames))
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'succeeded', output: body(frames) })
  })

  it('respects explicit step limits and the reserved finalization iteration', async () => {
    const f = fixture()
    f.llm.stream = vi.fn(async function* () { yield { done: true, content: 'partial answer', finishReason: 'length' as const } })
    await f.run({ maxIterations: 1 })
    expect(f.llm.stream).toHaveBeenCalledTimes(1)
    expect(f.outcomes.at(-1)).toMatchObject({ status: 'failed', stopReason: 'output_limit' })
    const reserved = fixture()
    reserved.llm.stream = vi.fn(async function* (_messages: Message[], options?: LLMAdapterOptions): AsyncGenerator<LLMStreamChunk> {
      yield { done: true, content: options?.systemPrompt ? 'final partial answer' : 'first partial answer', finishReason: 'length' as const }
    })
    await reserved.run({ maxIterations: 2, finalizeOnLimit: true })
    expect(reserved.llm.stream).toHaveBeenCalledTimes(2)
    expect(reserved.outcomes.at(-1)).toMatchObject({ status: 'failed', stopReason: 'output_limit' })
  })
})
