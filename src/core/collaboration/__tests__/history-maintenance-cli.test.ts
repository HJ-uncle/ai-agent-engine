import fs from 'node:fs'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalSqliteProcessClient } from '../../../storage/sqlite/local-process-client.js'
import { ensureHistoryMaintenanceStorageSchema } from '../history-maintenance-storage.js'
type ReadonlyDatabase = { prepare(sql: string): { get(): Record<string, unknown> | undefined }; close(): void }
let DatabaseSync: (new (file: string, options: { readOnly: boolean }) => ReadonlyDatabase) | undefined
try { ({ DatabaseSync } = createRequire(import.meta.url)('node:sqlite')) } catch { /* CLI requires a Node build with node:sqlite. */ }

let directory: string, database: string
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const cli = (script: string, args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', path.resolve('scripts', script), ...args],
  { cwd: path.resolve('.'), encoding: 'utf8', timeout: 20_000, windowsHide: true })
beforeEach(async () => {
  directory = path.resolve('.e2e-tmp', 'maintenance-cli-' + randomUUID()); fs.mkdirSync(directory, { recursive: true })
  database = path.join(directory, 'fixture.db')
  const db = new LocalSqliteProcessClient({ url: 'file:' + database.replaceAll('\\', '/') })
  try {
    await ensureHistoryMaintenanceStorageSchema(db)
    for (const state of ['pending', 'committed']) {
      const json = JSON.stringify({ kind: 'micro', cleared: 1000, sourceRows: Array.from({ length: 1000 }, (_, i) => [i, 'tool']), freedTokens: 9000 })
      await db.execute({ sql: 'INSERT INTO collaboration_history_maintenance VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        args: [state, 'tenant', 'session', 'sqlite', 'root', 'attempt', 'invocation', 1, 'anchor', hash('anchor'), json, hash(json), state, null] })
    }
  } finally { db.close(); await db.whenClosed() }
})
afterEach(() => {
  if (path.dirname(directory) !== path.resolve('.e2e-tmp') || !path.basename(directory).startsWith('maintenance-cli-')) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
describe.skipIf(!DatabaseSync)('session storage operator commands on disposable fixtures', () => {
  it('defaults to read-only stats and refuses implicit online VACUUM', () => {
    const before = hash(fs.readFileSync(database))
    const result = cli('maintain-session-storage.ts', ['--database', database])
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ mode: 'dry-run', stats: { pendingRows: 1, uncompactedTerminalRows: 1 } })
    expect(hash(fs.readFileSync(database))).toBe(before)
    const rejected = cli('maintain-session-storage.ts', ['--database', database, '--apply', '--vacuum'])
    expect(rejected.status).not.toBe(0); expect(rejected.stderr).toContain('VACUUM is offline only')
    expect(hash(fs.readFileSync(database))).toBe(before)
  }, 30_000)

  it('applies terminal compaction and explicit offline VACUUM while preserving pending recovery bytes', () => {
    const beforeDb = new DatabaseSync!(database, { readOnly: true })
    const original = beforeDb.prepare("SELECT payload_json FROM collaboration_history_maintenance WHERE state='pending'").get()!.payload_json
    beforeDb.close()
    const result = cli('maintain-session-storage.ts', ['--database', database, '--apply', '--all', '--vacuum', '--engine-stopped'])
    expect(result.status, result.stderr).toBe(0)
    const afterDb = new DatabaseSync!(database, { readOnly: true })
    try {
      expect(afterDb.prepare("SELECT payload_json FROM collaboration_history_maintenance WHERE state='pending'").get()!.payload_json).toBe(original)
      expect(afterDb.prepare('SELECT count(*) AS n FROM collaboration_history_maintenance_compactions').get()!.n).toBe(1)
      expect(JSON.parse(String(afterDb.prepare("SELECT payload_json FROM collaboration_history_maintenance WHERE state='committed'").get()!.payload_json)).format)
        .toBe('aether-history-maintenance-terminal')
    } finally { afterDb.close() }
  }, 30_000)

  it('cold archive CLI requires apply to write and can verify and restore the exported archive', () => {
    const sessions = path.join(directory, 'sessions'), cold = path.join(directory, 'history-cold'), source = path.join(sessions, 'sample.jsonl.bak')
    fs.mkdirSync(sessions); fs.writeFileSync(source, '{"old":true}\n')
    const dry = cli('history-cold.ts', ['--sessions-dir', sessions])
    expect(dry.status, dry.stderr).toBe(0); expect(JSON.parse(dry.stdout).mode).toBe('dry-run'); expect(fs.existsSync(cold)).toBe(false)
    const apply = cli('history-cold.ts', ['--sessions-dir', sessions, '--apply'])
    expect(apply.status, apply.stderr).toBe(0); expect(fs.existsSync(source)).toBe(true)
    const receipt = JSON.parse(apply.stdout.trim().split('\n')[0])
    const verify = cli('history-cold.ts', ['--cold-dir', cold, '--verify', receipt.manifestPath])
    expect(verify.status, verify.stderr).toBe(0)
    const destination = path.join(directory, 'restored.backup')
    const restored = cli('history-cold.ts', ['--cold-dir', cold, '--restore', receipt.manifestPath, '--destination', destination, '--apply'])
    expect(restored.status, restored.stderr).toBe(0); expect(fs.readFileSync(destination, 'utf8')).toBe('{"old":true}\n')
  }, 30_000)
})
