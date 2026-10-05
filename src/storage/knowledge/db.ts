import { createClient, type Client } from '@libsql/client'
import path from 'node:path'
import fs from 'node:fs'
import { getDb } from '../sqlite/db.js'

let client: Client | null = null

/**
 * Knowledge data has its own SQLite file in normal engine runs.  Keeping the
 * store separate prevents large FTS writes from blocking conversation history
 * and makes backup/migration of a tenant's documents independent.  Unit tests
 * deliberately opt into the mocked core DB so existing isolation fixtures stay
 * fast and deterministic.
 */
export function getKnowledgeDb(): Client {
  if (process.env.VITEST === 'true' || process.env.KNOWLEDGE_DB_USE_SHARED === 'true') return getDb()
  if (client) return client
  const configured = process.env.KNOWLEDGE_DATA_DIR
  const mainPath = process.env.DATA_DIR
  const dbPath = configured || (mainPath ? path.join(path.dirname(path.resolve(mainPath)), 'knowledge.db') : path.resolve('./data/knowledge.db'))
  fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true })
  client = createClient({ url: `file:${path.resolve(dbPath)}` })
  return client
}

export function closeKnowledgeDb(): void {
  client?.close()
  client = null
}

export function knowledgeDbPath(): string {
  const configured = process.env.KNOWLEDGE_DATA_DIR
  const mainPath = process.env.DATA_DIR
  return path.resolve(configured || (mainPath ? path.join(path.dirname(path.resolve(mainPath)), 'knowledge.db') : './data/knowledge.db'))
}
