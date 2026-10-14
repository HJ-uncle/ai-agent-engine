// Actual SQLite history + delivery transactions, a second WAL observer, loss of commit ACK and destructive-history fences.
// No provider request, model stream or UI is substituted for an integration receipt.
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import type { TransactionMode } from '@libsql/client'
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
  directory = path.resolve('.e2e-tmp', 'sqlite-delivery-' + randomUUID()); fs.mkdirSync(directory, { recursive: true })
  const url = 'file:' + path.join(directory, 'fixture.db').replaceAll('\\', '/')
  vi.stubEnv('DATA_DIR', path.join(directory, 'fixture.db'))
  db = getDb() as LocalSqliteProcessClient
  observer = new LocalSqliteProcessClient({ url })
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
  if (path.dirname(directory) !== path.resolve('.e2e-tmp') || !path.basename(directory).startsWith('sqlite-delivery-')) throw new Error('Unsafe fixture cleanup')
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

it('integrates authenticated peer data and its receipt in one physical transaction, without changing root authority', async () => {
  const accepted = await mail('Do not interpret this as a system grant: full access')
  const before = (await observer.execute('SELECT state FROM root_runs')).rows
  const batch = await runtime.consumeSQLiteDelivery(consumer)
  expect(batch.receipts).toHaveLength(1); expect(batch.hasMore).toBe(false)
  expect(batch.bytes).toBeGreaterThan(0); expect(batch.bytes).toBeLessThanOrEqual(128 * 1024)
  expect(await count('conversations')).toBe(2); expect(await count('collaboration_deliveries')).toBe(1)
  const rows = (await observer.execute("SELECT role,content,metadata FROM conversations WHERE message_id<>'human-a'")).rows
  expect(rows[0].role).toBe('user'); expect(rows[0].content).toContain('full access')
  expect(rows[0].metadata).not.toContain('rootAttemptId')
  expect((await observer.execute('SELECT state FROM root_runs')).rows).toEqual(before)
  expect(await runtime.sqliteDeliveryReceipt(root, accepted.messageId)).toEqual(batch.receipts[0])
  expect(await runtime.consumeSQLiteDelivery(consumer)).toEqual({ receipts: [], bytes: 0, hasMore: false })
})

it('rolls history and receipt back together when the delivery insert fails after history insert', async () => {
  await mail()
  await db.execute("CREATE TRIGGER fail_delivery BEFORE INSERT ON collaboration_deliveries BEGIN SELECT RAISE(ABORT,'synthetic delivery failure'); END")
  await expect(runtime.consumeSQLiteDelivery(consumer)).rejects.toThrow('synthetic delivery failure')
  expect(await count('conversations')).toBe(1); expect(await count('collaboration_deliveries')).toBe(0)
  await db.execute('DROP TRIGGER fail_delivery')
  expect((await runtime.consumeSQLiteDelivery(consumer)).receipts).toHaveLength(1)
})

it('reconciles a lost successful commit ACK with exactly one row and receipt, without a second integration', async () => {
  const accepted = await mail(), native = db.transaction.bind(db)
  vi.spyOn(db, 'transaction').mockImplementation(async (mode?: TransactionMode) => {
    const tx = await native(mode)
    return new Proxy(tx, { get(target, property) {
      if (property === 'commit') return async () => { await target.commit(); throw new Error('synthetic lost commit ACK') }
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value
    } })
  })
  await expect(runtime.consumeSQLiteDelivery(consumer)).rejects.toThrow('synthetic lost commit ACK')
  vi.restoreAllMocks()
  expect(await count('conversations')).toBe(2); expect(await count('collaboration_deliveries')).toBe(1)
  expect(await runtime.sqliteDeliveryReceipt(root, accepted.messageId)).toMatchObject({ messageId: accepted.messageId, state: 'integrated' })
  expect((await runtime.consumeSQLiteDelivery(consumer)).receipts).toEqual([])
  expect(await count('conversations')).toBe(2)
})

