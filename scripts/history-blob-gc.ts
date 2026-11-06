import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { DatabaseSync } from 'node:sqlite'
import { collectHistoryBlobGarbage } from '../src/storage/conversation/history-blob-gc.js'

const { values } = parseArgs({ options: { database: { type: 'string' }, 'cold-dir': { type: 'string', multiple: true },
  apply: { type: 'boolean' }, 'engine-stopped': { type: 'boolean' }, 'minimum-age-days': { type: 'string' },
  'max-line-bytes': { type: 'string' }, help: { type: 'boolean' } } })
if (values.help) {
  console.log('Usage: npx tsx scripts/history-blob-gc.ts --database PATH [--cold-dir PATH ...] [--minimum-age-days 7] [--max-line-bytes 33554432] [--apply --engine-stopped]\nDefault is read-only mark/report. Apply is offline only: stop every engine first. Marks every sessions JSONL/backup, every verified cold archive, maintenance recovery plan and collaboration encoded_row. Unknown/corrupt/unreadable sources refuse the entire sweep. Minimum age cannot be below 7 days. Include every external cold directory with --cold-dir. Never run while another process writes history or archives.')
} else {
  if (!values.database) throw new Error('--database is required')
  if (values.apply && !values['engine-stopped']) throw new Error('GC apply is offline only: close every engine and pass --engine-stopped')
  const database = path.resolve(values.database)
  if (!fs.lstatSync(database).isFile() || fs.lstatSync(database).isSymbolicLink()) throw new Error('Database must be a regular existing file')
  const db = new DatabaseSync(database, { readOnly: !values.apply })
  try {
    db.exec('PRAGMA busy_timeout=2500')
    if (values.apply) db.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE')
    else db.exec('PRAGMA query_only=ON; BEGIN')
    const dataRoot = path.dirname(database)
    const result = await collectHistoryBlobGarbage({ dataRoot,
      database: { all: sql => db.prepare(sql).all(), iterate: sql => db.prepare(sql).iterate() },
      coldRoots: [path.join(dataRoot, 'history-cold'), ...(values['cold-dir'] ?? [])],
      apply: values.apply, engineStopped: values['engine-stopped'],
      ...(values['minimum-age-days'] ? { minimumAgeMs: Number(values['minimum-age-days']) * 86400_000 } : {}),
      ...(values['max-line-bytes'] ? { maxLineBytes: Number(values['max-line-bytes']) } : {}) })
    db.exec('COMMIT')
    console.log(JSON.stringify(result, null, 2))
    if (!result.safeToSweep) process.exitCode = 2
  } finally { db.close() }
}
