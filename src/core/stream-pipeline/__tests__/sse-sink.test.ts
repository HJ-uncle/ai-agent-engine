import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { sseStream } from '../sse-sink.js'
import { StreamBus, busToIterable } from '../stream-bus.js'
import type { FastifyReply } from 'fastify'

// ─── Mock FastifyReply ────────────────────────────────────────────────────────
//
// sse-sink 仅会用到 reply.raw.{setHeader,write,end}，全部用 vi.fn 捕获。

interface MockReply {
  reply: FastifyReply
  writes: string[]
  ended: boolean
  headers: Record<string, string>
}

function createMockReply(): MockReply {
  const writes: string[] = []
  let ended = false
  const headers: Record<string, string> = {}
  const raw = {
    setHeader(name: string, value: string): void {
      headers[name] = value
    },
    setTimeout(): void {},
    once(): void {},
    off(): void {},
    write(chunk: string): boolean {
      writes.push(chunk)
      return true
    },
    end(): void {
      ended = true
    },
  }
  return {
    reply: { raw } as unknown as FastifyReply,
    writes,
    ended,
    get headers() {
      return headers
    },
  } as unknown as MockReply
}

async function* fromArray<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item
}

function createEventReply(writeResults: boolean[] = []) {
  const writes: string[] = []
  let resolveFirstWrite!: () => void
  const firstWrite = new Promise<void>(resolve => { resolveFirstWrite = resolve })
  const raw = Object.assign(new EventEmitter(), {
    setHeader: vi.fn(),
    setTimeout: vi.fn(),
    write: vi.fn((data: string) => {
      writes.push(data)
      resolveFirstWrite()
      return writeResults.shift() ?? true
    }),
    end: vi.fn(),
  })
  return { raw, writes, firstWrite, reply: { raw } as unknown as FastifyReply }
}

/**
 * 把 mock 捕获的 raw write 解析为 envelope 对象数组（去掉 [DONE] 终止帧）。
 */
