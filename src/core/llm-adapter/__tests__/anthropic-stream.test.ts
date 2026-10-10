/** Real SDK + in-memory SSE: gateways may put content in start frames, not only deltas. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AnthropicAdapter } from '../anthropic.js'
import { APIConnectionError } from '@anthropic-ai/sdk'
import type { LLMAdapterOptions, LLMStreamChunk } from '../types.js'

afterEach(() => vi.unstubAllGlobals())
type Frame = { type: string; [key: string]: unknown }
const start = (content: unknown[] = []): Frame => ({ type: 'message_start', message: {
  id: 'response-1', type: 'message', role: 'assistant', model: 'deepseek-v4.1-flash',
  content, stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 0 },
} })
const stop = (reason: string | null = 'end_turn'): Frame[] => [
  { type: 'message_delta', delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 7 } },
  { type: 'message_stop' },
]
const block = (index: number, content: Record<string, unknown>): Frame => ({ type: 'content_block_start', index, content_block: content })
const delta = (index: number, content: Record<string, unknown>): Frame => ({ type: 'content_block_delta', index, delta: content })
const blockStop = (index: number): Frame => ({ type: 'content_block_stop', index })

async function consume(frames: Frame[], chunks: LLMStreamChunk[] = [], options: Pick<LLMAdapterOptions, 'responseThinkingField' | 'thinkingEnabled'> = {}) {
  const wire = frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join('')
  // A single network chunk intentionally lets SDK accumulation outrun the consumer.
  // This catches duplicate output from retaining mutable content_block_start objects.
  vi.stubGlobal('fetch', vi.fn(async () => new Response(wire, { headers: { 'content-type': 'text/event-stream' } })))
  const adapter = new AnthropicAdapter('deepseek-v4.1-flash', 'fixture-key', 'http://fixture.invalid/anthropic', { 'X-Access-Token': 'fixture-token' })
  for await (const chunk of adapter.stream([{ role: 'user', content: '帮我做一个五子棋' }], { model: adapter.model, thinkingEnabled: false, ...options })) chunks.push(chunk)
  return chunks
}
const text = (chunks: LLMStreamChunk[]) => chunks.map(chunk => chunk.content ?? '').join('')
const reasoning = (chunks: LLMStreamChunk[]) => chunks.map(chunk => chunk.reasoningContent ?? '').join('')
const calls = (chunks: LLMStreamChunk[]) => chunks.flatMap(chunk => chunk.toolCalls ?? [])

describe('Anthropic streaming block fidelity', () => {
  it('preserves complete text in a block-start frame', async () => {
    const chunks = await consume([start(), block(0, { type: 'text', text: '五子棋已创建。' }), blockStop(0), ...stop()])
    expect(text(chunks)).toBe('五子棋已创建。')
    expect(chunks.at(-1)).toMatchObject({ done: true, finishReason: 'stop', promptTokens: 12, completionTokens: 7 })
  })

  it('preserves message-start content without requiring later content deltas', async () => {
    const chunks = await consume([start([{ type: 'text', text: '五子棋已创建。' }]), ...stop()])
    expect(text(chunks)).toBe('五子棋已创建。')
  })

  it.each(['', '开始：'])('does not duplicate SDK-accumulated text with start prefix %j', async prefix => {
    const chunks = await consume([start(), block(0, { type: 'text', text: prefix }),
      delta(0, { type: 'text_delta', text: '五子棋' }), delta(0, { type: 'text_delta', text: '已创建。' }), blockStop(0), ...stop()])
    expect(text(chunks)).toBe(prefix + '五子棋已创建。')
    expect(chunks.filter(chunk => chunk.content).map(chunk => chunk.content)).toEqual([...(prefix ? [prefix] : []), '五子棋', '已创建。'])
  })

  it.each(['thinking', 'reasoning', 'reasoning_content'])('keeps %s start/delta evidence separate from visible text', async kind => {
    const chunks = await consume([start(), block(0, { type: kind, [kind]: '计划' }),
      delta(0, { type: `${kind}_delta`, [kind]: '完成' }), blockStop(0),
      block(1, { type: 'text', text: '可见结果' }), blockStop(1), ...stop()])
    expect(reasoning(chunks)).toBe('计划完成')
    expect(text(chunks)).toBe('可见结果')
  })

  it('does not display redacted thinking as either text or reasoning', async () => {
    const chunks = await consume([start(), block(0, { type: 'redacted_thinking', data: 'private-block' }), blockStop(0),
      block(1, { type: 'text', text: '可见结果' }), blockStop(1), ...stop()])
    expect(reasoning(chunks)).toBe('')
    expect(text(chunks)).toBe('可见结果')
  })

  it.each(['block_start', 'message_start'])('retains complete tool input from %s and emits it once', async location => {
    const input = { path: 'gomoku.html', content: '<h1>五子棋</h1>' }
    const tool = { type: 'tool_use', id: 'call-1', name: 'write_file', input }
    const frames = location === 'block_start' ? [start(), block(0, tool), blockStop(0)] : [start([tool])]
    const chunks = await consume([...frames, ...stop('tool_use')])
    expect(calls(chunks)).toEqual([{ id: 'call-1', name: 'write_file', args: JSON.stringify(input), index: 0 }])
    expect(chunks.at(-1)?.finishReason).toBe('tool_calls')
  })

  it('collects fragmented tool JSON instead of prefixing the empty initial input', async () => {
    const chunks = await consume([start(), block(0, { type: 'tool_use', id: 'call-1', name: 'write_file', input: {} }),
      delta(0, { type: 'input_json_delta', partial_json: '{"path":' }), delta(0, { type: 'input_json_delta', partial_json: '"gomoku.html"}' }),
      blockStop(0), ...stop('tool_use')])
    expect(calls(chunks)).toEqual([{ id: 'call-1', name: 'write_file', args: '{"path":"gomoku.html"}', index: 0 }])
  })

  it('does not turn max_tokens into successful completion', async () => {
    const chunks = await consume([start(), block(0, { type: 'text', text: '部分结果' }), blockStop(0), ...stop('max_tokens')])
    expect(text(chunks)).toBe('部分结果')
    expect(chunks.at(-1)?.finishReason).toBe('length')
  })

  it.each([null, 'unknown_finish', 'pause_turn'])('rejects unsupported terminal reason %j', async reason => {
    const chunks: LLMStreamChunk[] = []
    await expect(consume([start(), ...stop(reason)], chunks)).rejects.toMatchObject({
      code: reason ? 'UNSUPPORTED_STOP_REASON' : 'INCOMPLETE_STREAM',
    })
    expect(chunks.some(chunk => chunk.done)).toBe(false)
  })

  it('rejects a stream with no message_stop instead of accepting the partial text', async () => {
    const chunks: LLMStreamChunk[] = []
    await expect(consume([start(), block(0, { type: 'text', text: '部分结果' }), blockStop(0)], chunks)).rejects.toMatchObject({ code: 'INCOMPLETE_STREAM' })
    expect(text(chunks)).toBe('部分结果')
    expect(chunks.some(chunk => chunk.done)).toBe(false)
  })

  it('leaves genuinely empty completed output empty for the run loop to diagnose', async () => {
    const chunks = await consume([start(), ...stop()])
    expect(text(chunks)).toBe('')
    expect(reasoning(chunks)).toBe('')
    expect(calls(chunks)).toEqual([])
    expect(chunks.at(-1)?.finishReason).toBe('stop')
  })

  it.each(['private_reasoning', 'private_reasoning_delta'])('retains legacy custom thinking field %s separately', async field => {
    const chunks = await consume([start(), block(0, { type: 'private_reasoning', [field]: '计划' }),
      delta(0, { type: 'private_reasoning_delta', [field]: '完成' }), blockStop(0),
      block(1, { type: 'text', text: '结果' }), blockStop(1), ...stop()], [], { thinkingEnabled: true, responseThinkingField: field })
    expect(reasoning(chunks)).toBe('计划完成')
    expect(text(chunks)).toBe('结果')
  })

  it('propagates provider SSE errors without completing or dispatching an unfinished tool', async () => {
    const chunks: LLMStreamChunk[] = []
    await expect(consume([start(), block(0, { type: 'tool_use', id: 'unfinished', name: 'write_file', input: {} }),
      delta(0, { type: 'input_json_delta', partial_json: '{"path":"' }),
      { type: 'error', error: { type: 'overloaded_error', message: 'fixture provider unavailable' } }], chunks)).rejects.toBeInstanceOf(APIConnectionError)
    expect(calls(chunks)).toEqual([])
    expect(chunks.some(chunk => chunk.done)).toBe(false)
  })

  it('honors AbortController after partial text without dispatching later tools or completion', async () => {
    const controller = new AbortController()
    const frames = [start(), block(0, { type: 'text', text: '部分结果' }), blockStop(0),
      block(1, { type: 'tool_use', id: 'never-run', name: 'write_file', input: { path: 'gomoku.html' } }), blockStop(1), ...stop('tool_use')]
    const wire = frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join('')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(wire, { headers: { 'content-type': 'text/event-stream' } })))
    const adapter = new AnthropicAdapter('deepseek-v4.1-flash', 'fixture-key', 'http://fixture.invalid/anthropic', { 'X-Access-Token': 'fixture-token' })
    const iterator = adapter.stream([{ role: 'user', content: '创建五子棋' }], { model: adapter.model, signal: controller.signal })[Symbol.asyncIterator]()
    expect(await iterator.next()).toMatchObject({ done: false, value: { done: false, promptTokens: 12, completionTokens: 0 } })
    expect(await iterator.next()).toMatchObject({ done: false, value: { content: '部分结果', done: false } })
    controller.abort()
    await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' })
    expect(await iterator.next()).toMatchObject({ done: true, value: undefined })
  })
})
