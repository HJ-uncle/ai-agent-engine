import type { Client } from '@libsql/client'

/** Existing connections keep automatic routing until the user chooses a wire format. */
export async function up(client: Client): Promise<void> {
  const columns = await client.execute('PRAGMA table_info(models)')
  if (columns.rows.some(column => column.name === 'api_format')) return
  await client.execute("ALTER TABLE models ADD COLUMN api_format TEXT NOT NULL DEFAULT 'auto' CHECK (api_format IN ('auto', 'openai', 'anthropic'))")
}
