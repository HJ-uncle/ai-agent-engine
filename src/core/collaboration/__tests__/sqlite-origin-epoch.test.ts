// Actual SQLite history + delivery transactions, a second WAL observer, loss of commit ACK and destructive-history fences.
// No provider request, model stream or UI is substituted for an integration receipt.
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import type { Transaction, TransactionMode, InStatement } from '@libsql/client'
import { getDb, closeDb } from '../../../storage/sqlite/db.js'
import { LocalSqliteProcessClient } from '../../../storage/sqlite/local-process-client.js'
import { SQLiteConversationHistory } from '../../../storage/conversation/history.js'
import { SubagentStore } from '../../subagent/store.js'
import { CollaborationRuntime } from '../runtime.js'
import { CollaborationStore } from '../store.js'
import type { CollaborationProducer } from '../types.js'
import type { SQLiteDeliveryConsumer } from '../sqlite-delivery.js'
import { ensureSQLiteDeliverySchema } from '../delivery-schema.js'
import { CollaborationError } from '../types.js'
import { authenticatedSQLiteRows, readAuthenticatedSQLiteHistory } from '../../../storage/conversation/sqlite-origin.js'

let directory: string, db: LocalSqliteProcessClient, observer: LocalSqliteProcessClient
let runtime: CollaborationRuntime, store: CollaborationStore, agents: SubagentStore, root: CollaborationProducer
let history: SQLiteConversationHistory, consumer: SQLiteDeliveryConsumer
let scope: { tenantId: string; sessionId: string }
const rootIdentity = { rootRunId: 'root-a', rootAttemptId: 'attempt-a' }

