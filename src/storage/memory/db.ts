import { createClient } from '@libsql/client'
import type { Client } from '@libsql/client'
import path from 'node:path'
import fs from 'node:fs'

let client: Client | null = null
let initialized = false

function resolveMemoryDbPath(): string {
  const dataDir = process.env.DATA_DIR ?? './data'
  const resolvedDataDir = path.resolve(dataDir)
  const memoryDir = path.join(resolvedDataDir, 'memory')

  if (!fs.existsSync(memoryDir)) {
    fs.mkdirSync(memoryDir, { recursive: true })
  }

  return path.join(memoryDir, 'memory.db')
}

export function getMemoryDb(): Client {
  if (client) return client

  const dbPath = resolveMemoryDbPath()
  const url = `file:${dbPath}`

  client = createClient({ url })
  return client
}

export async function initMemoryDb(schemaStatements: string[]): Promise<void> {
  if (initialized) return
  initialized = true

  const db = getMemoryDb()

  await db.execute('PRAGMA journal_mode = WAL').catch(() => {})
  await db.execute('PRAGMA synchronous = NORMAL').catch(() => {})
  await db.execute('PRAGMA foreign_keys = ON').catch(() => {})

  for (const sql of schemaStatements) {
    await db.execute(sql).catch((err) => {
      console.warn('[memory-db] schema statement warning:', (err as Error)?.message)
    })
  }
}

export function closeMemoryDb(): void {
  if (client) {
    client.close()
    client = null
    initialized = false
  }
}
