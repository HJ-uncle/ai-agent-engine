import type { Client } from '@libsql/client'
export async function up(db: Client): Promise<void> {
  const columns = await db.execute('PRAGMA table_info(cron_jobs)')
  if (!columns.rows.some(row => row.name === 'timeout_seconds')) await db.execute(`ALTER TABLE cron_jobs ADD COLUMN timeout_seconds INTEGER CHECK (timeout_seconds IS NULL OR (typeof(timeout_seconds) = 'integer' AND timeout_seconds >= 0))`)
}