function parseEnvelopes(writes: string[]): Array<Record<string, unknown> | '[DONE]'> {
  return writes
    .map((w) => {
      if (w === 'event: done\ndata: [DONE]\n\n' || w === 'data: [DONE]\n\n') return '[DONE]'
      return w.replace(/^data: /, '').replace(/\n\n$/, '')
    })
    .map((line) => (line === '[DONE]' ? '[DONE]' : (JSON.parse(line) as Record<string, unknown>)))
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('sseStream', () => {
  // ── 1. 普通文本 chunk ───────────────────────────────────────────────────────
  it('plain text chunks are wrapped as { content: ... } envelope', async () => {
    const mock = createMockReply()
    await sseStream(fromArray(['Hello', ' world']), mock.reply)

    const envelopes = parseEnvelopes(mock.writes)
    expect(envelopes).toEqual([
      { content: 'Hello' },
      { content: ' world' },
      '[DONE]',
    ])
    // CR/SSE headers are set
    expect(mock.headers['Content-Type']).toContain('text/event-stream')
    expect(mock.headers['Cache-Control']).toBe('no-cache')
  })

  // ── 2. __thinking__ ────────────────────────────────────────────────────────
  it('__thinking__ frame becomes { thinking: ... } envelope', async () => {
    const mock = createMockReply()
    await sseStream(fromArray(['\x00__thinking__step 1']), mock.reply)

    const envelopes = parseEnvelopes(mock.writes)
    expect(envelopes[0]).toEqual({ thinking: 'step 1' })
  })

  // ── 3. __usage__ ───────────────────────────────────────────────────────────
  it('__usage__ frame becomes { usage: {...} } envelope', async () => {
    const mock = createMockReply()
    const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 }
    await sseStream(fromArray([`\x00__usage__${JSON.stringify(usage)}`]), mock.reply)

    const envelopes = parseEnvelopes(mock.writes)
    expect(envelopes[0]).toEqual({ usage })
  })

  // ── 4. __user_msg_id__ legacy + __userMsgId__ alias ───────────────────────
  it('both __user_msg_id__ and __userMsgId__ produce identical { userMsgId } envelope', async () => {
    const mock = createMockReply()
    await sseStream(
      fromArray([
        '\x00__user_msg_id__msg-old-1',
        '\x00__userMsgId__msg-new-2',
      ]),
      mock.reply,
    )

    const envelopes = parseEnvelopes(mock.writes)
    expect(envelopes).toEqual([
      { userMsgId: 'msg-old-1' },
      { userMsgId: 'msg-new-2' },
      '[DONE]',
    ])
  })

  // ── 5. __tool_start__ + __tool_call__ dual emission ───────────────────────
  it('legacy __tool_start__ produces { toolStart } and new __tool_call__ produces { toolCall }', async () => {
    const mock = createMockReply()
    const legacyPayload = { name: 'search', args: { q: 'x' }, toolCallId: 'tc-1' }
    const newPayload = {
      toolName: 'search',
      args: { q: 'x' },
      toolCallId: 'tc-1',
      messageId: 'msg-1',
    }
    await sseStream(
      fromArray([
        `\x00__tool_start__${JSON.stringify(legacyPayload)}`,
        `\x00__tool_call__${JSON.stringify(newPayload)}`,
      ]),
      mock.reply,
    )

    const envelopes = parseEnvelopes(mock.writes)
    expect(envelopes[0]).toEqual({ toolStart: legacyPayload })
    expect(envelopes[1]).toEqual({ toolCall: newPayload })
  })

  // ── 6. __tool_end__ + __tool_result__ dual emission ───────────────────────
  it('legacy __tool_end__ produces { toolEnd } and new __tool_result__ produces { toolResult }', async () => {
    const mock = createMockReply()
    const legacyEnd = { name: 'search', toolCallId: 'tc-1', success: true, outputPreview: 'ok' }
    const newResult = {
      toolCallId: 'tc-1',
      toolName: 'search',
      success: true,
      output: 'ok',
      durationMs: 12,
    }
    await sseStream(
      fromArray([
        `\x00__tool_end__${JSON.stringify(legacyEnd)}`,
        `\x00__tool_result__${JSON.stringify(newResult)}`,
      ]),
      mock.reply,
    )

    const envelopes = parseEnvelopes(mock.writes)
    expect(envelopes[0]).toEqual({ toolEnd: legacyEnd })
    expect(envelopes[1]).toEqual({ toolResult: newResult })
  })

  // ── 7. __ask_user__ + __permission_request__ dual emission ────────────────
  it('legacy __ask_user__ produces { ask_user } and new __permission_request__ produces { permissionRequest }', async () => {
    const mock = createMockReply()
    const askPayload = { question: 'continue?', toolCallId: 'tc-1' }
    const permPayload = {
      requestId: 'tc-1',
      toolName: 'ask_user',
      args: askPayload,
      sessionId: 'sess-1',
      messageId: 'msg-1',
      description: 'continue?',
    }
    await sseStream(
      fromArray([
        `\x00__ask_user__${JSON.stringify(askPayload)}`,
        `\x00__permission_request__${JSON.stringify(permPayload)}`,
      ]),
      mock.reply,
    )

    const envelopes = parseEnvelopes(mock.writes)
    expect(envelopes[0]).toEqual({ ask_user: askPayload })
    expect(envelopes[1]).toEqual({ permissionRequest: permPayload })
  })

  // ── 8. __message_block__ ───────────────────────────────────────────────────
  it('__message_block__ frame becomes { messageBlock } envelope', async () => {
    const mock = createMockReply()
    const block = {
      messageId: 'm-9',
      role: 'assistant',
      content: 'final',
      metadata: { tokens: 12 },
    }
    await sseStream(
      fromArray([`\x00__message_block__${JSON.stringify(block)}`]),
      mock.reply,
    )

    const envelopes = parseEnvelopes(mock.writes)
    expect(envelopes[0]).toEqual({ messageBlock: block })
  })

  // ── 9. Malformed JSON inside control frame is silently ignored ────────────
  it('malformed JSON inside control frame is silently dropped (no envelope written)', async () => {
    const mock = createMockReply()
    await sseStream(fromArray(['\x00__usage__not-a-json']), mock.reply)

    const envelopes = parseEnvelopes(mock.writes)
    // 仅会有 [DONE]，控制帧解析失败被忽略
    expect(envelopes).toEqual(['[DONE]'])
  })

  // ── 10. Always ends with [DONE] sentinel ──────────────────────────────────
  it('always emits [DONE] sentinel and closes the stream', async () => {
    const mock = createMockReply()
    await sseStream(fromArray(['hello']), mock.reply)

    const last = mock.writes[mock.writes.length - 1]
    expect(last).toBe('event: done\ndata: [DONE]\n\n')
  })
})

