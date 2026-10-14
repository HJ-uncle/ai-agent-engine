/** Real isolated WAL and ordered publication. No models, HTTP listeners or Electron. */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Transaction, InStatement } from '@libsql/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalSqliteProcessClient } from '../../../storage/sqlite/local-process-client.js'
import { CurrentTurnProjection } from '../../stream-pipeline/stream-projection.js'
import { StreamBus } from '../../stream-pipeline/stream-bus.js'
import { ParentPublicationAuthority } from '../parent-publication.js'
import { PublishedTurnBootstraps } from '../turn-bootstrap.js'
import { childProjectionReferences, resolvePublishedProjectionReferences } from '../child-recovery-projection.js'
import { resetParentChildRecovery } from '../child-usage-authority.js'
import { SubagentStore } from '../store.js'
import type { ChildProjectionReference } from '../recovery-leases.js'
import type { PublishedFence } from '../published-store.js'

const reference = (id: string, seq = 1) => ({ schemaVersion: 2, kind: 'published-reference', runId: id, seq,
  view: { schemaVersion: 2, view: 'published-reference', runId: id, lastSeq: seq } })
const frame = (name: string, payload: unknown) => '\x00__' + name + '__' + JSON.stringify(payload)
const hooks = { beforeAppend: async () => {}, beforeTerminal: async () => {} }

it('keeps no lifetime child Map in explicit durable mode after slot eviction, snapshot and fork', () => {
  const projection = new CurrentTurnProjection([], [], false, 'published-store')
  for (let i = 0; i < 12_000; i++) projection.apply({ subagentEvent: reference('child-' + i) })
  expect(projection.snapshot()).toHaveLength(4096)
  expect(projection.subagentWatermarks()).toEqual([])
  expect(projection.hasChildEvidence).toBe(true)
  expect(Object.getOwnPropertyDescriptor(projection, 'childSequences')?.value).toBeUndefined()
  const next = projection.fork()
  expect(next.childSequenceSource).toBe('published-store')
  expect(next.hasChildEvidence).toBe(true)
  expect(next.subagentWatermarks()).toEqual([])
  expect(Object.getOwnPropertyDescriptor(next, 'childSequences')?.value).toBeUndefined()
  expect(next.snapshot()).toEqual(projection.snapshot())
})

it('keeps legacy watermarks including evicted identities and does not infer SQL authority from hooks', async () => {
  const projection = new CurrentTurnProjection()
  for (let i = 0; i < 4200; i++) projection.apply({ subagentEvent: reference('child-' + i) })
  expect(projection.snapshot()).toHaveLength(4096)
  expect(projection.subagentWatermarks()).toHaveLength(4200)
  expect(projection.fork().subagentWatermarks()).toEqual(projection.subagentWatermarks())
  const bus = new StreamBus(new AbortController(), { publication: hooks })
  await bus.publish(frame('subagent_event', reference('one')))
  expect(bus.snapshot().subagentWatermarks).toEqual([{ runId: 'one', seq: 1 }])
})

it('rejects all unadmitted durable seeds even though SQL mode omits watermark inventory', () => {
  expect(() => new StreamBus(new AbortController(), { childSequenceSource: 'published-store' })).toThrow('require ordered publication')
  for (const initialProjection of [[{ subagentEvent: reference('one') }],
    [{ toolResult: { toolCallId: 'tool', meta: { subagent: reference('one').view } } }]]) {
    expect(() => new StreamBus(new AbortController(), { publication: hooks, childSequenceSource: 'published-store', initialProjection })).toThrow('unadmitted child')
    const bus = new StreamBus(new AbortController(), { publication: hooks, childSequenceSource: 'published-store' })
    expect(() => bus.seedProjection(initialProjection)).toThrow('unadmitted child')
  }
  expect(() => new StreamBus(new AbortController(), { publication: hooks, childSequenceSource: 'published-store',
    initialSubagentWatermarks: [{ runId: 'omitted', seq: 2 }] })).toThrow('unadmitted child')
})

