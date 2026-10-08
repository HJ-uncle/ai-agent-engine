import type { Client } from '@libsql/client'

export async function up(db: Client): Promise<void> {
  const result = await db.execute('PRAGMA table_info(account_identities)')
  const columns = new Set(result.rows.map(row => String(row.name)))
  for (const name of ['name', 'email', 'avatar_url']) {
    if (!columns.has(name)) await db.execute('ALTER TABLE account_identities ADD COLUMN ' + name + ' TEXT')
  }
}
