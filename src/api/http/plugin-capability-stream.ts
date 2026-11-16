import type { FastifyReply, FastifyRequest } from 'fastify'
import { PluginError } from '../../plugins/types.js'
import { awaitPluginStream, pluginStreamError, type PluginStreamListener } from '../../plugins/capability-stream-types.js'

/** Backpressured SSE transport. The capability owns event content and its terminal. */
export class PluginCapabilityHttpStreams {
  private readonly connections = new Map<AbortController, Promise<void>>()
  private stopping = false

  async open(request: FastifyRequest, reply: FastifyReply, run: (onEvent: PluginStreamListener, signal: AbortSignal) => Promise<unknown>): Promise<void> {
    if (this.stopping) throw new PluginError('PLUGIN_STREAM_CLOSED', '服务正在关闭，请稍后重试', 503)
    const abort = new AbortController(), response = reply.raw
    const onClose = () => { if (!response.writableEnded) abort.abort() }
    const onAbort = () => abort.abort()
    request.raw.once('aborted', onAbort); response.once('close', onClose); response.once('error', onAbort)
    reply.hijack()
    for (const [name, value] of Object.entries(reply.getHeaders())) if (value !== undefined) response.setHeader(name, value)
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
    response.flushHeaders()
    let terminal = false
    const write: PluginStreamListener = async event => {
      if (terminal || abort.signal.aborted || response.destroyed) throw new PluginError('PLUGIN_STREAM_CLOSED', '流式连接已经关闭', 409)
      const frame = `data: ${JSON.stringify(event)}\n\n`
      const accepted = response.write(frame)
      if (!accepted) {
        let drain: (() => void) | undefined
        try {
          await awaitPluginStream(new Promise<void>(resolve => { drain = resolve; response.once('drain', drain) }), abort.signal)
        } catch (error) { abort.abort(); throw error
        } finally { if (drain) response.off('drain', drain) }
      }
      if (event.type === 'complete' || event.type === 'error') terminal = true
    }
    const heartbeat = setInterval(() => {
      if (terminal || abort.signal.aborted || response.destroyed || response.writableLength) return
      try { response.write(': heartbeat\n\n') } catch { abort.abort() }
    }, 15_000)
    heartbeat.unref()
    const operation = (async () => {
      try {
        await awaitPluginStream(run(write, abort.signal), abort.signal)
        if (!terminal) throw new PluginError('PLUGIN_STREAM_INCOMPLETE', '流式调用未返回完成事件', 502)
      } catch (error) {
        if (!terminal && !abort.signal.aborted && !response.destroyed) {
          const safe = pluginStreamError(error, abort.signal)
          try { await write({ type: 'error', error: { code: safe.code, message: safe.message } }) } catch { abort.abort() }
        }
      } finally {
        clearInterval(heartbeat)
        request.raw.off('aborted', onAbort); response.off('close', onClose); response.off('error', onAbort)
        if (!response.destroyed) response.end()
        abort.abort(); this.connections.delete(abort)
      }
    })()
    this.connections.set(abort, operation)
    await operation
  }

  async close(): Promise<void> {
    this.stopping = true
    for (const abort of this.connections.keys()) abort.abort()
    await Promise.allSettled(this.connections.values())
  }
}