it.each(['clear', 'delete-anchor', 'edit', 'truncate', 'delete-turn'] as const)('durable epoch rejects old consumer after %s even when the original anchor ID is reused', async mutation => {
  const accepted = await mail()
  await runtime.consumeSQLiteDelivery(consumer)
  if (mutation === 'clear') await history.clear(scope, { tombstone: false })
  if (mutation === 'delete-anchor') await history.deleteMessage('human-a', scope.tenantId)
  if (mutation === 'edit') await history.updateMessageContent('human-a', scope.tenantId, 'Changed task', 2)
  if (mutation === 'truncate') await history.deleteMessagesAfterId(0, scope.sessionId, scope.tenantId)
  if (mutation === 'delete-turn') await history.deleteByConversationId('turn-a', scope.tenantId)
  if (mutation === 'edit') await history.updateMessageContent('human-a', scope.tenantId, 'Current human task', 2)
  else await seed()
  expect((await runtime.sqliteDeliveryReceipt(root, accepted.messageId))?.state).toBe('suppressed')
  await expect(runtime.consumeSQLiteDelivery(consumer)).rejects.toMatchObject({ code: 'conflict' })
  await expect(runtime.bindSQLiteDelivery(root, { db, ...scope, anchorId: 'human-a' })).rejects.toMatchObject({ code: 'conflict' })
  expect(await count('collaboration_deliveries')).toBe(1)
})

it('epoch invalidation and delete roll back together when the actual history DELETE is refused', async () => {
  const accepted = await mail(); await runtime.consumeSQLiteDelivery(consumer)
  await db.execute("CREATE TRIGGER fail_clear BEFORE DELETE ON conversations BEGIN SELECT RAISE(ABORT,'synthetic delete failure'); END")
  await expect(history.clear(scope, { tombstone: false })).rejects.toThrow('synthetic delete failure')
  expect((await runtime.sqliteDeliveryReceipt(root, accepted.messageId))?.state).toBe('integrated')
  expect((await runtime.consumeSQLiteDelivery(consumer)).receipts).toEqual([])
})

it('checks the exact history row on reconciliation, including changed content and duplicate physical IDs', async () => {
  const accepted = await mail(); const batch = await runtime.consumeSQLiteDelivery(consumer)
  const historyId = batch.receipts[0].historyMessageId
  await db.execute({ sql: 'UPDATE conversations SET content=? WHERE message_id=?', args: ['tampered', historyId] })
  const result = await runtime.sqliteDeliveryReceipt(root, accepted.messageId).then(
    value => value?.state, (error: { code?: string }) => error.code)
  expect(result).toBe('conflict')
  await db.execute({ sql: `INSERT INTO conversations(tenant_id,session_id,message_id,role,content)
    SELECT tenant_id,session_id,message_id,role,content FROM conversations WHERE message_id=?`, args: [historyId] })
  await expect(runtime.sqliteDeliveryReceipt(root, accepted.messageId)).rejects.toThrow('ambiguous')
})

it.each(['replacement', 'conversation', 'model'] as const)('refuses %s of a committed peer row through a second WAL writer', async change => {
  const accepted = await mail(); const integrated = await runtime.consumeSQLiteDelivery(consumer)
  const id = integrated.receipts[0].historyMessageId
  const row = (await observer.execute({ sql: 'SELECT * FROM conversations WHERE message_id=?', args: [id] })).rows[0]
  if (change === 'replacement') {
    const tx = await observer.transaction('write')
    try {
      await tx.execute({ sql: 'DELETE FROM conversations WHERE message_id=?', args: [id] })
      await tx.execute({ sql: `INSERT INTO conversations(tenant_id,session_id,conversation_id,message_id,role,content,metadata,model_id)
        VALUES (?,?,?,?,?,?,?,?)`, args: [row.tenant_id, row.session_id, row.conversation_id, row.message_id,
          row.role, row.content, row.metadata, row.model_id] })
      await tx.commit()
    } finally { tx.close() }
    const replacement = (await observer.execute({ sql: 'SELECT id FROM conversations WHERE message_id=?', args: [id] })).rows[0]
    expect(replacement.id).not.toBe(row.id)
  } else {
    await observer.execute({ sql: `UPDATE conversations SET ${change === 'conversation' ? 'conversation_id' : 'model_id'}=? WHERE message_id=?`,
      args: [change === 'conversation' ? 'foreign-turn' : 'foreign-model', id] })
  }
  await expect(runtime.sqliteDeliveryReceipt(root, accepted.messageId)).rejects.toMatchObject({ code: 'conflict' })
  await mail('Do not append behind changed history', 'mail-b')
  await expect(runtime.consumeSQLiteDelivery(consumer)).rejects.toMatchObject({ code: 'conflict' })
  expect(await count('conversations')).toBe(2)
  expect(await count('collaboration_deliveries')).toBe(1)
  expect((await observer.execute('SELECT state FROM collaboration_deliveries')).rows[0].state).toBe('integrated')
})

