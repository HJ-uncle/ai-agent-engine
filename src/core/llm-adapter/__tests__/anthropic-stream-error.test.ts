/** Real Anthropic SDK and controlled fetch: bounded, lossless gateway error diagnostics. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BadRequestError, APIConnectionError, APIUserAbortError } from '@anthropic-ai/sdk'
import { createHash } from 'node:crypto'
import { AnthropicAdapter } from '../anthropic.js'
import { AnthropicStreamError, preserveAnthropicStreamErrors } from '../anthropic-stream-error.js'
import type { LLMRequestAttemptEvent, LLMStreamChunk } from '../types.js'

afterEach(() => vi.unstubAllGlobals())
const frame = (type: string, value: unknown) => `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`
const start = frame('message_start', { type: 'message_start', message: {
  id: 'response-1', type: 'message', role: 'assistant', model: 'qwen3.8-flash', content: [],
  stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 0 },
} })
const text = (value: string) => frame('content_block_start', { type: 'content_block_start', index: 0,
  content_block: { type: 'text', text: value } }) + frame('content_block_stop', { type: 'content_block_stop', index: 0 })
const terminal = frame('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 7 } })
  + frame('message_stop', { type: 'message_stop' })
const failure = (type: string, message: string) => frame('error', { type: 'error', error: { type, message } })
function response(wire: string, fragmentBytes?: number) {
  if (!fragmentBytes) return new Response(wire, { headers: { 'content-type': 'text/event-stream' } })
  const bytes = new TextEncoder().encode(wire)
  let offset = 0
  return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
    if (offset >= bytes.length) { controller.close(); return }
    controller.enqueue(bytes.slice(offset, offset + fragmentBytes)); offset += fragmentBytes
  } }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } })
}
async function consume(wire: string, chunks: LLMStreamChunk[] = [], fragmentBytes?: number, attempts: LLMRequestAttemptEvent[] = []) {
  const fetchMock = vi.fn(async () => response(wire, fragmentBytes))
  vi.stubGlobal('fetch', fetchMock)
  const adapter = new AnthropicAdapter('qwen3.8-flash', 'fixture-key', 'http://fixture.invalid/anthropic', { 'X-Access-Token': 'fixture-token' })
  for await (const chunk of adapter.stream([{ role: 'user', content: 'synthetic test' }], { model: adapter.model,
    onRequestAttempt: event => { attempts.push(event) } })) chunks.push(chunk)
  return fetchMock
}

describe('Anthropic SSE gateway errors', () => {
  it('preserves allowlisted type/message and classification without enabling retries', async () => {
    const chunks: LLMStreamChunk[] = [], attempts: LLMRequestAttemptEvent[] = []
    await expect(consume(start + failure('overloaded_error', 'Overloaded'), chunks, undefined, attempts)).rejects.toMatchObject({
      name: 'AnthropicStreamError', code: 'PROVIDER_STREAM_ERROR', source: 'anthropic_sse_error',
      providerErrorType: 'overloaded_error', providerMessage: 'overloaded', classification: 'transient', retryable: false,
    })
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1)
    expect(chunks.some(chunk => chunk.done)).toBe(false)
    expect(chunks[0]).toMatchObject({ promptTokens: 12, completionTokens: 0, done: false })
    expect(attempts).toHaveLength(2)
    expect(attempts[1]).toMatchObject({ type: 'finish', outcome: 'failed', usage: { promptTokens: 12, completionTokens: 0 } })
    expect(attempts[1].requestAttemptId).toBe(attempts[0].requestAttemptId)
  })

  it.each([
    ['rate_limit_error', 'transient'], ['invalid_request_error', 'request'],
    ['authentication_error', 'authentication'], ['billing_error', 'quota'],
  ])('classifies %s independently of the SDK connection-error label', async (type, classification) => {
    await expect(consume(failure(type, 'synthetic payload'))).rejects.toMatchObject({ providerErrorType: type, classification, retryable: false })
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1)
  })

  it('does not retain quoted credentials, prompts, paths, unknown fields or raw causes', async () => {
    const privateMessage = 'fixture-token fixture-key Authorization: Bearer private-token synthetic-business-marker C:/private/data'
    let observed: unknown
    try { await consume(failure('api_error', privateMessage)) } catch (error) { observed = error }
    expect(observed).toBeInstanceOf(AnthropicStreamError)
    expect(observed).toMatchObject({ providerErrorType: 'api_error', providerMessage: '[provider message redacted]',
      providerMessageLength: privateMessage.length, providerMessageSha256: createHash('sha256').update(privateMessage).digest('hex') })
    const serialized = JSON.stringify(observed) + (observed as Error).stack
    for (const value of ['fixture-token', 'fixture-key', 'private-token', 'synthetic-business-marker', 'C:/private/data']) expect(serialized).not.toContain(value)
    expect(observed).not.toHaveProperty('cause')
    expect(observed).not.toHaveProperty('headers')
    expect(observed).not.toHaveProperty('error')
  })

  it('redacts unknown provider types and malformed payloads conservatively', async () => {
    await expect(consume(failure('secret-value-as-type', 'Overloaded'))).rejects.toMatchObject({ providerErrorType: 'unrecognized_error', classification: 'unknown', retryable: false })
    await expect(consume('event: error\ndata: not-json-secret\n\n')).rejects.toMatchObject({ malformed: true, providerErrorType: 'unrecognized_error', classification: 'unknown' })
  })

  it.each([1, 2, 7])('handles CRLF, multiline data and UTF-8 fragmented into %i-byte chunks', async fragmentBytes => {
    const wire = start.replaceAll('\n', '\r\n')
      + 'data: {"type":"error",\r\ndata: "error":{"type":"overloaded_error","message":"服务内部内容"}}\r\nevent: error\r\n\r\n'
    await expect(consume(wire, [], fragmentBytes)).rejects.toMatchObject({ providerErrorType: 'overloaded_error', classification: 'transient',
      providerMessage: '[provider message redacted]', providerMessageLength: 6 })
  })

  it('bounds oversized error events and never logs their raw payload', async () => {
    const privateMessage = 'private-prefix-' + 'x'.repeat(50_000)
    let observed: unknown
    try { await consume(start + failure('overloaded_error', privateMessage), [], 101) } catch (error) { observed = error }
    expect(observed).toMatchObject({ malformed: true, providerErrorType: 'unrecognized_error', classification: 'unknown', retryable: false })
    expect(JSON.stringify(observed)).not.toContain('private-prefix')
    expect(JSON.stringify(observed).length).toBeLessThan(1000)
  })

  it('retains prior text and usage when error arrives in the same network chunk', async () => {
    const chunks: LLMStreamChunk[] = []
    await expect(consume(start + text('already delivered') + failure('rate_limit_error', 'Too many requests'), chunks)).rejects.toMatchObject({ classification: 'transient' })
    expect(chunks.map(chunk => chunk.content ?? '').join('')).toBe('already delivered')
    expect(chunks[0]).toMatchObject({ promptTokens: 12, completionTokens: 0 })
    expect(chunks.some(chunk => chunk.done)).toBe(false)
  })

  it('passes large successful frames byte-for-byte without applying error limits to content', async () => {
    const chunks: LLMStreamChunk[] = [], value = '正常内容'.repeat(10_000)
    await consume(start + text(value) + terminal, chunks, 137)
    expect(chunks.map(chunk => chunk.content ?? '').join('')).toBe(value)
    expect(chunks.at(-1)).toMatchObject({ done: true, finishReason: 'stop', promptTokens: 12, completionTokens: 7 })
  })

  it('does not intercept HTTP errors or non-SSE response bodies', async () => {
    const json = new Response('{"error":"not-stream"}', { headers: { 'content-type': 'application/json' } })
    expect(preserveAnthropicStreamErrors(json)).toBe(json)
    const bad = new Response('{"type":"error","error":{"type":"invalid_request_error","message":"invalid request"}}', { status: 400, headers: { 'content-type': 'application/json' } })
    expect(preserveAnthropicStreamErrors(bad)).toBe(bad)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(await bad.clone().text(), { status: 400, headers: bad.headers })))
    const adapter = new AnthropicAdapter('qwen3.8-flash', 'fixture-key', 'http://fixture.invalid/anthropic')
    const collecting = (async () => { for await (const _chunk of adapter.stream([{ role: 'user', content: 'test' }], { model: adapter.model })) { /* Consume only. */ } })()
    await expect(collecting).rejects.toBeInstanceOf(BadRequestError)
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1)
  })

  it('keeps failed transport errors distinct from confirmed SSE gateway errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    const adapter = new AnthropicAdapter('qwen3.8-flash', 'fixture-key', 'http://fixture.invalid/anthropic')
    const collecting = (async () => { for await (const _chunk of adapter.stream([{ role: 'user', content: 'test' }], { model: adapter.model })) { /* Consume only. */ } })()
    await expect(collecting).rejects.toBeInstanceOf(APIConnectionError)
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1)
  })

  it('keeps concurrent response error evidence isolated on one shared adapter', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => response(start + failure('overloaded_error', 'Overloaded'), 3))
      .mockImplementationOnce(async () => response(start + failure('authentication_error', 'Authentication failed'), 7))
    vi.stubGlobal('fetch', fetchMock)
    const adapter = new AnthropicAdapter('qwen3.8-flash', 'fixture-key', 'http://fixture.invalid/anthropic')
    const collect = async () => { for await (const _chunk of adapter.stream([{ role: 'user', content: 'test' }], { model: adapter.model })) { /* Consume only. */ } }
    const results = await Promise.allSettled([collect(), collect()])
    expect(results).toHaveLength(2)
    expect(results[0]).toMatchObject({ status: 'rejected', reason: { providerErrorType: 'overloaded_error', classification: 'transient' } })
    expect(results[1]).toMatchObject({ status: 'rejected', reason: { providerErrorType: 'authentication_error', classification: 'authentication' } })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it.each([true, false])('preserves authentication headers when tokenAuth=%s', async tokenAuth => {
    const fetchMock = vi.fn(async () => response(start + terminal))
    vi.stubGlobal('fetch', fetchMock)
    const adapter = new AnthropicAdapter('qwen3.8-flash', 'fixture-key', 'http://fixture.invalid/anthropic',
      tokenAuth ? { 'X-Access-Token': 'fixture-token', 'X-Trace-Static': 'test' } : { 'X-Trace-Static': 'test' })
    for await (const _chunk of adapter.stream([{ role: 'user', content: 'test' }], { model: adapter.model })) { /* Consume only. */ }
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const headers = new Headers((fetchMock.mock.calls[0] as unknown as [unknown, RequestInit])[1].headers)
    expect(headers.get('X-Trace-Static')).toBe('test')
    expect(headers.get('X-API-Key')).toBe(tokenAuth ? null : 'fixture-key')
    expect(headers.get('X-Access-Token')).toBe(tokenAuth ? 'fixture-token' : null)
  })
})

