/** Real WAL admission/outbox and actual history backends; no listener, dispatcher or model. */
import fs from 'node:fs'
import path from 'node:path'
import type { Transaction } from '@libsql/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as database from '../../sqlite/db.js'
import { LocalSqliteProcessClient } from '../../sqlite/local-process-client.js'
import { RootRunStore } from '../../root-runs/index.js'
import { CronStore } from '../../cron/index.js'
import { CronRunStore } from '../../cron/runs.js'
import { createConversationHistory } from '../../conversation/factory.js'
import { admissionProjectingHistory, projectTerminalAdmissionUsers, readAdmissionSeed } from '../projection.js'
import { prepareUserAdmission, userAdmissionDigest } from '../index.js'

const scope = { tenantId: 'default', sessionId: 'server-seed' }
let directory: string, db: LocalSqliteProcessClient, roots: RootRunStore
beforeEach(async () => {
  fs.mkdirSync('.e2e-tmp', { recursive: true }); directory = fs.mkdtempSync(path.resolve('.e2e-tmp/server-seed-'))
  vi.stubEnv('DATA_DIR', path.join(directory, 'fixture.db')); vi.stubEnv('HISTORY_BACKEND', 'jsonl')
  db = new LocalSqliteProcessClient({ url: 'file:' + path.join(directory, 'fixture.db').replaceAll('\\', '/') })
  vi.spyOn(database, 'getDb').mockImplementation(() => db); await database.initDb()
  roots = new RootRunStore(() => db); await roots.list(scope.tenantId, scope.sessionId)
})
afterEach(async () => {
  database.closeDb(); expect((await db.closeWithReceipt()).healthy).toBe(true)
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (path.dirname(directory) !== path.resolve('.e2e-tmp') || !path.basename(directory).startsWith('server-seed-')) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 })
})
const create = (request: Record<string, unknown>, store = roots, sessionId = scope.sessionId) => store.create(scope.tenantId, sessionId, 'scripted-only', [], request)
async function count(table: string) { return Number((await db.execute('SELECT count(*) AS n FROM ' + table)).rows[0].n) }
function lostAck(afterCommit?: () => Promise<void>) {
  let faults = 0
  const proxy = new Proxy(db, { get(target, key) {
    if (key === 'transaction') return async (mode?: Parameters<typeof db.transaction>[0]) => {
      const tx = await target.transaction(mode); let inserted = false
      return new Proxy(tx, { get(owner, name) {
        if (name === 'execute') return async (...args: Parameters<Transaction['execute']>) => {
          const input = args[0], sql = typeof input === 'string' ? input : input.sql
          if (sql.startsWith('INSERT INTO root_runs(')) inserted = true
          return owner.execute(...args)
        }
        if (name === 'commit') return async () => { await owner.commit(); if (inserted) { faults++; await afterCommit?.(); throw new Error('LOST_ROOT_COMMIT_ACK') } }
        const value = Reflect.get(owner, name, owner); return typeof value === 'function' ? value.bind(owner) : value
      } })
    }
    const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value
  } })
  return { roots: new RootRunStore(() => proxy), get faults() { return faults } }
}
async function cronClaim() {
  const jobs = new CronStore(), runs = new CronRunStore(db), now = Math.floor(Date.now() / 60000) * 60000
  const job = await jobs.create(scope.tenantId, { name: 'Immutable occurrence', message: 'Exact occurrence input', thinkingMode: false,
    configuration: { version: 2, schedule: { kind: 'interval', everyMinutes: 1, anchorAt: now }, target: { kind: 'standalone' }, notificationPolicy: 'silent', toolProfile: 'general' } })
  await db.execute({ sql: 'UPDATE cron_jobs SET next_run_at=? WHERE id=?', args: [now, job.id] })
  const run = (await runs.claimDue((await jobs.getById(job.id, scope.tenantId))!, now, now + 60000, now + 1))!
  const request = { message: run.snapshot.message, sessionId: run.sessionId, automationRunId: run.id, cronJobId: run.jobId, thinkingMode: false, toolProfile: 'general' }
  return { run, request }
}

