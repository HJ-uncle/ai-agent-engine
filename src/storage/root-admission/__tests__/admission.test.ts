/** Physical SQLite/WAL admission, exact scoped receipts, crash projection and real JSONL/SQLite fill. No network/model. */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Transaction } from '@libsql/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as database from '../../sqlite/db.js'
import { LocalSqliteProcessClient } from '../../sqlite/local-process-client.js'
import { RootRunStore } from '../../root-runs/index.js'
import { createConversationHistory } from '../../conversation/factory.js'
import { canonicalAdmissionBody, ensureUserAdmissionSchema, lookupUserAdmission, prepareUserAdmission, readDatabaseNamespace, userAdmissionDigest, type EngineDatabaseNamespace, type PreparedUserAdmission } from '../index.js'
import { acknowledgeAdmissionUser, admissionProjectingHistory, projectTerminalAdmissionUsers, readAdmissionSeed } from '../projection.js'
import { bindHistoryGeneration, invalidateSessionHistory } from '../../conversation/serialization.js'
import * as historySerialization from '../../conversation/serialization.js'

let fixture: string, a: LocalSqliteProcessClient, b: LocalSqliteProcessClient, sa: RootRunStore, sb: RootRunStore, namespace: EngineDatabaseNamespace
const tenant = 'synthetic-admission-tenant', session = 'synthetic-admission-session'
const scope = { tenantId: tenant, sessionId: session }
const transport = { toolProfile: 'general', runLifetime: 'durable', subagentProtocol: 2 as const }
function body(key = 'request-one', message = 'synthetic user instruction', predecessor: PreparedUserAdmission['predecessor'] = null, overrides: Record<string, unknown> = {}) {
  const request: Record<string, unknown> = { sessionId: session, message, model: 'synthetic-never-dispatched', thinkingMode: false, skills: [], memoryScope: 'off', ...overrides }
  const selector = { protocolVersion: 1 as const, namespace, owner: 'work' as const, predecessor }
  request.admission = { ...selector, requestKey: key, bodyDigest: userAdmissionDigest(request, transport, selector) }
  return request
}
function prepared(request = body()) { return prepareUserAdmission(request, transport)! }
async function admit(store = sa, request = body(), targetTenant = tenant) {
  return store.createUserAdmission(targetTenant, 'synthetic-never-dispatched', [], request, prepared(request))
}
async function counts() {
  const result: Record<string, number> = {}
  for (const table of ['root_runs', 'user_root_admissions', 'user_root_admission_seeds']) result[table] = Number((await b.execute('SELECT count(*) AS n FROM ' + table)).rows[0].n)
  return result
}
async function reopen() {
  expect((await Promise.all([a.closeWithReceipt(), b.closeWithReceipt()])).every(receipt => receipt.healthy)).toBe(true)
  const url = 'file:' + path.join(fixture, 'fixture.db').replaceAll('\\', '/')
  a = new LocalSqliteProcessClient({ url }); b = new LocalSqliteProcessClient({ url }); sa = new RootRunStore(() => a); sb = new RootRunStore(() => b)
}
function faultAfterCommit(db: LocalSqliteProcessClient) {
  let faults = 0
  return { get faults() { return faults }, db: new Proxy(db, { get(target, key) {
    if (key === 'transaction') return async (mode?: Parameters<typeof db.transaction>[0]) => {
      const tx = await target.transaction(mode); let inserted = false
      return new Proxy(tx, { get(owner, name) {
        if (name === 'execute') return async (...args: Parameters<Transaction['execute']>) => {
          const statement = args[0], sql = typeof statement === 'string' ? statement : statement.sql
          if (sql.startsWith('INSERT INTO user_root_admissions ')) inserted = true
          return owner.execute(...args)
        }
        if (name === 'commit') return async () => { await owner.commit(); if (inserted) { faults++; throw new Error('SYNTHETIC_ADMISSION_LOST_COMMIT_ACK') } }
        const value = Reflect.get(owner, name, owner); return typeof value === 'function' ? value.bind(owner) : value
      } })
    }
    const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value
  } }) }
}
beforeEach(async () => {
  fs.mkdirSync('.e2e-tmp', { recursive: true }); fixture = fs.mkdtempSync(path.resolve('.e2e-tmp/user-admission-'))
  vi.stubEnv('DATA_DIR', path.join(fixture, 'fixture.db')); vi.stubEnv('HISTORY_BACKEND', 'jsonl')
  const url = 'file:' + path.join(fixture, 'fixture.db').replaceAll('\\', '/')
  a = new LocalSqliteProcessClient({ url }); b = new LocalSqliteProcessClient({ url })
  vi.spyOn(database, 'getDb').mockImplementation(() => a)
  await database.initDb(); await ensureUserAdmissionSchema(a); await ensureUserAdmissionSchema(b)
  namespace = await readDatabaseNamespace(a); sa = new RootRunStore(() => a); sb = new RootRunStore(() => b)
  await sa.list(tenant, session)
})
afterEach(async () => {
  database.closeDb(); const receipts = await Promise.all([a.closeWithReceipt(), b.closeWithReceipt()])
  expect(receipts.every(receipt => receipt.healthy)).toBe(true)
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (!path.resolve(fixture).startsWith(path.resolve('.e2e-tmp') + path.sep)) throw new Error('Unsafe admission fixture cleanup')
  fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 })
  expect(fs.existsSync(fixture)).toBe(false)
})

