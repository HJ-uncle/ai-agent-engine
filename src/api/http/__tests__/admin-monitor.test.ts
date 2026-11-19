import { mkdtempSync, mkdirSync, rmSync, lstatSync, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { statfs } from 'node:fs/promises'
import { LocalSqliteProcessClient } from '../../../storage/sqlite/local-process-client.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cpuDeltas, createAdminMonitor, hostLoadAverage, type CpuFrame } from '../admin/monitor.js'
import { createAdminStorageReader, volumeCapacity } from '../admin/monitor-storage.js'

const parent = fileURLToPath(new URL('../../../../.e2e-tmp/admin-monitor/fixtures/', import.meta.url))
const noStorage = { dataVolume: null, resources: { mainDatabaseBytes: null, walBytes: null, queuePending: null, queueRunning: null } }
let db: LocalSqliteProcessClient | undefined, fixture: string | undefined
function database() {
  mkdirSync(parent, { recursive: true }); fixture = mkdtempSync(path.join(parent, 'profile-'))
  const file = path.join(fixture, 'redacted-source-file.db')
  db = new LocalSqliteProcessClient({ url: `file:${file}` }); return { file, client: db }
}
afterEach(async () => {
  vi.useRealTimers(); if (db) { const receipt = await db.closeWithReceipt(); expect(receipt.nativeClosed).toBe(true) }; db = undefined
  if (!fixture) return
  const exact = path.resolve(fixture); fixture = undefined
  if (path.dirname(exact) !== path.resolve(parent) || !path.basename(exact).startsWith('profile-') || lstatSync(exact).isSymbolicLink()) throw Error('Unexpected test fixture')
  rmSync(exact, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})
const first: CpuFrame = { atMs: 1_000, cores: [{ busyMs: 50, idleMs: 50 }, { busyMs: 70, idleMs: 30 }], cpu: { user: 2_000, system: 3_000 }, loop: { active: 20, idle: 30 } }
const next: CpuFrame = { atMs: 1_200, cores: [{ busyMs: 120, idleMs: 80 }, { busyMs: 140, idleMs: 60 }], cpu: { user: 202_000, system: 103_000 }, loop: { active: 30, idle: 220 } }

describe('actual on-demand engine administration metrics', () => {
  it('distinguishes host capacity, one-core process CPU and event-loop activity; no fake zero for resets/hotplug/unsupported Windows load', () => {
    expect(cpuDeltas(first, next)).toEqual({ sampleWindowMs: 200, cpuPercent: 70, cpuCorePercent: 150, eventLoopUtilizationPercent: 5 })
    expect(cpuDeltas(first, { ...next, cores: [next.cores![0]], cpu: { user: 0, system: 3_100 }, loop: null }))
      .toEqual({ sampleWindowMs: 200, cpuPercent: null, cpuCorePercent: null, eventLoopUtilizationPercent: null })
    expect(cpuDeltas(first, { ...next, cores: first.cores, cpu: first.cpu }).cpuPercent).toBeNull()
    expect(cpuDeltas(first, { ...next, cores: first.cores, cpu: first.cpu }).cpuCorePercent).toBe(0)
    const unixLoad = vi.fn(() => [0, 0, 0]); expect(hostLoadAverage('win32', unixLoad)).toBeNull(); expect(unixLoad).not.toHaveBeenCalled()
    expect(hostLoadAverage('linux', unixLoad)).toEqual([0, 0, 0]); expect(hostLoadAverage('darwin', () => [1, -1, 2])).toBeNull()
  })

  it('reports caller-available disk blocks, real zero remaining and no truncated/impossible byte count', () => {
    expect(volumeCapacity({ bsize: 4096n, blocks: 300n, bavail: 0n })).toEqual({ totalBytes: 1_228_800, availableBytes: 0 })
    expect(volumeCapacity({ bsize: 4096n, blocks: 300n, bavail: 31n })?.availableBytes).toBe(126_976)
    expect(volumeCapacity({ bsize: 1n << 54n, blocks: 1n, bavail: 0n })).toBeNull()
    expect(volumeCapacity({ bsize: 0n, blocks: 0n, bavail: 0n })).toBeNull()
    expect(volumeCapacity({ bsize: 512n, blocks: 3n, bavail: 4n })).toBeNull()
  })

  it('uses the actual live SQLite volume and physical files; counts only active jobs without exposing identity, payload or path', async () => {
    const { client, file } = database(), sentinel = 'synthetic-private-tenant-and-payload'
    await client.execute('PRAGMA journal_mode=WAL'); await client.execute('CREATE TABLE jobs(tenant_id TEXT, status TEXT, payload TEXT, created_at INTEGER)')
    await client.execute('CREATE INDEX idx_jobs_status ON jobs(status, created_at)')
    for (const [tenant, status] of [[sentinel, 'pending'], ['second', 'pending'], [sentinel, 'running'], [sentinel, 'done'], ['third', 'failed']]) {
      await client.execute({ sql: 'INSERT INTO jobs(tenant_id,status,payload,created_at) VALUES (?,?,?,0)', args: [tenant, status, sentinel] })
    }
    const read = createAdminStorageReader(() => client), snapshot = await read(), actualVolume = await statfs(file, { bigint: true })
    expect(snapshot.dataVolume?.totalBytes).toBe(Number(actualVolume.blocks * actualVolume.bsize))
    expect(snapshot.dataVolume!.availableBytes).toBeGreaterThanOrEqual(0)
    expect(snapshot.dataVolume!.availableBytes).toBeLessThanOrEqual(snapshot.dataVolume!.totalBytes)
    expect(snapshot.resources).toEqual({ mainDatabaseBytes: statSync(file).size, walBytes: statSync(file + '-wal').size, queuePending: 2, queueRunning: 1 })
    for (const needle of [file, path.basename(file), sentinel, 'payload', 'tenant_id']) expect(JSON.stringify(snapshot).includes(needle)).toBe(false)
    await client.execute('DROP INDEX idx_jobs_status'); await client.execute('PRAGMA journal_mode=DELETE')
    expect(existsSync(file + '-wal')).toBe(false)
    const partial = await read(); expect(partial.dataVolume).not.toBeNull(); expect(partial.resources).toMatchObject({ queuePending: null, queueRunning: null, walBytes: 0 })
  })

  it('reports an exact indexed backlog beyond 100,000 so high-load thresholds remain meaningful', async () => {
    const { client } = database()
    await client.execute('CREATE TABLE jobs(status TEXT,created_at INTEGER)'); await client.execute('CREATE INDEX idx_jobs_status ON jobs(status,created_at)')
    await client.execute(`WITH RECURSIVE ticks(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM ticks WHERE n<100001)
      INSERT INTO jobs(status,created_at) SELECT 'pending',n FROM ticks`)
    const { resources } = await createAdminStorageReader(() => client)()
    expect(resources).toMatchObject({ queuePending: 100_001, queueRunning: 0 })
  })

  it('distinguishes an unopened or busy source from an empty queue and does not pile up blocked I/O on repeated requests', async () => {
    expect(await createAdminStorageReader(() => null)()).toEqual(noStorage)
    const { client } = database()
    await client.execute('CREATE TABLE jobs(status TEXT,created_at INTEGER)'); await client.execute('CREATE INDEX idx_jobs_status ON jobs(status,created_at)')
    expect((await createAdminStorageReader(() => client)()).resources).toMatchObject({ queuePending: 0, queueRunning: 0 })
    vi.useFakeTimers()
    let unlock!: () => void; const blocked = new Promise<void>(resolve => { unlock = resolve })
    const calls = vi.spyOn(client, 'execute').mockImplementation(async () => { await blocked; throw Error('do not return internal errors') })
    try {
      const read = createAdminStorageReader(() => client, 30), a = read(), b = read()
      await vi.advanceTimersByTimeAsync(45); expect(await a).toEqual(noStorage); expect(await b).toEqual(noStorage)
      const count = calls.mock.calls.length; expect(count).toBe(2); expect(await read()).toEqual(noStorage); expect(calls.mock.calls.length).toBe(count)
    } finally { unlock(); calls.mockRestore() }
  })

  it('extends a sample once after a transient per-core counter regression, without repeating storage reads or fabricating usage', async () => {
    const backstep: CpuFrame = { ...next, cores: [{ busyMs: 120, idleMs: 19 }, next.cores![1]] }
    for (const [final, expected] of [[next, 70], [backstep, null]] as const) {
      const frames = [first, backstep, { ...final, atMs: 1_400 }], frame = vi.fn(() => frames.shift()!)
      const pause = vi.fn(async () => {}), storage = vi.fn(async () => noStorage), read = createAdminMonitor({ frame, pause, storage })
      const pending = read(); expect(read()).toBe(pending)
      expect(await pending).toMatchObject({ sampleWindowMs: 400, host: { cpuPercent: expected } })
      expect(frame).toHaveBeenCalledTimes(3); expect(pause).toHaveBeenCalledTimes(2); expect(storage).toHaveBeenCalledTimes(1)
    }
    const noCounters = vi.fn(() => ({ ...first, cores: null })), pause = vi.fn(async () => {})
    expect((await createAdminMonitor({ frame: noCounters, pause, storage: async () => noStorage })()).host.cpuPercent).toBeNull()
    expect(pause).toHaveBeenCalledTimes(1)
  })

  it('starts no timer on construction, coalesces simultaneous requests and creates a new sample for a later manual refresh', async () => {
    let frameNumber = 0, finish!: () => void
    const frame = vi.fn(() => ++frameNumber % 2 ? first : next), pause = vi.fn(() => new Promise<void>(r => { finish = r })), storage = vi.fn(async () => noStorage)
    const sample = createAdminMonitor({ frame, pause, storage }); expect(frame).not.toHaveBeenCalled(); expect(pause).not.toHaveBeenCalled(); expect(storage).not.toHaveBeenCalled()
    const a = sample(), b = sample(); expect(a).toBe(b); expect(pause).toHaveBeenCalledTimes(1); expect(storage).toHaveBeenCalledTimes(1)
    finish(); const snapshot = await a; expect(snapshot).toMatchObject({ host: { cpuPercent: 70 }, engine: { cpuCorePercent: 150 }, sampleWindowMs: 200 })
    expect(Date.parse(snapshot.sampledAt)).toBeGreaterThan(0); expect(Object.keys(snapshot).sort()).toEqual(['dataVolume', 'engine', 'host', 'resources', 'sampleWindowMs', 'sampledAt'])
    const again = sample(); expect(again).not.toBe(a); finish(); await again; expect(storage).toHaveBeenCalledTimes(2)
  })
})
