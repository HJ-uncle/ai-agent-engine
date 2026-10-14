import { up as up29 } from './migrations/029_cron_automation.js'
import { up as up30 } from './migrations/030_conversation_projection_receipts.js'
import { up as up28 } from './migrations/028_task_plans.js'
import { up as up27 } from './migrations/027_cron_timeout.js'
import type { Client } from '@libsql/client'
import { repairLegacyCronTimeoutSchema } from './schema-compatibility.js'
import { LocalSqliteProcessClient, SqliteCloseLedger, getLocalSqliteEpoch, type SqliteDatabaseCloseReceipt } from './local-process-client.js'
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
import { up as up15 } from './migrations/015_add_metadata.js'
import { up as up16 } from './migrations/016_add_tenant_configs.js'
import { up as up17 } from './migrations/017_add_skill_imports.js'
import { up as up18 } from './migrations/018_skill_imports_scope.js'
import { up as up19 } from './migrations/019_subagent_runs.js'
import { up as up20 } from './migrations/020_skill_import_identity.js'

import { up as up21 } from './migrations/021_accounts.js'
import { up as up22 } from './migrations/022_account_external_flows.js'
import { up as up23 } from './migrations/023_account_access_tokens.js'
import { up as up24 } from './migrations/024_account_identity_profiles.js'
import { up as up26 } from './migrations/026_cron_thinking_mode.js'
import { up as up25 } from './migrations/025_conversation_usage_archive.js'

let client: LocalSqliteProcessClient | null = null
let initialization: Promise<void> | null = null
let closingReceipt: Promise<SqliteDatabaseCloseReceipt | null> | null = null
const closeLedger = new SqliteCloseLedger()

/** Unknown adapters do not acquire execution authority by claiming a source epoch. */
export function getDbEpoch(db: Client): number | undefined {
  return getLocalSqliteEpoch(db)
}

export function getDb(): Client {
  if (client && !client.closed) return client
  if (client?.closed) {
    closingReceipt = closeLedger.retire(client)
    client = null; initialization = null
  }

  const dbPath = process.env.DATA_DIR ?? './data/agent.db'
  const dbDir = path.dirname(path.resolve(dbPath))

  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true })
  }

  // @libsql/client uses file: prefix for local SQLite
  const url = `file:${path.resolve(dbPath)}`
  client = new LocalSqliteProcessClient({ url }, {
    cacheKb: Number(process.env.SQLITE_CACHE_KB ?? 20000),
    mmapBytes: Number(process.env.SQLITE_MMAP_BYTES ?? 268435456),
    busyTimeoutMs: Number(process.env.SQLITE_BUSY_TIMEOUT_MS ?? 5000),
    readyAfter: closingReceipt?.then(() => {}),
  })

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
export function initDb(): Promise<void> {
  const db = getDb()
  if (initialization) return initialization
  const pending = initializeSchema(db).catch(error => {
    if (initialization === pending) initialization = null
    throw error
  })
  initialization = pending
  return pending
}

async function initializeSchema(db: Client): Promise<void> {
  // 运行完整迁移（所有 CREATE TABLE IF NOT EXISTS，幂等）
  await repairLegacyCronTimeoutSchema(db)
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
  await up15(db)
  await up16(db)
  await up17(db)
  await up18(db)
  await up19(db)
  await up20(db)
  await up21(db)
  await up22(db)
  await up23(db)
  await up24(db)
  await up25(db)
  await up26(db)
    await up27(db)
  await up28(db)
  await up29(db)
  await up30(db)
  // 兼容旧数据库：补充新列
  // 必须串行执行并单独捕获异常。SQLite 不支持 ALTER TABLE ADD COLUMN IF NOT EXISTS，
  // 若使用 batch 批量执行，当遇到已存在的列时会抛出异常，导致事务回滚并中断后续的列补充，引发严重的数据不一致隐患。
  await db.execute('ALTER TABLE conversations ADD COLUMN tool_call_name TEXT').catch(() => {})
  await db.execute('ALTER TABLE conversations ADD COLUMN conversation_id TEXT').catch(() => {})
  await db.execute('ALTER TABLE conversations ADD COLUMN token_usage TEXT').catch(() => {})
  await db.execute('ALTER TABLE conversations ADD COLUMN reasoning_content TEXT').catch(() => {})
  await db.execute('ALTER TABLE conversations ADD COLUMN model_id TEXT').catch(() => {})
  await db.execute('ALTER TABLE conversations ADD COLUMN metadata TEXT').catch(() => {})
  await db.execute('ALTER TABLE sessions ADD COLUMN metadata TEXT').catch(() => {})

  // 在列补充完成后再建索引（避免旧库 CREATE TABLE IF NOT EXISTS 跳过时列还不存在）
  await db.execute(
    'CREATE INDEX IF NOT EXISTS idx_conversations_conv_id ON conversations(conversation_id)',
  ).catch(() => {})
}

export function closeDb(): Promise<SqliteDatabaseCloseReceipt | null> {
  initialization = null
  if (client) {
    const previous = client
    client = null
    closingReceipt = closeLedger.retire(previous)
  }
  return closingReceipt ?? Promise.resolve(null)
}
