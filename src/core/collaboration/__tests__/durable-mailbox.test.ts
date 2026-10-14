// SQLite admission/queue receipts, server capability ownership and failure/restart boundaries.
// No model executor or frontend event is substituted for delivery evidence.
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Transaction, TransactionMode } from '@libsql/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SubagentStore } from '../../subagent/store.js'
import { LocalSqliteProcessClient } from '../../../storage/sqlite/local-process-client.js'
import type { CreateSubagentRun, SubagentContinuationProfile } from '../../subagent/types.js'
import { CollaborationRuntime } from '../runtime.js'
import { CollaborationStore } from '../store.js'
import type { CollaborationProducer, CollaborationReceipt, CollaborationRootScope } from '../types.js'

let directory: string, db: LocalSqliteProcessClient, store: CollaborationStore, agents: SubagentStore, runtime: CollaborationRuntime
let root: CollaborationProducer
const scope: CollaborationRootScope = { tenantId: 'tenant-a', rootRunId: 'root-a', rootAttemptId: 'attempt-a', rootSessionId: 'parent-a' }
const profile: SubagentContinuationProfile = { readOnly: true, systemPrompt: 'frozen fixture', toolNames: [], workspacePaths: [] }
const childInput = (key: string, overrides: Partial<CreateSubagentRun> = {}): CreateSubagentRun => ({
  tenantId: scope.tenantId, rootSessionId: scope.rootSessionId, parentSessionId: scope.rootSessionId,
  parentConversationId: 'turn-a', parentMessageId: 'dispatch', parentToolCallId: key,
  task: 'synthetic communication fixture', description: key, modelId: 'fixture-no-model', continuation: profile, ...overrides,
})
async function insertRoot(tenantId = scope.tenantId, runId = scope.rootRunId, attemptId = scope.rootAttemptId, sessionId = scope.rootSessionId, turnId = 'turn-a') {
  await db.execute({ sql: 'INSERT INTO root_runs(tenant_id,session_id,run_id,turn_id,state) VALUES (?,?,?,?,?)',
    args: [tenantId, sessionId, runId, turnId, JSON.stringify({ status: 'running', attemptId, sessionId, turnId })] })
}
async function rows(table: string): Promise<number> { return Number((await db.execute(`SELECT count(*) AS count FROM ${table}`)).rows[0].count) }
async function child(key: string) {
  const admitted = await runtime.admitChild(root, childInput(key))
  return { ...admitted, participantId: `child:${admitted.mutation.header.childSessionId}` }
}

beforeEach(async () => {
  directory = path.resolve('.e2e-tmp', `g3-mailbox-${randomUUID()}`)
  fs.mkdirSync(directory, { recursive: true })
  db = new LocalSqliteProcessClient({ url: `file:${path.join(directory, 'fixture.db').replaceAll('\\', '/')}` })
  await db.execute(`CREATE TABLE root_runs(seq INTEGER PRIMARY KEY AUTOINCREMENT,tenant_id TEXT NOT NULL,session_id TEXT NOT NULL,
    run_id TEXT NOT NULL UNIQUE,turn_id TEXT NOT NULL,state TEXT NOT NULL)`)
  await insertRoot()
  store = new CollaborationStore(db); agents = new SubagentStore(db); runtime = new CollaborationRuntime(store, agents)
  root = await runtime.admitRoot(scope)
})
afterEach(async () => {
  vi.restoreAllMocks(); db.close(); await db.whenClosed()
  if (!directory.startsWith(path.resolve('.e2e-tmp') + path.sep)) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 })
})

