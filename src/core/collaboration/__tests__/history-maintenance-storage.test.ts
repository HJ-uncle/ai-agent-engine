import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { Transaction } from '@libsql/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalSqliteProcessClient } from '../../../storage/sqlite/local-process-client.js'
import {
  ensureHistoryMaintenanceStorageSchema, finalizeHistoryMaintenance, invalidatePendingHistoryMaintenance,
  compactTerminalHistoryMaintenance, getHistoryMaintenanceStorageStats,
} from '../history-maintenance-storage.js'

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const length = (value: string) => Buffer.byteLength(value, 'utf8')
const scope = { tenantId: 'tenant-fixture', sessionId: 'session-fixture' }
const table = 'collaboration_history_maintenance'
const audit = 'collaboration_history_maintenance_compactions'
let directory: string, db: LocalSqliteProcessClient

function recoveryPayload(size = 8192) {
  const encoded = JSON.stringify({ type: 'update', content: '工具结果 '.repeat(Math.ceil(size / 13)) }) + '\n'
  return { kind: 'update', plan: { fileIdentity: '1:2:3', offset: 123, bytes: length(encoded), hash: digest(encoded),
    prefixHash: digest('prefix'), encoded }, retired: ['retired-one'], retained: ['retained-one'], before: digest('before') }
}
async function insert(id: string, state: 'pending' | 'committed' | 'invalidated', payload: unknown = recoveryPayload(),
  payloadHash?: string, tenantId = scope.tenantId, sessionId = scope.sessionId) {
  await ensureHistoryMaintenanceStorageSchema(db)
  const json = JSON.stringify(payload)
  await db.execute({ sql: `INSERT INTO ${table} VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [id, tenantId, sessionId, 'jsonl', 'root', 'attempt', 'invocation', 7, 'anchor', digest('anchor'),
      json, payloadHash ?? digest(json), state, state === 'committed' ? 42 : null] })
  return json
}
async function row(id: string) { return (await db.execute({ sql: `SELECT * FROM ${table} WHERE maintenance_id=?`, args: [id] })).rows[0] }
async function auditRow(id: string) { return (await db.execute({ sql: `SELECT * FROM ${audit} WHERE maintenance_id=?`, args: [id] })).rows[0] }
async function transaction(action: (tx: Transaction) => Promise<void>) {
  const tx = await db.transaction('write')
  try { await action(tx); await tx.commit() }
  catch (error) { if (!tx.closed) await tx.rollback(); throw error }
  finally { tx.close() }
}

beforeEach(() => {
  directory = path.resolve('.e2e-tmp', 'maintenance-storage-' + randomUUID())
  fs.mkdirSync(directory, { recursive: true })
  db = new LocalSqliteProcessClient({ url: 'file:' + path.join(directory, 'fixture.db').replaceAll('\\', '/') })
})
afterEach(async () => {
  vi.restoreAllMocks(); db.close(); await db.whenClosed()
  if (path.dirname(directory) !== path.resolve('.e2e-tmp') || !path.basename(directory).startsWith('maintenance-storage-')) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

describe('durable history maintenance terminal storage', () => {
  it('does not create tables when reading stats from an unused database', async () => {
    const stats = await getHistoryMaintenanceStorageStats(db)
    expect(Object.values(stats).every(value => value === 0)).toBe(true)
    expect((await db.execute("SELECT name FROM sqlite_master WHERE type='table'")).rows).toEqual([])
  })

  it('keeps every pending recovery byte and hash while compacting terminal records', async () => {
    const pending = await insert('pending', 'pending')
    await insert('committed', 'committed')
    const before = await row('pending')
    const result = await compactTerminalHistoryMaintenance(db)
    expect(result).toMatchObject({ scanned: 1, compacted: 1, skippedCorrupt: 0, hasMore: false })
    expect(await row('pending')).toEqual(before)
    expect((await row('pending')).payload_json).toBe(pending)
    expect(await auditRow('pending')).toBeUndefined()
    const stats = await getHistoryMaintenanceStorageStats(db)
    expect(stats.pendingRows).toBe(1); expect(stats.pendingPayloadBytes).toBe(length(pending))
  })

  it('writes a bounded terminal manifest and retains exact original and current hash semantics', async () => {
    const payload = recoveryPayload(200_000), original = await insert('one', 'pending', payload)
    await transaction(tx => finalizeHistoryMaintenance(tx, 'one', 1234))
    const saved = await row('one'), json = String(saved.payload_json), manifest = JSON.parse(json)
    expect(saved).toMatchObject({ state: 'committed', committed_at: 1234, payload_hash: digest(json) })
    expect(manifest).toMatchObject({ format: 'aether-history-maintenance-terminal', schemaVersion: 1, state: 'committed',
      kind: 'update', originalPayloadHash: digest(original), originalPayloadBytes: length(original),
      plan: { fileIdentity: '1:2:3', offset: 123, bytes: length(payload.plan.encoded), hash: digest(payload.plan.encoded), lineCount: 1 },
      retired: { count: 1, hash: digest(JSON.stringify(payload.retired)) } })
    expect(manifest.plan).not.toHaveProperty('encoded')
    expect(length(json)).toBeLessThan(2048)
    expect(await auditRow('one')).toMatchObject({ format_version: 1, terminal_state: 'committed',
      original_payload_hash: digest(original), original_payload_bytes: length(original), manifest_hash: digest(json), manifest_bytes: length(json), compacted_at: 1234 })
  })

  it('rolls back peer retirement, payload replacement and audit row together', async () => {
    await insert('atomic', 'pending')
    await db.execute('CREATE TABLE peer(state TEXT NOT NULL)')
    await db.execute("INSERT INTO peer VALUES('integrated')")
    const original = await row('atomic')
    await expect(transaction(async tx => {
      await tx.execute("UPDATE peer SET state='suppressed'")
      await finalizeHistoryMaintenance(tx, 'atomic')
      throw new Error('post-finalize failure')
    })).rejects.toThrow('post-finalize failure')
    expect(await row('atomic')).toEqual(original)
    expect(await auditRow('atomic')).toBeUndefined()
    expect((await db.execute('SELECT state FROM peer')).rows[0].state).toBe('integrated')
    await transaction(async tx => { await tx.execute("UPDATE peer SET state='suppressed'"); await finalizeHistoryMaintenance(tx, 'atomic') })
    expect((await row('atomic')).state).toBe('committed')
    expect((await db.execute('SELECT state FROM peer')).rows[0].state).toBe('suppressed')
  })

  it('is idempotent after a committed transaction loses its acknowledgement and the process restarts', async () => {
    await insert('ack', 'pending')
    const tx = await db.transaction('write'), commit = tx.commit.bind(tx)
    vi.spyOn(tx, 'commit').mockImplementation(async () => { await commit(); throw new Error('ACK lost after commit') })
    await finalizeHistoryMaintenance(tx, 'ack', 100)
    await expect(tx.commit()).rejects.toThrow('ACK lost after commit'); tx.close()
    const first = await row('ack'), firstAudit = await auditRow('ack')
    db.close(); await db.whenClosed()
    db = new LocalSqliteProcessClient({ url: 'file:' + path.join(directory, 'fixture.db').replaceAll('\\', '/') })
    await ensureHistoryMaintenanceStorageSchema(db)
    await transaction(tx => finalizeHistoryMaintenance(tx, 'ack', 200))
    expect(await row('ack')).toEqual(first); expect(await auditRow('ack')).toEqual(firstAudit)
    expect((await compactTerminalHistoryMaintenance(db)).compacted).toBe(0)
  })

  it('rolls back a sidecar write failure without deleting recovery bytes', async () => {
    await insert('failed-audit', 'pending')
    const original = await row('failed-audit')
    await db.execute(`CREATE TRIGGER fail_manifest BEFORE INSERT ON ${audit} BEGIN SELECT RAISE(ABORT,'injected sidecar failure'); END`)
    await expect(transaction(tx => finalizeHistoryMaintenance(tx, 'failed-audit'))).rejects.toThrow('injected sidecar failure')
    expect(await row('failed-audit')).toEqual(original)
    expect(await auditRow('failed-audit')).toBeUndefined()
  })

  it('invalidates with the epoch atomically and preserves corrupt bytes for diagnosis', async () => {
    const good = await insert('good', 'pending'), bad = await insert('bad', 'pending', recoveryPayload(), digest('wrong'))
    await insert('other', 'pending', recoveryPayload(), undefined, scope.tenantId, 'other-session')
    await db.execute('CREATE TABLE epoch(value INTEGER)'); await db.execute('INSERT INTO epoch VALUES(7)')
    await expect(transaction(async tx => {
      await tx.execute('UPDATE epoch SET value=value+1'); await invalidatePendingHistoryMaintenance(tx, scope)
      throw new Error('revoke rollback')
    })).rejects.toThrow('revoke rollback')
    expect((await row('good')).payload_json).toBe(good); expect((await row('good')).state).toBe('pending')
    expect((await row('bad')).payload_json).toBe(bad); expect((await row('bad')).state).toBe('pending')
    expect((await db.execute('SELECT value FROM epoch')).rows[0].value).toBe(7)
    await transaction(async tx => { await tx.execute('UPDATE epoch SET value=value+1'); await invalidatePendingHistoryMaintenance(tx, scope) })
    expect((await row('good')).state).toBe('invalidated'); expect(String((await row('good')).payload_json)).not.toContain('encoded')
    expect((await row('bad')).state).toBe('invalidated'); expect((await row('bad')).payload_json).toBe(bad)
    expect(await auditRow('bad')).toBeUndefined(); expect((await row('other')).state).toBe('pending')
    expect((await db.execute('SELECT value FROM epoch')).rows[0].value).toBe(8)
    expect(await compactTerminalHistoryMaintenance(db)).toMatchObject({ compacted: 0, skippedCorrupt: 1 })
  })

  it('migrates terminal rows using row and byte budgets with a restartable keyset cursor', async () => {
    const original = await insert('a', 'committed')
    await insert('b', 'invalidated'); await insert('c', 'committed'); await insert('d', 'committed')
    await insert('e', 'pending')
    const one = await compactTerminalHistoryMaintenance(db, { batchSize: 2, maxRows: 3, maxPayloadBytes: length(original) + 1 })
    expect(one).toMatchObject({ scanned: 1, compacted: 1, afterId: 'a', hasMore: true })
    const next = await compactTerminalHistoryMaintenance(db, { batchSize: 1, maxRows: 2, afterId: one.afterId })
    expect(next).toMatchObject({ scanned: 2, compacted: 2, afterId: 'c', hasMore: true })
    const last = await compactTerminalHistoryMaintenance(db, { afterId: next.afterId })
    expect(last).toMatchObject({ scanned: 1, compacted: 1, afterId: 'd', hasMore: false })
    expect((await row('e')).state).toBe('pending'); expect((await row('a')).committed_at).toBe(42)
    const stats = await getHistoryMaintenanceStorageStats(db)
    expect(stats).toMatchObject({ pendingRows: 1, committedRows: 3, invalidatedRows: 1, compactedRows: 4, uncompactedTerminalRows: 0 })
    const actual = (await db.execute(`SELECT sum(length(CAST(payload_json AS BLOB))) AS n FROM ${table} WHERE state!='pending'`)).rows[0]
    expect(stats.terminalPayloadBytes).toBe(Number(actual.n))
    expect(stats.reclaimedPayloadBytes).toBe(stats.originalPayloadBytes - stats.terminalPayloadBytes)
    expect((await compactTerminalHistoryMaintenance(db)).scanned).toBe(0)
  })

  it('processes a single oversized legacy row alone without starving the cursor', async () => {
    await insert('a-large', 'committed', recoveryPayload(1024 * 1024))
    await insert('b-small', 'committed')
    const first = await compactTerminalHistoryMaintenance(db, { maxPayloadBytes: 128, batchSize: 16 })
    expect(first).toMatchObject({ scanned: 1, compacted: 1, afterId: 'a-large', hasMore: true })
    expect(first.originalPayloadBytes).toBeGreaterThan(1024 * 1024)
    expect(first.storedPayloadBytes).toBeLessThan(2048)
    expect((await row('b-small')).payload_json).toContain('encoded')
  })

  it('commits completed migration batches but rolls back the whole failing batch', async () => {
    await insert('a', 'committed'); await insert('b', 'committed'); await insert('c', 'invalidated')
    const originalB = await row('b'), originalC = await row('c')
    await db.execute(`CREATE TRIGGER fail_second_batch BEFORE INSERT ON ${audit}
      WHEN NEW.maintenance_id='b' BEGIN SELECT RAISE(ABORT,'injected migration failure'); END`)
    await expect(compactTerminalHistoryMaintenance(db, { batchSize: 1 })).rejects.toThrow('injected migration failure')
    expect(await auditRow('a')).toBeDefined()
    expect(await row('b')).toEqual(originalB); expect(await row('c')).toEqual(originalC)
    expect(await auditRow('b')).toBeUndefined()
    await db.execute('DROP TRIGGER fail_second_batch')
    expect(await compactTerminalHistoryMaintenance(db)).toMatchObject({ scanned: 2, compacted: 2, skippedCorrupt: 0 })
    expect((await getHistoryMaintenanceStorageStats(db)).compactedRows).toBe(3)
  })

  it('skips corrupt hashes, malformed recovery plans and unaudited terminal manifests without changing bytes', async () => {
    await insert('a-hash', 'committed', recoveryPayload(), digest('invalid'))
    const invalidPlan = recoveryPayload(); invalidPlan.plan.hash = digest('invalid')
    await insert('b-plan', 'invalidated', invalidPlan)
    const fake = { format: 'aether-history-maintenance-terminal', schemaVersion: 1, state: 'committed', kind: 'update',
      originalPayloadHash: digest('anything'), originalPayloadBytes: 1, arbitraryBody: 'must retain diagnostic evidence' }
    await insert('c-fake', 'committed', fake)
    const originals = await Promise.all(['a-hash', 'b-plan', 'c-fake'].map(row))
    const result = await compactTerminalHistoryMaintenance(db)
    expect(result).toMatchObject({ scanned: 3, compacted: 0, skippedCorrupt: 3, hasMore: false })
    expect(await Promise.all(['a-hash', 'b-plan', 'c-fake'].map(row))).toEqual(originals)
    expect((await db.execute(`SELECT * FROM ${audit}`)).rows).toEqual([])
    expect(await getHistoryMaintenanceStorageStats(db)).toMatchObject({ uncompactedTerminalRows: 3, compactedRows: 0 })
  })

  it('rejects inconsistent terminal audit data and additional body fields on an idempotent finalize', async () => {
    await insert('tampered', 'pending')
    await transaction(tx => finalizeHistoryMaintenance(tx, 'tampered'))
    const saved = await row('tampered'), manifest = JSON.parse(String(saved.payload_json))
    manifest.arbitraryBody = 'unexpected body'
    const json = JSON.stringify(manifest)
    await db.execute({ sql: `UPDATE ${table} SET payload_json=?,payload_hash=? WHERE maintenance_id=?`, args: [json, digest(json), 'tampered'] })
    await db.execute({ sql: `UPDATE ${audit} SET manifest_hash=?,manifest_bytes=? WHERE maintenance_id=?`, args: [digest(json), length(json), 'tampered'] })
    await expect(transaction(tx => finalizeHistoryMaintenance(tx, 'tampered'))).rejects.toMatchObject({ code: 'HISTORY_MAINTENANCE_PAYLOAD_CORRUPT' })
    expect((await row('tampered')).payload_json).toBe(json)
  })

  it('keeps terminal storage bounded across large completed outputs and SQLite-only summaries', async () => {
    for (let index = 0; index < 8; index++) {
      await insert('large-' + index, 'pending', recoveryPayload((index + 1) * 32_000))
      await transaction(tx => finalizeHistoryMaintenance(tx, 'large-' + index))
    }
    await insert('sqlite', 'committed', { kind: 'summary', before: digest('before'), after: digest('after'),
      retiredRowIds: Array.from({ length: 10_000 }, (_, index) => index), retained: ['still-active'] })
    await compactTerminalHistoryMaintenance(db)
    const stats = await getHistoryMaintenanceStorageStats(db)
    expect(stats.compactedRows).toBe(9)
    expect(stats.terminalPayloadBytes).toBeLessThan(9 * 2048)
    expect(stats.reclaimedPayloadBytes).toBeGreaterThan(1024 * 1024)
    const manifest = JSON.parse(String((await row('sqlite')).payload_json))
    expect(manifest.retiredRowIds.count).toBe(10_000)
  })
})
