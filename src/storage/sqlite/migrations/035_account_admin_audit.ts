import type { Client } from '@libsql/client'

// Business mutations and their durable audit receipt must survive the same commit even with WAL.
export async function up(db: Client): Promise<void> {
  await db.execute(`CREATE TABLE IF NOT EXISTS account_admin_audit_outbox (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, at TEXT NOT NULL,
    actor_id TEXT NOT NULL, actor_name TEXT NOT NULL, role_id TEXT NOT NULL, action TEXT NOT NULL,
    target_id TEXT, outcome TEXT NOT NULL, reason TEXT, request_id TEXT NOT NULL, changes TEXT
  )`)
}
