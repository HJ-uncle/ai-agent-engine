import type { Client } from '@libsql/client'
export async function up(db: Client): Promise<void> {
  const columns = await db.execute('PRAGMA table_info(cron_jobs)')
  if (!columns.rows.some(row => row.name === 'thinking_mode')) await db.execute('ALTER TABLE cron_jobs ADD COLUMN thinking_mode TEXT')
}