describe('WQ2 user root admission and database namespace', () => {
  it('admits an explicit attachment-only user seed without admitting missing text or invalid files', async () => {
    expect(() => prepared(body('empty', ''))).toThrow('ADMISSION_REQUIRES_SESSION_AND_MESSAGE')
    expect(() => prepared(body('empty-files', '', null, { attachments: [] }))).toThrow('ADMISSION_REQUIRES_SESSION_AND_MESSAGE')
    expect(() => prepared(body('missing', '', null, { message: null, attachments: [{ name: 'fixture.txt' }] }))).toThrow('ADMISSION_REQUIRES_SESSION_AND_MESSAGE')
    const missing = body('missing-field', '', null, { attachments: [{ name: 'fixture.txt' }] })
    delete missing.message
    const selector = { protocolVersion: 1 as const, namespace, owner: 'work' as const, predecessor: null }
    missing.admission = { ...selector, requestKey: 'missing-field', bodyDigest: userAdmissionDigest(missing, transport, selector) }
    expect(() => prepared(missing)).toThrow('ADMISSION_REQUIRES_SESSION_AND_MESSAGE')
    expect(() => prepared(body('invalid-file', '', null, { attachments: [{ name: '' }] }))).toThrow('INVALID_ADMISSION_ATTACHMENT')
    const upload = body('only-file', '', null, { attachments: [{ name: '.ae/attachments/fixture.txt', type: 'text/plain', content: 'NOT_IN_LABEL' }] })
    const accepted = await admit(sa, upload)
    const seed = await readAdmissionSeed(b, scope, accepted.run.runId)
    expect(seed.message).toMatchObject({ content: '', metadata: { attachments: [{ name: '.ae/attachments/fixture.txt', type: 'text/plain' }] } })
    expect(seed.seedJson).not.toContain('NOT_IN_LABEL')
    expect((await admit(sb, upload)).receipt).toEqual(accepted.receipt)
    expect(await counts()).toEqual({ root_runs: 1, user_root_admissions: 1, user_root_admission_seeds: 1 })
  })

  it('hashes exact JSON semantics and captures drafts before awaits', () => {
    expect(canonicalAdmissionBody({ b: false, a: [] })).toBe(canonicalAdmissionBody({ a: [], b: false }))
    expect(canonicalAdmissionBody({ a: [] })).not.toBe(canonicalAdmissionBody({}))
    const request = body(); const snapshot = prepared(request); request.message = 'changed after capture'
    expect(snapshot.userContent).toBe('synthetic user instruction')
    expect(() => prepared(request)).toThrow('ADMISSION_BODY_DIGEST_MISMATCH')
    expect(() => prepared(body('bad', 'valid', null, { automationRunId: 'cron-owned' }))).toThrow('USER_ADMISSION_CANNOT_CLAIM_AUTOMATION_OR_RESUME')
    expect(() => canonicalAdmissionBody({ text: 'x'.repeat(2 * 1024 * 1024 + 1) })).toThrow('ADMISSION_BODY_TOO_LARGE')
    const sparse = new Array(3); sparse[0] = 'one'
    expect(() => canonicalAdmissionBody(sparse)).toThrow('INVALID_ADMISSION_BODY')
    expect(() => canonicalAdmissionBody(Object.defineProperty({}, 'hidden', { value: true }))).toThrow('INVALID_ADMISSION_BODY')
    expect(() => canonicalAdmissionBody(Object.assign([], { extra: true }))).toThrow('INVALID_ADMISSION_BODY')
    expect(() => canonicalAdmissionBody({ accessor: undefined })).toThrow('INVALID_ADMISSION_BODY')
    const upload = body('attachment', 'read attachment', null, { metadata: { chip: 'source', attachments: ['caller-stale'] }, attachments: [{ name: '.ae/uploads/test.txt', type: 'text/plain', content: 'INLINE_CONTENT_NOT_A_TRANSCRIPT_LABEL' }] })
    const captured = prepared(upload)
    expect(captured.userMetadata).toEqual({ chip: 'source', attachments: [{ name: '.ae/uploads/test.txt', type: 'text/plain' }] })
    expect(JSON.stringify(captured)).not.toContain('INLINE_CONTENT_NOT_A_TRANSCRIPT_LABEL')
  })
  it('atomically commits root, immutable user seed, assistant anchor and exact receipt', async () => {
    const result = await admit()
    expect(result.duplicate).toBe(false)
    expect(result.receipt).toMatchObject({ requestKey: 'request-one', namespace, rootRunId: result.run.runId,
      turnId: result.run.turnId, userMessageId: result.run.userMessageId, assistantMessageId: result.run.assistantMessageId })
    expect(await counts()).toEqual({ root_runs: 1, user_root_admissions: 1, user_root_admission_seeds: 1 })
    const seed = await readAdmissionSeed(b, scope, result.run.runId)
    expect(seed.message.content).toBe('synthetic user instruction'); expect(seed.projected).toBe(false)
    expect(Number((await b.execute('SELECT count(*) AS n FROM conversations')).rows[0].n)).toBe(0)
  })
  it('admits exactly one root across two real SQLite connections with matching key/body', async () => {
    const request = body()
    const results = await Promise.all([admit(sa, request), admit(sb, request)])
    expect(results.filter(result => !result.duplicate)).toHaveLength(1)
    expect(results[0].receipt).toEqual(results[1].receipt)
    expect(new Set(results.map(result => result.run.runId)).size).toBe(1)
    expect(await counts()).toEqual({ root_runs: 1, user_root_admissions: 1, user_root_admission_seeds: 1 })
  })
  it('keeps physical admission unique with independent connections even without the process-local history queue', async () => {
    vi.spyOn(historySerialization, 'withHistoryLock').mockImplementation(async (_tenant, action) => action())
    const request = body('physical-race')
    const results = await Promise.all([admit(sa, request), admit(sb, request)])
    expect(results.map(result => result.receipt)).toEqual([results[0].receipt, results[0].receipt])
    expect(results.filter(result => result.duplicate)).toHaveLength(1)
    expect(await counts()).toEqual({ root_runs: 1, user_root_admissions: 1, user_root_admission_seeds: 1 })
  })
  it('rejects changed body for the same request key even after root terminal completion', async () => {
    const accepted = await admit(); await sa.update(tenant, accepted.run.runId, { status: 'succeeded' })
    await expect(admit(sb, body('request-one', 'different content'))).rejects.toMatchObject({ statusCode: 409, code: 'ADMISSION_KEY_BODY_CONFLICT' })
    expect(await counts()).toEqual({ root_runs: 1, user_root_admissions: 1, user_root_admission_seeds: 1 })
    expect((await admit(sb)).duplicate).toBe(true)
  })
  it('binds every receipt to trusted tenant, session and durable namespace', async () => {
    const accepted = await admit(); const selector = prepared()
    expect(await lookupUserAdmission(b, 'foreign-tenant', session, selector)).toBe(null)
    expect(await lookupUserAdmission(b, tenant, 'foreign-session', selector)).toBe(null)
    await expect(lookupUserAdmission(b, tenant, session, { ...selector, namespace: { ...namespace, generation: randomUUID() } })).rejects.toMatchObject({ code: 'ENGINE_NAMESPACE_CHANGED' })
    await expect(lookupUserAdmission(b, tenant, session, { ...selector, namespace: { ...namespace, id: randomUUID() } })).rejects.toMatchObject({ code: 'ENGINE_NAMESPACE_CHANGED' })
    const foreign = await admit(sb, body(), 'foreign-tenant')
    expect(foreign.run.runId).not.toBe(accepted.run.runId)
  })
  it('rejects stale predecessor attempt/version, missing latest anchor and a still-active predecessor', async () => {
    const prior = await admit(); const stored = (await sa.get(tenant, prior.run.runId))!
    const anchor = { runId: stored.runId, attemptId: stored.attemptId, version: stored.version }
    await expect(admit(sb, body('next', 'next', anchor))).rejects.toMatchObject({ code: 'ADMISSION_PREDECESSOR_NOT_TERMINAL' })
    await sa.update(tenant, stored.runId, { status: 'succeeded' })
    await expect(admit(sb, body('next', 'next', anchor))).rejects.toMatchObject({ code: 'ADMISSION_PREDECESSOR_CHANGED' })
    await expect(admit(sb, body('next'))).rejects.toMatchObject({ code: 'ADMISSION_PREDECESSOR_CHANGED' })
    const terminal = (await sa.get(tenant, stored.runId))!; const current = { runId: terminal.runId, attemptId: terminal.attemptId, version: terminal.version }
    await expect(admit(sb, body('next', 'next', { ...current, attemptId: randomUUID() }))).rejects.toMatchObject({ code: 'ADMISSION_PREDECESSOR_CHANGED' })
    const next = await admit(sb, body('next', 'next', current)); expect(next.run.runId).not.toBe(prior.run.runId)
  })
  it('rolls back all admission facts when writing the seed fails', async () => {
    await a.execute("CREATE TRIGGER synthetic_seed_failure BEFORE INSERT ON user_root_admission_seeds BEGIN SELECT RAISE(ABORT,'synthetic-seed-failure'); END")
    await expect(admit()).rejects.toThrow('synthetic-seed-failure')
    expect(await counts()).toEqual({ root_runs: 0, user_root_admissions: 0, user_root_admission_seeds: 0 })
  })
  it('rolls back root, seed and receipt on actual deferred FK COMMIT failure', async () => {
    await a.executeMultiple(`CREATE TABLE synthetic_commit_parent(id INTEGER PRIMARY KEY);
      CREATE TABLE synthetic_commit_child(id INTEGER REFERENCES synthetic_commit_parent(id) DEFERRABLE INITIALLY DEFERRED);
      CREATE TRIGGER synthetic_receipt_commit_failure AFTER INSERT ON user_root_admissions BEGIN INSERT INTO synthetic_commit_child VALUES(1); END;`)
    await expect(admit()).rejects.toThrow(/FOREIGN KEY constraint failed/i)
    expect(await counts()).toEqual({ root_runs: 0, user_root_admissions: 0, user_root_admission_seeds: 0 })
  })
  it('reconciles a lost COMMIT ACK by exact receipt without a second insert or prepared owner', async () => {
    const fault = faultAfterCommit(a); const uncertain = new RootRunStore(() => fault.db); const preparedOwners: string[] = []
    const request = body()
    const first = await uncertain.createUserAdmission(tenant, 'synthetic-never-dispatched', [], request, prepared(request), undefined, id => preparedOwners.push(id))
    const repeat = await uncertain.createUserAdmission(tenant, 'synthetic-never-dispatched', [], request, prepared(request), undefined, id => preparedOwners.push(id))
    expect(fault.faults).toBe(1); expect(preparedOwners).toEqual([first.run.runId])
    expect(first.duplicate).toBe(false); expect(repeat.duplicate).toBe(true); expect(first.receipt).toEqual(repeat.receipt)
    expect(await counts()).toEqual({ root_runs: 1, user_root_admissions: 1, user_root_admission_seeds: 1 })
  })
  it('returns unknown when a lost COMMIT ACK cannot be queried, without blind reinsert or readmission', async () => {
    let readUnavailable = false, inserts = 0
    const uncertain = new RootRunStore(() => new Proxy(a, { get(target, key) {
      if (key === 'transaction') return async (mode?: Parameters<typeof a.transaction>[0]) => {
        const tx = await target.transaction(mode); let inserted = false
        return new Proxy(tx, { get(owner, name) {
          if (name === 'execute') return async (...args: Parameters<Transaction['execute']>) => {
            const statement = args[0], sql = typeof statement === 'string' ? statement : statement.sql
            if (mode === 'read' && readUnavailable) throw new Error('SYNTHETIC_RECEIPT_QUERY_UNAVAILABLE')
            if (sql.startsWith('INSERT INTO user_root_admissions ')) { inserted = true; inserts++ }
            return owner.execute(...args)
          }
          if (name === 'commit') return async () => { await owner.commit(); if (inserted) { readUnavailable = true; throw new Error('SYNTHETIC_COMMIT_ACK_LOST') } }
          const value = Reflect.get(owner, name, owner); return typeof value === 'function' ? value.bind(owner) : value
        } })
      }
      const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value
    } }))
    const owners: string[] = [], request = body('unknown-ack')
    await expect(uncertain.createUserAdmission(tenant, 'synthetic', [], request, prepared(request), undefined, id => owners.push(id))).rejects.toThrow('USER_ADMISSION_ACK_UNKNOWN')
    expect(inserts).toBe(1); expect(owners).toHaveLength(1)
    expect(await counts()).toEqual({ root_runs: 1, user_root_admissions: 1, user_root_admission_seeds: 1 })
    readUnavailable = false
    const accepted = await sa.findUserAdmission(tenant, session, prepared(request))
    expect(accepted?.run.runId).toBe(owners[0]); expect(inserts).toBe(1)
  })
  it('retains tombstoned receipts as unavailable rather than admitting the key again', async () => {
    const accepted = await admit(); await sa.deleteTurns(tenant, session, [accepted.run.turnId])
    await expect(admit(sb)).rejects.toMatchObject({ code: 'ADMISSION_RECEIPT_UNAVAILABLE' })
    expect(await counts()).toEqual({ root_runs: 0, user_root_admissions: 1, user_root_admission_seeds: 1 })
  })
  it('retains namespace, receipt and original seed after owned SQLite close/reopen without reexecution', async () => {
    const accepted = await admit(); expect((await Promise.all([a.closeWithReceipt(), b.closeWithReceipt()])).every(receipt => receipt.healthy)).toBe(true)
    const url = 'file:' + path.join(fixture, 'fixture.db').replaceAll('\\', '/')
    a = new LocalSqliteProcessClient({ url }); b = new LocalSqliteProcessClient({ url }); sa = new RootRunStore(() => a); sb = new RootRunStore(() => b)
    await ensureUserAdmissionSchema(a); expect(await readDatabaseNamespace(a)).toEqual(namespace)
    await sa.initialize(); expect((await admit(sb)).run.status).toBe('interrupted')
    expect((await admit(sb)).receipt).toEqual(accepted.receipt)
    const secondDb = new LocalSqliteProcessClient({ url: 'file:' + path.join(fixture, 'new.db').replaceAll('\\', '/') })
    try { await ensureUserAdmissionSchema(secondDb); expect(await readDatabaseNamespace(secondDb)).not.toEqual(namespace) }
    finally { expect((await secondDb.closeWithReceipt()).healthy).toBe(true) }
  })
  it.each(['jsonl', 'sqlite'])('fills actual %s user projection and final assistant without an empty placeholder blocking append', async backend => {
    vi.stubEnv('HISTORY_BACKEND', backend)
    const accepted = await admit(), seed = await readAdmissionSeed(a, scope, accepted.run.runId)
    const history = admissionProjectingHistory(createConversationHistory(), seed.anchor)
    await history.append({ ...seed.message, tokens: 42, modelInputContent: 'processed attachment provider snapshot' }, scope)
    await history.append({ id: seed.anchor.assistantAnchorId, role: 'assistant', content: 'FINAL_ASSISTANT_BODY', conversationId: seed.anchor.turnId } as import('../../../core/agent-context/types.js').Message, scope)
    expect((await readAdmissionSeed(b, scope, accepted.run.runId)).projected).toBe(true)
    const rows = await history.getFullHistory(scope)
    expect(rows.filter(message => message.id === seed.anchor.userMessageId)).toHaveLength(1)
    expect(rows.find(message => message.id === seed.anchor.userMessageId)?.modelInputContent).toBe('processed attachment provider snapshot')
    expect(rows.find(message => message.id === seed.anchor.assistantAnchorId)?.content).toBe('FINAL_ASSISTANT_BODY')
  })
  it('leaves an interrupted failed JSONL projection pending and recovers only its seed on restart', async () => {
    const accepted = await admit(), seed = await readAdmissionSeed(a, scope, accepted.run.runId)
    const history = admissionProjectingHistory(createConversationHistory(), seed.anchor)
    const fail = vi.spyOn(fs.promises, 'appendFile').mockRejectedValueOnce(new Error('SYNTHETIC_JSONL_WRITE_FAILURE'))
    await expect(history.append(seed.message, scope)).rejects.toThrow('SYNTHETIC_JSONL_WRITE_FAILURE')
    fail.mockRestore(); expect((await readAdmissionSeed(b, scope, accepted.run.runId)).projected).toBe(false)
    await sa.update(tenant, accepted.run.runId, { status: 'interrupted' })
    const restartedHistory = createConversationHistory()
    expect(await projectTerminalAdmissionUsers(b, restartedHistory, scope)).toBe(1)
    expect(await projectTerminalAdmissionUsers(a, createConversationHistory(), scope)).toBe(0)
    expect((await restartedHistory.getFullHistory(scope)).filter(message => message.id === seed.anchor.userMessageId)).toHaveLength(1)
    expect((await restartedHistory.getFullHistory(scope)).some(message => message.role === 'assistant')).toBe(false)
  })

  it('keeps fsync failure pending, then close/reopen repairs one actual JSONL user without model or assistant output', async () => {
    const accepted = await admit(), seed = await readAdmissionSeed(a, scope, accepted.run.runId)
    const history = admissionProjectingHistory(createConversationHistory(), seed.anchor)
    const realOpen = fs.promises.open.bind(fs.promises)
    const fault = vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
      const handle = await realOpen(...args)
      if (args[1] === 'r+') return new Proxy(handle, { get(target, key) {
        if (key === 'sync') return async () => { throw new Error('SYNTHETIC_JSONL_SYNC_FAILURE') }
        const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value
      } })
      return handle
    })
    await expect(history.append(seed.message, scope)).rejects.toThrow('SYNTHETIC_JSONL_SYNC_FAILURE')
    fault.mockRestore(); expect((await readAdmissionSeed(b, scope, accepted.run.runId)).projected).toBe(false)
    expect((await history.getFullHistory(scope)).filter(row => row.id === seed.anchor.userMessageId)).toHaveLength(1)
    await reopen(); await sa.initialize()
    expect(await projectTerminalAdmissionUsers(a, createConversationHistory(), scope)).toBe(1)
    expect((await admit(sb)).receipt).toEqual(accepted.receipt)
    const recoveredRows = await createConversationHistory().getFullHistory(scope)
    expect(recoveredRows.map(row => [row.id, row.role, row.content])).toEqual([[seed.anchor.userMessageId, 'user', seed.message.content]])
    const file = path.join(fixture, 'sessions', tenant, session + '.jsonl')
    expect(fs.readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(1)
  })

  it.each(['jsonl', 'sqlite'])('does not mark %s projection done when SQLite ACK fails; restart repairs without a duplicate', async backend => {
    vi.stubEnv('HISTORY_BACKEND', backend)
    const accepted = await admit(), seed = await readAdmissionSeed(a, scope, accepted.run.runId)
    await a.execute("CREATE TRIGGER synthetic_projection_ack_failure BEFORE UPDATE OF projected_at ON user_root_admission_seeds BEGIN SELECT RAISE(ABORT,'synthetic-projection-ack-failure'); END")
    const history = admissionProjectingHistory(createConversationHistory(), seed.anchor)
    await expect(history.append(seed.message, scope)).rejects.toThrow('synthetic-projection-ack-failure')
    expect((await readAdmissionSeed(b, scope, accepted.run.runId)).projected).toBe(false)
    await a.execute('DROP TRIGGER synthetic_projection_ack_failure')
    await reopen(); await sa.initialize()
    expect(await projectTerminalAdmissionUsers(a, createConversationHistory(), scope)).toBe(1)
    expect(await projectTerminalAdmissionUsers(b, createConversationHistory(), scope)).toBe(0)
    expect((await createConversationHistory().getFullHistory(scope)).filter(row => row.id === seed.anchor.userMessageId)).toHaveLength(1)
    expect(await counts()).toEqual({ root_runs: 1, user_root_admissions: 1, user_root_admission_seeds: 1 })
  })

  it('fails closed on receipt or seed corruption and retains the original key instead of readmitting', async () => {
    const accepted = await admit()
    const receipt = JSON.stringify(accepted.receipt)
    await a.execute({ sql: 'UPDATE user_root_admissions SET receipt_json=?', args: [JSON.stringify({ ...accepted.receipt, owner: 'automation' })] })
    await expect(admit(sb)).rejects.toMatchObject({ code: 'ADMISSION_RECEIPT_UNAVAILABLE' })
    await a.execute({ sql: 'UPDATE user_root_admissions SET receipt_json=?', args: [receipt] })
    const seed = await readAdmissionSeed(a, scope, accepted.run.runId)
    await a.execute({ sql: 'UPDATE user_root_admission_seeds SET seed_json=?', args: [JSON.stringify({ ...seed.message, content: 'tampered original content' })] })
    await expect(readAdmissionSeed(b, scope, accepted.run.runId)).rejects.toMatchObject({ code: 'ADMISSION_SEED_CORRUPT' })
    await expect(admit(sb)).rejects.toMatchObject({ code: 'ADMISSION_RECEIPT_UNAVAILABLE' })
    await expect(acknowledgeAdmissionUser(a, scope, seed)).rejects.toMatchObject({ code: 'ADMISSION_SEED_UNAVAILABLE' })
    expect((await counts()).root_runs).toBe(1)
  })

  it.each(['jsonl', 'sqlite'])('rejects existing %s user identity with different actual content, and verifies JSON-looking raw strings', async backend => {
    vi.stubEnv('HISTORY_BACKEND', backend)
    const accepted = await admit(sa, body('json-looking', '["actual original string"]')), seed = await readAdmissionSeed(a, scope, accepted.run.runId)
    const history = admissionProjectingHistory(createConversationHistory(), seed.anchor)
    await history.append(seed.message, scope)
    expect((await readAdmissionSeed(a, scope, accepted.run.runId)).projected).toBe(true)
    await history.updateMessageContent(seed.anchor.userMessageId, tenant, 'externally changed user body', 1)
    await expect(history.append(seed.message, scope)).rejects.toMatchObject({ code: 'ADMISSION_USER_PROJECTION_CONFLICT' })
  })

  it('fences admission projection methods after history generation invalidation', async () => {
    const accepted = await admit(), seed = await readAdmissionSeed(a, scope, accepted.run.runId)
    const history = bindHistoryGeneration(createConversationHistory(), tenant, session)
    invalidateSessionHistory(tenant, session)
    await expect(history.appendAdmissionUser!(seed.message, scope, seed.anchor)).rejects.toThrow('History was changed; this run may no longer append')
    expect((await readAdmissionSeed(a, scope, accepted.run.runId)).projected).toBe(false)
    expect(await history.getFullHistory(scope)).toEqual([])
  })
  it('permits legacy snapshot readers without pending admissions, but gates a retained terminal outbox on unsupported backends', async () => {
    const history = new Proxy(createConversationHistory(), { get(target, key) {
      if (key === 'appendAdmissionUser') return undefined
      const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value
    } })
    expect(await projectTerminalAdmissionUsers(a, history, scope)).toBe(0)
    const accepted = await admit()
    expect(await projectTerminalAdmissionUsers(a, history, scope)).toBe(0)
    await sa.update(tenant, accepted.run.runId, { status: 'interrupted' })
    await expect(projectTerminalAdmissionUsers(a, history, scope)).rejects.toMatchObject({ code: 'ADMISSION_HISTORY_BACKEND_UNSUPPORTED' })
    expect((await readAdmissionSeed(a, scope, accepted.run.runId)).projected).toBe(false)
  })
})
