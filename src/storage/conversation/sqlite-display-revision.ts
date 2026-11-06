import type { Client } from '@libsql/client'

const ready = new WeakMap<Client, Promise<void>>()

/** Durable counters survive restarts and observe legacy writers without changing append semantics. */
export function ensureDisplayHistoryRevision(db: Client): Promise<void> {
  let pending = ready.get(db)
  if (!pending) {
    pending = (async () => {
      await db.execute(`CREATE TABLE IF NOT EXISTS conversation_display_revisions (
        tenant_id TEXT NOT NULL, session_id TEXT NOT NULL, identity TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (tenant_id, session_id))`)
      for (const operation of ['UPDATE', 'DELETE']) {
        await db.execute(`CREATE TRIGGER IF NOT EXISTS conversation_display_after_${operation.toLowerCase()}
          AFTER ${operation} ON conversations BEGIN
            INSERT INTO conversation_display_revisions (tenant_id,session_id,identity,revision)
            VALUES (OLD.tenant_id,OLD.session_id,lower(hex(randomblob(16))),1)
            ON CONFLICT(tenant_id,session_id) DO UPDATE SET revision=revision+1;
          END`)
      }
    })().catch(error => { ready.delete(db); throw error })
    ready.set(db, pending)
  }
  return pending
}
