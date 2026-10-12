import type { Client } from '@libsql/client'

export async function up(client: Client): Promise<void> {
  // deleted_at was retired by migration 003. Reintroducing it here causes
  // unnecessary paired ADD/DROP schema changes at every startup.
  try {
    await client.execute('ALTER TABLE conversations ADD COLUMN message_id TEXT')
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('duplicate column name')) {
      throw error
    }
  }

  await client.execute('CREATE INDEX IF NOT EXISTS idx_conversations_message_id ON conversations(message_id)')
}

export async function down(client: Client): Promise<void> {
  // Old versions of 002 also introduced deleted_at; current versions do not.
  // Rollback must work for both without treating a missing column as failure.
  const columns = await client.execute('PRAGMA table_info(conversations)')
  const names = new Set(columns.rows.map(row => row.name))
  const statements = ['DROP INDEX IF EXISTS idx_conversations_message_id']
  if (names.has('message_id')) statements.push('ALTER TABLE conversations DROP COLUMN message_id')
  if (names.has('deleted_at')) statements.push('ALTER TABLE conversations DROP COLUMN deleted_at')
  await client.batch(statements.map(sql => ({ sql })), 'write')
}
