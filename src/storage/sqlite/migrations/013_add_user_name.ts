import type { Client } from '@libsql/client'

export async function up(client: Client): Promise<void> {
  // 逐条执行并忽略 "duplicate column name" 错误（幂等）
  // SQLite 不支持 ALTER TABLE ... ADD COLUMN IF NOT EXISTS，
  // 只能捕获异常保证重复执行时不崩溃。
  await client.execute('ALTER TABLE users ADD COLUMN name TEXT').catch(() => {})
  await client.execute('ALTER TABLE users ADD COLUMN external_id TEXT').catch(() => {})
}
