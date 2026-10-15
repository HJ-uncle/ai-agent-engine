import { ensureControllerSchema } from './controller-origin.js'
import type { Client, InStatement } from '@libsql/client'

const prepared = new WeakMap<Client, Promise<void>>()
export function ensureSQLiteDeliverySchema(db: Client): Promise<void> {
  let pending = prepared.get(db)
  if (!pending) {
    pending = (async () => {
      await ensureControllerSchema(db)
      await db.execute(`CREATE TABLE IF NOT EXISTS collaboration_history_epochs (
        tenant_id TEXT NOT NULL, session_id TEXT NOT NULL, epoch INTEGER NOT NULL,
        PRIMARY KEY(tenant_id,session_id))`)
      await db.execute(`CREATE TABLE IF NOT EXISTS collaboration_deliveries (
        tenant_id TEXT NOT NULL, root_run_id TEXT NOT NULL, root_attempt_id TEXT NOT NULL,
        message_id TEXT NOT NULL, recipient_participant_id TEXT NOT NULL,
        recipient_invocation_run_id TEXT NOT NULL, history_session_id TEXT NOT NULL,
        history_message_id TEXT NOT NULL, history_epoch INTEGER NOT NULL,
        history_row_id INTEGER, history_conversation_id TEXT, history_model_id TEXT,
        history_identity_version INTEGER NOT NULL DEFAULT 0,
        payload_hash TEXT NOT NULL, history_content TEXT NOT NULL, history_metadata TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('integrated','suppressed')), reason TEXT,
        integrated_at INTEGER NOT NULL,
        PRIMARY KEY(tenant_id,root_run_id,root_attempt_id,message_id),
        UNIQUE(tenant_id,history_session_id,history_message_id))`)
      // An older receipt cannot be authenticated by inspecting the row that
      // happens to occupy its readable ID today. Migration leaves identity 0.
      const tx = await db.transaction('write')
      try {
        const columns = new Set((await tx.execute('PRAGMA table_info(collaboration_deliveries)')).rows.map(row => String(row.name)))
        for (const [name, definition] of [
          ['history_row_id', 'INTEGER'], ['history_conversation_id', 'TEXT'],
          ['history_model_id', 'TEXT'], ['history_identity_version', 'INTEGER NOT NULL DEFAULT 0'],
        ]) {
          if (!columns.has(name)) await tx.execute(`ALTER TABLE collaboration_deliveries ADD COLUMN ${name} ${definition}`)
        }
        await tx.commit()
      } catch (error) { if (!tx.closed) await tx.rollback().catch(() => undefined); throw error }
      finally { tx.close() }
      await db.execute(`CREATE INDEX IF NOT EXISTS collaboration_deliveries_recipient
        ON collaboration_deliveries(tenant_id,root_run_id,root_attempt_id,recipient_participant_id,message_id)`)
      // Legacy tables can lack the original UNIQUE history key. Keep suppressed
      // origin exclusion indexed without treating duplicate receipts as trusted.
      await db.execute(`CREATE INDEX IF NOT EXISTS collaboration_deliveries_history
        ON collaboration_deliveries(tenant_id,history_session_id,history_message_id,state)`)
    })().catch(error => { prepared.delete(db); throw error })
    prepared.set(db, pending)
  }
  return pending
}

/** These statements must precede the edit/delete in the very same write transaction. */
export function invalidateSQLiteDeliveryStatements(selector: InStatement): InStatement[] {
  if (typeof selector === 'string') throw new Error('A parameterized history scope is required')
  const selected = selector.sql, args = selector.args ?? []
  return [
    { sql: `INSERT OR IGNORE INTO collaboration_history_epochs(tenant_id,session_id,epoch)
      SELECT tenant_id,session_id,0 FROM (${selected})`, args },
    { sql: `UPDATE collaboration_history_epochs SET epoch=epoch+1
      WHERE (tenant_id,session_id) IN (${selected})`, args },
    { sql: `UPDATE collaboration_deliveries SET state='suppressed',reason='history_changed'
      WHERE (tenant_id,history_session_id) IN (${selected}) AND state='integrated'`, args },
  ]
}

export const sqliteHistoryScope = (tenantId: string, sessionId: string): InStatement => ({
  sql: 'SELECT ? AS tenant_id,? AS session_id', args: [tenantId, sessionId],
})
