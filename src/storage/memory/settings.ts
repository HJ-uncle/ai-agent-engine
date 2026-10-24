import { getMemoryDb, initMemoryDb } from './db.js'
import { MEMORY_SCHEMA } from './schema.js'
import type { ToolProfile } from '../../tools/tool-profile.js'
import type { MemoryScope } from './types.js'

/** Compatibility representation. New callers use effectiveScopes for the two independent switches. */
export type MemoryMode = 'off' | 'global' | 'session'

export interface MemoryPreferences {
  globalEnabled: boolean
  sessionDefaultEnabled: boolean
  /** Server capability, independent of the saved preferences. */
  enabled: boolean
}

export interface SessionMemorySettings extends MemoryPreferences {
  memoryScope: MemoryMode
  effectiveScope: MemoryMode
  sessionOverride: boolean | null
  sessionEnabled: boolean
  effectiveScopes: MemoryScope[]
}

export function isMemoryMode(value: unknown): value is MemoryMode {
  return value === 'off' || value === 'global' || value === 'session'
}

export function defaultMemoryMode(_profile?: ToolProfile): MemoryMode {
  return 'session'
}

function requireSession(sessionId: string): void {
  if (!sessionId?.trim()) throw new Error('sessionId is required for memory settings')
}

async function database() {
  await initMemoryDb(MEMORY_SCHEMA)
  return getMemoryDb()
}

export async function getMemoryPreferences(tenantId: string): Promise<MemoryPreferences> {
  const db = await database()
  const result = await db.execute({ sql: 'SELECT global_enabled, session_default_enabled FROM memory_preferences WHERE tenant_id = ?', args: [tenantId] })
  const row = result.rows[0]
  return {
    globalEnabled: Number(row?.global_enabled ?? 0) === 1,
    sessionDefaultEnabled: Number(row?.session_default_enabled ?? 1) === 1,
    enabled: process.env.ENABLE_LONG_TERM_MEMORY !== 'false',
  }
}

export async function setMemoryPreferences(tenantId: string, patch: Partial<Pick<MemoryPreferences, 'globalEnabled' | 'sessionDefaultEnabled'>>): Promise<MemoryPreferences> {
  if (Object.keys(patch).length === 0 || Object.keys(patch).some(key => key !== 'globalEnabled' && key !== 'sessionDefaultEnabled') ||
    (patch.globalEnabled !== undefined && typeof patch.globalEnabled !== 'boolean') ||
    (patch.sessionDefaultEnabled !== undefined && typeof patch.sessionDefaultEnabled !== 'boolean')) {
    throw new Error('记忆默认设置必须包含有效的布尔值')
  }
  const db = await database()
  const global = patch.globalEnabled === undefined ? null : Number(patch.globalEnabled)
  const session = patch.sessionDefaultEnabled === undefined ? null : Number(patch.sessionDefaultEnabled)
  // Patch in SQL so independent settings windows cannot lose each other's update.
  await db.execute({
    sql: `INSERT INTO memory_preferences (tenant_id, global_enabled, session_default_enabled, updated_at)
          VALUES (?, coalesce(?, 0), coalesce(?, 1), unixepoch())
          ON CONFLICT(tenant_id) DO UPDATE SET
            global_enabled = coalesce(?, memory_preferences.global_enabled),
            session_default_enabled = coalesce(?, memory_preferences.session_default_enabled), updated_at = unixepoch()`,
    args: [tenantId, global, session, global, session],
  })
  return getMemoryPreferences(tenantId)
}

