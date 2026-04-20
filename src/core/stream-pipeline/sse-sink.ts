import type { FastifyReply } from 'fastify'

export async function sseStream(
  source: AsyncIterable<string>,
  reply: FastifyReply,
): Promise<void> {
  reply.raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  reply.raw.setHeader('Cache-Control', 'no-cache')
  reply.raw.setHeader('Connection', 'keep-alive')
  reply.raw.setHeader('X-Accel-Buffering', 'no')

  try {
    for await (const chunk of source) {
      // Special __usage__ frame — send as a dedicated usage event, not content
      if (chunk.startsWith('\x00__usage__')) {
        try {
          const usageJson = chunk.slice('\x00__usage__'.length)
          const usage = JSON.parse(usageJson)
          reply.raw.write(`data: ${JSON.stringify({ usage })}\n\n`)
        } catch {
          // ignore malformed usage frame
        }
        continue
      }
      const data = JSON.stringify({ content: chunk })
      reply.raw.write(`data: ${data}\n\n`)
    }
    // Send done event
    reply.raw.write('data: [DONE]\n\n')
  } finally {
    reply.raw.end()
  }
}