describe('Anthropic original response reader cleanup', () => {
  const controlled = (wire: string, close: boolean, cancelFailure?: Error) => {
    let sourceController: ReadableStreamDefaultController<Uint8Array> | undefined
    const cancel = vi.fn((_reason?: unknown) => { if (cancelFailure) throw cancelFailure })
    const original = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        sourceController = controller
        if (wire) controller.enqueue(new TextEncoder().encode(wire))
        if (close) controller.close()
      },
      cancel,
    }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } })
    return { original, cancel, sourceError: (error: Error) => sourceController!.error(error) }
  }

  it('releases the original body lock at normal EOF without cancelling completed data', async () => {
    const source = controlled(start + text('ok') + terminal, true)
    const wrapped = preserveAnthropicStreamErrors(source.original)
    expect(source.original.body!.locked).toBe(true)
    expect(await wrapped.text()).toBe(start + text('ok') + terminal)
    expect(source.original.body!.locked).toBe(false)
    expect(source.cancel).not.toHaveBeenCalled()
  })

  it.each([false, true])('cancels once and releases the original SSE-error body when cancel rejects=%s', async rejects => {
    const source = controlled(start + failure('overloaded_error', 'Overloaded'), false, rejects ? new Error('synthetic cancel failure') : undefined)
    const wrapped = preserveAnthropicStreamErrors(source.original)
    expect(source.original.body!.locked).toBe(true)
    await expect(wrapped.text()).rejects.toMatchObject({ code: 'PROVIDER_STREAM_ERROR', providerErrorType: 'overloaded_error' })
    expect(source.original.body!.locked).toBe(false)
    expect(source.cancel).toHaveBeenCalledTimes(1)
    expect(source.cancel.mock.calls[0]?.[0]).toBeInstanceOf(AnthropicStreamError)
  })

  it('releases the original body after reader.read rejects and preserves that transport cause', async () => {
    const source = controlled(start, false)
    const wrapped = preserveAnthropicStreamErrors(source.original)
    const reader = wrapped.body!.getReader()
    expect((await reader.read()).done).toBe(false)
    const transportError = new Error('synthetic transport read failure')
    source.sourceError(transportError)
    await expect(reader.read()).rejects.toBe(transportError)
    reader.releaseLock()
    expect(source.original.body!.locked).toBe(false)
    expect(source.cancel).not.toHaveBeenCalled()
  })

  it('cancels once and releases the original lock on consumer early return', async () => {
    const source = controlled(start, false)
    const wrapped = preserveAnthropicStreamErrors(source.original)
    const iterator = wrapped.body![Symbol.asyncIterator]()
    expect((await iterator.next()).done).toBe(false)
    await iterator.return?.()
    expect(source.original.body!.locked).toBe(false)
    expect(source.cancel).toHaveBeenCalledTimes(1)
  })

  it('releases the original body when cancelled during an outstanding read', async () => {
    const source = controlled('', false)
    const wrapped = preserveAnthropicStreamErrors(source.original)
    const reader = wrapped.body!.getReader()
    const pending = reader.read()
    await reader.cancel('synthetic consumer stop')
    expect(await pending).toEqual({ value: undefined, done: true })
    reader.releaseLock()
    expect(source.original.body!.locked).toBe(false)
    expect(source.cancel).toHaveBeenCalledTimes(1)
    expect(source.cancel).toHaveBeenCalledWith('synthetic consumer stop')
  })

  it('releases the actual SDK underlying response body when AbortSignal fires after usage', async () => {
    // SDK 0.20 needs a byte after a terminal double-LF before yielding it.
    const source = controlled(start + ': ping\n', false)
    vi.stubGlobal('fetch', vi.fn(async () => source.original))
    const controller = new AbortController()
    const adapter = new AnthropicAdapter('qwen3.8-flash', 'fixture-key', 'http://fixture.invalid/anthropic')
    const iterator = adapter.stream([{ role: 'user', content: 'test' }], { model: adapter.model, signal: controller.signal })[Symbol.asyncIterator]()
    expect((await iterator.next()).value).toMatchObject({ promptTokens: 12, done: false })
    expect(source.original.body!.locked).toBe(true)
    controller.abort()
    await expect(iterator.next()).rejects.toBeInstanceOf(APIUserAbortError)
    expect(await iterator.next()).toMatchObject({ done: true })
    await vi.waitFor(() => expect(source.original.body!.locked).toBe(false))
    expect(source.cancel).toHaveBeenCalledTimes(1)
    expect(source.cancel.mock.calls[0]?.[0]).toMatchObject({ name: 'AbortError' })
  })

  it('releases the actual SDK original reader on adapter generator early return', async () => {
    const source = controlled(start + ': ping\n', false)
    vi.stubGlobal('fetch', vi.fn(async () => source.original))
    const adapter = new AnthropicAdapter('qwen3.8-flash', 'fixture-key', 'http://fixture.invalid/anthropic')
    const iterator = adapter.stream([{ role: 'user', content: 'test' }], { model: adapter.model })[Symbol.asyncIterator]()
    expect((await iterator.next()).value).toMatchObject({ promptTokens: 12, done: false })
    expect(source.original.body!.locked).toBe(true)
    await iterator.return?.()
    await vi.waitFor(() => expect(source.original.body!.locked).toBe(false))
    expect(source.cancel).toHaveBeenCalledTimes(1)
  })
})
