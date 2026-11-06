import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { DatabaseSync } from 'node:sqlite'
import type { Client, InStatement } from '@libsql/client'
import { LocalSqliteProcessClient } from '../src/storage/sqlite/local-process-client.js'
import { compactTerminalHistoryMaintenance, getHistoryMaintenanceStorageStats } from '../src/core/collaboration/history-maintenance-storage.js'

const { values } = parseArgs({ options: {
  database: { type: 'string' }, apply: { type: 'boolean' }, all: { type: 'boolean' },
  vacuum: { type: 'boolean' }, 'engine-stopped': { type: 'boolean' },
  'max-rows': { type: 'string' }, 'batch-size': { type: 'string' }, 'max-payload-bytes': { type: 'string' }, help: { type: 'boolean' },
} })
if (values.help) {
  console.log('Usage: npx tsx scripts/maintain-session-storage.ts --database PATH [--apply] [--all] [--max-rows 128] [--batch-size 16] [--max-payload-bytes 8388608]\nDefault is read-only statistics. --apply compacts terminal receipts only. --vacuum requires --apply --engine-stopped: shut down EVERY engine instance first; VACUUM takes an exclusive maintenance lock and may need a full database copy worth of free disk.')
} else {
  if (!values.database) throw new Error('--database is required; no implicit production database is opened')
  if ((values.all || values.vacuum) && !values.apply) throw new Error('--all and --vacuum require --apply')
  if (values.vacuum && !values['engine-stopped']) throw new Error('VACUUM is offline only: close every engine instance and pass --engine-stopped')
  const database = path.resolve(values.database)
  if (!fs.statSync(database).isFile()) throw new Error('Database must already exist as a regular file')
  if (!values.apply) {
    const native = new DatabaseSync(database, { readOnly: true })
    try {
      native.exec('PRAGMA query_only=ON; BEGIN')
      // Adapter is deliberately SELECT-only and backed by a native read-only connection.
      const readonlyClient = { execute: async (statement: InStatement) => {
        const sql = typeof statement === 'string' ? statement : statement.sql
        if (!/^SELECT\b/i.test(sql.trim())) throw new Error('Dry-run permits only SELECT')
        return { rows: native.prepare(sql).all() }
      } } as unknown as Client
      console.log(JSON.stringify({ mode: 'dry-run', database, stats: await getHistoryMaintenanceStorageStats(readonlyClient) }, null, 2))
    } finally { native.close() }
  } else {
    const db = new LocalSqliteProcessClient({ url: 'file:' + database.replaceAll('\\', '/') })
    try {
      const before = await getHistoryMaintenanceStorageStats(db)
      let afterId: string | undefined, more: boolean
      do {
        const result = await compactTerminalHistoryMaintenance(db, { afterId,
          ...(values['max-rows'] ? { maxRows: Number(values['max-rows']) } : {}),
          ...(values['batch-size'] ? { batchSize: Number(values['batch-size']) } : {}),
          ...(values['max-payload-bytes'] ? { maxPayloadBytes: Number(values['max-payload-bytes']) } : {}) })
        console.log(JSON.stringify({ mode: 'apply-batch', ...result })); afterId = result.afterId; more = result.hasMore
      } while (values.all && more)
      if (values.vacuum) {
        await db.execute('PRAGMA locking_mode=EXCLUSIVE')
        await db.execute('BEGIN EXCLUSIVE'); await db.execute('COMMIT')
        const checkpoint = (await db.execute('PRAGMA wal_checkpoint(TRUNCATE)')).rows[0]
        if (checkpoint && Number(checkpoint.busy) !== 0) throw new Error('Database is busy; offline VACUUM was refused')
        await db.execute('VACUUM')
      }
      console.log(JSON.stringify({ mode: 'applied', before, after: await getHistoryMaintenanceStorageStats(db), vacuum: !!values.vacuum }, null, 2))
    } finally { db.close(); await db.whenClosed() }
  }
}
