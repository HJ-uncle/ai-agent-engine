import { AsyncLocalStorage } from 'node:async_hooks'
import path from 'node:path'
import type { ConversationHistory } from '../../core/agent-context/types.js'

const queues = new Map<string, Promise<void>>()
const held = new AsyncLocalStorage<ReadonlyMap<string, { active: boolean }>>()
const generations = new Map<string, number>()
const mutations = new Set<string>()
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
  })
  try { return await action() }
  finally { await withHistoryLock(tenantId, async () => { mutations.delete(key) }) }
}

export function invalidateSessionHistory(tenantId: string, sessionId: string): void {
  const key = generationKey(tenantId, sessionId)
  generations.set(key, (generations.get(key) ?? 0) + 1)
}

/** Cancellation still persists tool outcomes. Destructive edits invalidate old writers. */
export function bindHistoryGeneration(history: ConversationHistory, tenantId: string, sessionId: string): ConversationHistory {
  const key = generationKey(tenantId, sessionId)
  const generation = generations.get(key) ?? 0
  return new Proxy(history, { get(target, property) {
    const method = Reflect.get(target, property)
    if (property === 'append') return (...args: Parameters<ConversationHistory['append']>) => withHistoryLock(tenantId, () => {
      if ((generations.get(key) ?? 0) !== generation) throw new Error('History was changed; this run may no longer append')
      return target.append(...args)
    })
    return typeof method === 'function' ? method.bind(target) : method
  } })
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
  return new Proxy(history, {
    get(target, property) {
      const value = Reflect.get(target, property)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        const candidate = property === 'append' ? args[1] : args[0]
        const ctx = candidate && typeof candidate === 'object' && 'tenantId' in candidate ? candidate as { tenantId: string; signal?: AbortSignal } : undefined
        const tenantId = ctx?.tenantId ?? (property === 'listSessions' ? args[0] :
          property === 'deleteMessagesAfterId' ? args[2] : args[1])
        if (typeof tenantId !== 'string') throw new Error(`Missing history tenant for ${String(property)}`)
        return withHistoryLock(tenantId, () => {
          return value.apply(target, args)
        })
      }
    },
  })
}
