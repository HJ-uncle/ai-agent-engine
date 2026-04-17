import type { MemoryStore } from '../../core/agent-context/index.js'
import { getDb } from '../sqlite/db.js'

type Ctx = { tenantId: string; sessionId: string }

export class SQLiteMemoryStore implements MemoryStore {
  async remember(key: string, value: string, ctx: Ctx): Promise<void> {
    const db = getDb()
    await db.execute({
      sql: `INSERT INTO memories (tenant_id, session_id, key, value, updated_at)
            VALUES (?, ?, ?, ?, unixepoch())
            ON CONFLICT(tenant_id, session_id, key)
            DO UPDATE SET value = excluded.value, updated_at = unixepoch()`,
      args: [ctx.tenantId, ctx.sessionId, key, value],
    })
  }

  async recall(key: string, ctx: Ctx): Promise<string | null> {
    const db = getDb()
    const result = await db.execute({
      sql: 'SELECT value FROM memories WHERE tenant_id = ? AND session_id = ? AND key = ?',
      args: [ctx.tenantId, ctx.sessionId, key],
    })
    const row = result.rows[0]
    return row ? (row['value'] as string) : null
  }

  async list(ctx: Ctx): Promise<string[]> {
    const db = getDb()
    const result = await db.execute({
      sql: 'SELECT key FROM memories WHERE tenant_id = ? AND session_id = ? ORDER BY updated_at DESC',
      args: [ctx.tenantId, ctx.sessionId],
    })
    return result.rows.map((r) => r['key'] as string)
  }

  async forget(key: string, ctx: Ctx): Promise<void> {
    const db = getDb()
    await db.execute({
      sql: 'DELETE FROM memories WHERE tenant_id = ? AND session_id = ? AND key = ?',
      args: [ctx.tenantId, ctx.sessionId, key],
    })
  }
}
