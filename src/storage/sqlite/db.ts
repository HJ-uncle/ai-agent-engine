import { createClient } from '@libsql/client'
import type { Client } from '@libsql/client'
import path from 'node:path'
import fs from 'node:fs'

let client: Client | null = null

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

  // 运行时幂等补列：兼容已有数据库（不含 tool_call_name 列的旧版本）
  // SQLite 不支持 IF NOT EXISTS，用 try/catch 静默跳过已存在的情况
  client.execute('ALTER TABLE conversations ADD COLUMN tool_call_name TEXT').catch(() => {
    // 列已存在时 SQLite 报错，静默忽略
  })

  return client
}

export function closeDb(): void {
  if (client) {
    client.close()
    client = null
  }
}
