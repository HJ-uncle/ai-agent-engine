import { createClient } from '@libsql/client'
import type { Client } from '@libsql/client'
import path from 'node:path'
import fs from 'node:fs'
import { up } from './migrations/001_initial.js'
import { up as up2 } from './migrations/002_add_message_id.js'
import { up as up3 } from './migrations/003_drop_deleted_at.js'
import { up as up4 } from './migrations/004_add_agents.js'
import { up as up5 } from './migrations/005_add_token_usage.js'
import { up as up6 } from './migrations/006_add_models_management.js'

let client: Client | null = null
let initialized = false

export function getDb(): Client {
  if (client) return client

  const dbPath = process.env.DB_PATH ?? './data/agent.db'
  const dbDir = path.dirname(path.resolve(dbPath))

  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true })
  }

  // @libsql/client uses file: prefix for local SQLite
  const url = `file:${path.resolve(dbPath)}`
  client = createClient({ url })

  return client
}

/**
 * 在应用启动时调用一次，确保所有表和列都存在。
 * 使用 CREATE TABLE IF NOT EXISTS，完全幂等，安全重复执行。
 */
export async function initDb(): Promise<void> {
  if (initialized) return
  initialized = true

  const db = getDb()

  // 运行完整迁移（所有 CREATE TABLE IF NOT EXISTS，幂等）
  await up(db)
  await up2(db)
  await up3(db)
  await up4(db)
  await up5(db)
  await up6(db)
  // 兼容旧数据库：补充新列（ALTER TABLE 不支持 IF NOT EXISTS，用 catch 静默跳过）
  await db.execute('ALTER TABLE conversations ADD COLUMN tool_call_name TEXT').catch(() => {})
  await db.execute('ALTER TABLE conversations ADD COLUMN conversation_id TEXT').catch(() => {})
  await db.execute('ALTER TABLE conversations ADD COLUMN token_usage TEXT').catch(() => {})
  await db.execute('ALTER TABLE conversations ADD COLUMN reasoning_content TEXT').catch(() => {})

  // 在列补充完成后再建索引（避免旧库 CREATE TABLE IF NOT EXISTS 跳过时列还不存在）
  await db.execute(
    'CREATE INDEX IF NOT EXISTS idx_conversations_conv_id ON conversations(conversation_id)',
  ).catch(() => {})
}

export function closeDb(): void {
  if (client) {
    client.close()
    client = null
  }
}