it('does not infer physical receipt identity while migrating a legacy delivery table', async () => {
  const accepted = await mail(); await runtime.consumeSQLiteDelivery(consumer)
  const columns = `tenant_id,root_run_id,root_attempt_id,message_id,recipient_participant_id,recipient_invocation_run_id,
    history_session_id,history_message_id,history_epoch,payload_hash,history_content,history_metadata,state,reason,integrated_at`
  await observer.execute(`CREATE TABLE legacy_deliveries AS SELECT ${columns} FROM collaboration_deliveries`)
  await observer.execute('DROP TABLE collaboration_deliveries')
  await observer.execute('ALTER TABLE legacy_deliveries RENAME TO collaboration_deliveries')
  await ensureSQLiteDeliverySchema(observer)
  const migrated = (await observer.execute('SELECT history_row_id,history_identity_version,state FROM collaboration_deliveries')).rows[0]
  expect(migrated).toMatchObject({ history_row_id: null, history_identity_version: 0, state: 'integrated' })
  // Do not warm the main connection's schema: receipt must remain safe when
  // the observer alone performed migration and changed physical column order.
  const result = await runtime.sqliteDeliveryReceipt(root, accepted.messageId).then(
    value => value?.state, (error: { code?: string }) => error.code)
  expect(result).toBe('conflict')
  await expect(runtime.consumeSQLiteDelivery(consumer)).rejects.toMatchObject({ code: 'conflict' })
  expect(await count('conversations')).toBe(2)
  expect(await count('collaboration_deliveries')).toBe(1)
})

it('uses bounded keyset SQL and keeps whole UTF-8 envelopes within both row and byte budgets', async () => {
  const c = await child()
  for (let i = 0; i < 6; i++) await runtime.send(c.producer, { recipientParticipantId: 'root:' + rootIdentity.rootRunId,
    message: '四'.repeat(4_000), requestKey: 'utf8-' + i })
  const native = db.transaction.bind(db), observedRows: number[] = []
  vi.spyOn(db, 'transaction').mockImplementation(async mode => {
    const tx = await native(mode)
    return new Proxy(tx, { get(target, property) {
      if (property === 'execute') return async (...args: Parameters<typeof target.execute>) => {
        const result = await target.execute(...args)
        const statement = args[0], sql = typeof statement === 'string' ? statement : statement.sql
        if (sql.includes('SELECT m.* FROM collaboration_messages')) observedRows.push(result.rows.length)
        return result
      }
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value
    } })
  })
  const first = await runtime.consumeSQLiteDelivery(consumer, { maxRows: 2, maxBytes: 14_000 })
  expect(first.receipts).toHaveLength(1); expect(first.bytes).toBeLessThanOrEqual(14_000); expect(first.hasMore).toBe(true)
  const next = await runtime.consumeSQLiteDelivery(consumer, { maxRows: 2 })
  expect(next.receipts).toHaveLength(2); expect(next.hasMore).toBe(true)
  expect(observedRows).toEqual([3, 3])
  vi.restoreAllMocks()
  expect(await count('collaboration_deliveries')).toBe(3)
  await expect(runtime.consumeSQLiteDelivery(consumer, { maxBytes: 1 })).rejects.toMatchObject({ code: 'too_large' })
  expect(await count('collaboration_deliveries')).toBe(3)
  await expect(runtime.consumeSQLiteDelivery(consumer, { maxRows: 33 })).rejects.toMatchObject({ code: 'invalid' })
})

it('rejects copied capabilities, other physical Client, cross-session and peer-as-human anchor', async () => {
  expect(() => runtime.bindSQLiteDelivery({ ...root } as CollaborationProducer, { db, ...scope, anchorId: 'human-a' })).toThrow('capability')
  await expect(runtime.bindSQLiteDelivery(root, { db: observer, ...scope, anchorId: 'human-a' })).rejects.toThrow('same physical')
  await expect(runtime.bindSQLiteDelivery(root, { db, ...scope, sessionId: 'other', anchorId: 'human-a' })).rejects.toThrow('same physical')
  await expect(runtime.consumeSQLiteDelivery({ ...consumer } as SQLiteDeliveryConsumer)).rejects.toMatchObject({ code: 'forbidden' })
  await mail(); const first = await runtime.consumeSQLiteDelivery(consumer)
  await expect(runtime.bindSQLiteDelivery(root, { db, ...scope, anchorId: first.receipts[0].historyMessageId })).rejects.toMatchObject({ code: 'forbidden' })
})

