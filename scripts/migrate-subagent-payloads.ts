import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { parseArgs } from 'node:util'
import { DatabaseSync, backup } from 'node:sqlite'
import type { Client, InStatement } from '@libsql/client'
import { LocalSqliteProcessClient } from '../src/storage/sqlite/local-process-client.js'
import { getSubagentPayloadMigrationStats, migrateSubagentPayloads, type SubagentPayloadMigrationCursor } from '../src/core/subagent/payload-migration.js'

const { values } = parseArgs({ options: {
  database: { type: 'string' }, apply: { type: 'boolean' }, 'engine-stopped': { type: 'boolean' },
  all: { type: 'boolean' }, 'backup-dir': { type: 'string' }, 'max-rows': { type: 'string' },
  'batch-size': { type: 'string' }, 'max-row-bytes': { type: 'string' },
  'after-table': { type: 'string' }, 'after-rowid': { type: 'string' }, help: { type: 'boolean' },
} })

async function assertRealPath(file: string): Promise<void> {
  const absolute = path.resolve(file), root = path.parse(absolute).root
  let current = root
  for (const segment of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    const stat = await fs.promises.lstat(current)
    if (stat.isSymbolicLink()) throw new Error(`Backup refuses a symbolic link or junction: ${current}`)
  }
}
async function flushFile(file: string): Promise<void> {
  const handle = await fs.promises.open(file, 'r+')
  try { await handle.sync() } finally { await handle.close() }
}
async function flushDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return // Node/Windows cannot portably fsync directories.
  const handle = await fs.promises.open(directory, 'r')
  try { await handle.sync() } finally { await handle.close() }
}
async function copyImmutableDirectory(source: string, target: string): Promise<void> {
  await assertRealPath(source)
  if (!(await fs.promises.lstat(source)).isDirectory()) throw new Error(`Payload root is not a directory: ${source}`)
  await fs.promises.mkdir(target)
  for (const entry of await fs.promises.readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name), to = path.join(target, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`Backup refuses a symbolic link or junction: ${from}`)
    if (entry.isDirectory()) await copyImmutableDirectory(from, to)
    else if (entry.isFile()) {
      await assertRealPath(from)
      await fs.promises.copyFile(from, to, fs.constants.COPYFILE_EXCL)
      await flushFile(to)
    } else throw new Error(`Backup refuses a nonregular payload entry: ${from}`)
  }
  await flushDirectory(target)
}
async function validateImmutableDirectory(source: string): Promise<void> {
  await assertRealPath(source)
  if (!(await fs.promises.lstat(source)).isDirectory()) throw new Error(`Payload root is not a directory: ${source}`)
  for (const entry of await fs.promises.readdir(source, { withFileTypes: true })) {
    const child = path.join(source, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`Backup refuses a symbolic link or junction: ${child}`)
    if (entry.isDirectory()) await validateImmutableDirectory(child)
    else if (entry.isFile()) await assertRealPath(child)
    else throw new Error(`Backup refuses a nonregular payload entry: ${child}`)
  }
}

/** SQLite's online-backup API includes committed WAL content; copying the .db file does not. */
async function createBackup(database: string, directory: string): Promise<string> {
  await assertRealPath(database)
  await assertRealPath(path.dirname(directory))
  for (const source of [database + '.subagent-payloads', path.join(path.dirname(database), 'blobs')]) {
    const relative = path.relative(source, directory)
    if (relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)))
      throw new Error('Backup destination must not be inside a source payload directory')
  }
  const existingSources: string[] = []
  for (const source of [database + '.subagent-payloads', path.join(path.dirname(database), 'blobs')]) {
    try { await validateImmutableDirectory(source); existingSources.push(source) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
  }
  // mkdir without recursive intentionally fails for any pre-existing backup destination.
  await fs.promises.mkdir(directory)
  const destination = path.join(directory, path.basename(database))
  // Reserve a new regular file before SQLite opens the destination. Never overwrite a backup.
  const reservation = await fs.promises.open(destination, 'wx'); await reservation.close()
  const native = new DatabaseSync(database, { readOnly: true })
  try { await backup(native, destination) } finally { native.close() }
  await flushFile(destination)
  const copied: string[] = []
  for (const [source, target] of [
    [database + '.subagent-payloads', destination + '.subagent-payloads'],
    [path.join(path.dirname(database), 'blobs'), path.join(directory, 'blobs')],
  ]) {
    if (!existingSources.includes(source)) continue
    await copyImmutableDirectory(source, target); copied.push(path.basename(target))
  }
  const manifest = path.join(directory, 'subagent-migration-backup.json')
  await fs.promises.writeFile(manifest, JSON.stringify({ version: 1, createdAt: new Date().toISOString(),
    sourceDatabase: database, database: path.basename(destination), payloadDirectories: copied,
    scope: 'SQLite plus subagent payloads and history blobs; sessions and cold archives are separate engine state.',
    restore: 'Restore the database and its companion payload directories together. Keep <database>.subagent-payloads named after the restored database.',
  }, null, 2), { flag: 'wx' })
  await flushFile(manifest); await flushDirectory(directory); await flushDirectory(path.dirname(directory))
  return destination
}

