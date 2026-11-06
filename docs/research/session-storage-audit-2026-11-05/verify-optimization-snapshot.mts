/** Read-only source backup; all changes occur in an explicit disposable fixture directory. */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { DatabaseSync, backup } from 'node:sqlite'
import { LocalSqliteProcessClient } from '../../../src/storage/sqlite/local-process-client.js'
import { up } from '../../../src/storage/sqlite/migrations/031_security_audit_payloads.js'
import { compactTerminalHistoryMaintenance, getHistoryMaintenanceStorageStats } from '../../../src/core/collaboration/history-maintenance-storage.js'
import { AuditLogStore } from '../../../src/security/audit-log.js'
import { auditEvidenceJoins, auditEvidenceSelect, hydrateAuditEvidence } from '../../../src/security/audit-payloads.js'

const [sourceName, reportName] = process.argv.slice(2)
if (!sourceName || !reportName) throw new Error('Usage: tsx verify-optimization-snapshot.mts SOURCE_DB REPORT_JSON')
const source = path.resolve(sourceName), report = path.resolve(reportName)
const parent = path.resolve('.e2e-tmp'), fixture = path.join(parent, 'storage-snapshot-' + crypto.randomUUID())
fs.mkdirSync(fixture, { recursive: true })
const destination = path.join(fixture, 'agent.db')
const input = new DatabaseSync(source, { readOnly: true })
try { await backup(input, destination) } finally { input.close() }
const db = new LocalSqliteProcessClient({ url: 'file:' + destination.replaceAll('\\', '/') })
let verified = false
const stats = async () => {
  const pages = async (key: string) => Number(Object.values((await db.execute('PRAGMA ' + key)).rows[0])[0])
  return { fileBytes: fs.statSync(destination).size, pageCount: await pages('page_count'), freePages: await pages('freelist_count'), pageSize: await pages('page_size'),
    tables: (await db.execute(`SELECT s.tbl_name AS name, SUM(d.pgsize) AS bytes FROM dbstat d JOIN sqlite_schema s ON s.name=d.name GROUP BY s.tbl_name ORDER BY bytes DESC LIMIT 12`)).rows,
    maintenance: await getHistoryMaintenanceStorageStats(db) }
}
const evidenceDigest = async (packed: boolean) => {
  const hash = crypto.createHash('sha256'); let after = 0, count = 0
  while (true) {
    const rows = (await db.execute({ sql: packed ? `SELECT a.*,${auditEvidenceSelect} FROM security_audit_log a ${auditEvidenceJoins} WHERE a.id>? ORDER BY a.id LIMIT 500`
      : 'SELECT * FROM security_audit_log WHERE id>? ORDER BY id LIMIT 500', args: [after] })).rows
    if (!rows.length) break
    for (const row of rows) {
      const evidence = packed ? hydrateAuditEvidence(row) : { target: row.target, details: row.details, reason: row.reason }
      hash.update(JSON.stringify([row.id, row.tenant_id, row.session_id, row.category, row.decision, row.created_at, row.rule_id, evidence.target, evidence.details, evidence.reason]) + '\n')
      after = Number(row.id); count++
    }
  }
  return { count, sha256: hash.digest('hex') }
}
try {
  const started = Date.now(), before = await stats(), evidenceBefore = await evidenceDigest(false)
  let afterId: string | undefined, hasMore = true, compacted = 0, skippedCorrupt = 0
  while (hasMore) {
    const batch = await compactTerminalHistoryMaintenance(db, { afterId })
    afterId = batch.afterId; hasMore = batch.hasMore; compacted += batch.compacted; skippedCorrupt += batch.skippedCorrupt
  }
  await up(db)
  const store = new AuditLogStore(() => db, () => path.join(fixture, 'audit-archive'))
  let migrated = 0
  do { const result = await store.maintain({ allowDays: 0, importantDays: 0 }); migrated += result.migrated; hasMore = result.hasBacklog } while (hasMore)
  const evidenceAfter = await evidenceDigest(true)
  if (JSON.stringify(evidenceBefore) !== JSON.stringify(evidenceAfter)) throw new Error('Audit evidence changed during snapshot migration')
  const logicalAfter = await stats()
  await db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
  await db.execute('VACUUM')
  await db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
  const afterVacuum = await stats()
  const integrity = (await db.execute('PRAGMA integrity_check')).rows
  if (String(Object.values(integrity[0])[0]) !== 'ok') throw new Error('Snapshot integrity check failed')
  fs.writeFileSync(report, JSON.stringify({ measuredAt: new Date().toISOString(), mode: 'isolated-backup-only', source, fixture, before, logicalAfter, afterVacuum,
    compacted, skippedCorrupt, migrated, evidenceBefore, evidenceAfter, integrity, durationMs: Date.now() - started }, null, 2) + '\n')
  console.log(JSON.stringify({ report, beforeBytes: before.fileBytes, afterBytes: afterVacuum.fileBytes, compacted, skippedCorrupt, migrated,
    auditEvidenceUnchanged: true, durationMs: Date.now() - started }))
  verified = true
} finally {
  db.close(); await db.whenClosed()
  if (verified) {
    if (path.dirname(fixture) !== parent || !path.basename(fixture).startsWith('storage-snapshot-')) throw new Error('Unsafe fixture cleanup')
    fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 5 })
    const receipt = JSON.parse(fs.readFileSync(report, 'utf8')); receipt.fixtureRemoved = true
    fs.writeFileSync(report, JSON.stringify(receipt, null, 2) + '\n')
  }
}