/** Resolve defaults and a nullable session override in one indexed DB read. Never touches chat history. */
export async function getSessionMemorySettings(tenantId: string, sessionId: string, _profile?: ToolProfile): Promise<SessionMemorySettings> {
  requireSession(sessionId)
  const db = await database()
  const result = await db.execute({
    sql: `SELECT p.global_enabled, p.session_default_enabled, s.scope,
                 o.session_enabled, o.session_id AS override_session_id
          FROM (SELECT ? AS tenant_id, ? AS session_id) requested
          LEFT JOIN memory_preferences p ON p.tenant_id = requested.tenant_id
          LEFT JOIN memory_session_settings s ON s.tenant_id = requested.tenant_id AND s.session_id = requested.session_id
          LEFT JOIN memory_session_preferences o ON o.tenant_id = requested.tenant_id AND o.session_id = requested.session_id`,
    args: [tenantId, sessionId],
  })
  const row = result.rows[0]
  const globalEnabled = Number(row?.global_enabled ?? 0) === 1
  const sessionDefaultEnabled = Number(row?.session_default_enabled ?? 1) === 1
  const legacy = isMemoryMode(row?.scope) ? row.scope : undefined
  // An old global selection never authorizes tenant-wide sharing. Only the new
  // explicit settings switch can enable it; old off/session choices remain explicit.
  const sessionOverride = row?.override_session_id != null
    ? row.session_enabled == null ? null : Number(row.session_enabled) === 1
    : legacy === 'session' ? true : legacy === 'off' ? false : null
  const sessionEnabled = sessionOverride ?? sessionDefaultEnabled
  const enabled = process.env.ENABLE_LONG_TERM_MEMORY !== 'false'
  const effectiveScopes: MemoryScope[] = enabled
    ? [...(globalEnabled ? ['global' as const] : []), ...(sessionEnabled ? ['session' as const] : [])] : []
  const effectiveScope: MemoryMode = effectiveScopes.includes('session') ? 'session' : effectiveScopes.includes('global') ? 'global' : 'off'
  const memoryScope = legacy ?? (sessionEnabled ? 'session' : globalEnabled ? 'global' : 'off')
  return { memoryScope, effectiveScope, enabled, globalEnabled, sessionDefaultEnabled, sessionOverride, sessionEnabled, effectiveScopes }
}

export async function setSessionMemoryEnabled(tenantId: string, sessionId: string, sessionEnabled: boolean | null): Promise<void> {
  requireSession(sessionId)
  if (sessionEnabled !== null && typeof sessionEnabled !== 'boolean') throw new Error('sessionEnabled must be boolean or null')
  const db = await database()
  await db.batch([
    { sql: `INSERT INTO memory_session_preferences (tenant_id, session_id, session_enabled, updated_at) VALUES (?, ?, ?, unixepoch())
            ON CONFLICT(tenant_id, session_id) DO UPDATE SET session_enabled = excluded.session_enabled, updated_at = unixepoch()`,
      args: [tenantId, sessionId, sessionEnabled === null ? null : Number(sessionEnabled)] },
    // A new explicit choice/inheritance reset supersedes the legacy selector.
    { sql: 'DELETE FROM memory_session_settings WHERE tenant_id = ? AND session_id = ?', args: [tenantId, sessionId] },
  ], 'write')
}

/** Compatibility only: it never enables the independent global preference. */
export async function setSessionMemoryScope(tenantId: string, sessionId: string, memoryScope: MemoryMode): Promise<void> {
  requireSession(sessionId)
  if (!isMemoryMode(memoryScope)) throw new Error('memoryScope must be off, global or session')
  const db = await database()
  await db.batch([
    { sql: `INSERT INTO memory_session_settings (tenant_id, session_id, scope, updated_at) VALUES (?, ?, ?, unixepoch())
            ON CONFLICT(tenant_id, session_id) DO UPDATE SET scope = excluded.scope, updated_at = unixepoch()`, args: [tenantId, sessionId, memoryScope] },
    { sql: `INSERT INTO memory_session_preferences (tenant_id, session_id, session_enabled, updated_at) VALUES (?, ?, ?, unixepoch())
            ON CONFLICT(tenant_id, session_id) DO UPDATE SET session_enabled = excluded.session_enabled, updated_at = unixepoch()`,
      args: [tenantId, sessionId, memoryScope === 'global' ? null : Number(memoryScope === 'session')] },
  ], 'write')
}
