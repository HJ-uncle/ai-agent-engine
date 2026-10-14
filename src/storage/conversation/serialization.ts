import { AsyncLocalStorage } from 'node:async_hooks'
import path from 'node:path'
import type { ConversationHistory } from '../../core/agent-context/types.js'
import { forwardConversationOrigin } from './jsonl-origin.js'

const queues = new Map<string, Promise<void>>()
const held = new AsyncLocalStorage<ReadonlyMap<string, { active: boolean }>>()
const generations = new Map<string, number>()
const mutations = new Set<string>()
interface CompressionLease { settled: Promise<void>; controller: AbortController }
const compressions = new Map<string, Set<CompressionLease>>()
const generationKey = (tenantId: string, sessionId: string) => `${path.resolve(process.env.DATA_DIR ?? './data/agent.db')}\0${tenantId}\0${sessionId}`

export function isSessionHistoryMutating(tenantId: string, sessionId: string): boolean {
  return mutations.has(generationKey(tenantId, sessionId))
}

/** Block new runs while child cancellation settles without holding their history lock. */
export async function withSessionHistoryMutation<T>(tenantId: string, sessionId: string, action: () => Promise<T>): Promise<T> {
  const key = generationKey(tenantId, sessionId)
  await withHistoryLock(tenantId, async () => {
    if (mutations.has(key)) throw Object.assign(new Error('Session history is being changed; retry after it completes'), { statusCode: 409 })
    mutations.add(key)
    cancelSessionCompressions(key)
  })
  try { return await action() }
  finally { await withHistoryLock(tenantId, async () => { mutations.delete(key) }) }
}

export function invalidateSessionHistory(tenantId: string, sessionId: string): void {
  const key = generationKey(tenantId, sessionId)
  generations.set(key, (generations.get(key) ?? 0) + 1)
  cancelSessionCompressions(key)
}

function cancelSessionCompressions(key: string): void {
  for (const lease of compressions.get(key) ?? []) lease.controller.abort(Object.assign(
    new Error('Session history was changed; compression was not committed'), { code: 'HISTORY_COMPRESSION_CONFLICT' }))
}

/** Summary generation never grants a stale or cancelled writer a commit. */
export function assertCompressionContext(ctx: { tenantId: string; sessionId: string; signal?: AbortSignal }): void {
  if (ctx.signal?.aborted) throw ctx.signal.reason ?? Object.assign(new Error('Compression cancelled'), { name: 'AbortError' })
  if (isSessionHistoryMutating(ctx.tenantId, ctx.sessionId))
    throw Object.assign(new Error('Session history is being changed; compression was not committed'), { code: 'HISTORY_COMPRESSION_CONFLICT' })
}

export function isSessionHistoryCompressing(tenantId: string, sessionId: string): boolean {
  return Boolean(compressions.get(generationKey(tenantId, sessionId))?.size)
}

/** A new turn waits only for its own maintenance, never while holding tenant SQL ownership. */
export async function waitForSessionHistoryCompression(tenantId: string, sessionId: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  const pending = [...(compressions.get(generationKey(tenantId, sessionId)) ?? [])].map(lease => lease.settled)
  if (!pending.length) return
  await new Promise<void>((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal?.reason ?? new Error('Admission cancelled')) }
    const cleanup = () => signal?.removeEventListener('abort', abort)
    signal?.addEventListener('abort', abort, { once: true })
    void Promise.all(pending).then(() => { cleanup(); resolve() })
    if (signal?.aborted) abort()
  })
}

/** Keep same-session admission ordered while summary generation releases the tenant lock. */
export async function withSessionHistoryCompression<T>(ctx: { tenantId: string; sessionId: string; signal?: AbortSignal }, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const key = generationKey(ctx.tenantId, ctx.sessionId)
  const controller = new AbortController()
  let release!: () => void
  const settled = new Promise<void>(resolve => { release = resolve })
  const lease = { settled, controller }
  await withHistoryLock(ctx.tenantId, async () => {
    assertCompressionContext(ctx)
    const pending = compressions.get(key) ?? new Set<CompressionLease>()
    pending.add(lease); compressions.set(key, pending)
  })
  const abort = () => controller.abort(ctx.signal?.reason ?? new Error('Compression cancelled'))
  ctx.signal?.addEventListener('abort', abort, { once: true })
  if (ctx.signal?.aborted) abort()
  try {
    controller.signal.throwIfAborted()
    return await action(controller.signal)
  }
  finally {
    ctx.signal?.removeEventListener('abort', abort)
    await withHistoryLock(ctx.tenantId, async () => {
      const pending = compressions.get(key)
      pending?.delete(lease)
      if (!pending?.size) compressions.delete(key)
      release()
    })
  }
}

