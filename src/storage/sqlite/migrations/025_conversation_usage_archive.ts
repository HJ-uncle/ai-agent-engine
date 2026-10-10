import type { Client } from '@libsql/client'

/** Compaction changes context rows, but cannot erase retained call billing. */
export async function up(db: Client): Promise<void> {
  // Databases predating message IDs still need stable receipt identities;
  // otherwise retaining a legacy row after compaction counts it twice.
  await db.execute({ sql: `UPDATE conversations SET message_id='legacy-sqlite-' || lower(hex(randomblob(16)))
    WHERE message_id IS NULL OR message_id=''` })
  await db.execute({ sql: `CREATE TABLE IF NOT EXISTS conversation_usage_archive (
    tenant_id TEXT NOT NULL, session_id TEXT NOT NULL, message_id TEXT NOT NULL,
    conversation_id TEXT, row_id INTEGER NOT NULL, token_usage TEXT NOT NULL,
    PRIMARY KEY (tenant_id, session_id, message_id)
  )` })
  await db.execute({ sql: 'CREATE INDEX IF NOT EXISTS idx_usage_archive_turn ON conversation_usage_archive(tenant_id, session_id, conversation_id)' })
}
