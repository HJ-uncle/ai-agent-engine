import { getMemoryDb } from './db.js'
import type { ToolProfile } from '../../tools/tool-profile.js'

export type MemoryMode = 'off' | 'global' | 'session'

export function isMemoryMode(value: unknown): value is MemoryMode {
  return value === 'off' || value === 'global' || value === 'session'
}

export function defaultMemoryMode(profile?: ToolProfile): MemoryMode {
  return profile === 'code' ? 'off' : 'global'
}

function requireSession(sessionId: string): void {
  if (!sessionId?.trim()) throw new Error('sessionId is required for memory settings')
}

export async function getSessionMemorySettings(tenantId: string, sessionId: string, profile?: ToolProfile) {
  requireSession(sessionId)
  const result = await getMemoryDb().execute({
    sql: 'SELECT scope FROM memory_session_settings WHERE tenant_id = ? AND session_id = ?',
    args: [tenantId, sessionId],
  })
  const stored = result.rows[0]?.scope
  const memoryScope = isMemoryMode(stored) ? stored : defaultMemoryMode(profile)
  const enabled = process.env.ENABLE_LONG_TERM_MEMORY !== 'false'
  const effectiveScope: MemoryMode = enabled ? memoryScope : 'off'
  return { memoryScope, effectiveScope, enabled }
}

export async function setSessionMemoryScope(tenantId: string, sessionId: string, memoryScope: MemoryMode): Promise<void> {
  requireSession(sessionId)
  if (!isMemoryMode(memoryScope)) throw new Error('memoryScope must be off, global or session')
  await getMemoryDb().execute({
    sql: `INSERT INTO memory_session_settings (tenant_id, session_id, scope, updated_at)
          VALUES (?, ?, ?, unixepoch())
          ON CONFLICT(tenant_id, session_id) DO UPDATE SET scope = excluded.scope, updated_at = excluded.updated_at`,
    args: [tenantId, sessionId, memoryScope],
  })
}
