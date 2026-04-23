import type { FastifyReply } from 'fastify'

export async function sseStream(
  source: AsyncIterable<string>,
  reply: FastifyReply,
): Promise<void> {
  console.log('--- sseStream started ---')
  reply.raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  reply.raw.setHeader('Cache-Control', 'no-cache')
  reply.raw.setHeader('Connection', 'keep-alive')
  reply.raw.setHeader('X-Accel-Buffering', 'no')

  try {
    for await (const chunk of source) {
      console.log('--- sseStream chunk ---', chunk.slice(0, 50))
      // ── __usage__ frame ──────────────────────────────────────────────────
      if (chunk.startsWith('\x00__usage__')) {
        try {
          const usage = JSON.parse(chunk.slice('\x00__usage__'.length))
          reply.raw.write(`data: ${JSON.stringify({ usage })}\n\n`)
        } catch { /* ignore */ }
        continue
      }
      // ── __thinking__ frame (AI 思考文字，调用工具前) ─────────────────────
      if (chunk.startsWith('\x00__thinking__')) {
        const text = chunk.slice('\x00__thinking__'.length)
        reply.raw.write(`data: ${JSON.stringify({ thinking: text })}\n\n`)
        continue
      }
      // ── __tool_start__ frame ─────────────────────────────────────────────
      if (chunk.startsWith('\x00__tool_start__')) {
        try {
          const tool = JSON.parse(chunk.slice('\x00__tool_start__'.length))
          reply.raw.write(`data: ${JSON.stringify({ toolStart: tool })}\n\n`)
        } catch { /* ignore */ }
        continue
      }
      // ── __tool_end__ frame ───────────────────────────────────────────────
      if (chunk.startsWith('\x00__tool_end__')) {
        try {
          const tool = JSON.parse(chunk.slice('\x00__tool_end__'.length))
          reply.raw.write(`data: ${JSON.stringify({ toolEnd: tool })}\n\n`)
        } catch { /* ignore */ }
        continue
      }
      // ── 普通内容 ─────────────────────────────────────────────────────────
      reply.raw.write(`data: ${JSON.stringify({ content: chunk })}\n\n`)
    }
    // Send done event
    reply.raw.write('data: [DONE]\n\n')
  } finally {
    reply.raw.end()
  }
}
