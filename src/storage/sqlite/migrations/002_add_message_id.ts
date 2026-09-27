import type { Client } from '@libsql/client'

export async function up(client: Client): Promise<void> {
  // Use try-catch for ALTER TABLE to handle duplicate column errors gracefully
  // Since SQLite does not support ALTER TABLE ADD COLUMN IF NOT EXISTS
  
  try {
    await client.execute(`ALTER TABLE conversations ADD COLUMN message_id TEXT`)
  } catch (err: any) {
    if (!err.message?.includes('duplicate column name')) {
      throw err
    }
  }

  try {
    await client.execute(`ALTER TABLE conversations ADD COLUMN deleted_at INTEGER`)
  } catch (err: any) {
    if (!err.message?.includes('duplicate column name')) {
      throw err
    }
  }

  try {
    await client.execute(`CREATE INDEX IF NOT EXISTS idx_conversations_message_id ON conversations(message_id)`)
  } catch (err: any) {
    // Ignore index creation errors if they occur
  }
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
