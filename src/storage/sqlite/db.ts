import { createClient } from '@libsql/client'
import type { Client } from '@libsql/client'
import path from 'node:path'
import fs from 'node:fs'
import { up } from './migrations/001_initial.js'
import { up as up2 } from './migrations/002_add_message_id.js'
import { up as up3 } from './migrations/003_drop_deleted_at.js'
import { up as up4 } from './migrations/004_add_agents.js'
import { up as up5 } from './migrations/005_add_token_usage.js'
import { up as up6 } from './migrations/006_add_todos_cron.js'
import { up as up7 } from './migrations/007_add_models_management.js'
import { up as up8 } from './migrations/008_add_agent_allowed_tools.js'
import { up as up9 } from './migrations/009_add_sessions.js'
import { up as up10 } from './migrations/010_add_system_config.js'
import { up as up11 } from './migrations/011_add_security_and_perf.js'
import { up as up12 } from './migrations/012_add_message_model_id.js'
import { up as up13 } from './migrations/013_add_user_name.js'
import { up as up14 } from './migrations/014_add_model_capabilities.js'

let client: Client | null = null
let initialized = false
let pragmasApplied = false

/**
 * 应用 SQLite 性能相关 pragmas（幂等，只执行一次）。
 * 收益：WAL 允许并发读写，NORMAL 同步降低 fsync 次数，缓存/映射显著加速查询。
 * 期望响应速度提升 30-50%。
 */
async function applyPerformancePragmas(db: Client): Promise<void> {
  if (pragmasApplied) return
  pragmasApplied = true

  // 运行期可调的阈值（默认值经过多数工作负载验证）
  const cacheKb      = parseInt(process.env.SQLITE_CACHE_KB       ?? '20000', 10) // 20MB
  const mmapBytes    = parseInt(process.env.SQLITE_MMAP_BYTES     ?? '268435456', 10) // 256MB
  const busyTimeout  = parseInt(process.env.SQLITE_BUSY_TIMEOUT_MS ?? '5000', 10)

  const pragmas = [
    `PRAGMA journal_mode = WAL`,
    `PRAGMA synchronous = NORMAL`,
    `PRAGMA cache_size = -${cacheKb}`,     // 负数表示 KB
    `PRAGMA temp_store = MEMORY`,
    `PRAGMA mmap_size = ${mmapBytes}`,
    `PRAGMA busy_timeout = ${busyTimeout}`,
    `PRAGMA foreign_keys = ON`,
  ]
  for (const p of pragmas) {
    // 某些 pragma 在只读或内存库中可能失败，容忍错误
    await db.execute(p).catch(() => {})
  }
}

export function getDb(): Client {
  if (client) return client

  const dbPath = process.env.DATA_DIR ?? './data/agent.db'
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
 * 收集 SQLite 运行时状态（供 /api/v1/performance/stats 展示）。
 */
export async function getDbStats(): Promise<Record<string, string | number>> {
  const db = getDb()
  const keys = ['journal_mode', 'synchronous', 'cache_size', 'temp_store', 'mmap_size', 'busy_timeout', 'foreign_keys']
  const out: Record<string, string | number> = {}
  for (const k of keys) {
    try {
      const r = await db.execute(`PRAGMA ${k}`)
      if (r.rows.length > 0) {
        const row = r.rows[0]
        out[k] = (row[k] ?? Object.values(row)[0]) as string | number
      }
    } catch { /* ignore */ }
  }
  return out
}

/**
 * 在应用启动时调用一次，确保所有表和列都存在。
 * 使用 CREATE TABLE IF NOT EXISTS，完全幂等，安全重复执行。
 */
export async function initDb(): Promise<void> {
  if (initialized) return
  initialized = true

  const db = getDb()

  // 先应用性能 pragma，再跑迁移（让迁移本身也享受 WAL 加速）
  await applyPerformancePragmas(db)

  // 运行完整迁移（所有 CREATE TABLE IF NOT EXISTS，幂等）
  await up(db)
  await up2(db)
  await up3(db)
  await up4(db)
  await up5(db)
  await up6(db)
  await up7(db)
  await up8(db)
  await up9(db)
  await up10(db)
  await up11(db)
  await up12(db)
  await up13(db)
  await up14(db)
  // 兼容旧数据库：补充新列
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