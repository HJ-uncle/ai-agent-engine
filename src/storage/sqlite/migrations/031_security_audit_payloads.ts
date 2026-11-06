import type { Client } from '@libsql/client'

/** Keep every decision, but store repeated large evidence once per tenant. */
export async function up(db: Client): Promise<void> {
  const columns = new Set((await db.execute('PRAGMA table_info(security_audit_log)')).rows.map(row => row.name))
  for (const column of ['target_ref', 'details_ref', 'reason_ref']) {
    if (!columns.has(column)) await db.execute(`ALTER TABLE security_audit_log ADD COLUMN ${column} TEXT`)
  }
  if (!columns.has('payload_version')) {
    await db.execute('ALTER TABLE security_audit_log ADD COLUMN payload_version INTEGER NOT NULL DEFAULT 0')
  }
  await db.execute(`CREATE TABLE IF NOT EXISTS security_audit_payloads (
    tenant_id TEXT NOT NULL, digest TEXT NOT NULL,
    encoding TEXT NOT NULL CHECK(encoding IN ('utf8','gzip')),
    content BLOB NOT NULL, raw_bytes INTEGER NOT NULL,
    PRIMARY KEY(tenant_id, digest)
  )`)
  // This partial index shrinks to empty after the resumable background conversion.
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_audit_payload_pending
    ON security_audit_log(id) WHERE payload_version=0`)
  for (const column of ['target_ref', 'details_ref', 'reason_ref']) {
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_audit_${column}
      ON security_audit_log(tenant_id, ${column}) WHERE ${column} IS NOT NULL`)
  }
  await db.execute(`CREATE TABLE IF NOT EXISTS security_audit_archives (
    tenant_id TEXT NOT NULL, archive_id TEXT NOT NULL, relative_path TEXT NOT NULL,
    event_count INTEGER NOT NULL, first_id INTEGER NOT NULL, last_id INTEGER NOT NULL,
    first_at INTEGER NOT NULL, last_at INTEGER NOT NULL, compressed_bytes INTEGER NOT NULL,
    actor TEXT NOT NULL DEFAULT 'system',
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY(tenant_id, archive_id)
  )`)
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_audit_archives_time
    ON security_audit_archives(tenant_id, created_at DESC)`)
}