beforeEach(async () => {
  const previous = getDb() as LocalSqliteProcessClient
  closeDb(); await previous.whenClosed()
  directory = path.resolve('.e2e-tmp', 'sqlite-origin-epoch-' + randomUUID()); fs.mkdirSync(directory, { recursive: true })
  const url = 'file:' + path.join(directory, 'fixture.db').replaceAll('\\', '/')
  vi.stubEnv('DATA_DIR', path.join(directory, 'fixture.db'))
  db = getDb() as LocalSqliteProcessClient
  observer = new LocalSqliteProcessClient({ url }, { busyTimeoutMs: 100 })
  scope = { tenantId: path.basename(directory), sessionId: 'parent-a' }
  await db.execute(`CREATE TABLE root_runs(seq INTEGER PRIMARY KEY AUTOINCREMENT,tenant_id TEXT NOT NULL,
    session_id TEXT NOT NULL,run_id TEXT NOT NULL UNIQUE,turn_id TEXT NOT NULL,state TEXT NOT NULL)`)
  await db.execute(`CREATE TABLE conversations(id INTEGER PRIMARY KEY AUTOINCREMENT,tenant_id TEXT,session_id TEXT,
    conversation_id TEXT,message_id TEXT,role TEXT,content TEXT,reasoning_content TEXT,tool_call_id TEXT,
    tool_call_name TEXT,tool_name TEXT,tool_args TEXT,tokens INTEGER,token_usage TEXT,model_id TEXT,metadata TEXT,
    created_at REAL DEFAULT (unixepoch()))`)
  await db.execute({ sql: 'INSERT INTO root_runs(tenant_id,session_id,run_id,turn_id,state) VALUES (?,?,?,?,?)',
    args: [scope.tenantId, scope.sessionId, rootIdentity.rootRunId, 'turn-a',
      JSON.stringify({ status: 'running', attemptId: rootIdentity.rootAttemptId, sessionId: scope.sessionId, turnId: 'turn-a' })] })
  store = new CollaborationStore(db); agents = new SubagentStore(db); runtime = new CollaborationRuntime(store, agents)
  root = await runtime.admitRoot({ tenantId: scope.tenantId, ...rootIdentity })
  history = new SQLiteConversationHistory()
  await seed()
  consumer = await runtime.bindSQLiteDelivery(root, { db, ...scope, anchorId: 'human-a' })
})
afterEach(async () => {
  vi.restoreAllMocks(); closeDb(); observer.close(); await Promise.all([db.whenClosed(), observer.whenClosed()]); vi.unstubAllEnvs()
  if (path.dirname(directory) !== path.resolve('.e2e-tmp') || !path.basename(directory).startsWith('sqlite-origin-epoch-')) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
const seed = () => history.append({ id: 'human-a', role: 'user', content: 'Current human task', conversationId: 'turn-a' }, scope)
async function child(key = 'child-a') {
  const result = await runtime.admitChild(root, { tenantId: scope.tenantId, rootSessionId: scope.sessionId,
    parentSessionId: scope.sessionId, parentConversationId: 'turn-a', parentMessageId: 'dispatch-a', parentToolCallId: key,
    task: 'Synthetic child', description: key, modelId: 'no-model',
    continuation: { readOnly: true, systemPrompt: '', toolNames: [], workspacePaths: [] } })
  return { ...result, target: 'child:' + result.mutation.header.childSessionId }
}
async function mail(body = 'Synthetic peer data', key = 'mail-a') {
  const c = await child()
  return runtime.send(c.producer, { recipientParticipantId: 'root:' + rootIdentity.rootRunId, message: body, requestKey: key })
}
async function count(table: string, connection = observer) {
  return Number((await connection.execute(`SELECT count(*) AS n FROM ${table}`)).rows[0].n)
}



const readOrigins = {
  raw: () => authenticatedSQLiteRows(db, scope),
  public: () => readAuthenticatedSQLiteHistory(history, scope),
}
for (const [entry, read] of Object.entries(readOrigins)) {
  it(entry + ' reader accepts valid initial epoch zero with the exact physical peer receipt', async () => {
    await mail(); await runtime.consumeSQLiteDelivery(consumer)
    expect((await read())?.length).toBe(2)
  })
  for (const corrupt of ['missing', 'null', 'negative', 'fractional', 'text', 'unsafe-integer']) {
    it(entry + ' reader rejects ' + corrupt + ' durable epoch without changing a valid physical peer identity', async () => {
      await mail(); await runtime.consumeSQLiteDelivery(consumer)
      // A legacy nullable schema preserves every valid receipt field while exposing
      // the NULL/NULL comparison edge; rewriting physical history is unnecessary.
      await observer.batch([
        'CREATE TABLE legacy_nullable_deliveries AS SELECT * FROM collaboration_deliveries',
        'DROP TABLE collaboration_deliveries',
        'ALTER TABLE legacy_nullable_deliveries RENAME TO collaboration_deliveries',
        'CREATE TABLE legacy_nullable_epochs AS SELECT * FROM collaboration_history_epochs',
        'DROP TABLE collaboration_history_epochs',
        'ALTER TABLE legacy_nullable_epochs RENAME TO collaboration_history_epochs',
      ], 'write')
      const value = corrupt === 'missing' || corrupt === 'null' ? null
        : corrupt === 'negative' ? -1 : corrupt === 'fractional' ? 0.5
          : corrupt === 'text' ? 'not-an-epoch' : 9007199254740992
      await observer.batch([
        { sql: 'UPDATE collaboration_deliveries SET history_epoch=? WHERE tenant_id=? AND history_session_id=?', args: [value, scope.tenantId, scope.sessionId] },
        corrupt === 'missing'
          ? { sql: 'DELETE FROM collaboration_history_epochs WHERE tenant_id=? AND session_id=?', args: [scope.tenantId, scope.sessionId] }
          : { sql: 'UPDATE collaboration_history_epochs SET epoch=? WHERE tenant_id=? AND session_id=?', args: [value, scope.tenantId, scope.sessionId] },
      ], 'write')
      const identity = (await observer.execute('SELECT history_row_id,history_identity_version,state FROM collaboration_deliveries')).rows[0]
      expect(Number(identity.history_identity_version)).toBe(1)
      expect(Number(identity.history_row_id)).toBeGreaterThan(0)
      expect(identity.state).toBe('integrated')
      const outcome = await read().then(() => 'accepted', (error: unknown) => error instanceof CollaborationError ? error.code : 'unexpected-error')
      expect(outcome, 'A missing or invalid durable epoch must reject, even when physical peer identity is exact').toBe('conflict')
    })
  }
}
