import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HistoryBlobStore } from '../history-blobs.js'
import { archiveSealedHistoryBackup } from '../history-cold.js'
import { collectHistoryBlobGarbage, type HistoryBlobGCQueries } from '../history-blob-gc.js'

interface NativeDatabase {
  exec(sql: string): void
  prepare(sql: string): { run(...args: unknown[]): unknown; all(): Record<string, unknown>[]; iterate(): Iterable<Record<string, unknown>> }
  close(): void
}
let DatabaseSync: (new (file: string) => NativeDatabase) | undefined
try { ({ DatabaseSync } = createRequire(import.meta.url)('node:sqlite')) } catch { /* Native CLI support is optional on older Node versions. */ }
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const scope = { tenantId: 'gc-tenant', sessionId: 'gc-session' }
let root: string, dbPath: string, db: NativeDatabase, store: HistoryBlobStore, query: HistoryBlobGCQueries
const old = new Date(Date.now() - 10 * 86400_000)
async function encoded(id: string) {
  const row = { type: 'tool', uuid: id, ...scope, payload: { content: 'large unique tool evidence ' + id + ' '.repeat(1000) } }
  const line = await store.encode(row) + '\n'
  const envelope = JSON.parse(line).storageBlobs
  const file = path.join(root, 'blobs', envelope.tenant, envelope.refs[0].hash.slice(0, 2), envelope.refs[0].hash + '.gz')
  await fsp.utimes(file, old, old)
  return { line, file }
}
beforeEach(async () => {
  if (!DatabaseSync) return
  root = path.resolve('.e2e-tmp', 'history-blob-gc-' + randomUUID()); await fsp.mkdir(path.join(root, 'sessions'), { recursive: true })
  dbPath = path.join(root, 'agent.db'); db = new DatabaseSync(dbPath); store = new HistoryBlobStore(dbPath, 32)
  db.exec('CREATE TABLE collaboration_history_maintenance(payload_json TEXT,payload_hash TEXT,state TEXT,backend TEXT)')
  db.exec('CREATE TABLE collaboration_jsonl_deliveries(encoded_row TEXT,row_hash TEXT,row_bytes INTEGER)')
  query = { all: sql => db.prepare(sql).all(), iterate: sql => db.prepare(sql).iterate() }
})
afterEach(async () => {
  if (!DatabaseSync) return
  vi.restoreAllMocks()
  db.close()
  if (path.dirname(root) !== path.resolve('.e2e-tmp') || !path.basename(root).startsWith('history-blob-gc-')) throw new Error('Unsafe fixture cleanup')
  await fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
describe.skipIf(!DatabaseSync)('offline content blob GC', () => {
  it('marks active, sealed, cold, pending and every collaboration encoded_row before deleting only aged orphans', async () => {
    const active = await encoded('active'), sealed = await encoded('sealed'), cold = await encoded('cold')
    const pending = await encoded('pending'), delivery = await encoded('delivery'), orphan = await encoded('orphan'), young = await encoded('young')
    await fsp.utimes(young.file, new Date(), new Date())
    await fsp.writeFile(path.join(root, 'sessions/active.jsonl'), active.line)
    await fsp.writeFile(path.join(root, 'sessions/sealed.jsonl.123456.bak'), sealed.line)
    await fsp.writeFile(path.join(root, 'sessions/cold.jsonl.bak'), cold.line)
    await archiveSealedHistoryBackup(path.join(root, 'sessions'), 'cold.jsonl.bak', path.join(root, 'history-cold'), { removeSource: true })
    const payload = JSON.stringify({ kind: 'update', plan: { encoded: pending.line, bytes: Buffer.byteLength(pending.line), hash: digest(pending.line) } })
    db.prepare('INSERT INTO collaboration_history_maintenance VALUES(?,?,?,?)').run(payload, digest(payload), 'pending', 'jsonl')
    db.prepare('INSERT INTO collaboration_jsonl_deliveries VALUES(?,?,?)').run(delivery.line, digest(delivery.line), Buffer.byteLength(delivery.line))
    const dry = await collectHistoryBlobGarbage({ dataRoot: root, database: query })
    expect(dry, JSON.stringify(dry.errors)).toMatchObject({ safeToSweep: true, mode: 'dry-run', scannedJsonlFiles: 2,
      scannedColdArchives: 1, scannedDatabaseRows: 2, referencedBlobs: 5, blobFiles: 7, retainedYoungBlobs: 1, deletedFiles: 0 })
    expect(dry.orphanFiles).toHaveLength(1); expect(fs.existsSync(orphan.file)).toBe(true)
    db.exec('BEGIN EXCLUSIVE')
    const applied = await collectHistoryBlobGarbage({ dataRoot: root, database: query, apply: true, engineStopped: true })
    db.exec('COMMIT')
    expect(applied, JSON.stringify(applied.errors)).toMatchObject({ mode: 'applied', safeToSweep: true, deletedFiles: 1 })
    expect(fs.existsSync(orphan.file)).toBe(false)
    for (const retained of [active, sealed, cold, pending, delivery, young]) expect(fs.existsSync(retained.file)).toBe(true)
  })

  it.each(['truncated JSONL', 'unknown envelope', 'out-of-bounds reference', 'corrupt blob', 'pending hash mismatch', 'unknown source file'])
    ('refuses the entire sweep for %s and preserves an otherwise valid orphan', async fault => {
      const reference = await encoded('reference'), orphan = await encoded('orphan')
      let line = reference.line
      if (fault === 'truncated JSONL') line = line.slice(0, -1)
      if (fault === 'unknown envelope') { const row = JSON.parse(line); row.storageBlobs.version = 2; line = JSON.stringify(row) + '\n' }
      if (fault === 'out-of-bounds reference') { const row = JSON.parse(line); row.storageBlobs.refs[0].path = ['payload', 'missing']; line = JSON.stringify(row) + '\n' }
      await fsp.writeFile(path.join(root, 'sessions/active.jsonl'), line)
      if (fault === 'corrupt blob') await fsp.writeFile(reference.file, 'corrupt gzip')
      if (fault === 'pending hash mismatch') db.prepare('INSERT INTO collaboration_history_maintenance VALUES(?,?,?,?)').run('{}', digest('wrong'), 'pending', 'jsonl')
      if (fault === 'unknown source file') await fsp.writeFile(path.join(root, 'sessions/unrecognized.bin'), 'possibly referenced data')
      const result = await collectHistoryBlobGarbage({ dataRoot: root, database: query, apply: true, engineStopped: true })
      expect(result).toMatchObject({ mode: 'refused', safeToSweep: false, deletedFiles: 0 })
      expect(result.errors.length).toBeGreaterThan(0); expect(fs.existsSync(orphan.file)).toBe(true)
    })

  it('refuses a cold gzip without its manifest', async () => {
    const referenced = await encoded('reference'), orphan = await encoded('orphan')
    await fsp.writeFile(path.join(root, 'sessions/sealed.jsonl.bak'), referenced.line)
    const receipt = await archiveSealedHistoryBackup(path.join(root, 'sessions'), 'sealed.jsonl.bak', path.join(root, 'history-cold'), { removeSource: true })
    await fsp.unlink(receipt.manifestPath)
    const refused = await collectHistoryBlobGarbage({ dataRoot: root, database: query, apply: true, engineStopped: true })
    expect(refused).toMatchObject({ safeToSweep: false, deletedFiles: 0 }); expect(fs.existsSync(orphan.file)).toBe(true)
  })

  it('refuses unreadable sources and symlinked directories before deleting anything', async () => {
    const orphan = await encoded('orphan'), file = path.join(root, 'sessions/active.jsonl')
    await fsp.writeFile(file, '')
    const lstat = fsp.lstat.bind(fsp)
    vi.spyOn(fsp, 'lstat').mockImplementation(((candidate: fs.PathLike, options?: unknown) => {
      if (String(candidate) === file) return Promise.reject(Object.assign(new Error('injected source read failure'), { code: 'EIO' }))
      return lstat(candidate, options as never)
    }) as typeof fsp.lstat)
    const failed = await collectHistoryBlobGarbage({ dataRoot: root, database: query, apply: true, engineStopped: true })
    expect(failed).toMatchObject({ mode: 'refused', deletedFiles: 0 }); expect(fs.existsSync(orphan.file)).toBe(true)
    vi.restoreAllMocks()
    const outside = path.join(root, 'outside'); await fsp.mkdir(outside)
    await fsp.symlink(outside, path.join(root, 'sessions/linked'), process.platform === 'win32' ? 'junction' : 'dir')
    const linked = await collectHistoryBlobGarbage({ dataRoot: root, database: query, apply: true, engineStopped: true })
    expect(linked).toMatchObject({ mode: 'refused', deletedFiles: 0 }); expect(fs.existsSync(orphan.file)).toBe(true)
  })

  it('enforces offline authorization and the minimum seven-day grace period', async () => {
    await expect(collectHistoryBlobGarbage({ dataRoot: root, database: query, apply: true })).rejects.toThrow('engineStopped')
    await expect(collectHistoryBlobGarbage({ dataRoot: root, database: query, minimumAgeMs: 1 })).rejects.toThrow('at least 7 days')
  })

  it('CLI defaults to reporting and requires an explicit offline apply before removing aged orphans', async () => {
    const orphan = await encoded('cli-orphan')
    db.close(); db = new DatabaseSync!(dbPath) // No transaction or lock survives into the operator process.
    const run = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', path.resolve('scripts/history-blob-gc.ts'), '--database', dbPath, ...args],
      { cwd: path.resolve('.'), encoding: 'utf8', timeout: 20_000, windowsHide: true })
    const dry = run(); expect(dry.status, dry.stderr).toBe(0); expect(JSON.parse(dry.stdout)).toMatchObject({ mode: 'dry-run', deletedFiles: 0 })
    const denied = run('--apply'); expect(denied.status).not.toBe(0); expect(fs.existsSync(orphan.file)).toBe(true)
    const applied = run('--apply', '--engine-stopped'); expect(applied.status, applied.stderr).toBe(0)
    expect(JSON.parse(applied.stdout)).toMatchObject({ mode: 'applied', deletedFiles: 1 }); expect(fs.existsSync(orphan.file)).toBe(false)
  }, 30_000)
})
