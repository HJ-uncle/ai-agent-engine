import type { Client } from '@libsql/client'

export async function up(client: Client): Promise<void> {
  const statements = [
    // Add message_id to conversations
    `ALTER TABLE conversations ADD COLUMN message_id TEXT`,
    // Add deleted_at to conversations
    `ALTER TABLE conversations ADD COLUMN deleted_at INTEGER`,
    // Create an index for faster lookup by message_id
    `CREATE INDEX IF NOT EXISTS idx_conversations_message_id ON conversations(message_id)`
  ]

  await client.batch(statements.map((sql) => ({ sql })), 'write')
}

export async function down(client: Client): Promise<void> {
  // SQLite ALTER TABLE DROP COLUMN is supported in newer versions,
  // but for safety in older versions, we might need a table recreation.
  // Assuming SQLite 3.35.0+ which supports DROP COLUMN.
  const statements = [
    `DROP INDEX IF EXISTS idx_conversations_message_id`,
    `ALTER TABLE conversations DROP COLUMN message_id`,
    `ALTER TABLE conversations DROP COLUMN deleted_at`
  ]

  await client.batch(statements.map((sql) => ({ sql })), 'write')
}
