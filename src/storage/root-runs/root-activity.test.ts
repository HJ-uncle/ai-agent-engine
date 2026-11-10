/** Real SQLite transactions and execution capabilities; no model or HTTP listener. */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as database from '../sqlite/db.js'
import { LocalSqliteProcessClient } from '../sqlite/local-process-client.js'
import { RootRunStore, type RootRun, type RootRunActivity } from './index.js'
import { CollaborationRuntime } from '../../core/collaboration/runtime.js'
import { CollaborationStore } from '../../core/collaboration/store.js'
import { ExecutionOwners, type ExecutionOwner } from '../../core/collaboration/execution-owner.js'
import { SubagentStore } from '../../core/subagent/store.js'
import { withHistoryLock } from '../conversation/serialization.js'

let directory: string, db: LocalSqliteProcessClient, store: RootRunStore, root: RootRun
let runtime: CollaborationRuntime, owners: ExecutionOwners, owner: ExecutionOwner, controller: AbortController
const waiting = (): RootRunActivity => ({ phase: 'waiting_children', groups: [
  { id: 'integration', label: '集成模块', state: 'waiting', total: 2, settled: 1, failed: 0 },
] })
beforeEach(async () => {
  await database.closeDb()
  fs.mkdirSync('.e2e-tmp', { recursive: true }); directory = fs.mkdtempSync(path.resolve('.e2e-tmp/root-activity-'))
  vi.stubEnv('DATA_DIR', path.join(directory, 'fixture.db'))
  db = new LocalSqliteProcessClient({ url: 'file:' + path.join(directory, 'fixture.db').replaceAll('\\', '/') })
  vi.spyOn(database, 'getDb').mockImplementation(() => db)
  await database.initDb()
  store = new RootRunStore(() => db); root = await store.create('activity', 'session', 'no-model', [], {})
  runtime = new CollaborationRuntime(new CollaborationStore(db), new SubagentStore(db))
  owners = new ExecutionOwners(db, runtime); controller = new AbortController()
  owner = await owners.admitRoot({ tenantId: 'activity', rootRunId: root.runId,
    rootAttemptId: (await store.get('activity', root.runId))!.attemptId, controller })
})
afterEach(async () => {
  await database.closeDb(); expect((await db.closeWithReceipt()).healthy).toBe(true)
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (path.dirname(directory) !== path.resolve('.e2e-tmp') || !path.basename(directory).startsWith('root-activity-')) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 })
})

