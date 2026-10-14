import type { Client } from '@libsql/client'
import { ensureHistoryMaintenanceSchema } from './history-maintenance.js'

const prepared = new WeakMap<Client, Promise<void>>()
export function ensureJSONLDeliverySchema(db: Client): Promise<void> {
  let pending = prepared.get(db)
  if (!pending) {
    pending = (async () => {
      await db.execute(`CREATE TABLE IF NOT EXISTS collaboration_jsonl_epochs (
        tenant_id TEXT NOT NULL,session_id TEXT NOT NULL,epoch INTEGER NOT NULL,
        PRIMARY KEY(tenant_id,session_id))`)
      await db.execute(`CREATE TABLE IF NOT EXISTS collaboration_jsonl_deliveries (
        tenant_id TEXT NOT NULL,root_run_id TEXT NOT NULL,root_attempt_id TEXT NOT NULL,message_id TEXT NOT NULL,
        recipient_participant_id TEXT NOT NULL,recipient_invocation_run_id TEXT NOT NULL,
        history_session_id TEXT NOT NULL,history_message_id TEXT NOT NULL,history_epoch INTEGER NOT NULL,
        file_identity TEXT NOT NULL,row_offset INTEGER NOT NULL,row_bytes INTEGER NOT NULL,row_hash TEXT NOT NULL,
        encoded_row TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('pending','integrated','suppressed')),
        reason TEXT,integrated_at INTEGER,
        PRIMARY KEY(tenant_id,root_run_id,root_attempt_id,message_id),UNIQUE(tenant_id,history_session_id,history_message_id))`)
      await db.execute(`CREATE INDEX IF NOT EXISTS collaboration_jsonl_deliveries_history
        ON collaboration_jsonl_deliveries(tenant_id,history_session_id,history_message_id,state)`)
    })().catch(error => { prepared.delete(db); throw error })
    prepared.set(db, pending)
  }
  return pending
}

/** SQL commits before file mutation: uncertain filesystem writes revoke old authority. */
export async function invalidateJSONLDeliveries(db: Client, scope: { tenantId: string; sessionId: string }): Promise<void> {
  await ensureJSONLDeliverySchema(db)
  await ensureHistoryMaintenanceSchema(db)
  const tx = await db.transaction('write')
  try {
    await tx.execute({ sql: `INSERT INTO collaboration_jsonl_epochs VALUES(?,?,1)
      ON CONFLICT(tenant_id,session_id) DO UPDATE SET epoch=epoch+1`, args: [scope.tenantId, scope.sessionId] })
    await tx.execute({ sql: `UPDATE collaboration_jsonl_deliveries SET state='suppressed',reason='history_changed'
      WHERE tenant_id=? AND history_session_id=? AND state IN ('pending','integrated')`, args: [scope.tenantId, scope.sessionId] })
    await tx.execute({ sql: `UPDATE collaboration_history_maintenance SET state='invalidated'
      WHERE tenant_id=? AND session_id=? AND backend='jsonl' AND state='pending'`, args: [scope.tenantId, scope.sessionId] })
    await tx.commit()
  } catch (error) { if (!tx.closed) await tx.rollback().catch(() => undefined); throw error }
  finally { tx.close() }
}
