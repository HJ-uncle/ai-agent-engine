/**
 * storage/memory/db.ts — 独立记忆数据库（图谱 Schema）
 *
 * 兼容 libsql 本地 / Turso 云两种后端：
 * - F32_BLOB 在 Turso 和较新 libsql 本地客户端中可用
 * - 老旧 libsql 本地客户端不支持 F32_BLOB 时自动回退到 BLOB
 */
import { LocalSqliteProcessClient } from '../sqlite/local-process-client.js'
import type { Client } from '@libsql/client'
import path from 'node:path'
import fs from 'node:fs'

let client: LocalSqliteProcessClient | null = null
let initialization: Promise<void> | null = null

export function resolveMemoryDbPath(): string {
  // DATA_DIR 语义与主 DB 对齐：始终视为 SQLite 数据库**文件**路径
  //   客户端传值：path.join(dataDir, 'agent.db') → /path/to/data/agent.db
  //   默认回退值：'./data/agent.db'
  // 通过 path.dirname 取出其所在目录，memory.db 写入同级 memory/ 子目录
  const dbFilePath = process.env.DATA_DIR ?? './data/agent.db'
  const dataDir = path.dirname(path.resolve(dbFilePath))
  const memoryDir = path.join(dataDir, 'memory')
  fs.mkdirSync(memoryDir, { recursive: true })
  return path.join(memoryDir, 'memory.db')
}

export function getMemoryDb(): Client {
  if (client && !client.closed) return client
  if (client?.closed) { client = null; initialization = null }
  client = new LocalSqliteProcessClient({ url: `file:${resolveMemoryDbPath()}` }, { cacheKb: 2000, mmapBytes: 0 })
  return client
}

/**
 * 尝试执行 SQL，如果失败且涉及 F32_BLOB，自动回退到 BLOB 版本
 */
async function tryExecuteWithF32BlobFallback(db: Client, sql: string): Promise<void> {
  try {
    await db.execute(sql)
  } catch (err) {
    const msg = (err as Error)?.message ?? ''
    // 检测 F32_BLOB 或 vector 相关不支持
    const isF32BlobIssue =
      sql.toUpperCase().includes('F32_BLOB') ||
      msg.toUpperCase().includes('F32_BLOB') ||
      msg.includes('no such function') ||
      msg.includes('syntax error')

    if (isF32BlobIssue) {
      // F32_BLOB / vector32 在当前 libsql 本地后端不支持，回退到 BLOB
      const fallback = sql
        .replace(/\bF32_BLOB\(\d+\)/gi, 'BLOB')
        .replace(/libsql_vector_idx\([\w]+\)/gi, 'embedding')
      console.warn('[memory-db] F32_BLOB not supported, falling back to BLOB for this statement')
      await db.execute(fallback).catch((e2) => {
        console.warn('[memory-db] fallback statement also failed:', (e2 as Error)?.message)
      })
    } else {
      console.warn('[memory-db] schema statement warning:', msg)
    }
  }
}

export function initMemoryDb(schemaStatements: string[]): Promise<void> {
  const db = getMemoryDb()
  if (initialization) return initialization
  const pending = initializeMemorySchema(db, schemaStatements).catch(error => {
    if (initialization === pending) initialization = null
    throw error
  })
  initialization = pending
  return pending
}

async function initializeMemorySchema(db: Client, schemaStatements: string[]): Promise<void> {
  // PRAGMA 非关键，失败忽略
  await Promise.all([
    db.execute('PRAGMA journal_mode = WAL').catch(() => {}),
    db.execute('PRAGMA synchronous = NORMAL').catch(() => {}),
    db.execute('PRAGMA foreign_keys = ON').catch(() => {}),
  ])

  // Schema statements must run in declaration order.  The memory graph has
  // indexes and foreign keys that depend on the tables declared immediately
  // before them.  Splitting statements into a normal batch and a fallback
  // batch (the old implementation) reordered those dependencies: SQLite
  // rejected the first index on `memory_nodes`, rolled back the whole batch,
  // and left the graph only partially initialized on machines without the
  // vector extension.  Execute each statement in order and apply the F32_BLOB
  // fallback per statement so a single optional vector feature cannot erase
  // the rest of the schema.
  for (const sql of schemaStatements) {
    await tryExecuteWithF32BlobFallback(db, sql)
  }

  // Older installations pre-date scoped memories.  Keep their data visible in
  // the global scope while adding the columns lazily (SQLite does not support
  // `ADD COLUMN IF NOT EXISTS`).  This migration is deliberately idempotent so
  // a process restart cannot change existing records.
  await migrateMemoryScopes(db)

  console.log('[memory-db] Schema initialization complete')
}

async function migrateMemoryScopes(db: Client): Promise<void> {
  const columns = async (table: string): Promise<Set<string>> => {
    const result = await db.execute(`PRAGMA table_info(${table})`)
    return new Set(result.rows.map((row) => String(row.name)))
  }

  const nodeColumns = await columns('memory_nodes')
  if (!nodeColumns.has('embedding_space')) {
    await db.execute('ALTER TABLE memory_nodes ADD COLUMN embedding_space TEXT')
  }
  if (!nodeColumns.has('scope')) {
    await db.execute("ALTER TABLE memory_nodes ADD COLUMN scope TEXT NOT NULL DEFAULT 'global'")
  }
  // Existing rows were created before scopes existed and are intentionally
  // treated as global memories.  Do not infer scope from the legacy session_id.
  await db.execute("UPDATE memory_nodes SET scope = 'global' WHERE scope IS NULL OR scope NOT IN ('global','session')")

  const edgeColumns = await columns('memory_edges')
  if (!edgeColumns.has('scope')) {
    await db.execute("ALTER TABLE memory_edges ADD COLUMN scope TEXT NOT NULL DEFAULT 'global'")
  }
  if (!edgeColumns.has('session_id')) {
    await db.execute("ALTER TABLE memory_edges ADD COLUMN session_id TEXT NOT NULL DEFAULT ''")
  }
  await db.execute("UPDATE memory_edges SET scope = 'global', session_id = '' WHERE scope IS NULL OR scope NOT IN ('global','session')")

  await db.execute('CREATE INDEX IF NOT EXISTS idx_memory_nodes_scope ON memory_nodes(tenant_id, scope, session_id)')
  await db.execute('CREATE INDEX IF NOT EXISTS idx_memory_edges_scope ON memory_edges(tenant_id, scope, session_id)')
  await db.execute('CREATE INDEX IF NOT EXISTS idx_memory_edges_source_scope ON memory_edges(tenant_id, scope, source_node_id, session_id)')
  await db.execute('CREATE INDEX IF NOT EXISTS idx_memory_edges_target_scope ON memory_edges(tenant_id, scope, target_node_id, session_id)')
}

/** Clear ownership immediately; callers cleaning up files can await native handle release. */
export function closeMemoryDb(): Promise<void> {
  const previous = client
  client = null
  initialization = null
  previous?.close()
  return previous?.whenClosed() ?? Promise.resolve()
}