describe('execution-owned root activity', () => {
  it('persists only bounded progress, changes its version once and leaves unchanged observations idle', async () => {
    const activity = waiting()
    const operation = store.setActivityOwned(owner, activity)
    activity.groups[0].settled = 2 // callers cannot mutate an in-flight write
    const first = await operation
    expect(first).toMatchObject({ status: 'running', version: root.version + 1, activity: waiting() })
    expect(first.finishedAt).toBeUndefined()
    const assertion = vi.spyOn(runtime.store, 'assertProducer')
    const same = await store.setActivityOwned(owner, waiting())
    expect(same).toEqual(first)
    expect(assertion).toHaveBeenCalledWith(expect.objectContaining({ commit: expect.any(Function) }), owners.record(owner).binding, true)
    const executing = await store.setActivityOwned(owner, { phase: 'executing', groups: [] })
    expect(executing.version).toBe(first.version + 1)
    expect((await store.latest('activity', 'session'))?.activity).toEqual({ phase: 'executing', groups: [] })
  })

  it('rejects invalid counts, duplicate IDs and oversized payloads before touching the run', async () => {
    const group = waiting().groups[0]
    const invalid: unknown[] = [null, {}, { phase: 'waiting_children', groups: [] },
      { phase: 'waiting_children', groups: Array.from({ length: 33 }, (_, i) => ({ ...group, id: String(i) })) },
      ...[{ label: 'x'.repeat(241) }, { id: '' }, { label: '' }, { total: 0 }, { settled: 3 }, { failed: 2 },
        { total: 1.5 }, { settled: -1 }, { state: 'succeeded' }].map(patch => ({ phase: 'waiting_children', groups: [{ ...group, ...patch }] })),
      { phase: 'waiting_children', groups: [group, group] }]
    for (const activity of invalid) await expect(store.setActivityOwned(owner, activity as RootRunActivity)).rejects.toThrow('ROOT_ACTIVITY_INVALID')
    expect((await store.latest('activity', 'session'))?.version).toBe(root.version)
    const maximum = { phase: 'executing' as const, groups: Array.from({ length: 32 }, (_, i) => ({ ...group, id: String(i), label: 'x'.repeat(240) })) }
    expect((await store.setActivityOwned(owner, maximum)).activity?.groups).toHaveLength(32)
  })

  it('rejects forged capabilities and a store using another physical database', async () => {
    await expect(store.setActivityOwned(Object.freeze({}) as ExecutionOwner, waiting())).rejects.toThrow('EXECUTION_OWNERSHIP')
    const other = new LocalSqliteProcessClient({ url: 'file:' + path.join(directory, 'other.db').replaceAll('\\', '/') })
    try { await expect(new RootRunStore(() => other).setActivityOwned(owner, waiting())).rejects.toThrow('DATASOURCE_MISMATCH') }
    finally { await other.closeWithReceipt() }
    expect((await store.latest('activity', 'session'))?.activity).toBeUndefined()
  })

  it.each(['attemptId', 'turnId', 'sessionId'] as const)('rechecks durable %s inside the write transaction', async field => {
    const stored = (await store.get('activity', root.runId))!
    await db.execute({ sql: 'UPDATE root_runs SET state=? WHERE run_id=?', args: [JSON.stringify({ ...stored, [field]: randomUUID() }), root.runId] })
    await expect(store.setActivityOwned(owner, waiting())).rejects.toThrow()
    expect((await store.get('activity', root.runId))?.activity).toBeUndefined()
  })

  it('rejects a cancelled owner even when the durable root has not settled yet', async () => {
    controller.abort()
    await expect(store.setActivityOwned(owner, waiting())).rejects.toThrow('revoked')
    expect((await store.latest('activity', 'session'))?.version).toBe(root.version)
  })

  it('rejects child execution capabilities rather than allowing them to publish root activity', async () => {
    const ticket = owners.reserveChild(owner)
    const admitted = await runtime.admitChild(owners.producerForExecution(owner), {
      tenantId: 'activity', parentSessionId: root.sessionId, rootSessionId: root.sessionId, parentConversationId: root.turnId,
      parentMessageId: 'dispatch', parentToolCallId: 'child', task: 'Read only', description: 'Child', modelId: 'no-model',
      continuation: { readOnly: true, systemPrompt: '', toolNames: [], workspacePaths: [] },
    })
    const child = owners.attachChild(ticket, admitted.mutation.header.runId, admitted.producer)
    await expect(store.setActivityOwned(child, waiting())).rejects.toThrow('root capability')
    owners.failChild(ticket, new Error('Fixture ended'))
    expect((await store.latest('activity', 'session'))?.activity).toBeUndefined()
  })

  it.each(['generation', 'terminal'] as const)('rejects a durable %s change even if the local owner still exists', async change => {
    if (change === 'generation') await db.execute({ sql: 'UPDATE collaboration_roots SET generation=? WHERE root_run_id=?', args: [randomUUID(), root.runId] })
    else {
      const stored = (await store.get('activity', root.runId))!
      await db.execute({ sql: 'UPDATE root_runs SET state=? WHERE run_id=?', args: [JSON.stringify({ ...stored, status: 'cancelled' }), root.runId] })
    }
    await expect(store.setActivityOwned(owner, waiting())).rejects.toThrow()
    expect((await store.get('activity', root.runId))?.activity).toBeUndefined()
  })

  it('rechecks cancellation after waiting for the history lock', async () => {
    let release!: () => void, entered!: () => void
    const ready = new Promise<void>(resolve => { entered = resolve })
    const held = withHistoryLock('activity', async () => { entered(); await new Promise<void>(resolve => { release = resolve }) })
    await ready
    const update = store.setActivityOwned(owner, waiting()); void update.catch(() => undefined)
    controller.abort(); release(); await held
    await expect(update).rejects.toThrow('revoked')
    expect((await store.latest('activity', 'session'))?.activity).toBeUndefined()
  })

  it('rolls back activity and version if cancellation arrives during its SQL write', async () => {
    const transaction = db.transaction.bind(db)
    vi.spyOn(db, 'transaction').mockImplementation(async mode => {
      const tx = await transaction(mode), execute = tx.execute.bind(tx)
      vi.spyOn(tx, 'execute').mockImplementation(async query => {
        const result = await execute(query)
        const sql = typeof query === 'string' ? query : query.sql
        if (sql.startsWith('UPDATE root_runs SET state=')) controller.abort()
        return result
      })
      return tx
    })
    await expect(store.setActivityOwned(owner, waiting())).rejects.toThrow('revoked')
    expect(await store.latest('activity', 'session')).toMatchObject({ version: root.version, status: 'running' })
    expect((await store.latest('activity', 'session'))?.activity).toBeUndefined()
  })

  it('clears activity on completion and never accepts a later observer', async () => {
    await store.setActivityOwned(owner, waiting())
    const done = await store.finishOwned(owner, { status: 'succeeded' })
    expect(done.status).toBe('succeeded'); expect(done.activity).toBeUndefined()
    await expect(store.setActivityOwned(owner, waiting())).rejects.toThrow()
    expect((await store.get('activity', root.runId))?.activity).toBeUndefined()
  })

  it('clears activity when parked, resumed and recovered after a process restart', async () => {
    await store.setActivityOwned(owner, waiting())
    const request = { requestId: 'ask', kind: 'ask' as const, toolCallId: 'ask', toolName: 'ask_user', args: {}, question: 'Which one?' }
    expect((await store.finishOwned(owner, { status: 'waiting' }, request)).activity).toBeUndefined()
    expect((await store.answer('activity', 'session', root.runId, 'ask', 'ask', 'ask_user', 'one')).run.activity).toBeUndefined()
    // Seed a pre-restart activity without granting the stale owner new authority.
    const stored = (await store.get('activity', root.runId))!
    await db.execute({ sql: 'UPDATE root_runs SET state=? WHERE run_id=?', args: [JSON.stringify({ ...stored, activity: waiting() }), root.runId] })
    await db.closeWithReceipt()
    db = new LocalSqliteProcessClient({ url: 'file:' + path.join(directory, 'fixture.db').replaceAll('\\', '/') })
    store = new RootRunStore(() => db); await store.initialize()
    expect(await store.latest('activity', 'session')).toMatchObject({ status: 'interrupted' })
    expect((await store.get('activity', root.runId))?.activity).toBeUndefined()
  })
})