if (values.help) {
  console.log(`Usage: npx tsx scripts/migrate-subagent-payloads.ts --database PATH [--apply --engine-stopped] [--all]
  [--backup-dir NEW_DIRECTORY] [--max-rows 128] [--batch-size 16] [--max-row-bytes 8388608]
  [--after-table TABLE --after-rowid ROWID]
Default: read-only per-table byte statistics. Apply requires EVERY engine instance stopped and creates
a new consistent SQLite + companion payload backup before modifying any row. --all repeats bounded
batches; otherwise one batch is applied and the returned table+rowid cursor can be passed next time.
Legacy v1 and subagent_records stay unchanged. Oversized/noncanonical details are reported and skipped.
Failures retain the old data and return a retry cursor. No VACUUM or payload deletion is performed.
Reduced inline bytes are logical savings, not bytes reclaimed from the database file.`)
} else {
  if (!values.database) throw new Error('--database is required; no default user database is opened')
  if (values.apply && !values['engine-stopped']) throw new Error('--apply requires --engine-stopped: close EVERY engine instance first')
  if (!values.apply && (values.all || values['backup-dir'] || values['after-table'] || values['after-rowid']))
    throw new Error('--all, --backup-dir and resume cursors require --apply')
  if ((values['after-table'] === undefined) !== (values['after-rowid'] === undefined))
    throw new Error('--after-table and --after-rowid must be supplied together')
  const database = path.resolve(values.database)
  await assertRealPath(database)
  if (!(await fs.promises.lstat(database)).isFile()) throw new Error('Database must already exist as a regular file')
  const options = {
    ...(values['max-rows'] !== undefined ? { maxRows: Number(values['max-rows']) } : {}),
    ...(values['batch-size'] !== undefined ? { batchSize: Number(values['batch-size']) } : {}),
    ...(values['max-row-bytes'] !== undefined ? { maxRowBytes: Number(values['max-row-bytes']) } : {}),
    ...(values['after-table'] ? { after: { table: values['after-table'], rowid: values['after-rowid']! } as SubagentPayloadMigrationCursor } : {}),
  }
  // Validate all numeric inputs before backup or any writable database connection.
  for (const [key, min, max] of [['maxRows', 1, 100_000], ['batchSize', 1, 256], ['maxRowBytes', 1, 256 * 1024 * 1024]] as const) {
    const value = options[key]
    if (value !== undefined && (!Number.isSafeInteger(value) || value < min || value > max)) throw new RangeError(`Invalid ${key}`)
  }
  if (options.after && (!['subagent_runs', 'subagent_checkpoints', 'subagent_tools', 'subagent_tool_versions', 'subagent_events', 'subagent_outbox'].includes(options.after.table)
    || !/^-?(0|[1-9]\d*)$/.test(options.after.rowid) || BigInt(options.after.rowid) < -9223372036854775808n || BigInt(options.after.rowid) > 9223372036854775807n))
    throw new RangeError('Invalid resume cursor')
  if (!values.apply) {
    const native = new DatabaseSync(database, { readOnly: true })
    try {
      native.exec('PRAGMA query_only=ON; BEGIN')
      const readonlyClient = { execute: async (statement: InStatement) => {
        const sql = typeof statement === 'string' ? statement : statement.sql
        if (!/^SELECT\b/i.test(sql.trim())) throw new Error('Dry-run permits only SELECT')
        const args = typeof statement === 'string' ? [] : statement.args ?? []
        if (!Array.isArray(args)) throw new Error('Expected positional SQL arguments')
        return { rows: native.prepare(sql).all(...args) }
      } } as unknown as Client
      console.log(JSON.stringify({ mode: 'dry-run', database, stats: await getSubagentPayloadMigrationStats(readonlyClient, options),
        note: 'Inline JSON bytes are not total database size, external file size, or an estimate of reclaimable disk space.' }, null, 2))
    } finally { native.close() }
  } else {
    const backupDirectory = path.resolve(values['backup-dir'] ?? `${database}.subagent-migration-backup-${Date.now()}-${randomUUID()}`)
    const backupDatabase = await createBackup(database, backupDirectory)
    console.log(JSON.stringify({ mode: 'backup-complete', database: backupDatabase }))
    const db = new LocalSqliteProcessClient({ url: 'file:' + database.replaceAll('\\', '/') })
    try {
      const before = await getSubagentPayloadMigrationStats(db, options)
      let after = options.after
      for (;;) {
        const result = await migrateSubagentPayloads(db, { ...options, after })
        console.log(JSON.stringify({ mode: 'apply-batch', ...result }))
        if (result.failure || result.aborted) { process.exitCode = 1; break }
        after = result.after
        if (!values.all || !result.hasMore) break
      }
      console.log(JSON.stringify({ mode: process.exitCode ? 'stopped' : 'applied', before,
        after: await getSubagentPayloadMigrationStats(db, options), backupDatabase, vacuum: false }, null, 2))
    } finally { db.close(); await db.whenClosed() }
  }
}
