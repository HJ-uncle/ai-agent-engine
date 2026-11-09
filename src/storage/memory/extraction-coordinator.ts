import { getMemoryDb, peekMemoryDb } from './db.js'
import type { MemoryContext } from './types.js'

export type MemoryExclusion = { action: 'forget'; summary: string }
type Tracker = { exclusions: MemoryExclusion[] }
type ScopeState = { revision: number; tail: Promise<void>; pending: number; trackers: Set<Tracker> }
const databases = new WeakMap<object, Map<string, ScopeState>>()
const scopeKey = (ctx: MemoryContext) => JSON.stringify([ctx.tenantId || 'default', ctx.scope ?? 'global', ctx.scope === 'session' ? ctx.sessionId : ''])

/** Internal observability only: never creates a scope, connection, or model-facing capability. */
export function getActiveMemoryExtractionCount(ctx: MemoryContext): number {
  const db = peekMemoryDb()
  return db ? databases.get(db)?.get(scopeKey(ctx))?.trackers.size ?? 0 : 0
}

function scopeState(ctx: MemoryContext) {
  const db = getMemoryDb()
  let scopes = databases.get(db)
  if (!scopes) { scopes = new Map(); databases.set(db, scopes) }
  const key = scopeKey(ctx)
  let state = scopes.get(key)
  if (!state) { state = { revision: 0, tail: Promise.resolve(), pending: 0, trackers: new Set() }; scopes.set(key, state) }
  const selected = state
  const cleanup = () => { if (!selected.pending && !selected.trackers.size && scopes.get(key) === selected) scopes.delete(key) }
  return { state: selected, cleanup, db, key }
}

async function locked<T>(state: ScopeState, cleanup: () => void, action: () => Promise<T>): Promise<T> {
  const previous = state.tail
  let release!: () => void
  state.tail = new Promise<void>(resolve => { release = resolve })
  state.pending++
  await previous
  try { return await action() }
  finally { state.pending--; release(); cleanup() }
}

/** Only in-flight jobs need a deletion journal: none survive an engine restart. */
export function trackMemoryExtraction(ctx: MemoryContext) {
  const { state, cleanup, db, key } = scopeState(ctx)
  const tracker: Tracker = { exclusions: [] }
  let active = true
  state.trackers.add(tracker)
  return {
    matches: (context: MemoryContext) => active && db === getMemoryDb() && key === scopeKey(context),
    snapshot: () => ({ revision: state.revision, exclusions: [...tracker.exclusions] }),
    commit: (revision: number, write: () => Promise<void>) => locked(state, cleanup, async () => {
      if (!active || state.revision !== revision) return false
      await write()
      return true
    }),
    close: () => { active = false; state.trackers.delete(tracker); tracker.exclusions.length = 0; cleanup() },
  }
}
export type MemoryExtractionTracker = ReturnType<typeof trackMemoryExtraction>

/** Serialize the successful delete and its publication against extraction writes. */
export async function coordinateMemoryDeletion<T>(ctx: MemoryContext, remove: () => Promise<{ value: T; summary?: string }>): Promise<T> {
  const { state, cleanup } = scopeState(ctx)
  return locked(state, cleanup, async () => {
    const result = await remove()
    if (result.summary !== undefined) {
      state.revision++
      for (const tracker of state.trackers) tracker.exclusions.push({ action: 'forget', summary: result.summary })
    }
    return result.value
  })
}
