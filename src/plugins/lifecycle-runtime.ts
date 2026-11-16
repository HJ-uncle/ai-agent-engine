import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { serialize } from 'node:v8'
import { z } from 'zod'
import { PluginService } from './service.js'
import { pluginEventSchema, type PluginEventType } from './contributions.js'
import { onPluginChanged } from './change-events.js'
import { assertCapability, publishedCapabilityAccess, type CapabilityAccess } from './capability-runtime.js'
import { invokePluginApplication } from './application.js'
import { PluginError } from './types.js'
import type { PublishedPluginMetadata } from './service.js'
import { onAgentLifecycleEvent } from '../core/runtime-events.js'

export const pluginHostEventSchema = z.object({ event: pluginEventSchema, eventId: z.string().uuid(), sessionId: z.string().min(1).max(256).optional(), payload: z.record(z.unknown()).default({}) }).strict()
export interface PluginHostEvent { id: string; type: PluginEventType; sessionId: string | null; payload: Record<string, unknown>; timestamp: number; sequence: number }
interface PluginEventJournal { entries: Array<{ event: PluginHostEvent; bytes: number }>; bytes: number }
const JOURNAL_HISTORY_BYTES = 8 * 1024 * 1024
const origins = new AsyncLocalStorage<readonly string[]>()
const runtimes = new Set<PluginLifecycleRuntime>()
export function withPluginEventOrigin<T>(pluginId: string, action: () => T): T { return origins.run([...(origins.getStore() ?? []), pluginId], action) }
/** Called only by engine sources. Plugin JSON has no event-emission capability. */
export async function emitPluginHostEvent(tenantId: string, event: PluginEventType, sessionId?: string, payload: Record<string, unknown> = {}) {
  await Promise.allSettled([...runtimes].map(runtime => runtime.dispatch(tenantId, { event, eventId: randomUUID(), sessionId, payload }, true)))
}
export function pollPluginHostEvents(access: CapabilityAccess, tenantId: string, sessionId: string | undefined, args: Record<string, unknown>) {
  const input = z.object({ cursor: z.number().int().min(0).default(0), limit: z.number().int().min(1).default(50) }).strict().parse(args)
  const root = access.runtimeRoot ?? new PluginService().rootDir
  const runtime = [...runtimes].find(runtime => runtime.service.rootDir === root)
  return runtime?.poll(tenantId, sessionId, input.cursor, input.limit) ?? { events: [], nextCursor: input.cursor }
}

