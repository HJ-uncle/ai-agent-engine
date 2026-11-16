import type { FastifyReply, FastifyRequest } from 'fastify'
import { onPluginChanged } from './change-events.js'

type Change = { kind: 'plugin'; action: 'refresh' | 'update'; id: string }
type Connection = { tenantId: string; notify(id: string): void; close(): void }
const frame = (change: Change): string => `data: ${JSON.stringify({ pluginCatalogueChange: change })}\n\n`

/** App-owned, tenant-scoped invalidations. No plugin code, filesystem reads, or chat cursors. */
export class PluginCatalogueStream {
  private readonly connections = new Set<Connection>()
  private readonly unsubscribe: () => void
  private stopped = false
  constructor(private readonly root: string, private readonly options: { heartbeatMs?: number; stalledMs?: number } = {}) {
    this.unsubscribe = onPluginChanged(change => {
      if (change.root !== this.root || this.stopped) return
      for (const connection of this.connections) if (connection.tenantId === change.tenantId) connection.notify(change.pluginId)
    })
  }
  get connectionCount(): number { return this.connections.size }

  open(request: FastifyRequest, reply: FastifyReply, tenantId: string): void {
    if (this.stopped) { reply.code(503).send({ code: 503, message: 'Plugin catalogue stream is stopping', data: null }); return }
    reply.hijack()
    const response = reply.raw
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
    response.flushHeaders()
    const pending = new Set<string>()
    let refresh = false, closed = false, blocked = false
    let scheduled: ReturnType<typeof setImmediate> | undefined, stalled: ReturnType<typeof setTimeout> | undefined
    let heartbeat: ReturnType<typeof setInterval> | undefined
    const cleanup = (): void => {
      if (closed) return
      closed = true; pending.clear()
      if (scheduled) clearImmediate(scheduled)
      if (heartbeat) clearInterval(heartbeat)
      if (stalled) clearTimeout(stalled)
      request.raw.off('aborted', cleanup)
      response.off('close', cleanup); response.off('error', cleanup); response.off('drain', drain)
      this.connections.delete(connection)
    }
    const close = (): void => { cleanup(); if (!response.destroyed) response.destroy() }
    const write = (text: string): void => {
      if (closed || blocked) return
      try {
        if (!response.write(text)) {
          blocked = true
          stalled = setTimeout(close, this.options.stalledMs ?? 30_000); stalled.unref()
        }
      } catch { close() }
    }
    const flush = (): void => {
      scheduled = undefined
      if (closed || blocked) return
      if (refresh) { refresh = false; pending.clear(); write(frame({ kind: 'plugin', action: 'refresh', id: '*' })); return }
      for (const id of pending) {
        pending.delete(id); write(frame({ kind: 'plugin', action: 'update', id }))
        if (closed || blocked) return
      }
    }
    const schedule = (): void => { if (!closed && !blocked && !scheduled) { scheduled = setImmediate(flush); scheduled.unref() } }
    const drain = (): void => {
      blocked = false; if (stalled) { clearTimeout(stalled); stalled = undefined }
      if (refresh || pending.size) schedule()
    }
    const connection: Connection = { tenantId, close, notify: id => {
      if (closed) return
      // One stalled client cannot retain an unbounded list of plugin identities.
      if (!refresh) { pending.add(id); if (pending.size > 32) { pending.clear(); refresh = true } }
      schedule()
    } }
    this.connections.add(connection)
    request.raw.once('aborted', cleanup)
    response.once('close', cleanup); response.once('error', cleanup); response.on('drain', drain)
    heartbeat = setInterval(() => { if (!blocked) write(': heartbeat\n\n') }, this.options.heartbeatMs ?? 15_000); heartbeat.unref()
    write(frame({ kind: 'plugin', action: 'refresh', id: '*' }))
  }

  close(): void {
    if (this.stopped) return
    this.stopped = true; this.unsubscribe()
    for (const connection of this.connections) connection.close()
  }
}