describe('sseStream subscription lifecycle', () => {
  it('detaches an idle subscription on socket close without aborting the producer or another client', async () => {
    const controller = new AbortController()
    const bus = new StreamBus(controller)
    const other = busToIterable(bus)
    const otherRead = other.next()
    const socket = createEventReply()
    const completed = sseStream(busToIterable(bus), socket.reply)

    socket.raw.emit('close')
    await completed
    expect(socket.writes).toEqual([])
    expect(socket.raw.end).toHaveBeenCalledOnce()
    expect(socket.raw.listenerCount('close')).toBe(0)
    expect(socket.raw.listenerCount('error')).toBe(0)
    expect(controller.signal.aborted).toBe(false)
    const payload = bus.push('still running')!
    expect(await otherRead).toEqual({ value: payload, done: false })
    bus.end()
    await other.return!()
  })

  it('unblocks a backpressured write on socket close and removes drain listeners', async () => {
    const controller = new AbortController()
    const bus = new StreamBus(controller)
    const payload = bus.push('buffered')!
    const socket = createEventReply([false])
    const completed = sseStream(busToIterable(bus), socket.reply)
    await socket.firstWrite
    expect(socket.raw.listenerCount('drain')).toBe(1)

    socket.raw.emit('close')
    await completed
    expect(socket.writes).toEqual([`id: ${payload.id}\ndata: {"content":"buffered"}\n\n`])
    expect(socket.raw.listenerCount('drain')).toBe(0)
    expect(socket.raw.listenerCount('close')).toBe(0)
    expect(socket.raw.listenerCount('error')).toBe(0)
    expect(controller.signal.aborted).toBe(false)
    bus.end()
  })

  it('unblocks a backpressured write on socket error without emitting a second error frame', async () => {
    const bus = new StreamBus(new AbortController())
    bus.push('buffered')
    const socket = createEventReply([false])
    const completed = sseStream(busToIterable(bus), socket.reply)
    await socket.firstWrite

    expect(() => socket.raw.emit('error', new Error('broken pipe'))).not.toThrow()
    await completed
    expect(socket.writes).toHaveLength(1)
    expect(socket.writes[0]).toContain('"content":"buffered"')
    expect(socket.raw.listenerCount('drain')).toBe(0)
    expect(socket.raw.listenerCount('error')).toBe(0)
    bus.end()
  })

  it('resumes after drain and retains event IDs on body and control envelopes in order', async () => {
    const bus = new StreamBus(new AbortController())
    const body = bus.push('hello')!
    const control = bus.push('\x00__tool_args__{"toolCallId":"tool-1","args":"{\\"path\\":"}')!
    bus.end()
    const socket = createEventReply([false, true, true])
    const completed = sseStream(busToIterable(bus), socket.reply)
    await socket.firstWrite
    expect(socket.writes).toHaveLength(1)

    socket.raw.emit('drain')
    await completed
    expect(socket.writes).toEqual([
      `id: ${body.id}\ndata: {"content":"hello"}\n\n`,
      `id: ${control.id}\ndata: {"toolArgs":{"toolCallId":"tool-1","args":"{\\"path\\":"}}\n\n`,
      'event: done\ndata: [DONE]\n\n',
    ])
    expect(socket.raw.listenerCount('drain')).toBe(0)
    expect(socket.raw.listenerCount('close')).toBe(0)
    expect(socket.raw.listenerCount('error')).toBe(0)
  })

  it('can close while the final done frame is backpressured', async () => {
    const socket = createEventReply([false])
    const completed = sseStream(fromArray([]), socket.reply)
    await socket.firstWrite
    expect(socket.writes).toEqual(['event: done\ndata: [DONE]\n\n'])
    socket.raw.emit('close')
    await completed
    expect(socket.raw.end).toHaveBeenCalledOnce()
    expect(socket.raw.listenerCount('drain')).toBe(0)
  })

  it('finishes on disconnect even when an upstream next and return never settle', async () => {
    const returned = vi.fn(() => new Promise<IteratorResult<string>>(() => {}))
    const source: AsyncIterable<string> = {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<string>>(() => {}),
        return: returned,
      }),
    }
    const socket = createEventReply()
    const completed = sseStream(source, socket.reply)
    socket.raw.emit('close')
    await completed
    expect(returned).toHaveBeenCalledOnce()
    expect(socket.writes).toEqual([])
    expect(socket.raw.end).toHaveBeenCalledOnce()
  })

  it('reports a slow-subscriber snapshot requirement as a coded error followed by done', async () => {
    const bus = new StreamBus(new AbortController(), { maxSubscriberEvents: 1 })
    const iterator = busToIterable(bus)
    bus.push('one')
    bus.push('two')
    const socket = createEventReply()
    await sseStream(iterator, socket.reply)
    expect(JSON.parse(socket.writes[0]!.slice('data: '.length))).toMatchObject({ code: 'snapshot_required' })
    expect(socket.writes.at(-1)).toBe('event: done\ndata: [DONE]\n\n')
    bus.end()
  })
})
