import type { Client } from '@libsql/client'

export async function up(client: Client): Promise<void> {
  // Modern databases already lack this retired column. Checking metadata
  // keeps subsequent startups free of unnecessary schema changes.
  const columns = await client.execute('PRAGMA table_info(conversations)')
  if (!columns.rows.some(row => row.name === 'deleted_at')) return

  // A real legacy column still needs migration. Dependency, lock and I/O
  // errors must reach initialization rather than leave an unknown schema.
  await client.execute('ALTER TABLE conversations DROP COLUMN deleted_at')
}

export async function down(client: Client): Promise<void> {
  const columns = await client.execute('PRAGMA table_info(conversations)')
  if (columns.rows.some(row => row.name === 'deleted_at')) return
  await client.execute('ALTER TABLE conversations ADD COLUMN deleted_at INTEGER')
}
