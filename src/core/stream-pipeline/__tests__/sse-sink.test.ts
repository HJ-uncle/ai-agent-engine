import { describe, it, expect, vi } from 'vitest'
import { sseStream } from '../sse-sink.js'
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
