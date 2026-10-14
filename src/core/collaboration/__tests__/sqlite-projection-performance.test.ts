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

let directory: string, db: LocalSqliteProcessClient, observer: LocalSqliteProcessClient
let runtime: CollaborationRuntime, store: CollaborationStore, agents: SubagentStore, root: CollaborationProducer
let history: SQLiteConversationHistory, consumer: SQLiteDeliveryConsumer
let scope: { tenantId: string; sessionId: string }
const rootIdentity = { rootRunId: 'root-a', rootAttemptId: 'attempt-a' }

beforeEach(async () => {
  const previous = getDb() as LocalSqliteProcessClient
  closeDb(); await previous.whenClosed()
  directory = path.resolve('.e2e-tmp', 'sqlite-projection-performance-' + randomUUID()); fs.mkdirSync(directory, { recursive: true })
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
  if (path.dirname(directory) !== path.resolve('.e2e-tmp') || !path.basename(directory).startsWith('sqlite-projection-performance-')) throw new Error('Unsafe fixture cleanup')
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


function pauseSnapshotAnchor() {
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const released = new Promise<void>(resolve => { release = resolve })
  const native = db.transaction.bind(db)
  let paused = false
  vi.spyOn(db, 'transaction').mockImplementation(async mode => {
    const tx = await native(mode)
    return new Proxy(tx, { get(target, property) {
      if (property === 'execute') return async (statement: InStatement) => {
        const result = await target.execute(statement)
        const sql = typeof statement === 'string' ? statement : statement.sql
        if (!paused && sql.includes('SELECT id,message_id,role,content')) { paused = true; enter(); await released }
        return result
      }
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    } })
  })
  return { entered, release }
}

it('a held provider snapshot permits a second real WAL writer and retains one consistent history revision', async () => {
  expect((await observer.execute('PRAGMA journal_mode')).rows[0].journal_mode).toBe('wal')
  const gate = pauseSnapshotAnchor()
  const snapshot = runtime.sqliteDeliverySnapshot(consumer, true)
  await gate.entered
  let written: { ok: boolean; code?: string }
  try {
    await observer.execute({ sql: `INSERT INTO conversations(tenant_id,session_id,conversation_id,message_id,role,content)
      VALUES (?,?,?,?,?,?)`, args: [scope.tenantId, scope.sessionId, 'turn-a', 'during-snapshot', 'system', 'New constraint committed by a second WAL writer'] })
    written = { ok: true }
  } catch (error) { written = { ok: false, code: (error as { code?: string }).code } }
  finally { gate.release() }
  const rows = await snapshot
  expect(written.ok, 'A read projection must not reserve the WAL writer').toBe(true)
  expect(rows.some(row => row.message_id === 'during-snapshot')).toBe(false)
  expect((await runtime.sqliteDeliverySnapshot(consumer, true)).some(row => row.message_id === 'during-snapshot')).toBe(true)
})

it('a held provider snapshot does not own global runtime send admission', async () => {
  const sender = await child()
  let enterSend!: () => void
  const sendEntered = new Promise<string>(resolve => { enterSend = () => resolve('entered') })
  const nativeSend = store.send.bind(store)
  vi.spyOn(store, 'send').mockImplementation((...args) => { enterSend(); return nativeSend(...args) })
  const gate = pauseSnapshotAnchor()
  const snapshot = runtime.sqliteDeliverySnapshot(consumer, true)
  await gate.entered
  const send = runtime.send(sender.producer, { recipientParticipantId: 'root:' + rootIdentity.rootRunId,
    message: 'Accepted while projection is held', requestKey: 'projection-send' })
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<string>(resolve => { timer = setTimeout(() => resolve('blocked'), 2000) })
  let completion: string
  try { completion = await Promise.race([sendEntered, deadline]) }
  finally { if (timer) clearTimeout(timer); gate.release() }
  await snapshot
  const accepted = await send
  // The native adapter intentionally reuses one physical connection. This proves
  // runtime admission proceeds; the separate WAL writer test proves lock freedom.
  expect(completion!, 'Read projection must be outside the global runtime queue').toBe('entered')
  expect((await runtime.receipt(sender.producer, 'projection-send'))?.messageId).toBe(accepted.messageId)
  expect(await count('collaboration_deliveries')).toBe(0)
})

it('large active history authenticates linearly and carries no suppressed receipt bodies over the native wire', async () => {
  const integrated = 1000, suppressed = 1000, ordinary = 1000
  const body = 'physical evidence '.repeat(256)
  const tx = await db.transaction('write')
  try {
    for (let chunk = 0; chunk < integrated + suppressed; chunk += 100) {
      const statements: InStatement[] = []
      for (let n = chunk; n < chunk + 100; n++) {
        const id = 'peer:large-' + n, state = n < integrated ? 'integrated' : 'suppressed'
        statements.push({ sql: `INSERT INTO conversations(tenant_id,session_id,conversation_id,message_id,role,content,metadata)
          VALUES (?,?,?,?,?,?,?)`, args: [scope.tenantId, scope.sessionId, 'turn-a', id, 'user', body, '{}'] })
        statements.push({ sql: `INSERT INTO collaboration_deliveries
          (tenant_id,root_run_id,root_attempt_id,message_id,recipient_participant_id,recipient_invocation_run_id,
            history_session_id,history_message_id,history_epoch,history_row_id,history_conversation_id,history_model_id,
            history_identity_version,payload_hash,history_content,history_metadata,state,integrated_at)
          SELECT ?,?,?,?, ?,?,?,?,0,id,conversation_id,model_id,1,'fixture',content,metadata,?,0
          FROM conversations WHERE tenant_id=? AND session_id=? AND message_id=?`,
          args: [scope.tenantId, rootIdentity.rootRunId, rootIdentity.rootAttemptId, 'mail-large-' + n,
            'root:' + rootIdentity.rootRunId, 'fixture-invocation', scope.sessionId, id, state, scope.tenantId, scope.sessionId, id] })
      }
      await tx.batch(statements)
    }
    for (let chunk = 0; chunk < ordinary; chunk += 100) {
      await tx.batch(Array.from({ length: 100 }, (_, offset) => {
        const n = chunk + offset, role = n % 3 === 0 ? 'system' : n % 3 === 1 ? 'assistant' : 'tool'
        return { sql: `INSERT INTO conversations(tenant_id,session_id,conversation_id,message_id,role,content,tool_call_id,tool_name,tool_args)
          VALUES (?,?,?,?,?,?,?,?,?)`, args: [scope.tenantId, scope.sessionId, 'historical-turn', 'active-' + n,
            role, 'Complete retained constraint/tool evidence ' + n, role === 'tool' ? 'call-' + n : null,
            role === 'tool' ? 'read_file' : null, role === 'tool' ? '{"path":"full-evidence"}' : null] }
      }))
    }
    await tx.commit()
  } finally { tx.close() }
  const native = db.transaction.bind(db)
  let identityReads = 0, receiptWireBytes = 0, historyWireBytes = 0
  vi.spyOn(db, 'transaction').mockImplementation(async mode => {
    const transaction = await native(mode)
    return new Proxy(transaction, { get(target, property) {
      if (property === 'execute') return async (statement: InStatement) => {
        const result = await target.execute(statement), sql = typeof statement === 'string' ? statement : statement.sql
        if (/FROM collaboration_deliveries/.test(sql) && !sql.includes('SELECT c.*')) receiptWireBytes += Buffer.byteLength(JSON.stringify(result.rows))
        if (/SELECT (?:\*|c\.\*) FROM conversations/.test(sql)) {
          historyWireBytes += Buffer.byteLength(JSON.stringify(result.rows))
          const rows = result.rows.map(row => new Proxy(row, { get(value, key) {
            if (key === 'message_id') identityReads++
            return Reflect.get(value, key)
          } }))
          return new Proxy(result, { get(value, key) { return key === 'rows' ? rows : Reflect.get(value, key) } })
        }
        return result
      }
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value
    } })
  })
  const rows = await runtime.sqliteDeliverySnapshot(consumer, true)
  const measuredReads = identityReads
  console.log('[PROJECTION-METRICS]', JSON.stringify({ totalHistoryRows: 1 + integrated + suppressed + ordinary,
    totalReceipts: integrated + suppressed, activeHistoryRows: rows.length, identityReads: measuredReads,
    receiptWireBytes, historyWireBytes }))
  expect(rows).toHaveLength(1 + integrated + ordinary)
  expect(measuredReads, 'History ID inspection must be linear in active history and receipts').toBeLessThanOrEqual((integrated + suppressed + ordinary + 1) * 6)
  expect(receiptWireBytes, 'Retired receipt large bodies must stay inside SQLite').toBeLessThan(500_000)
  expect(historyWireBytes, 'Retained suppressed bodies must not be projected from native history').toBeLessThan(6_000_000)
  expect(rows.filter(row => row.role === 'system')).toHaveLength(334)
  expect(rows.filter(row => row.role === 'tool')).toHaveLength(333)
  expect(rows.find(row => row.message_id === 'active-998')).toMatchObject({ role: 'tool', content: 'Complete retained constraint/tool evidence 998', tool_call_id: 'call-998', tool_name: 'read_file', tool_args: '{"path":"full-evidence"}' })
  expect(rows.filter(row => String(row.message_id).startsWith('peer:large-'))).toHaveLength(integrated)
  expect(rows.some(row => row.message_id === 'peer:large-1000')).toBe(false)
  vi.restoreAllMocks()
  await observer.execute("UPDATE conversations SET model_id='independent-model' WHERE message_id='peer:large-999'")
  await expect(runtime.sqliteDeliverySnapshot(consumer, true)).rejects.toMatchObject({ code: 'conflict' })
})
