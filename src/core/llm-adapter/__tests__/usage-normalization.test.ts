import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAIAdapter } from '../openai.js'
import { QwenAdapter } from '../qwen.js'
import { openAIUsageSnapshot, openAIUsageFromSnapshot } from '../request-attempt.js'
import type { LLMRequestAttemptEvent, LLMStreamChunk } from '../types.js'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

const messages = [{ role: 'user' as const, content: 'Inspect the development workspace' }]
const models = ['qwen3.8-flash', 'MiniMax-M2.5', 'glm-5.3', 'kimi-k2.6']
const adapterFor = (model: string) => model.startsWith('qwen')
  ? new QwenAdapter(model, 'fixture-key', 'http://model.invalid')
  : new OpenAIAdapter(model, 'fixture-key', 'http://model.invalid')
const streamResponse = (frames: unknown[]) => new Response(
  frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n',
  { headers: { 'content-type': 'text/event-stream' } },
)

describe('compatible provider usage normalization', () => {
  it.each(models)('uses input/output aliases consistently for %s complete results and attempt billing', async model => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      id: 'fixture-answer', model,
      choices: [{ message: { role: 'assistant', content: 'complete' }, finish_reason: 'stop' }],
      usage: { input_tokens: 12_000, output_tokens: 5, prompt_tokens_details: { cached_tokens: 9_000 },
        completion_tokens_details: { reasoning_tokens: 2 } },
    }), { headers: { 'content-type': 'application/json' } })))
    const events: LLMRequestAttemptEvent[] = []
    const result = await adapterFor(model).complete(messages, { model, onRequestAttempt: event => { events.push(event) } })
    const expected = { promptTokens: 12_000, completionTokens: 5, cacheHitTokens: 9_000,
      cacheMissTokens: 3_000, reasoningTokens: 2 }
    expect(result).toMatchObject(expected)
    expect(events.at(-1)).toMatchObject({ type: 'finish', outcome: 'succeeded', usage: expected })
    expect((events.at(-1) as { usage?: { unknown?: boolean } }).usage?.unknown).not.toBe(true)
  })

  it.each(models)('retains cumulative input and cache fields across partial %s stream usage patches', async model => {
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse([
      { id: 'm', model, choices: [{ index: 0, delta: { content: 'inspect ' }, finish_reason: null }],
        usage: { input_tokens: 12_000, output_tokens: 0, prompt_tokens_details: { cached_tokens: 9_000 } } },
      { id: 'm', choices: [{ index: 0, delta: { content: 'then complete' }, finish_reason: null }],
        usage: { completion_tokens: 3, reasoning_tokens: 2 } },
      { id: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { output_tokens: 5, prompt_tokens_details: {} } },
    ])))
    const events: LLMRequestAttemptEvent[] = []
    const chunks: LLMStreamChunk[] = []
    for await (const chunk of adapterFor(model).stream(messages, { model, onRequestAttempt: event => { events.push(event) } })) chunks.push(chunk)
    const expected = { promptTokens: 12_000, completionTokens: 5, cacheHitTokens: 9_000,
      cacheMissTokens: 3_000, reasoningTokens: 2 }
    expect(chunks.at(-1)).toMatchObject({ done: true, finishReason: 'stop', ...expected })
    expect(events.at(-1)).toMatchObject({ type: 'finish', outcome: 'succeeded', usage: expected })
    expect((events.at(-1) as { usage?: { unknown?: boolean } }).usage?.unknown).not.toBe(true)
    expect(chunks.filter(chunk => chunk.content).map(chunk => chunk.content).join('')).toBe('inspect then complete')
  })

  it('does not add repeated cumulative snapshots or treat an explicit zero as missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse([
      { id: 'm', choices: [{ index: 0, delta: { content: 'done' }, finish_reason: null }],
        usage: { prompt_tokens: 10, completion_tokens: 3, prompt_cache_hit_tokens: 6 } },
      { id: 'm', choices: [{ index: 0, delta: {}, finish_reason: null }],
        usage: { prompt_tokens: 10, completion_tokens: 3 } },
      { id: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { completion_tokens: 0 } },
    ])))
    const events: LLMRequestAttemptEvent[] = []
    const chunks: LLMStreamChunk[] = []
    for await (const chunk of adapterFor('kimi-k2.6').stream(messages, { model: 'kimi-k2.6', onRequestAttempt: event => { events.push(event) } })) chunks.push(chunk)
    const expected = { promptTokens: 10, completionTokens: 0, cacheHitTokens: 6, cacheMissTokens: 4 }
    expect(chunks.at(-1)).toMatchObject(expected)
    expect(events.at(-1)).toMatchObject({ usage: expected })
  })

  it('keeps upstream usage unknown when every stream frame omits it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse([
      { id: 'm', choices: [{ index: 0, delta: { content: 'done' }, finish_reason: null }] },
      { id: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: null },
    ])))
    const events: LLMRequestAttemptEvent[] = []
    const chunks: LLMStreamChunk[] = []
    for await (const chunk of adapterFor('glm-5.3').stream(messages, { model: 'glm-5.3', onRequestAttempt: event => { events.push(event) } })) chunks.push(chunk)
    expect(events.at(-1)).toMatchObject({ type: 'finish', outcome: 'succeeded' })
    expect(events.at(-1)).not.toHaveProperty('usage')
    expect(chunks.at(-1)).not.toHaveProperty('promptTokens')
    expect(chunks.at(-1)).not.toHaveProperty('completionTokens')
  })

  it.each([
    { raw: { input_tokens: 12_000 }, observed: 'promptTokens', absent: 'completionTokens', value: 12_000 },
    { raw: { output_tokens: 0 }, observed: 'completionTokens', absent: 'promptTokens', value: 0 },
  ])('omits unreported stream counters instead of publishing fake zero: $observed', async ({ raw, observed, absent, value }) => {
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse([
      { id: 'm', choices: [{ index: 0, delta: { content: 'done' }, finish_reason: null }], usage: raw },
      { id: 'm', choices: [], usage: raw },
      { id: 'm', choices: [], usage: raw },
      { id: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ])))
    const events: LLMRequestAttemptEvent[] = []
    const chunks: LLMStreamChunk[] = []
    for await (const chunk of adapterFor('glm-5.3').stream(messages,
      { model: 'glm-5.3', onRequestAttempt: event => { events.push(event) } })) chunks.push(chunk)
    const metered = chunks.filter(chunk => observed in chunk)
    expect(metered).toHaveLength(4)
    for (const chunk of metered) {
      expect(chunk).toHaveProperty(observed, value)
      expect(chunk).not.toHaveProperty(absent)
    }
    expect(events.at(-1)).toMatchObject({ usage: { [observed]: value, [absent]: 0, unknown: true } })
  })

  it('preserves a reported cache miss counter across output-only patches', () => {
    const previous = openAIUsageSnapshot({ prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 60,
      prompt_cache_miss_tokens: 7 })
    expect(openAIUsageFromSnapshot(openAIUsageSnapshot({ output_tokens: 10 }, previous))).toEqual({ promptTokens: 100, completionTokens: 10,
      cacheHitTokens: 60, cacheMissTokens: 7 })
  })

  it.each([
    { first: { input_tokens: 120 }, missing: 'completionTokens', other: { output_tokens: 0 } },
    { first: { output_tokens: 0 }, missing: 'promptTokens', other: { input_tokens: 120 } },
  ])('retains unknown status across repeated sparse frames until $missing is reported', ({ first, missing, other }) => {
    const firstSnapshot = openAIUsageSnapshot(first)
    expect(firstSnapshot).not.toHaveProperty(missing)
    expect(openAIUsageFromSnapshot(firstSnapshot)).toMatchObject({ unknown: true })
    const repeated = openAIUsageSnapshot(first, firstSnapshot)
    expect(repeated).not.toHaveProperty(missing)
    expect(openAIUsageFromSnapshot(repeated)).toMatchObject({ unknown: true })
    const complete = openAIUsageFromSnapshot(openAIUsageSnapshot(other, repeated))
    expect(complete).toEqual({ promptTokens: 120, completionTokens: 0 })
  })

  it('publishes already reported usage before an incomplete stream fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse([
      { id: 'm', choices: [{ index: 0, delta: { content: 'partial evidence' }, finish_reason: null }],
        usage: { input_tokens: 12_000, output_tokens: 2, cache_hit_tokens: 9_000 } },
      { id: 'm', choices: [], usage: { output_tokens: 3 } },
    ])))
    const events: LLMRequestAttemptEvent[] = []
    const chunks: LLMStreamChunk[] = []
    const consume = async () => {
      for await (const chunk of adapterFor('MiniMax-M2.5').stream(messages,
        { model: 'MiniMax-M2.5', onRequestAttempt: event => { events.push(event) } })) chunks.push(chunk)
    }
    await expect(consume()).rejects.toMatchObject({ code: 'INCOMPLETE_STREAM' })
    const expected = { promptTokens: 12_000, completionTokens: 3, cacheHitTokens: 9_000, cacheMissTokens: 3_000 }
    expect(chunks.filter(chunk => chunk.promptTokens !== undefined).at(-1)).toMatchObject({ done: false, ...expected })
    expect(chunks.some(chunk => chunk.done)).toBe(false)
    expect(events.at(-1)).toMatchObject({ type: 'finish', outcome: 'failed', usage: expected })
  })
})
