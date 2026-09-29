import type { FastifyReply } from 'fastify'
import type { SseEventPayload } from './stream-bus.js'
import { decodeStreamChunk } from './stream-projection.js'

const HEARTBEAT_INTERVAL_MS = 15000

export async function sseStream(source: AsyncIterable<SseEventPayload | string>, reply: FastifyReply): Promise<void> {
  reply.raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  reply.raw.setHeader('Cache-Control', 'no-cache')
  reply.raw.setHeader('Connection', 'keep-alive')
  reply.raw.setHeader('X-Accel-Buffering', 'no')
  reply.raw.setTimeout(0)

  const iterator = source[Symbol.asyncIterator]()
  let clientGone = false
  let returned = false
  let heartbeat: ReturnType<typeof setTimeout> | undefined
  let disconnect!: () => void
  const disconnected = new Promise<null>(resolve => { disconnect = () => resolve(null) })
  const returnSource = () => {
    if (returned) return
    returned = true
    // A bus subscription return detaches immediately; it never aborts its producer.
    try { void Promise.resolve(iterator.return?.()).catch(() => {}) } catch { /* already closed */ }
  }
  const onClientClose = () => {
    clientGone = true
    if (heartbeat) clearTimeout(heartbeat)
    disconnect()
    returnSource()
  }
  reply.raw.once('error', onClientClose)
  reply.raw.once('close', onClientClose)

  const scheduleHeartbeat = () => {
    if (clientGone) return
    heartbeat = setTimeout(() => {
      if (clientGone) return
      try { reply.raw.write(`: ping ${Date.now()}\n\n`) }
      catch { onClientClose(); return }
      scheduleHeartbeat()
    }, HEARTBEAT_INTERVAL_MS)
  }
  scheduleHeartbeat()

  const writeData = async (data: string): Promise<void> => {
    if (clientGone || reply.raw.write(data)) return
    await new Promise<void>(resolve => {
      const finish = () => {
        reply.raw.off('drain', finish)
        reply.raw.off('error', finish)
        reply.raw.off('close', finish)
        resolve()
      }
      reply.raw.once('drain', finish)
      reply.raw.once('error', finish)
      reply.raw.once('close', finish)
      if (clientGone) finish()
    })
  }

  try {
    while (!clientGone) {
      const next = await Promise.race([iterator.next(), disconnected])
      if (next === null || next.done || clientGone) break
      const item = next.value
      const chunk = typeof item === 'string' ? item : item.chunk
      const envelope = decodeStreamChunk(chunk)
      if (!envelope) continue
      const id = typeof item === 'string' || !item.id ? '' : `id: ${item.id}\n`
      await writeData(`${id}data: ${JSON.stringify(envelope)}\n\n`)
    }
    if (!clientGone) await writeData('event: done\ndata: [DONE]\n\n')
  } catch (error) {
    if (!clientGone) {
      const message = error instanceof Error ? error.message : String(error)
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined
      try {
        await writeData(`data: ${JSON.stringify({ error: message, ...(code ? { code } : {}) })}\n\n`)
        await writeData('event: done\ndata: [DONE]\n\n')
      } catch { /* socket failed while reporting an upstream error */ }
    }
  } finally {
    if (heartbeat) clearTimeout(heartbeat)
    returnSource()
    reply.raw.off('error', onClientClose)
    reply.raw.off('close', onClientClose)
    try { reply.raw.end() } catch { /* already closed */ }
  }
}
