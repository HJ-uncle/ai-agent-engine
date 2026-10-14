/** Exact signed HTTP-shaped envelopes backed by real isolated WAL; no model or Electron. */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Transaction } from '@libsql/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalSqliteProcessClient } from '../../../storage/sqlite/local-process-client.js'
import { SubagentStore } from '../store.js'
import { resetParentChildRecovery } from '../child-usage-authority.js'
import { PublishedRecoveryLeases } from '../recovery-leases.js'
import { admitPublishedChild, capturePublishedFence, ensurePublicationOwner, PUBLISHED_CHILD_PAGE_BYTES, type PublicationScope } from '../published-store.js'

const scope: PublicationScope = { tenantId: 'synthetic-tenant', parentSessionId: 'parent', rootSessionId: 'root',
  parentTurnId: 'turn', rootRunId: 'root-run', attemptId: 'attempt', streamId: 'stream' }
const auth = { tenantId: scope.tenantId, parentSessionId: scope.parentSessionId }
let dir: string, a: LocalSqliteProcessClient, b: LocalSqliteProcessClient, agents: SubagentStore, leases: PublishedRecoveryLeases, now: number, sequence: number
async function write<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
  const tx = await a.transaction('write')
  try { const result = await fn(tx); await tx.commit(); return result }
  catch (error) { if (!tx.closed) await tx.rollback(); throw error }
  finally { tx.close() }
}
async function child(id: string, tokens: number, publish = true, agentName?: string) {
  const header = (await agents.createRunDelta({ ...scope, runId: id, parentConversationId: scope.parentTurnId,
    parentToolCallId: 'delegate-' + id, parentMessageId: 'dispatch-' + id, childSessionId: 'child-' + id,
    modelId: 'synthetic-no-model', task: 'isolated contract', description: 'synthetic', ...(agentName ? { agentName } : {}) })).header
  const used = (await agents.recordUsageDelta(scope.tenantId, header.runId, { invocationId: 'usage-' + id,
    promptTokens: tokens, completionTokens: 0 }))!.header
  if (publish) await write(tx => admitPublishedChild(tx, scope, ++sequence, id, used.lastSeq))
  return used
}
beforeEach(async () => {
  fs.mkdirSync('.e2e-tmp', { recursive: true }); dir = fs.mkdtempSync(path.resolve('.e2e-tmp/recovery-lease-'))
  const url = 'file:' + path.join(dir, 'fixture.db').replaceAll('\\', '/')
  a = new LocalSqliteProcessClient({ url }); b = new LocalSqliteProcessClient({ url })
  agents = new SubagentStore(a); await agents.captureChildUsage(scope.tenantId, scope.parentSessionId)
  await write(tx => ensurePublicationOwner(tx, scope))
  now = 10_000; sequence = 0; leases = new PublishedRecoveryLeases(a, { now: () => now })
})
afterEach(async () => {
  a.close(); b.close(); await Promise.all([a.whenClosed(), b.whenClosed()])
  if (!path.resolve(dir).startsWith(path.resolve('.e2e-tmp') + path.sep)) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 })
})
describe('fixed signed child recovery leases', () => {
  it('returns bounded refs, complete authority and frozen later pages despite future WAL commits', async () => {
    const firstChild = await child('one', 80); await child('two', 20)
    const first = await leases.issue(scope, 1)
    expect(first.data).toMatchObject({ totalPublishedCount: 2, includedCount: 1, hasMore: true, residentComplete: false,
      usage: { totalTokens: 100, count: 2, unknown: 0, source: 'authoritative-scalar' } })
    const sb = new SubagentStore(b)
    await sb.recordUsageDelta(scope.tenantId, 'one', { invocationId: 'later', promptTokens: 900, completionTokens: 0 })
    await child('three', 700)
    const next = await new PublishedRecoveryLeases(b, { now: () => now }).read(auth, first.data.snapshotId, first.data.nextCursor, 1)
    expect(next.data.refs.map(ref => ref.identity.runId)).toEqual(['two'])
    expect(next.data).toMatchObject({ totalPublishedCount: 2, hasMore: false, residentComplete: false, nextCursor: null,
      usage: { totalTokens: 100, count: 2, unknown: 0, revision: first.data.usage.revision } })
    expect((await leases.lookup(auth, first.data.snapshotId, 'one')).item!.atSeq).toBe(firstChild.lastSeq)
    expect((await leases.lookup(auth, first.data.snapshotId, 'three')).item).toBe(null)
  })
  it('rejects token changes, cross-tenant/session reads and selector substitution without disclosure', async () => {
    await child('one', 5); await child('two', 7); const first = await leases.issue(scope, 1)
    const token = first.data.snapshotId
    const signatureStart = token.indexOf('.') + 1
    const bad = token.slice(0, signatureStart) + (token[signatureStart] === 'a' ? 'b' : 'a') + token.slice(signatureStart + 1)
    await expect(leases.read(auth, bad)).rejects.toMatchObject({ statusCode: 409, reason: 'invalid_token' })
    await expect(leases.read({ ...auth, tenantId: 'other' }, token)).rejects.toMatchObject({ reason: 'snapshot_unavailable' })
    await expect(leases.read({ ...auth, parentSessionId: 'other' }, token)).rejects.toMatchObject({ reason: 'snapshot_unavailable' })
    await expect(leases.read(auth, first.data.nextCursor!)).rejects.toMatchObject({ reason: 'invalid_token' })
    await expect(leases.read(auth, token, token)).rejects.toMatchObject({ reason: 'invalid_token' })
  })
  it('refuses a valid cursor from another snapshot even if scopes and prefix match', async () => {
    await child('one', 5); await child('two', 7)
    const first = await leases.issue(scope, 1), second = await leases.issue(scope, 1)
    await expect(leases.read(auth, first.data.snapshotId, second.data.nextCursor)).rejects.toMatchObject({ reason: 'cursor_snapshot_mismatch' })
  })
  it('bounds the entire envelope including tokens and usage, without skipping an oversized identity', async () => {
    for (let index = 0; index < 5; index++) await child('wide-' + index, 1, true, '长'.repeat(30_000))
    const first = await leases.issue(scope, 5)
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(PUBLISHED_CHILD_PAGE_BYTES)
    expect(first.data.refs.length).toBeLessThan(5); expect(first.data.refs.length).toBeGreaterThan(0)
    const all = [...first.data.refs.map(ref => ref.identity.runId)]
    let cursor = first.data.nextCursor
    while (cursor) { const page = await leases.read(auth, first.data.snapshotId, cursor, 5); expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(PUBLISHED_CHILD_PAGE_BYTES)
      all.push(...page.data.refs.map(ref => ref.identity.runId)); cursor = page.data.nextCursor }
    expect(all).toEqual(['wide-0', 'wide-1', 'wide-2', 'wide-3', 'wide-4'])
    await child('too-wide', 1, true, '长'.repeat(100_000))
    await expect((async () => {
      let page = await leases.issue(scope, 200)
      while (page.data.nextCursor) page = await leases.read(auth, page.data.snapshotId, page.data.nextCursor, 200)
      return page
    })()).rejects.toMatchObject({ reason: 'oversized_identity' })
  })
  it('expires opaque snapshots and cannot silently rebind them to latest', async () => {
    await child('one', 5); const first = await leases.issue(scope)
    now += 10 * 60_000
    await expect(leases.read(auth, first.data.snapshotId)).rejects.toMatchObject({ reason: 'snapshot_expired' })
    await child('two', 10); expect((await leases.issue(scope)).data.totalPublishedCount).toBe(2)
  })
  it('pins publication and usage floors until lease expiry, then prunes without resurrecting old rows', async () => {
    await child('one', 5); const first = await leases.issue(scope)
    const next = (await agents.recordUsageDelta(scope.tenantId, 'one', { invocationId: 'next', promptTokens: 50, completionTokens: 0 }))!.header
    await write(tx => admitPublishedChild(tx, scope, ++sequence, 'one', next.lastSeq))
    const current = await write(tx => capturePublishedFence(tx, scope))
    const proposed = { revision: current.revision, eventSequence: current.eventSequence, usageRevision: current.usageRevision }
    expect(await leases.prune(scope, proposed)).toEqual({ revision: first.data.fence.revision, eventSequence: first.data.fence.eventSequence, usageRevision: first.data.fence.usageRevision })
    expect((await leases.read(auth, first.data.snapshotId)).data.usage.totalTokens).toBe(5)
    now += 10 * 60_000
    expect(await leases.prune(scope, proposed)).toEqual(proposed)
    expect(Number((await a.execute('SELECT count(*) AS n FROM parent_published_child_versions')).rows[0].n)).toBe(1)
    expect((await leases.issue(scope)).data.usage.totalTokens).toBe(55)
    expect(await leases.prune(scope, { revision: 0, eventSequence: 0, usageRevision: 0 })).toEqual(proposed)
  })
  it('keeps other live streams in the parent usage retention calculation', async () => {
    await child('one', 5); const first = await leases.issue(scope)
    const secondScope = { ...scope, streamId: 'stream-two' }; await write(tx => ensurePublicationOwner(tx, secondScope))
    await agents.recordUsageDelta(scope.tenantId, 'one', { invocationId: 'later-other', promptTokens: 50, completionTokens: 0 })
    const latest = await write(tx => capturePublishedFence(tx, secondScope))
    const floor = await leases.prune(secondScope, { revision: latest.revision, eventSequence: latest.eventSequence, usageRevision: latest.usageRevision })
    expect(floor.usageRevision).toBe(first.data.fence.usageRevision)
    expect((await leases.read(auth, first.data.snapshotId)).data.usage.totalTokens).toBe(5)
  })
  it('rejects clear/generation changes and missing exact checkpoints as recovery, never empty-complete', async () => {
    await child('one', 5); const first = await leases.issue(scope)
    await a.execute({ sql: 'DELETE FROM subagent_checkpoints WHERE tenant_id=? AND run_id=?', args: [scope.tenantId, 'one'] })
    await a.execute({ sql: 'DELETE FROM subagent_events WHERE tenant_id=? AND run_id=?', args: [scope.tenantId, 'one'] })
    await expect(leases.read(auth, first.data.snapshotId)).rejects.toMatchObject({ recoveryRequired: true, reason: 'missing_checkpoint' })
    await a.execute({ sql: 'UPDATE subagent_usage_parent_state SET generation=? WHERE tenant_id=? AND parent_session_id=?', args: [randomUUID(), ...Object.values(auth)] })
    await expect(leases.read(auth, first.data.snapshotId)).rejects.toMatchObject({ reason: 'generation_changed' })
  })
  it('enforces durable lease quotas across two service instances and releases only expired leases', async () => {
    await child('one', 5)
    const small = new PublishedRecoveryLeases(a, { now: () => now, maxParentLeases: 1, maxLeases: 2 })
    const first = await small.issue(scope)
    await expect(new PublishedRecoveryLeases(b, { now: () => now, maxParentLeases: 1, maxLeases: 2 }).issue(scope)).rejects.toMatchObject({ reason: 'lease_capacity' })
    expect(Number((await a.execute('SELECT count(*) AS n FROM child_recovery_leases')).rows[0].n)).toBe(1)
    now += 10 * 60_000; expect((await small.issue(scope)).data.snapshotId).not.toBe(first.data.snapshotId)
    expect(Number((await a.execute('SELECT count(*) AS n FROM child_recovery_leases')).rows[0].n)).toBe(1)
  })
  it('does not publish a lease if exact envelope construction or SQLite insert fails', async () => {
    await child('one', 5)
    await expect(leases.issue(scope, 201)).rejects.toMatchObject({ reason: 'invalid_limit' })
    expect(Number((await a.execute('SELECT count(*) AS n FROM child_recovery_leases')).rows[0].n)).toBe(0)
    await a.execute("CREATE TRIGGER synthetic_lease_failure BEFORE INSERT ON child_recovery_leases BEGIN SELECT RAISE(ABORT,'synthetic-lease-failure'); END")
    await expect(leases.issue(scope)).rejects.toThrow('synthetic-lease-failure')
    expect(Number((await a.execute('SELECT count(*) AS n FROM child_recovery_leases')).rows[0].n)).toBe(0)
  })
  it('reclaims invalid generation quota after actual clear without waiting for token expiry', async () => {
    await child('one', 5)
    const small = new PublishedRecoveryLeases(a, { now: () => now, maxParentLeases: 1, maxLeases: 1 })
    const old = await small.issue(scope)
    await write(tx => resetParentChildRecovery(tx, scope.tenantId, scope.parentSessionId))
    await agents.captureChildUsage(scope.tenantId, scope.parentSessionId)
    await write(tx => ensurePublicationOwner(tx, scope))
    const current = await small.issue(scope)
    expect(current.data.fence.generation).not.toBe(old.data.fence.generation)
    expect(Number((await b.execute('SELECT count(*) AS n FROM child_recovery_leases')).rows[0].n)).toBe(1)
    await expect(small.read(auth, old.data.snapshotId)).rejects.toMatchObject({ recoveryRequired: true, reason: 'snapshot_unavailable' })
  })
  it('rolls back the lease when deferred foreign-key validation fails at actual COMMIT', async () => {
    await child('one', 5); await leases.issue(scope)
    await a.execute('DELETE FROM child_recovery_leases')
    await a.executeMultiple(`CREATE TABLE synthetic_commit_parent(id INTEGER PRIMARY KEY);
      CREATE TABLE synthetic_commit_pending(id INTEGER REFERENCES synthetic_commit_parent(id) DEFERRABLE INITIALLY DEFERRED);
      CREATE TRIGGER synthetic_commit_failure AFTER INSERT ON child_recovery_leases BEGIN INSERT INTO synthetic_commit_pending VALUES(1); END;`)
    await expect(leases.issue(scope)).rejects.toThrow(/FOREIGN KEY constraint failed/i)
    expect(Number((await b.execute('SELECT count(*) AS n FROM child_recovery_leases')).rows[0].n)).toBe(0)
    expect(Number((await b.execute('SELECT count(*) AS n FROM synthetic_commit_pending')).rows[0].n)).toBe(0)
  })
  it('does not return success after a lost COMMIT ACK and preserves the independently committed lease', async () => {
    await child('one', 5)
    let injected = 0
    const faultDb = new Proxy(a, { get(target, key) {
      if (key === 'transaction') return async (mode?: Parameters<typeof a.transaction>[0]) => {
        const tx = await target.transaction(mode); let leaseInserted = false
        return new Proxy(tx, { get(owner, property) {
          if (property === 'execute') return async (...args: Parameters<Transaction['execute']>) => {
            const stmt = args[0], sql = typeof stmt === 'string' ? stmt : stmt.sql
            if (sql.startsWith('INSERT INTO child_recovery_leases ')) leaseInserted = true
            return owner.execute(...args)
          }
          if (property === 'commit') return async () => {
            await owner.commit()
            if (leaseInserted) { injected++; throw new Error('synthetic-lost-commit-ack') }
          }
          const value = Reflect.get(owner, property, owner)
          return typeof value === 'function' ? value.bind(owner) : value
        } })
      }
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    } })
    const uncertain = new PublishedRecoveryLeases(faultDb, { now: () => now, maxParentLeases: 1, maxLeases: 1 })
    await expect(uncertain.issue(scope)).rejects.toThrow('synthetic-lost-commit-ack')
    expect(injected).toBe(1)
    expect(Number((await b.execute('SELECT count(*) AS n FROM child_recovery_leases')).rows[0].n)).toBe(1)
    await expect(uncertain.issue(scope)).rejects.toMatchObject({ reason: 'lease_capacity' })
    expect(injected).toBe(1)
  })
  it('restores the same key and frozen prefix after actual SQLite process close/reopen, including expiry', async () => {
    await child('one', 5); const old = await leases.issue(scope)
    await child('two', 10)
    a.close(); b.close(); await Promise.all([a.whenClosed(), b.whenClosed()])
    const url = 'file:' + path.join(dir, 'fixture.db').replaceAll('\\', '/')
    a = new LocalSqliteProcessClient({ url }); b = new LocalSqliteProcessClient({ url })
    const reopened = new PublishedRecoveryLeases(a, { now: () => now })
    expect((await reopened.read(auth, old.data.snapshotId)).data).toMatchObject({ totalPublishedCount: 1,
      usage: { totalTokens: 5, count: 1, unknown: 0 } })
    now += 10 * 60_000
    await expect(reopened.read(auth, old.data.snapshotId)).rejects.toMatchObject({ reason: 'snapshot_expired' })
    expect((await reopened.issue(scope)).data.totalPublishedCount).toBe(2)
  })
  it('does not commit a lease that expires during envelope construction', async () => {
    await child('one', 5)
    const fastClock = new PublishedRecoveryLeases(a, { ttlMs: 1, now: () => { now += 2; return now } })
    await expect(fastClock.issue(scope)).rejects.toMatchObject({ reason: 'snapshot_expired' })
    expect(Number((await b.execute('SELECT count(*) AS n FROM child_recovery_leases')).rows[0].n)).toBe(0)
  })
  it('refuses an issue whose real commit ACK arrives after expiry, and bounds the persisted orphan by TTL', async () => {
    await child('one', 5)
    const slowAck = new Proxy(a, { get(target, property) {
      if (property === 'transaction') return async (mode?: Parameters<typeof a.transaction>[0]) => {
        const tx = await target.transaction(mode)
        return new Proxy(tx, { get(owner, key) {
          if (key === 'commit') return async () => { await owner.commit(); now += 2 }
          const value = Reflect.get(owner, key, owner)
          return typeof value === 'function' ? value.bind(owner) : value
        } })
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    } })
    await expect(new PublishedRecoveryLeases(slowAck, { ttlMs: 1, now: () => now }).issue(scope)).rejects.toMatchObject({ reason: 'snapshot_expired' })
    expect(Number((await b.execute('SELECT count(*) AS n FROM child_recovery_leases')).rows[0].n)).toBe(1)
    expect((await leases.issue(scope)).data.totalPublishedCount).toBe(1)
    expect(Number((await b.execute('SELECT count(*) AS n FROM child_recovery_leases')).rows[0].n)).toBe(1)
  })
})