describe('durable SQL sequence source', () => {
  let root: string, a: LocalSqliteProcessClient, b: LocalSqliteProcessClient, store: SubagentStore,
    authority: ParentPublicationAuthority, bus: StreamBus
  const scope = { tenantId: 'sequence-source', parentSessionId: 'parent', rootSessionId: 'root', parentTurnId: 'turn', rootRunId: 'root-run', attemptId: 'attempt' }
  const auth = { tenantId: scope.tenantId, parentSessionId: scope.parentSessionId }
  const run = { runId: scope.rootRunId, turnId: scope.parentTurnId, sessionId: scope.parentSessionId, version: 1, status: 'running' }
  async function write<T>(fn: (tx: Transaction) => Promise<T>) {
    const tx = await a.transaction('write')
    try { const value = await fn(tx); await tx.commit(); return value } catch (error) { if (!tx.closed) await tx.rollback(); throw error } finally { tx.close() }
  }
  beforeEach(async () => {
    root = path.resolve('.e2e-tmp', 'durable-sequences-' + randomUUID()); fs.mkdirSync(root, { recursive: true })
    const url = 'file:' + path.join(root, 'fixture.db').replaceAll('\\', '/')
    a = new LocalSqliteProcessClient({ url }); b = new LocalSqliteProcessClient({ url })
    store = new SubagentStore(a); await store.captureChildUsage(scope.tenantId, scope.parentSessionId)
    await a.executeMultiple('CREATE TABLE root_runs(tenant_id TEXT,session_id TEXT,run_id TEXT,turn_id TEXT,state TEXT);')
    await a.execute({ sql: 'INSERT INTO root_runs VALUES(?,?,?,?,?)', args: [scope.tenantId, scope.parentSessionId, scope.rootRunId, scope.parentTurnId, JSON.stringify({ ...run, attemptId: scope.attemptId })] })
    authority = new ParentPublicationAuthority(a, scope, { enabled: false, childSequenceSource: 'published-store' })
    bus = new StreamBus(new AbortController(), { publication: authority.hooks, childSequenceSource: 'published-store' })
    await bus.publish(frame('run', run))
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    const receipts = await Promise.all([a.closeWithReceipt(), b.closeWithReceipt()])
    fs.writeFileSync(path.join(root, 'close-receipts.json'), JSON.stringify(receipts, null, 2))
    for (const receipt of receipts) expect(receipt.healthy, JSON.stringify(receipt)).toBe(true)
  })
  async function oldReceipt() {
    const created = await store.createRunDelta({ ...scope, runId: 'one', parentConversationId: scope.parentTurnId,
      parentMessageId: 'message', parentToolCallId: 'delegate', childSessionId: 'child', modelId: 'synthetic-no-model', task: 'isolated', description: 'contract' })
    await bus.publish(frame('subagent_event', created.event))
    await bus.publish(frame('tool_result', { toolCallId: 'delegate', status: 'success', output: 'real result', meta: { subagent: { ...created.header, view: 'published-reference' } } }))
    const second = await store.recordUsageDelta(scope.tenantId, 'one', { invocationId: 'second', promptTokens: 5, completionTokens: 0 })
    if (!second) throw new Error('Missing second checkpoint')
    await bus.publish(frame('subagent_event', second.event))
    return { created, second }
  }
  const options = { childSequenceSource: 'published-store' as const }
  it('resolves an old receipt at the signed fence while future publication advances independently', async () => {
    const { created, second } = await oldReceipt(), captured = await authority.captureSnapshot(bus)
    expect(captured.snapshot.subagentWatermarks).toBeUndefined()
    const shape = childProjectionReferences(captured.snapshot)
    expect(shape.entries.find(entry => entry.field === 'toolResult')?.atSeq).toBe(created.header.lastSeq)
    const future = await store.recordUsageDelta(scope.tenantId, 'one', { invocationId: 'future', promptTokens: 900, completionTokens: 0 })
    if (!future) throw new Error('Missing future checkpoint')
    await bus.publish(frame('subagent_event', future.event))
    await authority.leases.retainProjection(auth, captured.recovery.data.snapshotId, shape.entries, captured.snapshot.projection.length, options)
    const page = await authority.leases.projection(auth, captured.recovery.data.snapshotId)
    expect(page.data.entries.find(entry => entry.field === 'toolResult')).toMatchObject({ atSeq: second.header.lastSeq, sourceAtSeq: created.header.lastSeq })
    expect(page.data.entries.every(entry => entry.atSeq === second.header.lastSeq)).toBe(true)
    expect(page.data.fence.eventSequence).toBe(captured.recovery.data.fence.eventSequence)
    expect(bus.snapshot().subagentWatermarks).toBeUndefined()
  })
  it('retains strict default API rejection and does not replace an old watermark with latest implicitly', async () => {
    await oldReceipt(); const captured = await authority.captureSnapshot(bus), shape = childProjectionReferences(captured.snapshot)
    await expect(authority.leases.retainProjection(auth, captured.recovery.data.snapshotId, shape.entries, captured.snapshot.projection.length)).rejects.toMatchObject({ reason: 'projection_prefix_mismatch' })
    expect((await a.execute('SELECT count(*) AS n FROM child_recovery_projection_archives')).rows[0].n).toBe(0)
    await authority.leases.retainProjection(auth, captured.recovery.data.snapshotId, shape.entries, captured.snapshot.projection.length, options)
  })
  it('captures, reloads, seeds and idempotently recaptures exact old-source bootstrap bytes without a Map', async () => {
    const { created, second } = await oldReceipt(), checkpoint = await authority.captureBootstrap(bus)
    const archive = (await a.execute({ sql: 'SELECT entry_json FROM parent_turn_bootstrap_refs WHERE checkpoint_id=? ORDER BY projection_index', args: [checkpoint.checkpointId] })).rows.map(row => JSON.parse(String(row.entry_json)) as ChildProjectionReference)
    expect(archive.find(entry => entry.field === 'toolResult')).toMatchObject({ atSeq: second.header.lastSeq, sourceAtSeq: created.header.lastSeq })
    expect((await authority.captureBootstrap(bus)).checkpointId).toBe(checkpoint.checkpointId)
    const restored = await new PublishedTurnBootstraps(b).load(checkpoint.fence, checkpoint.checkpointId)
    expect(restored.fence).toEqual(checkpoint.fence)
    const seed = await new PublishedTurnBootstraps(b).projectionSeed(checkpoint.fence, checkpoint.checkpointId)
    const next = new StreamBus(new AbortController(), { publication: hooks, childSequenceSource: 'published-store' })
    next.seedAdmittedProjection({ ...seed, streamId: next.streamId })
    expect(next.snapshot().subagentWatermarks).toBeUndefined()
    expect(childProjectionReferences(next.snapshot()).entries.find(entry => entry.field === 'toolResult')?.atSeq).toBe(created.header.lastSeq)
  })
  it('rejects missing exact old-source evidence and rolls the entire retained archive back', async () => {
    const { created } = await oldReceipt(), captured = await authority.captureSnapshot(bus), shape = childProjectionReferences(captured.snapshot)
    await a.execute({ sql: 'DELETE FROM subagent_checkpoints WHERE tenant_id=? AND run_id=? AND seq=?', args: [scope.tenantId, 'one', created.header.lastSeq] })
    await expect(authority.leases.retainProjection(auth, captured.recovery.data.snapshotId, shape.entries, captured.snapshot.projection.length, options)).rejects.toMatchObject({ reason: 'projection_prefix_mismatch' })
    await expect(authority.captureBootstrap(bus)).rejects.toMatchObject({ reason: 'projection_prefix_mismatch' })
    expect((await a.execute('SELECT count(*) AS n FROM child_recovery_projection_archives')).rows[0].n).toBe(0)
    expect((await a.execute('SELECT count(*) AS n FROM child_recovery_projection_refs')).rows[0].n).toBe(0)
    expect((await a.execute('SELECT count(*) AS n FROM parent_turn_bootstraps')).rows[0].n).toBe(0)
  })
  it('rejects a forged pre-resolved source and a future source rather than weakening the strict proof', async () => {
    await oldReceipt(); const captured = await authority.captureSnapshot(bus), shape = childProjectionReferences(captured.snapshot)
    const forged = shape.entries.map(entry => ({ ...entry, sourceAtSeq: entry.atSeq }))
    await expect(authority.leases.retainProjection(auth, captured.recovery.data.snapshotId, forged, captured.snapshot.projection.length, options)).rejects.toMatchObject({ reason: 'projection_shape_conflict' })
    const future = shape.entries.map(entry => ({ ...entry, atSeq: 999 }))
    await expect(authority.leases.retainProjection(auth, captured.recovery.data.snapshotId, future, captured.snapshot.projection.length, options)).rejects.toMatchObject({ reason: 'projection_prefix_mismatch' })
  })
  it('refuses old signed sequence resolution after clear changes the generation', async () => {
    await oldReceipt(); const captured = await authority.captureSnapshot(bus), shape = childProjectionReferences(captured.snapshot)
    await write(tx => resetParentChildRecovery(tx, scope.tenantId, scope.parentSessionId))
    await expect(authority.leases.retainProjection(auth, captured.recovery.data.snapshotId, shape.entries, captured.snapshot.projection.length, options)).rejects.toMatchObject({ reason: 'missing_publication_owner' })
  })
  it('keeps committed but unacknowledged child evidence invisible and does not abort execution', async () => {
    const created = await store.createRunDelta({ ...scope, runId: 'lost-ack', parentConversationId: scope.parentTurnId,
      parentMessageId: 'message', parentToolCallId: 'delegate', childSessionId: 'child', modelId: 'synthetic-no-model', task: 'isolated', description: 'contract' })
    const original = a.transaction.bind(a); let fault = true
    vi.spyOn(a, 'transaction').mockImplementation(async mode => {
      const tx = await original(mode)
      if (mode === 'write' && fault) { fault = false; const commit = tx.commit.bind(tx); tx.commit = async () => { await commit(); throw new Error('LOST_ACK') } }
      return tx
    })
    await expect(bus.publish(frame('subagent_event', created.event))).rejects.toMatchObject({ reason: 'evidence_unavailable' })
    expect(bus.lastEventId).toBe(bus.streamId + ':1')
    expect(bus.snapshot().projection.some(item => item.subagentEvent)).toBe(false)
    expect(bus.snapshot().subagentWatermarks).toBeUndefined()
    expect(Number((await b.execute('SELECT count(*) AS n FROM parent_publication_marks')).rows[0].n)).toBe(1)
    expect(bus.abortController.signal.aborted).toBe(false)
    await expect(authority.captureBootstrap(bus)).rejects.toMatchObject({ reason: 'evidence_unavailable' })
  })
  it('uses bounded SQL batches for retained refs and binds tenant, stream, generation and revision every time', async () => {
    await oldReceipt(); const captured = await authority.captureSnapshot(bus), fence = captured.recovery.data.fence
    const raw: ChildProjectionReference[] = Array.from({ length: 257 }, (_, projectionIndex) => ({ projectionIndex, field: 'subagentEvent', runId: 'one', atSeq: 1 }))
    let batchQueries = 0, retainedScans = 0
    const tx = await a.transaction('read')
    const counted = new Proxy(tx, { get(target, property, receiver) {
      if (property === 'execute') return async (statement: InStatement) => {
        const sql = typeof statement === 'string' ? statement : statement.sql
        if (sql.includes('run_id IN (')) { batchQueries++; expect(typeof statement !== 'string' && Array.isArray(statement.args) ? statement.args.length : 0).toBeLessThanOrEqual(133) }
        if (sql.includes('AND NOT EXISTS(SELECT 1 FROM subagent_checkpoints')) retainedScans++
        return target.execute(statement)
      }
      const value: unknown = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    } })
    try {
      const resolved = await resolvePublishedProjectionReferences(counted, fence, raw)
      expect(resolved).toHaveLength(257); expect(resolved.every(entry => entry.atSeq === 2 && entry.sourceAtSeq === 1)).toBe(true)
      expect(batchQueries).toBe(3); expect(retainedScans).toBe(1)
      for (const [patch, reason] of [[{ tenantId: 'foreign' }, 'missing_publication_owner'], [{ streamId: 'foreign' }, 'missing_publication_owner'],
        [{ generation: 'foreign' }, 'generation_changed'], [{ revision: fence.revision + 1 }, 'retention_gap']] as const)
        await expect(resolvePublishedProjectionReferences(counted, { ...fence, ...patch } as PublishedFence, raw)).rejects.toMatchObject({ statusCode: 409, recoveryRequired: true, reason })
    } finally { await tx.rollback(); tx.close() }
  })
})
