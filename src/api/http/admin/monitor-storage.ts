import { stat, statfs } from 'node:fs/promises'
import path from 'node:path'
import type { Client } from '@libsql/client'
import { peekOpenDb } from '../../../storage/sqlite/db.js'

export interface AdminDataVolume { totalBytes: number; availableBytes: number }
export interface AdminEngineResources {
  mainDatabaseBytes: number | null
  walBytes: number | null
  queuePending: number | null
  queueRunning: number | null
}
export interface AdminStorageSnapshot { dataVolume: AdminDataVolume | null; resources: AdminEngineResources }
type Disk = Pick<AdminEngineResources, 'mainDatabaseBytes' | 'walBytes'> & { dataVolume: AdminDataVolume | null }
type Queue = Pick<AdminEngineResources, 'queuePending' | 'queueRunning'>
type MonitorDb = Pick<Client, 'protocol' | 'execute'>
const noDisk: Disk = { dataVolume: null, mainDatabaseBytes: null, walBytes: null }
const noQueue: Queue = { queuePending: null, queueRunning: null }

function safeInteger(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'bigint') return null
  const n = Number(value)
  return Number.isSafeInteger(n) && n >= 0 ? n : null
}

export function volumeCapacity(stats: { bsize: bigint; blocks: bigint; bavail: bigint }): AdminDataVolume | null {
  const { bsize, blocks, bavail } = stats
  if (bsize <= 0n || blocks <= 0n || bavail < 0n || bavail > blocks) return null
  const totalBytes = safeInteger(blocks * bsize), availableBytes = safeInteger(bavail * bsize)
  return totalBytes !== null && availableBytes !== null ? { totalBytes, availableBytes } : null
}

async function readDisk(db: MonitorDb | null): Promise<Disk> {
  if (db?.protocol !== 'file') return noDisk
  // Respect the file bound to this connection even if cwd or DATA_DIR changed. Do not open the DB or walk storage.
  const rows = (await db.execute('PRAGMA database_list')).rows.filter(row => row.name === 'main')
  const filename = rows.length === 1 ? rows[0].file : null
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) return noDisk
  const main = await stat(filename, { bigint: true })
  if (!main.isFile()) return noDisk
  const [volume, wal] = await Promise.all([
    statfs(filename, { bigint: true }).then(volumeCapacity).catch(() => null),
    stat(filename + '-wal', { bigint: true }).then(file => file.isFile() ? safeInteger(file.size) : null)
      .catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? 0 : null),
  ])
  return { mainDatabaseBytes: safeInteger(main.size), walBytes: wal, dataVolume: volume }
}

// Both counts use only the status index, never job payloads or completed history. An absent index makes the metric
// unavailable instead of falling back to a table scan. Use exact counts: a large live backlog must still trigger a rule.
const countJobs = `SELECT
  (SELECT count(*) FROM jobs INDEXED BY idx_jobs_status WHERE status = 'pending') AS pending,
  (SELECT count(*) FROM jobs INDEXED BY idx_jobs_status WHERE status = 'running') AS running`
async function readQueue(db: MonitorDb | null): Promise<Queue> {
  if (!db) return noQueue
  const row = (await db.execute(countJobs)).rows[0]
  return { queuePending: safeInteger(row?.pending), queueRunning: safeInteger(row?.running) }
}

// A busy database or a stalled network volume must not hide the other readings. Keep the same settled timeout until
// the underlying I/O actually completes, so repeated requests cannot accumulate unresolved filesystem/SQLite calls.
function bounded<T>(read: () => Promise<T>, unavailable: T, timeoutMs: number): () => Promise<T> {
  let inFlight: Promise<T> | undefined
  return () => {
    if (inFlight) return inFlight
    let timer: ReturnType<typeof setTimeout>
    const timeout = new Promise<T>(done => { timer = setTimeout(() => done(unavailable), timeoutMs) })
    const actual = Promise.resolve().then(read).catch(() => unavailable).finally(() => { clearTimeout(timer); inFlight = undefined })
    return inFlight = Promise.race([actual, timeout])
  }
}

/** All sources are read on demand. Missing files/tables or an unopened DB never trigger configuration, migration or repair. */
export function createAdminStorageReader(openDb: () => MonitorDb | null = peekOpenDb, timeoutMs = 1_500): () => Promise<AdminStorageSnapshot> {
  const disk = bounded(() => readDisk(openDb()), noDisk, timeoutMs)
  const queue = bounded(() => readQueue(openDb()), noQueue, timeoutMs)
  return async () => {
    const [{ dataVolume, mainDatabaseBytes, walBytes }, jobs] = await Promise.all([disk(), queue()])
    return { dataVolume, resources: { mainDatabaseBytes, walBytes, ...jobs } }
  }
}
