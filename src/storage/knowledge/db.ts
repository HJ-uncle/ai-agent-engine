import type { Client } from '@libsql/client'
import { LocalSqliteProcessClient, SqliteCloseLedger, type SqliteDatabaseCloseReceipt } from '../sqlite/local-process-client.js'
import path from 'node:path'
import fs from 'node:fs'
import { getDb } from '../sqlite/db.js'

let client: LocalSqliteProcessClient | null = null
let closingReceipt: Promise<SqliteDatabaseCloseReceipt | null> | null = null
const closeLedger = new SqliteCloseLedger()

/**
 * Knowledge data has its own SQLite file in normal engine runs.  Keeping the
 * store separate prevents large FTS writes from blocking conversation history
 * and makes backup/migration of a tenant's documents independent.  Unit tests
 * deliberately opt into the mocked core DB so existing isolation fixtures stay
 * fast and deterministic.
 */
export function getKnowledgeDb(): Client {
  if (process.env.VITEST === 'true' || process.env.KNOWLEDGE_DB_USE_SHARED === 'true') return getDb()
  if (client && !client.closed) return client
  if (client?.closed) { closingReceipt = closeLedger.retire(client); client = null }
  const configured = process.env.KNOWLEDGE_DATA_DIR
  const mainPath = process.env.DATA_DIR
  const dbPath = configured || (mainPath ? path.join(path.dirname(path.resolve(mainPath)), 'knowledge.db') : path.resolve('./data/knowledge.db'))
  fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true })
  // The separate knowledge writer must supply its own exit/ACK evidence;
  // the main database's receipt cannot prove this native connection closed.
  client = new LocalSqliteProcessClient({ url: `file:${path.resolve(dbPath)}` }, {
    readyAfter: closingReceipt?.then(() => {}),
  })
  return client
}

export function closeKnowledgeDb(): Promise<SqliteDatabaseCloseReceipt | null> {
  if (client) {
    const previous = client
    client = null
    closingReceipt = closeLedger.retire(previous)
  }
  // Shared test mode owns no knowledge handle and must never close the main DB.
  return closingReceipt ?? Promise.resolve(null)
}

export function knowledgeDbPath(): string {
  const configured = process.env.KNOWLEDGE_DATA_DIR
  const mainPath = process.env.DATA_DIR
  return path.resolve(configured || (mainPath ? path.join(path.dirname(path.resolve(mainPath)), 'knowledge.db') : './data/knowledge.db'))
}
