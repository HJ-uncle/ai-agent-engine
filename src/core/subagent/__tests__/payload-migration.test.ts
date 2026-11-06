// Only isolated real SQLite fixtures. Never getDb(), DATA_DIR, a user DB, or online maintenance.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalSqliteProcessClient } from '../../../storage/sqlite/local-process-client.js'
import { up } from '../../../storage/sqlite/migrations/019_subagent_runs.js'
import { ensureSubagentDeltaSchema } from '../durable-schema.js'
import { SubagentPayloadCodec, SUBAGENT_PAYLOAD_FIELDS } from '../payload-codec.js'
import { getSubagentPayloadFiles, SubagentPayloadFiles } from '../payload-files.js'
import { getSubagentPayloadMigrationStats, migrateSubagentPayloads, type SubagentPayloadMigrationCursor } from '../payload-migration.js'

const executeFile = promisify(execFile), clients: LocalSqliteProcessClient[] = []
const large = '原始正文🙂\n"引用" '.repeat(2500)
let directory: string, file: string, db: LocalSqliteProcessClient
function open(database: string) {
  const client = new LocalSqliteProcessClient({ url: 'file:' + database.replaceAll('\\', '/') })
  clients.push(client); return client
}
const cli = (...args: string[]) => executeFile(process.execPath, ['--import', 'tsx', 'scripts/migrate-subagent-payloads.ts', ...args],
  { cwd: process.cwd(), timeout: 30_000, maxBuffer: 1024 * 1024 })
