import type { Client } from '@libsql/client'
import { getDb } from '../sqlite/db.js'
import { normalizeToolkits, type ToolkitId } from '../../tools/toolkits.js'

const schemas = new WeakMap<Client, Promise<void>>()
export function ensureSessionToolkitsSchema(db: Client): Promise<void> {
  let pending = schemas.get(db)
  if (!pending) {
    pending = db.execute(`CREATE TABLE IF NOT EXISTS session_toolkits (
      tenant_id TEXT NOT NULL, session_id TEXT NOT NULL, toolkits TEXT NOT NULL,
      PRIMARY KEY (tenant_id, session_id))`).then(() => {}).catch(error => { schemas.delete(db); throw error })
    schemas.set(db, pending)
  }
  return pending
}

export async function getSessionToolkits(tenantId: string, sessionId: string, db = getDb()): Promise<ToolkitId[]> {
  await ensureSessionToolkitsSchema(db)
  const row = (await db.execute({ sql: 'SELECT toolkits FROM session_toolkits WHERE tenant_id=? AND session_id=?', args: [tenantId, sessionId] })).rows[0]
  return row ? normalizeToolkits(JSON.parse(String(row.toolkits)))! : []
}

/** Called inside root admission's transaction; rejected/duplicate submissions never change settings. */
export async function persistSessionToolkits(db: Pick<Client, 'execute'>, tenantId: string, sessionId: string, request: Record<string, unknown>): Promise<void> {
  if (request.toolkits === undefined || request.automationRunId !== undefined || request.toolProfile === 'code') return
  const selected = normalizeToolkits(request.toolkits)!
  await db.execute({ sql: 'INSERT INTO session_toolkits(tenant_id,session_id,toolkits) VALUES(?,?,?) ON CONFLICT(tenant_id,session_id) DO UPDATE SET toolkits=excluded.toolkits',
    args: [tenantId, sessionId, JSON.stringify(selected)] })
}

export async function clearSessionToolkits(tenantId: string, sessionId: string, db = getDb()): Promise<void> {
  await ensureSessionToolkitsSchema(db)
  await db.execute({ sql: 'DELETE FROM session_toolkits WHERE tenant_id=? AND session_id=?', args: [tenantId, sessionId] })
}