/** Only model waiting can be abandoned; dispatched storage commits must settle truthfully. */
export async function awaitCompressionSummary<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted()
  const operation = action()
  if (!signal) return operation
  return new Promise<T>((resolve, reject) => {
    const cancelled = () => { cleanup(); reject(signal.reason) }
    const cleanup = () => signal.removeEventListener('abort', cancelled)
    signal.addEventListener('abort', cancelled, { once: true })
    void operation.then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
    if (signal.aborted) cancelled()
  })
}

/** Cancellation still persists tool outcomes. Destructive edits invalidate old writers. */
export function bindHistoryGeneration(history: ConversationHistory, tenantId: string, sessionId: string): ConversationHistory {
  const key = generationKey(tenantId, sessionId)
  const generation = generations.get(key) ?? 0
  return forwardConversationOrigin(history, new Proxy(history, { get(target, property) {
    const method = Reflect.get(target, property)
    if (property === 'append') return (...args: Parameters<ConversationHistory['append']>) => withHistoryLock(tenantId, () => {
      if ((generations.get(key) ?? 0) !== generation) throw new Error('History was changed; this run may no longer append')
      return target.append(...args)
    })
    if (property === 'appendIfActiveToolCallAnchor' && typeof method === 'function')
      return (...args: Parameters<NonNullable<ConversationHistory['appendIfActiveToolCallAnchor']>>) => withHistoryLock(tenantId, () => {
        if ((generations.get(key) ?? 0) !== generation) throw new Error('History was changed; this run may no longer append')
        return target.appendIfActiveToolCallAnchor!(...args)
      })
    if (property === 'appendAdmissionUser' && typeof method === 'function')
      return (...args: Parameters<NonNullable<ConversationHistory['appendAdmissionUser']>>) => withHistoryLock(tenantId, () => {
        if ((generations.get(key) ?? 0) !== generation) throw new Error('History was changed; this run may no longer append')
        return target.appendAdmissionUser!(...args)
      })
    return typeof method === 'function' ? method.bind(target) : method
  } }))
}

/** ID-only history mutations require tenant scope; all backends share this lock. */
export async function withHistoryLock<T>(tenantId: string, action: () => Promise<T>): Promise<T> {
  const key = `${path.resolve(process.env.DATA_DIR ?? './data/agent.db')}\0${tenantId}`
  if (held.getStore()?.get(key)?.active) return action()
  const previous = queues.get(key) ?? Promise.resolve()
  let release!: () => void
  const next = new Promise<void>(resolve => { release = resolve })
  queues.set(key, next)
  await previous
  const lease = { active: true }
  try { return await held.run(new Map([...(held.getStore() ?? []), [key, lease]]), action) }
  finally { lease.active = false; release(); if (queues.get(key) === next) queues.delete(key) }
}

export function serializeConversationHistory(history: ConversationHistory): ConversationHistory {
  return forwardConversationOrigin(history, new Proxy(history, {
    get(target, property) {
      const value = Reflect.get(target, property)
      if (typeof value !== 'function') return value
      // Both production backends split compress into prepare/commit critical
      // sections. Keeping this outer lock would still serialize other sessions
      // behind the network call between them.
      if (property === 'compress') return (...args: unknown[]) => value.apply(target, args)
      return (...args: unknown[]) => {
        const candidate = property === 'append' || property === 'appendIfActiveToolCallAnchor' || property === 'appendAdmissionUser' ? args[1] : args[0]
        const ctx = candidate && typeof candidate === 'object' && 'tenantId' in candidate ? candidate as { tenantId: string; signal?: AbortSignal } : undefined
        const tenantId = ctx?.tenantId ?? (property === 'listSessions' ? args[0] :
          property === 'deleteMessagesAfterId' ? args[2] : args[1])
        if (typeof tenantId !== 'string') throw new Error(`Missing history tenant for ${String(property)}`)
        return withHistoryLock(tenantId, () => {
          return value.apply(target, args)
        })
      }
    },
  }))
}