async function tool(id: string, detail = JSON.stringify({ id, args: { text: large }, output: large })) {
  const summary = JSON.stringify({ id, outputPreview: large, status: 'completed' })
  await db.execute({ sql: 'INSERT INTO subagent_tool_versions(tenant_id,run_id,tool_id,seq,ordinal,status,summary,detail) VALUES (?,?,?,?,?,?,?,?)',
    args: ['tenant-a', 'run', id, 1, 0, 'completed', summary, detail] })
  return { summary, detail }
}
beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-payload-migration-test-'))
  file = path.join(directory, 'fixture.db'); db = open(file)
  await up(db); await ensureSubagentDeltaSchema(db)
})
afterEach(async () => {
  vi.restoreAllMocks()
  for (const client of clients) client.close()
  await Promise.all(clients.splice(0).map(client => client.whenClosed()))
  const resolved = path.resolve(directory)
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('aether-payload-migration-test-')) throw new Error('Unsafe migration fixture cleanup')
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

describe('offline subagent payload migration', () => {
  it('roundtrips modern state, checkpoint, summaries, detail, delta and outbox; preserves v1 and records', async () => {
    const state = { schemaVersion: 2, runId: 'run', status: 'succeeded', partialOutput: large, resultSummary: large }
    const legacy = JSON.stringify({ schemaVersion: 1, runId: 'legacy', partialOutput: large, toolCalls: [] })
    for (const [id, raw] of [['run', JSON.stringify(state)], ['legacy', legacy]]) {
      await db.execute({ sql: 'INSERT INTO subagent_runs VALUES (?,?,?,?,?,?,?,?,?,?)', args: ['tenant-a', id, 'parent', id, id, 'succeeded', 1, 1, 1, raw] })
    }
    const record = JSON.stringify({ prompt: large, continuation: { systemPrompt: large } })
    await db.execute({ sql: 'INSERT INTO subagent_records VALUES (?,?,?)', args: ['tenant-a', 'run', record] })
    const header = JSON.stringify({ partialOutput: large, latestActivity: large, status: 'succeeded' })
    await db.execute({ sql: 'INSERT INTO subagent_checkpoints VALUES (?,?,?,?)', args: ['tenant-a', 'run', 1, header] })
    const original = await tool('tool')
    await db.execute({ sql: 'INSERT INTO subagent_tools VALUES (?,?,?,?,?,?,?)', args: ['tenant-a', 'run', 'tool', 0, 1, 'completed', original.summary] })
    const event = { schemaVersion: 2, kind: 'tool.completed', runId: 'run', seq: 1, headerPatch: { partialOutput: large }, toolUpsert: JSON.parse(original.summary) }
    const outbox = { schemaVersion: 2, kind: 'snapshot', runId: 'run', seq: 1, view: { partialOutput: large, toolCalls: [JSON.parse(original.summary)] } }
    const oldEvent = JSON.stringify({ schemaVersion: 1, snapshot: JSON.parse(legacy) })
    await db.execute({ sql: 'INSERT INTO subagent_events VALUES (?,?,?,?,?)', args: ['tenant-a', 'run', 1, 'tool.completed', JSON.stringify(event)] })
    await db.execute({ sql: 'INSERT INTO subagent_events VALUES (?,?,?,?,?)', args: ['tenant-a', 'legacy', 1, 'snapshot', oldEvent] })
    await db.execute({ sql: 'INSERT INTO subagent_outbox VALUES (?,?,?,?,?,?)', args: ['out', 'tenant-a', 'run', 1, JSON.stringify(outbox), 0] })
    const before = await getSubagentPayloadMigrationStats(db), result = await migrateSubagentPayloads(db)
    expect(result).toMatchObject({ scanned: 8, migrated: 6, skippedLegacy: 2, hasMore: false })
    expect(result.failure).toBeUndefined(); expect(result.reducedInlineBytes).toBeGreaterThan(100_000)
    const codec = new SubagentPayloadCodec(await getSubagentPayloadFiles(db))
    const raw = async (table: string, column: string, where = '') => String((await db.execute(`SELECT ${column} FROM ${table} ${where}`)).rows[0][column])
    expect(await codec.decodeState('tenant-a', await raw('subagent_runs', 'snapshot', "WHERE run_id='run'"))).toEqual(state)
    expect(await codec.decodeState('tenant-a', await raw('subagent_checkpoints', 'header'))).toEqual(JSON.parse(header))
    expect(await codec.decodeSummary('tenant-a', await raw('subagent_tools', 'summary'))).toEqual(JSON.parse(original.summary))
    expect(await codec.decodeSummary('tenant-a', await raw('subagent_tool_versions', 'summary'))).toEqual(JSON.parse(original.summary))
    const storedDetail = await raw('subagent_tool_versions', 'detail')
    expect(JSON.stringify(await codec.decodeDetail('tenant-a', storedDetail))).toBe(original.detail)
    expect(await codec.getDetailChunk('tenant-a', storedDetail, 0, 48)).toMatchObject({ totalBytes: Buffer.byteLength(original.detail), text: Buffer.from(original.detail).subarray(0, 48).toString('utf8') })
    expect(await codec.decodeEvent('tenant-a', await raw('subagent_events', 'event', "WHERE run_id='run'"))).toEqual(event)
    expect(await codec.decodeEvent('tenant-a', await raw('subagent_outbox', 'event'))).toEqual(outbox)
    expect(await raw('subagent_runs', 'snapshot', "WHERE run_id='legacy'")).toBe(legacy)
    expect(await raw('subagent_events', 'event', "WHERE run_id='legacy'")).toBe(oldEvent)
    expect(await raw('subagent_records', 'record')).toBe(record)
    const after = await getSubagentPayloadMigrationStats(db)
    expect(before.reduce((n, t) => n + t.inlineBytes, 0) - after.reduce((n, t) => n + t.inlineBytes, 0)).toBe(result.reducedInlineBytes)
    const again = await migrateSubagentPayloads(db)
    expect(again).toMatchObject({ scanned: 8, migrated: 0, hasMore: false, alreadyEncodedColumns: 7 })
    expect(await getSubagentPayloadMigrationStats(db)).toEqual(after)
  })

  it('retains noncanonical detail bytes and offsets while safely migrating its summary', async () => {
    const detail = '{ "output" : ' + JSON.stringify(large) + ', "id":"tool", "numeric":1.0 }'
    await tool('tool', detail)
    const result = await migrateSubagentPayloads(db)
    expect(result).toMatchObject({ scanned: 1, migrated: 1, skippedNoncanonicalDetails: 1 })
    const row = (await db.execute('SELECT summary,detail FROM subagent_tool_versions')).rows[0]
    expect(row.detail).toBe(detail); expect(String(row.summary)).toContain(SUBAGENT_PAYLOAD_FIELDS)
    const codec = new SubagentPayloadCodec(await getSubagentPayloadFiles(db))
    const page = await codec.getDetailChunk('tenant-a', row.detail, 0, 24)
    expect(page.totalBytes).toBe(Buffer.byteLength(detail)); expect(Buffer.from(detail).subarray(0, Buffer.byteLength(page.text)).toString()).toBe(page.text)
  })

  it('bounds raw row loads, reports oversized rows, and resumes across table boundaries by rowid', async () => {
    await db.execute({ sql: 'INSERT INTO subagent_checkpoints VALUES (?,?,?,?)', args: ['tenant-a', 'run', 1, JSON.stringify({ partialOutput: 'x'.repeat(2000) })] })
    await tool('oversized'); await tool('small', JSON.stringify({ output: 'x'.repeat(1500) }))
    // Keep both summaries small so only the first detail exceeds the budget.
    await db.execute("UPDATE subagent_tool_versions SET summary='{}'")
    const read = vi.spyOn(db, 'execute'), first = await migrateSubagentPayloads(db, { maxRows: 1, batchSize: 1, maxRowBytes: 4096 })
    expect(first).toMatchObject({ scanned: 1, migrated: 1, hasMore: true, after: { table: 'subagent_checkpoints', rowid: '1' } })
    read.mockClear()
    const second = await migrateSubagentPayloads(db, { after: first.after, maxRows: 1, maxRowBytes: 4096 })
    expect(second).toMatchObject({ scanned: 1, migrated: 0, skippedOversized: 1, hasMore: true, after: { table: 'subagent_tool_versions', rowid: '1' } })
    expect(read.mock.calls.some(([statement]) => /^SELECT tenant_id/.test(typeof statement === 'string' ? statement : (statement as { sql: string }).sql))).toBe(false)
    const third = await migrateSubagentPayloads(db, { after: second.after, maxRows: 1, maxRowBytes: 4096 })
    expect(third).toMatchObject({ scanned: 1, migrated: 1, hasMore: false })
    expect((await getSubagentPayloadMigrationStats(db, { maxRowBytes: 4096 })).find(table => table.table === 'subagent_tool_versions')?.oversizedRows).toBe(1)
    expect((await migrateSubagentPayloads(db)).migrated).toBe(1) // A fresh larger-budget scan retries the oversized row.
  })

  it('returns the last committed cursor on interruption and resumes after reopening the real DB', async () => {
    await tool('first'); const second = await tool('second')
    await db.execute("CREATE TRIGGER fail_second BEFORE UPDATE ON subagent_tool_versions WHEN OLD.tool_id='second' BEGIN SELECT RAISE(ABORT,'simulated interruption'); END")
    const result = await migrateSubagentPayloads(db)
    expect(result).toMatchObject({ scanned: 1, migrated: 1, after: { table: 'subagent_tool_versions', rowid: '1' }, hasMore: true,
      failure: { at: { table: 'subagent_tool_versions', rowid: '2' } } })
    expect((await db.execute("SELECT summary,detail FROM subagent_tool_versions WHERE tool_id='second'")).rows[0]).toMatchObject(second)
    db.close(); await db.whenClosed(); db = open(file)
    await db.execute('DROP TRIGGER fail_second')
    const resumed = await migrateSubagentPayloads(db, { after: result.after })
    expect(resumed).toMatchObject({ scanned: 1, migrated: 1, hasMore: false })
    const codec = new SubagentPayloadCodec(await getSubagentPayloadFiles(db))
    expect(JSON.stringify(await codec.decodeDetail('tenant-a', (await db.execute("SELECT detail FROM subagent_tool_versions WHERE tool_id='second'")).rows[0].detail))).toBe(second.detail)
  })

  it('publishes before CAS, never overwrites a concurrent raw change, and leaves retryable cursor', async () => {
    await tool('tool')
    const originalTransaction = db.transaction.bind(db)
    vi.spyOn(db, 'transaction').mockImplementationOnce(async mode => {
      expect(fs.readdirSync(file + '.subagent-payloads', { recursive: true }).some(entry => String(entry).endsWith('.gz'))).toBe(true)
      await db.execute("UPDATE subagent_tool_versions SET summary='{}'")
      return originalTransaction(mode)
    })
    const result = await migrateSubagentPayloads(db)
    expect(result).toMatchObject({ scanned: 0, migrated: 0, hasMore: true, failure: { code: 'MIGRATION_CAS_MISMATCH' } })
    expect(result.after).toBeUndefined()
    const raw = (await db.execute('SELECT summary,detail FROM subagent_tool_versions')).rows[0]
    expect(raw.summary).toBe('{}'); expect(String(raw.detail)).not.toContain(SUBAGENT_PAYLOAD_FIELDS)
    expect((await migrateSubagentPayloads(db)).migrated).toBe(1)
  })

  it('file failures and cancellation keep the old SQLite payload available for retry', async () => {
    const original = await tool('tool')
    const put = vi.spyOn(SubagentPayloadFiles.prototype, 'put').mockRejectedValueOnce(new Error('simulated disk failure'))
    expect(await migrateSubagentPayloads(db)).toMatchObject({ scanned: 0, migrated: 0, failure: { message: 'simulated disk failure' } })
    expect((await db.execute('SELECT summary,detail FROM subagent_tool_versions')).rows[0]).toMatchObject(original)
    put.mockRestore()
    const controller = new AbortController(), originalPut = SubagentPayloadFiles.prototype.put
    vi.spyOn(SubagentPayloadFiles.prototype, 'put').mockImplementationOnce(async function (this: SubagentPayloadFiles, tenant, value) {
      const reference = await originalPut.call(this, tenant, value); controller.abort(); return reference
    })
    expect(await migrateSubagentPayloads(db, { signal: controller.signal })).toMatchObject({ scanned: 0, migrated: 0, aborted: true, hasMore: true })
    expect((await db.execute('SELECT summary,detail FROM subagent_tool_versions')).rows[0]).toMatchObject(original)
    expect((await migrateSubagentPayloads(db)).migrated).toBe(1)
  })

  it('read-only stats do not initialize absent tables, cursor, or files; invalid limits fail before writes', async () => {
    const emptyFile = path.join(directory, 'empty.db'), empty = open(emptyFile)
    const before = (await empty.execute('SELECT name FROM sqlite_master')).rows
    expect(await getSubagentPayloadMigrationStats(empty)).toEqual([])
    expect(await migrateSubagentPayloads(empty)).toMatchObject({ scanned: 0, hasMore: false })
    expect((await empty.execute('SELECT name FROM sqlite_master')).rows).toEqual(before)
    expect(fs.existsSync(emptyFile + '.subagent-payloads')).toBe(false)
    for (const options of [{ maxRows: 0 }, { batchSize: 257 }, { maxRowBytes: Infinity }, { after: { table: 'bad', rowid: '1' } as unknown as SubagentPayloadMigrationCursor },
      { after: { table: 'subagent_runs', rowid: '9223372036854775808' } as SubagentPayloadMigrationCursor }])
      await expect(migrateSubagentPayloads(db, options)).rejects.toThrow(/Invalid/)
  })
})

describe('migration CLI safety and recoverable backup', () => {
  it('defaults to read-only statistics and requires explicit database plus stop declaration for apply', async () => {
    const original = await tool('tool'), before = fs.readFileSync(file)
    const result = await cli('--database', file)
    expect(JSON.parse(result.stdout)).toMatchObject({ mode: 'dry-run', database: file })
    expect(fs.readFileSync(file)).toEqual(before)
    expect((await db.execute('SELECT summary,detail FROM subagent_tool_versions')).rows[0]).toMatchObject(original)
    expect(fs.existsSync(file + '.subagent-payloads')).toBe(false)
    await expect(cli('--apply', '--database', file)).rejects.toMatchObject({ stderr: expect.stringContaining('--engine-stopped') })
    await expect(cli('--apply', '--engine-stopped')).rejects.toMatchObject({ stderr: expect.stringContaining('--database is required') })
    expect(fs.readdirSync(directory).some(name => name.includes('backup'))).toBe(false)
  })

  it('backs up committed WAL content and companion payloads before migrating; the moved backup hydrates independently', async () => {
    await db.execute('PRAGMA journal_mode=WAL'); await db.execute('PRAGMA wal_autocheckpoint=0')
    const first = await tool('already-external'); await migrateSubagentPayloads(db)
    const second = await tool('still-inline')
    expect(fs.statSync(file + '-wal').size).toBeGreaterThan(0)
    // Include an existing history blob root in the backup; it shares the DB directory contract.
    fs.mkdirSync(path.join(directory, 'blobs')); fs.writeFileSync(path.join(directory, 'blobs', 'evidence.gz'), 'fixture-history-blob')
    const backupDirectory = path.join(directory, 'backup')
    const result = await cli('--database', file, '--apply', '--engine-stopped', '--all', '--backup-dir', backupDirectory)
    expect(result.stdout).toContain('backup-complete'); expect(result.stdout).toContain('"vacuum": false')
    const backupFile = path.join(backupDirectory, path.basename(file)), restored = open(backupFile)
    const rows = (await restored.execute('SELECT tool_id,summary,detail FROM subagent_tool_versions ORDER BY rowid')).rows
    expect(rows).toHaveLength(2) // Includes the committed record that was still in the source WAL.
    expect(String(rows[0].detail)).toContain(SUBAGENT_PAYLOAD_FIELDS)
    expect(rows[1]).toMatchObject(second)
    expect(fs.readFileSync(path.join(backupDirectory, 'blobs', 'evidence.gz'), 'utf8')).toBe('fixture-history-blob')
    const codec = new SubagentPayloadCodec(await getSubagentPayloadFiles(restored))
    // Rename the original payload directory: a backup must not silently depend on that path.
    fs.renameSync(file + '.subagent-payloads', file + '.subagent-payloads-original')
    expect(JSON.stringify(await codec.decodeDetail('tenant-a', rows[0].detail))).toBe(first.detail)
    expect(JSON.parse(fs.readFileSync(path.join(backupDirectory, 'subagent-migration-backup.json'), 'utf8')).payloadDirectories).toContain(path.basename(backupFile) + '.subagent-payloads')
  }, 30_000)

  it('refuses to overwrite an existing backup and refuses symlink payload roots before mutation', async () => {
    const original = await tool('tool'), backupDirectory = path.join(directory, 'backup')
    fs.mkdirSync(backupDirectory); fs.writeFileSync(path.join(backupDirectory, 'keep'), 'keep')
    await expect(cli('--database', file, '--apply', '--engine-stopped', '--backup-dir', backupDirectory)).rejects.toMatchObject({ stderr: expect.stringContaining('EEXIST') })
    expect(fs.readFileSync(path.join(backupDirectory, 'keep'), 'utf8')).toBe('keep')
    const outside = path.join(directory, 'outside'); fs.mkdirSync(outside)
    fs.symlinkSync(outside, file + '.subagent-payloads', process.platform === 'win32' ? 'junction' : 'dir')
    await expect(cli('--database', file, '--apply', '--engine-stopped', '--backup-dir', path.join(directory, 'backup-refused'))).rejects.toMatchObject({ stderr: expect.stringContaining('symbolic link or junction') })
    expect((await db.execute('SELECT summary,detail FROM subagent_tool_versions')).rows[0]).toMatchObject(original)
  })
})
