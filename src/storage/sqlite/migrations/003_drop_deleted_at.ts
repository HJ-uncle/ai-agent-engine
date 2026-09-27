import type { Client } from '@libsql/client'

export async function up(client: Client): Promise<void> {
  const statements = [
    // Drop deleted_at from conversations
    // Note: SQLite ALTER TABLE DROP COLUMN is supported in 3.35.0+
    `ALTER TABLE conversations DROP COLUMN deleted_at`
  ]

  // wrap in try catch just in case it fails due to SQLite version or column not existing
  try {
    await client.batch(statements.map((sql) => ({ sql })), 'write')
  } catch (err: any) {
    console.warn('Migration 003: Failed to drop deleted_at, it might not exist or sqlite is too old. Error:', err.message)
  }
}

export async function down(client: Client): Promise<void> {
  const statements = [
    `ALTER TABLE conversations ADD COLUMN deleted_at INTEGER`
  ]

  try {
    await client.batch(statements.map((sql) => ({ sql })), 'write')
  } catch (err: any) {
    console.warn('Migration 003 down: Failed to add deleted_at back. Error:', err.message)
  }
}
