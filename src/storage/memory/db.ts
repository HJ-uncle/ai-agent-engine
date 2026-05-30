/**
 * storage/memory/db.ts — 独立记忆数据库（图谱 Schema）
 *
 * 兼容 libsql 本地 / Turso 云两种后端：
 * - F32_BLOB 在 Turso 和较新 libsql 本地客户端中可用
 * - 老旧 libsql 本地客户端不支持 F32_BLOB 时自动回退到 BLOB
 */
import { createClient } from '@libsql/client'
import type { Client } from '@libsql/client'
import path from 'node:path'
import fs from 'node:fs'

let client: Client | null = null
let initialized = false

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
  if (client) return client
  client = createClient({ url: `file:${resolveMemoryDbPath()}` })
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

export async function initMemoryDb(schemaStatements: string[]): Promise<void> {
  if (initialized) return
  initialized = true

  const db = getMemoryDb()

  // PRAGMA 非关键，失败忽略
  await Promise.all([
    db.execute('PRAGMA journal_mode = WAL').catch(() => {}),
    db.execute('PRAGMA synchronous = NORMAL').catch(() => {}),
    db.execute('PRAGMA foreign_keys = ON').catch(() => {}),
  ])

  // 将语句分为「普通」和「需回退」两类
  const normalStatements: string[] = []
  const fallbackStatements: string[] = []

  for (const sql of schemaStatements) {
    if (sql.toUpperCase().includes('F32_BLOB') || sql.toUpperCase().includes('LIBSQL_VECTOR_IDX')) {
      fallbackStatements.push(sql)
    } else {
      normalStatements.push(sql)
    }
  }

  // 1. 普通语句批量执行（效率最高）
  if (normalStatements.length > 0) {
    await db.batch(normalStatements.map(sql => ({ sql })), 'write').catch((err) => {
      console.warn('[memory-db] batch schema warning:', (err as Error)?.message)
    })
  }

  // 2. 需回退语句逐条执行
  for (const sql of fallbackStatements) {
    await tryExecuteWithF32BlobFallback(db, sql)
  }

  console.log('[memory-db] Schema initialization complete')
}

export function closeMemoryDb(): void {
  if (client) {
    client.close()
    client = null
    initialized = false
  }
}