/** Bounded host event journal + explicit granted hooks, using the normal plugin runtime. */
export class PluginLifecycleRuntime {
  private journals = new Map<string, PluginEventJournal>()
  private sequence = 0
  private active = new Map<string, { tenantId: string; pluginId: string; revision: number; controller: AbortController; completion: Promise<unknown> }>()
  private cooldowns = new Map<string, number>()
  private metadata = new Map<string, Promise<PublishedPluginMetadata[]>>()
  private unsubscribe?: () => void
  private unsubscribeAgents?: () => void
  private stopping = false
  private pending = new Set<Promise<unknown>>()
  constructor(readonly service: PluginService) {}
  async start(): Promise<void> {
    if (runtimes.has(this)) return
    this.stopping = false; runtimes.add(this)
    this.unsubscribeAgents = onAgentLifecycleEvent(event => {
      void this.dispatch(event.tenantId, { event: event.type, eventId: randomUUID(), sessionId: event.sessionId, payload: event.payload }, true).catch(() => undefined)
    })
    this.unsubscribe = onPluginChanged(change => {
      if (change.root !== this.service.rootDir) return
      this.metadata.delete(change.tenantId)
      for (const run of this.active.values()) if (run.tenantId === change.tenantId && run.pluginId === change.pluginId) {
        void publishedCapabilityAccess(this.service, run.tenantId, run.pluginId, run.revision)
          .then(access => assertCapability(access, 'events.subscribe', run.revision)).catch(() => run.controller.abort())
      }
    })
    for (const tenantId of await this.service.listTenantIds()) {
      try { await this.dispatch(tenantId, { event: 'app.started', eventId: randomUUID(), payload: {} }, true) } catch { /* Isolate damaged tenant metadata. */ }
    }
  }
  poll(tenantId: string, sessionId: string | undefined, cursor = 0, limit = 50) {
    // Renderer subscriptions can outlive an engine reconnect. A cursor from
    // the previous in-memory journal must not suppress all new events.
    if (cursor > this.sequence) cursor = 0
    const journal = this.journals.get(tenantId)?.entries.map(entry => entry.event) ?? []
    const available = journal.filter(event => event.sequence > cursor && (event.sessionId === null || event.sessionId === sessionId))
    const events = available.slice(0, limit)
    return { events: structuredClone(events), nextCursor: events.at(-1)?.sequence ?? Math.max(cursor, journal.at(-1)?.sequence ?? 0) }
  }
  dispatch(tenantId: string, raw: unknown, internal = false): Promise<{ eventId: string; accepted: number; skipped: number }> {
    const pending = this.deliver(tenantId, raw, internal)
    this.pending.add(pending); void pending.finally(() => this.pending.delete(pending)).catch(() => undefined)
    return pending
  }
  private async deliver(tenantId: string, raw: unknown, internal: boolean) {
    if (this.stopping) throw new PluginError('PLUGIN_STOPPING', '插件宿主正在关闭', 409)
    const input = pluginHostEventSchema.parse(raw)
    if (!internal && (input.event.startsWith('app.') || input.event.startsWith('agent.'))) throw new PluginError('PLUGIN_EVENT_SOURCE', '该事件只能由引擎产生', 403)
    if (!input.event.startsWith('app.') && !input.sessionId) throw new PluginError('PLUGIN_SESSION_REQUIRED', '此事件需要宿主绑定会话', 409)
    const journal = this.journals.get(tenantId) ?? { entries: [], bytes: 0 }
    if (journal.entries.some(entry => entry.event.id === input.eventId)) return { eventId: input.eventId, accepted: 0, skipped: 0 }
    const event: PluginHostEvent = { id: input.eventId, type: input.event, sessionId: input.sessionId ?? null, payload: structuredClone(input.payload), timestamp: Date.now(), sequence: ++this.sequence }
    const bytes = serialize(event).byteLength
    journal.entries.push({ event, bytes }); journal.bytes += bytes
    // Bound retained history, never reject or truncate the current event. Hooks
    // own their event reference independently of this polling journal.
    while (journal.entries.length > 1 && (journal.entries.length > 256 || journal.bytes > JOURNAL_HISTORY_BYTES)) {
      journal.bytes -= journal.entries.shift()!.bytes
    }
    this.journals.set(tenantId, journal)
    let accepted = 0, skipped = 0
    const origin = origins.getStore() ?? []
    let metadataPromise = this.metadata.get(tenantId)
    if (!metadataPromise) {
      metadataPromise = this.service.listPublishedMetadata(tenantId)
      this.metadata.set(tenantId, metadataPromise)
      void metadataPromise.catch(() => { if (this.metadata.get(tenantId) === metadataPromise) this.metadata.delete(tenantId) })
    }
    for (const metadata of await metadataPromise) {
      if (this.stopping) break
      if (!metadata.enabled || origin.includes(metadata.id)) continue
      const hooks = metadata.manifest.contributes?.hooks?.filter(hook => hook.event === input.event) ?? []
      if (!hooks.length) continue
      let access
      try { access = await publishedCapabilityAccess(this.service, tenantId, metadata.id, metadata.revision); assertCapability(access, 'events.subscribe', metadata.revision) } catch { skipped += hooks.length; continue }
      for (const hook of hooks) {
        if (this.stopping) break
        if ((hook.scope === 'session' || hook.when?.session === true || hook.when?.workspace === true) && !input.sessionId) { skipped++; continue }
        if (hook.when?.session === false && input.sessionId || hook.when?.engineReady === false) { skipped++; continue }
        const key = JSON.stringify([tenantId, metadata.id, hook.id, input.sessionId])
        if (this.active.has(key) || (this.cooldowns.get(key) ?? 0) > Date.now()) { skipped++; continue }
        const controller = new AbortController()
        this.cooldowns.set(key, Date.now() + 250)
        if (this.cooldowns.size > 1024) this.cooldowns.delete(this.cooldowns.keys().next().value!)
        const completion = Promise.resolve().then(async () => {
          const live = await publishedCapabilityAccess(this.service, tenantId, metadata.id, metadata.revision)
          assertCapability(live, 'events.subscribe', metadata.revision); controller.signal.throwIfAborted()
          return withPluginEventOrigin(metadata.id, () => invokePluginApplication(this.service, tenantId, metadata.id, metadata.revision,
            hook.tool, { ...hook.args, event }, controller.signal, input.sessionId))
        }).finally(() => this.active.delete(key))
        this.active.set(key, { tenantId, pluginId: metadata.id, revision: metadata.revision, controller, completion })
        void completion.catch(() => undefined); accepted++
      }
    }
    return { eventId: input.eventId, accepted, skipped }
  }
  async drain(): Promise<void> { await Promise.allSettled([...this.pending, ...[...this.active.values()].map(run => run.completion)]) }
  async stop(): Promise<void> {
    if (this.stopping) return
    for (const tenantId of await this.service.listTenantIds()) {
      try { await this.dispatch(tenantId, { event: 'app.stopping', eventId: randomUUID(), payload: {} }, true) } catch { /* Continue joining healthy tenant owners. */ }
    }
    // Shutdown gives hooks a grace period before cancelling and joining owned children.
    await Promise.race([this.drain(), new Promise<void>(resolve => { const timer = setTimeout(resolve, 1000); timer.unref() })])
    this.stopping = true; runtimes.delete(this); this.unsubscribe?.(); this.unsubscribe = undefined; this.unsubscribeAgents?.(); this.unsubscribeAgents = undefined
    await Promise.allSettled([...this.pending])
    for (const run of this.active.values()) run.controller.abort()
    await this.drain(); this.journals.clear(); this.cooldowns.clear(); this.metadata.clear()
  }
}
