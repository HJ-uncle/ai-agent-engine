import { createHash } from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'
import type { Client, InStatement, Row } from '@libsql/client'

export const AUDIT_PAYLOAD_VERSION = 1
export const AUDIT_INLINE_BYTES = 512
export const AUDIT_BATCH_BYTES = 4 * 1024 * 1024
const fields = ['target', 'details', 'reason'] as const
type EvidenceField = typeof fields[number]
export type AuditEvidence = Record<EvidenceField, string | null>

export function auditDigest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

/** Count and byte bounds both matter: a single deduplicated script may back hundreds of events. */
export function boundedAuditIds(rows: Row[], maxBytes = AUDIT_BATCH_BYTES): number[] {
  const budget = Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : AUDIT_BATCH_BYTES
  const ids: number[] = []
  let bytes = 0
  for (const row of rows) {
    // JSON escaping can expand a byte up to sixfold; include event metadata as well.
    const estimate = Math.max(0, Number(row.evidence_bytes)) * 6 + 2048
    if (ids.length && bytes + estimate > budget) break
    ids.push(Number(row.id)); bytes += estimate
  }
  return ids // A single large event is allowed to advance instead of starving forever.
}

/** Payload inserts and the referencing event must commit in the same transaction. */
export function encodeAuditEvidence(tenantId: string, evidence: AuditEvidence): {
  evidence: AuditEvidence; refs: Record<EvidenceField, string | null>; inserts: InStatement[]
} {
  const inline = { ...evidence }
  const refs: Record<EvidenceField, string | null> = { target: null, details: null, reason: null }
  const inserts: InStatement[] = []
  for (const field of fields) {
    const value = evidence[field]
    if (value === null || Buffer.byteLength(value, 'utf8') < AUDIT_INLINE_BYTES) continue
    const raw = Buffer.from(value, 'utf8')
    const digest = auditDigest(raw)
    const zipped = gzipSync(raw)
    const compressed = zipped.byteLength < raw.byteLength
    inserts.push({
      sql: `INSERT OR IGNORE INTO security_audit_payloads(tenant_id,digest,encoding,content,raw_bytes) VALUES(?,?,?,?,?)`,
      args: [tenantId, digest, compressed ? 'gzip' : 'utf8', compressed ? zipped : raw, raw.byteLength],
    })
    refs[field] = digest
    inline[field] = field === 'target' ? '' : null
  }
  return { evidence: inline, refs, inserts }
}

export const auditEvidenceSelect = fields.map(field =>
  `p_${field}.content AS ${field}_body,p_${field}.encoding AS ${field}_encoding,p_${field}.raw_bytes AS ${field}_bytes`).join(',')
export const auditEvidenceJoins = fields.map(field =>
  `LEFT JOIN security_audit_payloads p_${field} ON p_${field}.tenant_id=a.tenant_id AND p_${field}.digest=a.${field}_ref`).join('\n')

/** Corrupt/missing evidence is an error, never a silently truncated API result. */
export function hydrateAuditEvidence(row: Row): AuditEvidence {
  const evidence = {} as AuditEvidence
  for (const field of fields) {
    const ref = row[`${field}_ref`]
    if (!ref) { evidence[field] = row[field] as string | null; continue }
    const bytes = row[`${field}_body`]
    if (!(bytes instanceof ArrayBuffer) && !ArrayBuffer.isView(bytes)) throw new Error(`Missing audit ${field} evidence: ${ref}`)
    const body = bytes instanceof ArrayBuffer ? Buffer.from(bytes) : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const encoding = row[`${field}_encoding`]
    if (encoding !== 'gzip' && encoding !== 'utf8') throw new Error(`Unknown audit evidence encoding: ${encoding}`)
    const expectedLength = Number(row[`${field}_bytes`])
    const raw = encoding === 'gzip' ? gunzipSync(body, { maxOutputLength: Math.max(1, expectedLength) }) : body
    if (raw.byteLength !== expectedLength || auditDigest(raw) !== ref) throw new Error(`Corrupt audit ${field} evidence: ${ref}`)
    evidence[field] = raw.toString('utf8')
  }
  return evidence
}

/** Bounded, resumable conversion. Already converted rows are never rewritten on startup. */
export async function migrateAuditPayloadBatch(db: Client, batchSize = 250, maxBatchBytes = AUDIT_BATCH_BYTES): Promise<number> {
  const limit = Math.min(500, Math.max(1, Math.floor(batchSize)))
  const tx = await db.transaction('write')
  try {
    const candidates = (await tx.execute({ sql: `SELECT id,
      length(CAST(target AS BLOB))+coalesce(length(CAST(details AS BLOB)),0)+coalesce(length(CAST(reason AS BLOB)),0) AS evidence_bytes
      FROM security_audit_log WHERE payload_version=0 ORDER BY id LIMIT ?`, args: [limit] })).rows
    const ids = boundedAuditIds(candidates, maxBatchBytes)
    const rows = ids.length ? (await tx.execute({ sql: `SELECT id,tenant_id,target,details,reason FROM security_audit_log
      WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id`, args: ids })).rows : []
    const statements: InStatement[] = []
    for (const row of rows) {
      const packed = encodeAuditEvidence(String(row.tenant_id), {
        target: row.target as string, details: row.details as string | null, reason: row.reason as string | null,
      })
      statements.push(...packed.inserts, {
        sql: `UPDATE security_audit_log SET target=?,details=?,reason=?,target_ref=?,details_ref=?,reason_ref=?,payload_version=?
          WHERE id=? AND tenant_id=? AND payload_version=0`,
        args: [packed.evidence.target, packed.evidence.details, packed.evidence.reason,
          packed.refs.target, packed.refs.details, packed.refs.reason, AUDIT_PAYLOAD_VERSION, row.id, row.tenant_id],
      })
    }
    if (statements.length) await tx.batch(statements)
    await tx.commit()
    return rows.length
  } catch (error) { await tx.rollback(); throw error }
  finally { tx.close() }
}
