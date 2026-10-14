import type { Client } from '@libsql/client'

/** Identity-only fences outlive user transcript deletion and outbox ACK loss. */
export async function up(db: Client): Promise<void> {
  await db.execute(`CREATE TABLE IF NOT EXISTS conversation_projection_receipts (
    tenant_id TEXT NOT NULL, session_id TEXT NOT NULL, message_id TEXT NOT NULL,
    anchor_message_id TEXT NOT NULL, anchor_tool_call_id TEXT NOT NULL, anchor_conversation_id TEXT NOT NULL,
    backend TEXT NOT NULL CHECK(backend IN ('sqlite','jsonl')),
    disposition TEXT NOT NULL CHECK(disposition IN ('pending','appended','suppressed')),
    reservation_epoch INTEGER NOT NULL DEFAULT 0,
    anchor_sequence INTEGER,
    PRIMARY KEY(tenant_id, session_id, message_id)
  )`)
  await db.execute(`CREATE TABLE IF NOT EXISTS conversation_projection_epochs (
    tenant_id TEXT NOT NULL, session_id TEXT NOT NULL, epoch INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(tenant_id, session_id)
  )`)
}