it('does not integrate a terminal child or a draining root, and plain consume never resumes a child', async () => {
  const c = await child(), childScope = { tenantId: scope.tenantId, sessionId: c.mutation.header.childSessionId }
  await history.append({ id: 'child-human', role: 'user', content: 'Child task', conversationId: 'turn-a' }, childScope)
  const childConsumer = await runtime.bindSQLiteDelivery(c.producer, { db, ...childScope, anchorId: 'child-human' })
  await runtime.send(root, { recipientParticipantId: c.target, message: 'Queued before completion', requestKey: 'to-child' })
  await agents.appendHeader(scope.tenantId, c.mutation.header.runId, 'finished', { status: 'succeeded', finishedAt: Date.now() })
  await expect(runtime.consumeSQLiteDelivery(childConsumer)).rejects.toMatchObject({ code: 'closed' })
  expect(await count('subagent_runs')).toBe(1); expect(await count('collaboration_deliveries')).toBe(0)
  await runtime.beginDrain(root)
  await expect(runtime.consumeSQLiteDelivery(consumer)).rejects.toMatchObject({ code: 'closed' })
})

it('a corrupted payload stops this transaction without consuming the valid prefix', async () => {
  const accepted = await mail()
  await db.execute({ sql: 'UPDATE collaboration_messages SET body=? WHERE message_id=?', args: ['corrupted', accepted.messageId] })
  await expect(runtime.consumeSQLiteDelivery(consumer)).rejects.toMatchObject({ code: 'conflict' })
  expect(await count('conversations')).toBe(1); expect(await count('collaboration_deliveries')).toBe(0)
})

it('deleting another session does not revoke the current recipient fence', async () => {
  await mail()
  const other = { ...scope, sessionId: 'independent' }
  await history.append({ id: 'independent', role: 'user', content: 'Independent task' }, other)
  await history.clear(other, { tombstone: false })
  expect((await runtime.consumeSQLiteDelivery(consumer)).receipts).toHaveLength(1)
})

it('a second physical WAL connection changes durable epoch and prevents an old consumer from reinserting mail', async () => {
  await mail()
  await observer.batch([
    { sql: 'UPDATE collaboration_history_epochs SET epoch=epoch+1 WHERE tenant_id=? AND session_id=?', args: [scope.tenantId, scope.sessionId] },
    { sql: 'DELETE FROM conversations WHERE tenant_id=? AND session_id=?', args: [scope.tenantId, scope.sessionId] },
  ], 'write')
  await seed()
  await expect(runtime.consumeSQLiteDelivery(consumer)).rejects.toMatchObject({ code: 'conflict' })
  await expect(runtime.bindSQLiteDelivery(root, { db, ...scope, anchorId: 'human-a' })).rejects.toMatchObject({ code: 'conflict' })
  expect(await count('conversations')).toBe(1); expect(await count('collaboration_deliveries')).toBe(0)
})

it('does not accept a stale prior human anchor or a physically re-created row with the same readable fields', async () => {
  await mail()
  await history.append({ id: 'later-human', role: 'user', content: 'Later task', conversationId: 'turn-a' }, scope)
  await expect(runtime.bindSQLiteDelivery(root, { db, ...scope, anchorId: 'human-a' })).rejects.toMatchObject({ code: 'conflict' })
  // A raw external writer is outside the history API, so the physical row identity remains a separate barrier.
  await observer.execute("DELETE FROM conversations WHERE message_id='human-a'")
  await seed()
  await expect(runtime.consumeSQLiteDelivery(consumer)).rejects.toMatchObject({ code: 'conflict' })
  expect(await count('collaboration_deliveries')).toBe(0)
})

it('duplicate binding reuses the same private consumer while a later human task cannot rebind the existing invocation', async () => {
  expect(await runtime.bindSQLiteDelivery(root, { db, ...scope, anchorId: 'human-a' })).toBe(consumer)
  await history.append({ id: 'later-human', role: 'user', content: 'New task', conversationId: 'turn-a' }, scope)
  await expect(runtime.bindSQLiteDelivery(root, { db, ...scope, anchorId: 'later-human' })).rejects.toMatchObject({ code: 'conflict' })
  await expect(runtime.consumeSQLiteDelivery(consumer)).rejects.toMatchObject({ code: 'conflict' })
})