describe('trusted producer and atomic membership', () => {
  it('resolves root identity from the real root row and rejects unknown or stale attempts', async () => {
    expect(await runtime.admitRoot(scope)).toBe(root)
    await expect(runtime.admitRoot({ ...scope, rootAttemptId: 'wrong-attempt' })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(runtime.admitRoot({ ...scope, tenantId: 'other-tenant' })).rejects.toMatchObject({ code: 'forbidden' })
    expect(await rows('collaboration_roots')).toBe(1)
    expect(await rows('collaboration_participants')).toBe(1)
  })
  it('rejects copied, forged and another-registry capabilities before any message is written', async () => {
    const c = await child('peer')
    for (const forged of [{}, { ...scope }, { ...root }] as CollaborationProducer[]) {
      expect(() => runtime.send(forged, { recipientParticipantId: c.participantId, message: 'forged', requestKey: 'x' })).toThrow('server producer capability')
    }
    const foreign = new CollaborationRuntime(store, agents)
    expect(() => foreign.send(root, { recipientParticipantId: c.participantId, message: 'copied', requestKey: 'x' })).toThrow('server producer capability')
    await expect(foreign.admitRoot(scope)).rejects.toMatchObject({ code: 'conflict' })
    expect(await rows('collaboration_messages')).toBe(0)
  })
  it('commits the actual child, invocation and membership together and reuses the exact dispatch', async () => {
    const c = await child('one')
    const duplicate = await runtime.admitChild(root, childInput('one'))
    expect(duplicate.producer).toBe(c.producer)
    expect(duplicate.mutation.header.runId).toBe(c.mutation.header.runId)
    expect(await rows('subagent_runs')).toBe(1)
    expect(await rows('collaboration_participants')).toBe(2)
    expect(await rows('collaboration_invocations')).toBe(2)
    const actual = await store.participants(scope)
    expect(actual.entries.map(p => [p.kind, p.sessionId])).toEqual([['root', 'parent-a'], ['child', c.mutation.header.childSessionId]])
  })
  it('communication capability does not implicitly grant a child nested-spawn permission', async () => {
    const c = await child('one')
    expect(() => runtime.admitChild(c.producer, childInput('nested', { parentSessionId: c.mutation.header.childSessionId }))).toThrow('has not been authorized')
    expect(await rows('subagent_runs')).toBe(1)
  })
  it('resolves the original admitted child after terminal completion without resurrecting or reexecuting it', async () => {
    const c = await child('original')
    await agents.appendHeader(scope.tenantId, c.mutation.header.runId, 'finished', { status: 'succeeded', finishedAt: Date.now() })
    const retry = await runtime.admitChild(root, childInput('original'))
    expect(retry.producer).toBe(c.producer)
    expect(retry.mutation.header.runId).toBe(c.mutation.header.runId)
    expect(retry.mutation.header.status).toBe('succeeded')
    expect(await rows('subagent_runs')).toBe(1)
    expect(await rows('collaboration_invocations')).toBe(2)
  })
  it('rolls back child, delta/outbox and membership if the admission hook fails after its insert', async () => {
    const original = store.admitChild.bind(store)
    vi.spyOn(store, 'admitChild').mockImplementationOnce(async (tx, parent, header, admission) => {
      await original(tx, parent, header, admission)
      throw new Error('fixture fail after membership')
    })
    await expect(runtime.admitChild(root, childInput('must-rollback'))).rejects.toThrow('fail after membership')
    expect(await rows('subagent_runs')).toBe(0)
    expect(await rows('subagent_checkpoints')).toBe(0)
    expect(await rows('subagent_events')).toBe(0)
    expect(await rows('collaboration_participants')).toBe(1)
    expect(await rows('collaboration_invocations')).toBe(1)
  })
  it('recovers a lost child commit ACK through the same dispatch without a second child or membership', async () => {
    // Prepare before installing the fault: only the actual admission commit
    // should lose its response, not an unrelated schema/preparation operation.
    await agents.createRunDelta(childInput('warmup'))
    const native = db.transaction.bind(db)
    let dropped = false
    vi.spyOn(db, 'transaction').mockImplementation(async (mode?: TransactionMode) => {
      const tx = await native(mode)
      if (mode !== 'write' || dropped) return tx
      return new Proxy(tx, { get(target, property) {
        if (property === 'commit') return async () => { await target.commit(); dropped = true; throw new Error('child commit ACK unknown') }
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      } })
    })
    await expect(runtime.admitChild(root, childInput('lost-ack'))).rejects.toThrow('child commit ACK unknown')
    expect(await rows('subagent_runs')).toBe(2)
    expect(await rows('collaboration_participants')).toBe(2)
    vi.restoreAllMocks()
    const recovered = await runtime.admitChild(root, childInput('lost-ack'))
    expect(recovered.mutation.header.parentToolCallId).toBe('lost-ack')
    expect(await rows('subagent_runs')).toBe(2)
    expect(await rows('collaboration_participants')).toBe(2)
    expect(await rows('collaboration_invocations')).toBe(2)
  })
  it.each([
    ['tenant', { tenantId: 'tenant-b' }], ['root session', { rootSessionId: 'parent-b' }],
    ['parent session', { parentSessionId: 'parent-b' }], ['turn', { parentConversationId: 'turn-old' }],
  ])('rejects %s mismatch within the physical child transaction', async (_name, override) => {
    await expect(runtime.admitChild(root, childInput('bad', override))).rejects.toMatchObject({ code: 'forbidden' })
    expect(await rows('subagent_runs')).toBe(0)
    expect(await rows('collaboration_participants')).toBe(1)
  })
  it('cannot annex a legacy child from another turn through an idempotent dispatch collision', async () => {
    await agents.createRunDelta(childInput('existing', { parentConversationId: 'old-turn' }))
    await expect(runtime.admitChild(root, childInput('existing'))).rejects.toMatchObject({ code: 'forbidden' })
    expect(await rows('subagent_runs')).toBe(1)
    expect(await rows('collaboration_participants')).toBe(1)
  })
  it('cannot annex a legacy child even when its stored session and turn happen to match the current root', async () => {
    await agents.createRunDelta(childInput('legacy-current-turn'))
    await expect(runtime.admitChild(root, childInput('legacy-current-turn'))).rejects.toMatchObject({ code: 'forbidden' })
    expect(await rows('subagent_runs')).toBe(1)
    expect(await rows('collaboration_participants')).toBe(1)
    expect(await rows('collaboration_invocations')).toBe(1)
  })
  it('allows the trusted new root attempt without annexing a child owned by the prior attempt', async () => {
    const c = await child('prior-attempt')
    const accepted = await runtime.send(root, { recipientParticipantId: c.participantId, message: 'old waiting message', requestKey: 'old' })
    await db.execute({ sql: "UPDATE root_runs SET state=json_set(state,'$.attemptId','attempt-next') WHERE run_id='root-a'", args: [] })
    const nextRoot = await runtime.admitRoot({ ...scope, rootAttemptId: 'attempt-next' })
    expect(nextRoot).not.toBe(root)
    await expect(runtime.send(root, { recipientParticipantId: c.participantId, message: 'stale', requestKey: 'new' })).rejects.toMatchObject({ code: 'closed' })
    await expect(runtime.admitChild(nextRoot, childInput('prior-attempt'))).rejects.toMatchObject({ code: 'conflict' })
    expect(await store.findReceipt(scope, accepted.messageId)).toEqual({ ...accepted, state: 'interrupted', reason: 'root_attempt_superseded' })
    expect(await rows('collaboration_roots')).toBe(2)
    expect(await rows('subagent_runs')).toBe(1)
    expect(await rows('collaboration_participants')).toBe(3)
  })
  it('refuses a caller-supplied child session and retains the frozen child on explicit continuation', async () => {
    expect(() => runtime.admitChild(root, childInput('forged-session', { childSessionId: 'user-chosen' }))).toThrow('session identity')
    const c = await child('initial')
    await agents.appendHeader(scope.tenantId, c.mutation.header.runId, 'finished', { status: 'succeeded', finishedAt: Date.now() })
    const next = await runtime.admitChild(root, childInput('resume', { resumeFromRunId: c.mutation.header.runId,
      continuation: { ...profile, systemPrompt: 'malicious replacement', readOnly: false } }))
    expect(next.mutation.header.childSessionId).toBe(c.mutation.header.childSessionId)
    expect(next.mutation.header.runId).not.toBe(c.mutation.header.runId)
    expect(next.mutation.header.continuation).toEqual(profile)
    expect(await rows('collaboration_participants')).toBe(2)
    expect(await rows('collaboration_invocations')).toBe(3)
  })
})

describe('durable accepted receipts with no consumer claim', () => {
  it('persists root-to-child, child-to-root and same-root sibling messages with truthful queued status', async () => {
    const a = await child('a'), b = await child('b')
    const first = await runtime.send(root, { recipientParticipantId: a.participantId, message: 'root assigns', requestKey: 'assign' })
    const second = await runtime.send(a.producer, { recipientParticipantId: 'root:root-a', message: 'child reply', requestKey: 'reply' })
    const third = await runtime.send(a.producer, { recipientParticipantId: b.participantId, message: 'sibling handoff', requestKey: 'handoff' })
    expect([first.state, second.state, third.state]).toEqual(['queued', 'queued', 'queued'])
    expect(third.senderInvocationRunId).toBe(a.mutation.header.runId)
    const persisted = await db.execute('SELECT body,state FROM collaboration_messages ORDER BY seq')
    expect(persisted.rows.map(r => [r.body, r.state])).toEqual([['root assigns', 'queued'], ['child reply', 'queued'], ['sibling handoff', 'queued']])
  })
  it('retries the same key after a lost response without duplicating body or immutable receipt', async () => {
    const c = await child('a')
    const args = { recipientParticipantId: c.participantId, message: '中文🌿 synthetic handoff', requestKey: 'same-ack' }
    const accepted = await runtime.send(root, args)
    const reread = await runtime.receipt(root, args.requestKey)
    const duplicate = await runtime.send(root, args)
    expect(reread).toEqual(accepted); expect(duplicate).toEqual(accepted)
    expect(await rows('collaboration_messages')).toBe(1)
    expect(accepted.payloadBytes).toBe(Buffer.byteLength(args.message))
  })
  it('uses SQLite uniqueness for concurrent same-key sends', async () => {
    const c = await child('a')
    const accepted = await Promise.all(Array.from({ length: 16 }, () => runtime.send(root, { recipientParticipantId: c.participantId, message: 'same', requestKey: 'same' })))
    expect(new Set(accepted.map(r => r.messageId)).size).toBe(1)
    expect(await rows('collaboration_messages')).toBe(1)
  })
  it('rejects changed target or payload under an existing key rather than rewriting history', async () => {
    const a = await child('a'), b = await child('b')
    const original = { recipientParticipantId: a.participantId, message: 'original', requestKey: 'same' }
    await runtime.send(root, original)
    await expect(runtime.send(root, { ...original, message: 'replacement' })).rejects.toMatchObject({ code: 'conflict' })
    await expect(runtime.send(root, { ...original, recipientParticipantId: b.participantId })).rejects.toMatchObject({ code: 'conflict' })
    expect((await db.execute('SELECT body FROM collaboration_messages')).rows.map(r => r.body)).toEqual(['original'])
  })
  it('forbids another root or tenant even when its real participant id is known', async () => {
    await insertRoot('tenant-a', 'root-b', 'attempt-b', 'parent-b', 'turn-b')
    const other = await runtime.admitRoot({ tenantId: 'tenant-a', rootRunId: 'root-b', rootAttemptId: 'attempt-b' })
    const c = await runtime.admitChild(other, childInput('foreign', { rootSessionId: 'parent-b', parentSessionId: 'parent-b', parentConversationId: 'turn-b' }))
    const target = `child:${c.mutation.header.childSessionId}`
    await expect(runtime.send(root, { recipientParticipantId: target, message: 'cross-root', requestKey: 'no' })).rejects.toMatchObject({ code: 'not_found' })
    await expect(store.findReceipt({ ...scope, tenantId: 'tenant-b' }, 'anything')).rejects.toMatchObject({ code: 'not_found' })
    expect(await rows('collaboration_messages')).toBe(0)
  })
  it('a terminal invocation cannot send, while a root may queue a message for explicit resume', async () => {
    const c = await child('a')
    await agents.appendHeader(scope.tenantId, c.mutation.header.runId, 'finished', { status: 'succeeded', finishedAt: Date.now() })
    await expect(runtime.send(c.producer, { recipientParticipantId: 'root:root-a', message: 'late', requestKey: 'late' })).rejects.toMatchObject({ code: 'closed' })
    const accepted = await runtime.send(root, { recipientParticipantId: c.participantId, message: 'next explicit turn', requestKey: 'resume' })
    expect(accepted.state).toBe('queued')
    expect((await agents.getRunView(scope.tenantId, c.mutation.header.runId))?.status).toBe('succeeded')
  })
  it.each([['', 'invalid'], ['a'.repeat(32769), 'too_large']])('rejects invalid/oversize body before accepting any receipt', async (message, code) => {
    const c = await child('a')
    await expect(runtime.send(root, { recipientParticipantId: c.participantId, message, requestKey: 'invalid' })).rejects.toMatchObject({ code })
    expect(await rows('collaboration_messages')).toBe(0)
  })
  it('bounds unread backlog and never silently accepts an overflow message', async () => {
    const c = await child('a')
    const seed = await runtime.send(root, { recipientParticipantId: c.participantId, message: 'seed', requestKey: 'seed' })
    await db.execute({ sql: `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1023)
      INSERT INTO collaboration_messages(tenant_id,root_run_id,root_attempt_id,message_id,sender_participant_id,sender_invocation_run_id,recipient_participant_id,request_key,payload_hash,payload_bytes,body,accepted_at,state)
      SELECT 'tenant-a','root-a','attempt-a','seed-'||x,'root:root-a','root-a',?,'key-'||x,?,4,'seed',1,'queued' FROM n`, args: [c.participantId, seed.payloadHash] })
    await expect(runtime.send(root, { recipientParticipantId: c.participantId, message: 'overflow', requestKey: 'overflow' })).rejects.toMatchObject({ code: 'full' })
    expect(await rows('collaboration_messages')).toBe(1024)
  })
})

describe('prefix paging, admission closure and explicit startup', () => {
  it('keeps the exact admitted prefix through late children and binds signed cursor to root and revision', async () => {
    await child('a'); await child('b')
    const first = await store.participants(scope, { limit: 1 })
    await child('late')
    const rest = await store.participants(scope, { limit: 64, cursor: first.nextCursor })
    expect(rest.revision).toBe(first.revision)
    expect([first.entries[0], ...rest.entries].length).toBe(3)
    expect(rest.hasMore).toBe(false)
    const raw = first.nextCursor!.split('.')
    const forged = JSON.parse(Buffer.from(raw[0], 'base64url').toString()) as { revision: number }
    forged.revision += 1
    await expect(store.participants(scope, { cursor: `${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${raw[1]}` })).rejects.toMatchObject({ code: 'invalid' })
    await expect(store.receipts(scope, 'root:root-a', { cursor: first.nextCursor })).rejects.toMatchObject({ code: 'invalid' })
  })
  it('pages immutable receipt prefix without transporting body or including later acceptance', async () => {
    const c = await child('a')
    const accepted: CollaborationReceipt[] = []
    for (let i = 0; i < 4; i++) accepted.push(await runtime.send(root, { recipientParticipantId: c.participantId, message: 'a'.repeat(32768), requestKey: `key-${i}` }))
    const first = await store.receipts(scope, c.participantId, { limit: 2 })
    await runtime.send(root, { recipientParticipantId: c.participantId, message: 'late', requestKey: 'late' })
    const second = await store.receipts(scope, c.participantId, { cursor: first.nextCursor, limit: 2 })
    expect([...first.entries, ...second.entries]).toEqual(accepted)
    expect(second.hasMore).toBe(false)
    expect(JSON.stringify(first)).not.toContain('a'.repeat(100))
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(4096)
  })
  it('admission racing with drain is either admitted-and-owned or rejected with no partial child', async () => {
    const admitted = runtime.admitChild(root, childInput('before-drain'))
    const draining = runtime.beginDrain(root)
    await admitted; await draining
    await expect(runtime.admitChild(root, childInput('after-drain'))).rejects.toMatchObject({ code: 'closed' })
    expect(await rows('subagent_runs')).toBe(1)
    expect(await rows('collaboration_participants')).toBe(2)
    // This admission registry does not assert execution settlement/drain; G3b owns that gate.
    expect((await agents.getRunView(scope.tenantId, (await admitted).mutation.header.runId))?.status).toBe('queued')
  })
  it('draining permits existing sibling handoff but rejects root input and new children', async () => {
    const a = await child('a'), b = await child('b')
    await runtime.beginDrain(root)
    expect((await runtime.send(a.producer, { recipientParticipantId: b.participantId, message: 'finish handoff', requestKey: 'ok' })).state).toBe('queued')
    await expect(runtime.send(a.producer, { recipientParticipantId: 'root:root-a', message: 'too late', requestKey: 'late' })).rejects.toMatchObject({ code: 'closed' })
    await expect(runtime.beginDrain(a.producer)).rejects.toMatchObject({ code: 'forbidden' })
  })
  it('closure rejects queued messages, preserves idempotent receipts and cannot reopen', async () => {
    const c = await child('a'), input = { recipientParticipantId: c.participantId, message: 'queued', requestKey: 'one' }
    const accepted = await runtime.send(root, input)
    await runtime.closeAdmission(root)
    const receipt = await runtime.send(root, input)
    expect(receipt).toEqual({ ...accepted, state: 'rejected', reason: 'root_closed_without_consumer' })
    await expect(runtime.send(root, { ...input, requestKey: 'new' })).rejects.toMatchObject({ code: 'closed' })
    await expect(runtime.admitRoot(scope)).rejects.toMatchObject({ code: 'conflict' })
    expect(await rows('collaboration_messages')).toBe(1)
  })
  it('ordinary construction and GET preparation do not recover or execute pending work', async () => {
    const c = await child('a')
    const accepted = await runtime.send(root, { recipientParticipantId: c.participantId, message: 'waiting', requestKey: 'one' })
    const newStore = new CollaborationStore(db)
    await newStore.participants(scope)
    expect((await newStore.findReceipt(scope, accepted.messageId))?.state).toBe('queued')
    expect(String((await db.execute('SELECT phase FROM collaboration_roots')).rows[0].phase)).toBe('open')
  })
  it('explicit startup recovery survives another SQLite client without re-executing children', async () => {
    const c = await child('a')
    const accepted = await runtime.send(root, { recipientParticipantId: c.participantId, message: 'waiting', requestKey: 'one' })
    db.close(); await db.whenClosed()
    db = new LocalSqliteProcessClient({ url: `file:${path.join(directory, 'fixture.db').replaceAll('\\', '/')}` })
    const reopened = new CollaborationStore(db)
    expect(await reopened.recoverInterruptedAtStartup()).toBe(1)
    expect(await reopened.recoverInterruptedAtStartup()).toBe(0)
    expect(await reopened.findReceipt(scope, accepted.messageId)).toEqual({ ...accepted, state: 'interrupted', reason: 'engine_restarted_before_consumer' })
    const fresh = new CollaborationRuntime(reopened, new SubagentStore(db))
    await expect(fresh.admitRoot(scope)).rejects.toMatchObject({ code: 'conflict' })
    expect((await db.execute('SELECT status FROM subagent_runs')).rows[0].status).toBe('queued')
  })
  it('a before-commit storage fault rolls back body and a failed commit ACK retains the original error', async () => {
    const c = await child('a'), native = db.transaction.bind(db)
    let fault: 'body' | 'ack' = 'body'
    vi.spyOn(db, 'transaction').mockImplementation(async (mode?: TransactionMode) => {
      const tx = await native(mode)
      if (mode !== 'write') return tx
      return new Proxy(tx, { get(target, property) {
        if (property === 'execute' && fault === 'body') return async (...args: Parameters<Transaction['execute']>) => {
          const statement = args[0]
          const sql = typeof statement === 'string' ? statement : statement.sql
          const result = await target.execute(...args)
          if (sql.includes('INSERT INTO collaboration_messages')) throw new Error('before commit body failure')
          return result
        }
        if (property === 'commit' && fault === 'ack') return async () => { await target.commit(); throw new Error('commit ACK outcome unknown') }
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      } })
    })
    const input = { recipientParticipantId: c.participantId, message: 'fault fixture', requestKey: 'one' }
    await expect(runtime.send(root, input)).rejects.toThrow('before commit body failure')
    expect(await rows('collaboration_messages')).toBe(0)
    fault = 'ack'
    await expect(runtime.send(root, input)).rejects.toThrow('commit ACK outcome unknown')
    expect(await rows('collaboration_messages')).toBe(1)
    vi.restoreAllMocks()
    const recovered = await runtime.receipt(root, input.requestKey)
    expect(recovered?.state).toBe('queued')
    expect(await runtime.send(root, input)).toEqual(recovered)
  })
})