describe('Server immutable admission seed', () => {
  it('captures nested input before the first await and commits exact IDs with separate server authority', async () => {
    const request = { message: [{ type: 'text', text: 'Original immutable task' }], metadata: { label: { value: 'original' } } }
    const pending = create(request); request.message[0].text = 'mutated'; request.metadata.label.value = 'mutated'
    const root = await pending, seed = await readAdmissionSeed(db, scope, root.runId)
    expect(seed.message).toMatchObject({ id: root.userMessageId, content: [{ type: 'text', text: 'Original immutable task' }], conversationId: root.turnId, metadata: { label: { value: 'original' }, rootRunId: root.runId, turnId: root.turnId } })
    expect(JSON.parse(seed.receiptJson)).toMatchObject({ authority: 'server-root-admission', provenance: { kind: 'legacy-chat' }, rootRunId: root.runId, rootSequence: root.seq, userMessageId: root.userMessageId, assistantMessageId: root.assistantMessageId })
    expect(seed.anchor.assistantAnchorId).toBe(root.assistantMessageId)
    expect(await count('user_root_admissions')).toBe(0); expect(await count('server_root_admission_seeds')).toBe(1)
  })
  it.each(['jsonl', 'sqlite'])('%s projects attachment-only input exactly once and retains only attachment labels', async backend => {
    vi.stubEnv('HISTORY_BACKEND', backend)
    const root = await create({ message: '', attachments: [{ name: 'original.txt', type: 'text/plain', content: 'PRIVATE_ATTACHMENT_PAYLOAD' }] })
    const seed = await readAdmissionSeed(db, scope, root.runId), history = admissionProjectingHistory(createConversationHistory(), seed.anchor)
    expect(seed.message.content).toBe(''); expect(seed.message.metadata?.attachments).toEqual([{ name: 'original.txt', type: 'text/plain' }])
    expect(seed.seedJson).not.toContain('PRIVATE_ATTACHMENT_PAYLOAD')
    await history.append(seed.message, scope); await history.append(seed.message, scope)
    expect((await history.getFullHistory(scope)).map(message => message.id)).toEqual([root.userMessageId])
    expect((await readAdmissionSeed(db, scope, root.runId)).projected).toBe(true)
    await expect(history.append({ ...seed.message, content: 'changed input' }, scope)).rejects.toThrow('ADMISSION_USER_PROJECTION_CONFLICT')
  })
  it('reconciles a lost commit ACK from the exact immutable seed without a second root', async () => {
    const fault = lostAck(), root = await create({ message: 'Original committed input' }, fault.roots)
    expect(fault.faults).toBe(1); expect(await count('root_runs')).toBe(1)
    expect((await readAdmissionSeed(db, scope, root.runId)).message.content).toBe('Original committed input')
  })
  it.each(['missing', 'corrupt'])('fails closed after lost ACK with %s seed and never readmits', async kind => {
    const fault = lostAck(async () => { await db.execute(kind === 'missing' ? 'DELETE FROM server_root_admission_seeds' : "UPDATE server_root_admission_seeds SET seed_json='{}'") })
    await expect(create({ message: 'Exact input' }, fault.roots)).rejects.toThrow(kind === 'missing' ? 'ADMISSION_SEED_UNAVAILABLE' : 'ADMISSION_SEED_CORRUPT')
    expect(fault.faults).toBe(1); expect(await count('root_runs')).toBe(1)
  })
  it('never upgrades old readable IDs or caller supplied authority to immutable admission', async () => {
    const root = await create({ serverAdmissionReceipt: { authority: 'server-root-admission' } })
    await expect(readAdmissionSeed(db, scope, root.runId)).rejects.toThrow('ADMISSION_SEED_UNAVAILABLE')
    expect(await count('server_root_admission_seeds')).toBe(0)
    await expect(create({ message: 'spoofed', automationRunId: 'readable-cron-id' }, roots, 'other')).rejects.toThrow('Automation admission context is required')
    expect(await count('root_runs')).toBe(1)
  })
  it('binds genuine Cron provenance and detects occurrence/root/message tampering', async () => {
    const { run, request } = await cronClaim()
    const root = await roots.create(scope.tenantId, run.sessionId, 'scripted-only', [], request, { runId: run.id, dispatchRequest: request })
    const cronScope = { ...scope, sessionId: run.sessionId }, seed = await readAdmissionSeed(db, cronScope, root.runId)
    expect(seed.message.content).toBe(run.snapshot.message)
    expect(JSON.parse(seed.receiptJson).provenance).toEqual({ kind: 'cron', runId: run.id, jobId: run.jobId, jobRevision: run.jobRevision, scheduleRevision: run.scheduleRevision })
    await db.execute({ sql: 'UPDATE cron_runs SET root_run_id=? WHERE id=?', args: ['foreign-root', run.id] })
    await expect(readAdmissionSeed(db, cronScope, root.runId)).rejects.toThrow('ADMISSION_SEED_CORRUPT')
  })
  it('rejects a forged effective Cron message even when a separate valid dispatch body is supplied', async () => {
    const { run, request } = await cronClaim()
    await expect(roots.create(scope.tenantId, run.sessionId, 'scripted-only', [], { ...request, message: 'forged effective input' }, { runId: run.id, dispatchRequest: request })).rejects.toThrow('AUTOMATION_ADMISSION_SEED_CONFLICT')
    expect(await count('root_runs')).toBe(0)
    expect((await db.execute({ sql: 'SELECT root_run_id,status FROM cron_runs WHERE id=?', args: [run.id] })).rows[0]).toMatchObject({ root_run_id: null, status: 'claimed' })
  })
  it('retains the original seed through parking, answer attempt replacement, terminal identity and reopen', async () => {
    const root = await create({ message: 'Original before parking' }), first = await readAdmissionSeed(db, scope, root.runId)
    const pending = { requestId: 'ask', kind: 'ask' as const, toolCallId: 'call', toolName: 'ask_user', args: {}, messageId: 'assistant-ask' }
    await roots.update(scope.tenantId, root.runId, { status: 'waiting', pending: [{ ...pending, status: 'pending' }] })
    const answer = await roots.answer(scope.tenantId, scope.sessionId, root.runId, 'ask', 'call', 'ask_user', 'Answer text')
    expect(answer.run.status).toBe('running')
    await roots.update(scope.tenantId, root.runId, { status: 'succeeded', assistantMessageId: 'actual-terminal-id' })
    expect((await readAdmissionSeed(db, scope, root.runId)).seedJson).toBe(first.seedJson)
    expect((await readAdmissionSeed(db, scope, root.runId)).receiptJson).toBe(first.receiptJson)
    expect((await db.closeWithReceipt()).healthy).toBe(true)
    db = new LocalSqliteProcessClient({ url: 'file:' + path.join(directory, 'fixture.db').replaceAll('\\', '/') })
    expect((await readAdmissionSeed(db, scope, root.runId)).anchor.assistantAnchorId).toBe(root.assistantMessageId)
  })
  it('shares a finite terminal outbox budget with modern seeds and cannot resurrect deleted roots', async () => {
    const ids: string[] = []
    for (let i = 0; i < 11; i++) {
      const root = await create({ message: 'Retained server seed ' + i }); ids.push(root.runId)
      await roots.update(scope.tenantId, root.runId, { status: 'interrupted' })
    }
    const history = createConversationHistory()
    expect(await projectTerminalAdmissionUsers(db, history, scope)).toBe(8)
    await db.execute({ sql: 'DELETE FROM root_runs WHERE run_id=?', args: [ids[9]] })
    expect(await projectTerminalAdmissionUsers(db, history, scope)).toBe(2)
    const rows = await history.getFullHistory(scope)
    expect(rows).toHaveLength(10); expect(rows.some(row => row.metadata?.rootRunId === ids[9])).toBe(false)
    const context = await roots.userAdmissionContext(scope.tenantId, scope.sessionId)
    const transport = { toolProfile: 'general', runLifetime: 'durable', subagentProtocol: 2 as const }, selector = { protocolVersion: 1 as const, namespace: context.namespace, owner: 'work' as const, predecessor: context.predecessor }
    const body: Record<string, unknown> = { sessionId: scope.sessionId, message: 'Modern separately keyed input' }
    body.admission = { ...selector, requestKey: 'modern', bodyDigest: userAdmissionDigest(body, transport, selector) }
    const modern = await roots.createUserAdmission(scope.tenantId, 'scripted-only', [], body, prepareUserAdmission(body, transport)!)
    await roots.update(scope.tenantId, modern.run.runId, { status: 'succeeded' })
    expect(await projectTerminalAdmissionUsers(db, history, scope)).toBe(1)
    expect(JSON.parse((await readAdmissionSeed(db, scope, modern.run.runId)).receiptJson)).not.toHaveProperty('authority')
    expect(await count('user_root_admissions')).toBe(1); expect(await count('server_root_admission_seeds')).toBe(11)
  })
})
