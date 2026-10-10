/** Real SDK SSE regression: compatible gateways may correct input/cache in message_delta. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AnthropicAdapter } from '../anthropic.js'
import type { LLMRequestAttemptEvent, LLMStreamChunk } from '../types.js'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

type Usage = Record<string, unknown>
type Frame = Record<string, unknown>
const model = 'deepseek-v4.1-flash'

function start(usage: Usage): Frame {
  return { type: 'message_start', message: { id: 'usage-fixture', type: 'message', role: 'assistant', model,
    content: [], stop_reason: null, stop_sequence: null, usage } }
}

function delta(usage: Usage): Frame {
  return { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage }
}

function output(): Frame[] {
  return [
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'fixture response' } },
    { type: 'content_block_stop', index: 0 },
  ]
}

async function consume(frames: Frame[]) {
  const body = frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join('')
  const fetchMock = vi.fn(async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }))
  vi.stubGlobal('fetch', fetchMock)
  // Token-header fetch path uses the real Anthropic SDK and the controlled global transport.
  const adapter = new AnthropicAdapter(model, 'fixture-key', 'http://model.invalid', { 'X-Access-Token': 'fixture-token' })
  const attempts: LLMRequestAttemptEvent[] = []
  const chunks: LLMStreamChunk[] = []
  let failure: unknown
  try {
    for await (const chunk of adapter.stream([{ role: 'user', content: 'fixture request' }], {
      model, maxTokens: 256, thinkingEnabled: false,
      onRequestAttempt: event => { attempts.push(event) },
    })) chunks.push(chunk)
  } catch (error) { failure = error }
  expect(fetchMock).toHaveBeenCalledTimes(1)
  const finish = attempts.filter(event => event.type === 'finish').at(-1)
  return { chunks, finish, failure, terminal: chunks.filter(chunk => chunk.done).at(-1) }
}

describe('Anthropic SDK stream usage corrections', () => {
  it.each([[5081, 6390], [40081, 50273]])('uses final corrected input %i → %i in billing and context', async (initial, corrected) => {
    const { chunks, finish, terminal, failure } = await consume([
      start({ input_tokens: initial, output_tokens: 0 }), ...output(),
      delta({ input_tokens: corrected, output_tokens: 128 }), { type: 'message_stop' },
    ])
    expect(failure).toBeUndefined()
    expect(chunks.find(chunk => !chunk.done && chunk.promptTokens !== undefined)).toMatchObject({ promptTokens: initial, completionTokens: 0 })
    expect(chunks.some(chunk => !chunk.done && chunk.promptTokens === corrected)).toBe(true)
    expect(terminal).toMatchObject({ promptTokens: corrected, completionTokens: 128, finishReason: 'stop' })
    expect(finish).toMatchObject({ outcome: 'succeeded', usage: { promptTokens: corrected, completionTokens: 128 } })
    expect(chunks.map(chunk => chunk.content ?? '').join('')).toBe('fixture response')
  })

  it('keeps native input and cache counts when the final delta reports only output', async () => {
    const { terminal, finish, failure } = await consume([
      start({ input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 200, cache_creation_input_tokens: 30 }),
      ...output(), delta({ output_tokens: 20 }), { type: 'message_stop' },
    ])
    expect(failure).toBeUndefined()
    expect(terminal).toMatchObject({ promptTokens: 330, completionTokens: 20, cacheHitTokens: 200, cacheMissTokens: 30 })
    expect(finish).toMatchObject({ usage: { promptTokens: 330, completionTokens: 20, cacheHitTokens: 200, cacheMissTokens: 30 } })
  })

  it('does not invent output usage before the provider reports it', async () => {
    const { chunks, terminal, finish, failure } = await consume([
      start({ input_tokens: 80 }), ...output(), delta({ output_tokens: 9 }), { type: 'message_stop' },
    ])
    expect(failure).toBeUndefined()
    const firstReported = chunks.find(chunk => chunk.promptTokens !== undefined)
    expect(firstReported).toMatchObject({ promptTokens: 80 })
    expect(firstReported).not.toHaveProperty('completionTokens')
    expect(terminal).toMatchObject({ promptTokens: 80, completionTokens: 9 })
    expect(finish).toMatchObject({ usage: { promptTokens: 80, completionTokens: 9 } })
  })

  it('keeps unknown input absent from client chunks and marks an output-only ledger unknown', async () => {
    const { chunks, terminal, finish, failure } = await consume([
      start({ output_tokens: 0 }), ...output(), delta({ output_tokens: 9 }), { type: 'message_stop' },
    ])
    expect(failure).toBeUndefined()
    expect(chunks.filter(chunk => chunk.promptTokens !== undefined)).toHaveLength(0)
    expect(terminal).not.toHaveProperty('promptTokens')
    expect(terminal).toMatchObject({ completionTokens: 9 })
    expect(finish).toMatchObject({ usage: { completionTokens: 9, unknown: true } })
  })

  it('records known additive cache tokens as a lower bound when uncached input is missing', async () => {
    const { chunks, terminal, finish, failure } = await consume([
      start({ cache_read_input_tokens: 200, cache_creation_input_tokens: 30 }),
      ...output(), delta({ output_tokens: 9 }), { type: 'message_stop' },
    ])
    expect(failure).toBeUndefined()
    expect(chunks.filter(chunk => chunk.promptTokens !== undefined)).toHaveLength(0)
    expect(terminal).not.toHaveProperty('promptTokens')
    expect(terminal).toMatchObject({ completionTokens: 9, cacheHitTokens: 200, cacheMissTokens: 30 })
    expect(finish).toMatchObject({ usage: { promptTokens: 230, completionTokens: 9,
      cacheHitTokens: 200, cacheMissTokens: 30, unknown: true } })
  })

  it('recomputes input when cache read/creation are corrected without a new input_tokens field', async () => {
    const { terminal, finish, failure } = await consume([
      start({ input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 200, cache_creation_input_tokens: 30 }),
      ...output(), delta({ cache_read_input_tokens: 400, cache_creation_input_tokens: 40, output_tokens: 20 }),
      { type: 'message_stop' },
    ])
    expect(failure).toBeUndefined()
    expect(terminal).toMatchObject({ promptTokens: 540, completionTokens: 20, cacheHitTokens: 400, cacheMissTokens: 40 })
    expect(finish).toMatchObject({ usage: { promptTokens: 540, completionTokens: 20, cacheHitTokens: 400, cacheMissTokens: 40 } })
  })

  it('preserves fields absent from later sparse snapshots and never adds repeated snapshots', async () => {
    const { terminal, finish, failure } = await consume([
      start({ input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 200, cache_creation_input_tokens: 30 }),
      ...output(), delta({ input_tokens: 150, output_tokens: 10 }),
      delta({ input_tokens: 150, output_tokens: 10 }), delta({ output_tokens: 20 }),
      { type: 'message_stop' },
    ])
    expect(failure).toBeUndefined()
    expect(terminal).toMatchObject({ promptTokens: 380, completionTokens: 20, cacheHitTokens: 200, cacheMissTokens: 30 })
    expect(finish).toMatchObject({ usage: { promptTokens: 380, completionTokens: 20, cacheHitTokens: 200, cacheMissTokens: 30 } })
  })

  it('honors explicit zero for input, output, cache reads and cache creation', async () => {
    const { terminal, finish, failure } = await consume([
      start({ input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 200, cache_creation_input_tokens: 30 }),
      ...output(), delta({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
      { type: 'message_stop' },
    ])
    expect(failure).toBeUndefined()
    expect(terminal).toMatchObject({ promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 })
    expect(finish).toMatchObject({ usage: { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 } })
  })

  it('ignores invalid numeric patches while retaining the last reported counters', async () => {
    const { terminal, finish, failure } = await consume([
      start({ input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 200, cache_creation_input_tokens: 30 }),
      ...output(), delta({ output_tokens: 20 }),
      delta({ input_tokens: -1, output_tokens: '999', cache_read_input_tokens: null, cache_creation_input_tokens: -2 }),
      { type: 'message_stop' },
    ])
    expect(failure).toBeUndefined()
    expect(terminal).toMatchObject({ promptTokens: 330, completionTokens: 20, cacheHitTokens: 200, cacheMissTokens: 30 })
    expect(finish).toMatchObject({ usage: { promptTokens: 330, completionTokens: 20, cacheHitTokens: 200, cacheMissTokens: 30 } })
  })

  it('retains reported input when cancelled after the usage frame and before visible output', async () => {
    let bodyController!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller
        const frame = start({ input_tokens: 80, output_tokens: 0 })
        // SDK 0.20's line decoder retains the last newline until another line arrives.
        // A heartbeat flushes message_start without introducing any visible output.
        controller.enqueue(new TextEncoder().encode(`event: message_start\ndata: ${JSON.stringify(frame)}\n\nevent: ping\ndata: {"type":"ping"}\n\n`))
      },
    })
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      init?.signal?.addEventListener('abort', () => bodyController.error(init.signal?.reason), { once: true })
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const adapter = new AnthropicAdapter(model, 'fixture-key', 'http://model.invalid', { 'X-Access-Token': 'fixture-token' })
    const attempts: LLMRequestAttemptEvent[] = []
    const controller = new AbortController()
    const iterator = adapter.stream([{ role: 'user', content: 'fixture request' }], {
      model, maxTokens: 256, thinkingEnabled: false, signal: controller.signal,
      onRequestAttempt: event => { attempts.push(event) },
    })[Symbol.asyncIterator]()
    const first = await iterator.next()
    expect(first.value).toMatchObject({ done: false, promptTokens: 80, completionTokens: 0 })
    expect(first.value).not.toHaveProperty('content')
    controller.abort()
    await expect(iterator.next()).rejects.toThrow()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(attempts.filter(event => event.type === 'finish').at(-1)).toMatchObject({
      outcome: 'cancelled', usage: { promptTokens: 80, completionTokens: 0 },
    })
  })

  it('emits corrected reported usage before an incomplete stream fails so partial billing remains recoverable', async () => {
    const { chunks, finish, terminal, failure } = await consume([
      start({ input_tokens: 5081, output_tokens: 0 }), ...output(),
      delta({ input_tokens: 6390, output_tokens: 128 }),
      // Missing message_stop simulates a connection closing after its last usage report.
    ])
    expect(failure).toMatchObject({ code: 'INCOMPLETE_STREAM' })
    expect(terminal).toBeUndefined()
    expect(chunks.some(chunk => chunk.promptTokens === 6390 && chunk.completionTokens === 128)).toBe(true)
    expect(finish).toMatchObject({ outcome: 'failed', usage: { promptTokens: 6390, completionTokens: 128 } })
  })
})
