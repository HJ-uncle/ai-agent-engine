import type { FastifyInstance } from 'fastify'
import type { EventEmitter } from 'node:events'

// Only the parent process has this pipe. HTTP can present a capability, never create one.
// Keep just one digest per engine: a replaced window immediately retires the previous grant.
export interface ParentChannel extends EventEmitter {
  connected?: boolean
  send?: (message: object, callback: (error: Error | null) => void) => boolean
}
const windows = new WeakMap<object, { digest: string; id: string }>()
const protocol = 'aether:admin-window:1'
export function installDesktopAdminChannel(app: FastifyInstance, parent: ParentChannel, enabled: boolean): void {
  if (!parent.connected || !parent.send) return
  const server = app.server
  const clear = (): void => { windows.delete(server) }
  const receive = (raw: unknown): void => {
    if (!raw || typeof raw !== 'object' || !parent.connected) return
    const { channel, action, id, digest } = raw as Record<string, unknown>
    if (channel !== protocol || typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) return
    if (action === 'close') { if (windows.get(server)?.id === id) clear(); return }
    if (action !== 'open' || typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) return
    if (enabled) windows.set(server, { digest, id })
    try { parent.send!({ channel, action: 'opened', id, enabled }, error => { if (error && windows.get(server)?.id === id) clear() }) }
    catch { clear() }
  }
  const detach = (): void => { clear(); parent.off('message', receive); parent.off('disconnect', detach) }
  parent.on('message', receive); parent.once('disconnect', detach)
  app.addHook('onClose', async () => { detach() })
}
/** Capture this grant, not just a matching digest, so queued work also sees revocation. */
export function desktopWindowGrant(app: FastifyInstance, digest: string): (() => boolean) | undefined {
  const entry = windows.get(app.server)
  return entry && entry.digest === digest ? () => windows.get(app.server) === entry : undefined
}
