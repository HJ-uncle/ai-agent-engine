import { getDb } from '../storage/sqlite/db.js'
import type { Client, InStatement, Row } from '@libsql/client'
import { AUDIT_BATCH_BYTES, AUDIT_PAYLOAD_VERSION, auditEvidenceJoins, auditEvidenceSelect, boundedAuditIds, encodeAuditEvidence, hydrateAuditEvidence, migrateAuditPayloadBatch } from './audit-payloads.js'
import { defaultAuditArchiveDirectory, readAuditArchive, writeAuditArchive, type AuditArchiveReceipt } from './audit-archive.js'

export type AuditCategory = 'cmd' | 'network' | 'fs' | 'lsp'
export type AuditDecision = 'allow' | 'ask' | 'deny' | 'error'

export interface AuditEntry {
  id?: number
  tenantId?: string
  sessionId?: string | null
  category: AuditCategory
  target: string
  details?: unknown
  decision: AuditDecision
  ruleId?: number | null
  reason?: string
  createdAt?: number
}

export interface AuditQuery {
  tenantId?: string
  category?: AuditCategory
  decision?: AuditDecision
  limit?: number
  offset?: number
  /** unix 秒，返回该时间之后的记录 */
  since?: number
}

export interface AuditRetentionPolicy { allowDays: number; importantDays: number }
export interface AuditArchiveOptions {
  tenantId: string; actor?: string; batchSize?: number; maxBatches?: number; maxBatchBytes?: number; signal?: AbortSignal
}
export interface AuditArchiveInfo extends Omit<AuditArchiveReceipt, 'relativePath'> { actor: string; createdAt: number }
const evidenceRows = `SELECT a.*,${auditEvidenceSelect} FROM security_audit_log a ${auditEvidenceJoins}`
const maintenanceLocks = new WeakMap<Client, Promise<unknown>>()

async function serializeMaintenance<T>(db: Client, operation: () => Promise<T>): Promise<T> {
  const previous = maintenanceLocks.get(db) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(operation)
  maintenanceLocks.set(db, next)
  try { return await next }
  finally { if (maintenanceLocks.get(db) === next) maintenanceLocks.delete(db) }
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  return Number.isSafeInteger(value) && value! > 0 ? Math.min(value!, maximum) : fallback
}

function entryStatement(entry: AuditEntry): InStatement[] {
  const tenantId = entry.tenantId ?? 'default'
  const packed = encodeAuditEvidence(tenantId, { target: entry.target,
    details: entry.details === undefined ? null : JSON.stringify(entry.details) ?? null, reason: entry.reason ?? null })
  return [...packed.inserts, {
    sql: `INSERT INTO security_audit_log
      (tenant_id,session_id,category,target,details,decision,rule_id,reason,target_ref,details_ref,reason_ref,payload_version)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [tenantId, entry.sessionId ?? null, entry.category, packed.evidence.target, packed.evidence.details,
      entry.decision, entry.ruleId ?? null, packed.evidence.reason, packed.refs.target, packed.refs.details, packed.refs.reason, AUDIT_PAYLOAD_VERSION],
  }]
}

/**
 * 安全审计日志：所有安全相关决策都要留痕。
 * - 命令执行通过/拒绝
 * - 网络访问通过/拒绝
 * - LSP 扫描结果（按需）
 *
 * 写入必须容错，不能阻塞业务；读取提供分页检索。
 */
export class AuditLogStore {
  constructor(private readonly database: () => Client = getDb, private readonly archiveDirectory: () => string = defaultAuditArchiveDirectory) {}

  async append(entry: AuditEntry): Promise<void> {
    try {
      const db = this.database()
      // The event and any new evidence become visible together; every evaluation still inserts an event.
      await db.batch(entryStatement(entry), 'write')
    } catch (e) {
      // 审计失败不能阻塞主流程
      // eslint-disable-next-line no-console
      console.warn('[AuditLog] append failed:', (e as Error).message)
    }
  }

  async query(q: AuditQuery = {}): Promise<{ list: AuditEntry[]; total: number }> {
    const db = this.database()
    const where: string[] = []
    const args: Array<string | number> = []
    if (q.tenantId !== undefined) { where.push('a.tenant_id = ?'); args.push(q.tenantId) }
    if (q.category) { where.push('a.category = ?'); args.push(q.category) }
    if (q.decision) { where.push('a.decision = ?'); args.push(q.decision) }
    if (q.since)    { where.push('a.created_at >= ?'); args.push(q.since) }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''

    const countRes = await db.execute({
      sql: `SELECT COUNT(*) AS c FROM security_audit_log a ${whereSql}`,
      args,
    })
    const total = Number(countRes.rows[0]?.c ?? 0)

    const limit = boundedInteger(q.limit, 50, 500)
    const offset = Number.isSafeInteger(q.offset) && q.offset! > 0 ? q.offset! : 0
    const listRes = await db.execute({
      sql: `${evidenceRows} ${whereSql}
            ORDER BY a.created_at DESC, a.id DESC
            LIMIT ? OFFSET ?`,
      args: [...args, limit, offset],
    })

    const list: AuditEntry[] = listRes.rows.map(r => {
      const evidence = hydrateAuditEvidence(r)
      return {
        id: Number(r.id),
        tenantId: r.tenant_id as string,
        sessionId: r.session_id as string | null,
        category: r.category as AuditCategory,
        target: evidence.target!,
        details: evidence.details ? safeParse(evidence.details) : null,
        decision: r.decision as AuditDecision,
        ruleId: r.rule_id != null ? Number(r.rule_id) : null,
        reason: evidence.reason ?? '',
        createdAt: Number(r.created_at),
      }
    })
    return { list, total }
  }

  /** Compatibility API: remove online rows only after durable archive, scoped to one tenant. */
  async purgeOlderThan(days: number, options: AuditArchiveOptions = { tenantId: 'default' }): Promise<number> {
    if (!Number.isSafeInteger(days) || days < 1) throw new Error('Audit retention days must be a positive integer')
    if (!options.tenantId) throw new Error('Audit cleanup requires a tenant')
    const db = this.database(), cutoff = Math.floor(Date.now() / 1000) - days * 86400
    return serializeMaintenance(db, () => this.archiveMatching(db, 'a.tenant_id=? AND a.created_at<?',
      [options.tenantId, cutoff], options))
  }

  /** One bounded pass; this is an instance-owned lifecycle operation, never an unscoped HTTP deletion. */
  async maintain(policy: AuditRetentionPolicy, options: Omit<AuditArchiveOptions, 'tenantId'> = {}): Promise<{ migrated: number; archived: number; hasBacklog: boolean }> {
    if (![policy.allowDays, policy.importantDays].every(days => Number.isSafeInteger(days) && days >= 0)) throw new Error('Invalid audit retention policy')
    const db = this.database()
    return serializeMaintenance(db, async () => {
      const batchSize = boundedInteger(options.batchSize, 250, 500), maxBatches = boundedInteger(options.maxBatches, 4, 100)
      let migrated = 0
      for (let batch = 0; batch < maxBatches && !options.signal?.aborted; batch++) {
        const count = await migrateAuditPayloadBatch(db, batchSize, options.maxBatchBytes ?? AUDIT_BATCH_BYTES)
        migrated += count
        if (count < batchSize) break
      }
      const now = Math.floor(Date.now() / 1000), clauses: string[] = [], args: number[] = []
      const important = `(a.decision<>'allow' OR a.target IN ('security-mode-change','security-audit-archive'))`
      if (policy.allowDays > 0) { clauses.push(`(NOT ${important} AND a.created_at<?)`); args.push(now - policy.allowDays * 86400) }
      if (policy.importantDays > 0) { clauses.push(`(${important} AND a.created_at<?)`); args.push(now - policy.importantDays * 86400) }
      const archived = clauses.length && !options.signal?.aborted
        ? await this.archiveMatching(db, `(${clauses.join(' OR ')})`, args, { ...options, batchSize, maxBatches, actor: 'system:retention' }) : 0
      const pendingMigration = !options.signal?.aborted && (await db.execute('SELECT 1 FROM security_audit_log WHERE payload_version=0 LIMIT 1')).rows.length > 0
      const pendingArchive = clauses.length > 0 && !options.signal?.aborted &&
        (await db.execute({ sql: `SELECT 1 FROM security_audit_log a WHERE ${clauses.join(' OR ')} LIMIT 1`, args })).rows.length > 0
      return { migrated, archived, hasBacklog: Boolean(pendingMigration || pendingArchive) }
    })
  }

  async listArchives(tenantId: string, limit = 50, offset = 0): Promise<{ list: AuditArchiveInfo[]; total: number }> {
    const db = this.database()
    const total = Number((await db.execute({ sql: 'SELECT count(*) AS c FROM security_audit_archives WHERE tenant_id=?', args: [tenantId] })).rows[0].c)
    const rows = (await db.execute({ sql: `SELECT * FROM security_audit_archives WHERE tenant_id=? ORDER BY created_at DESC,archive_id DESC LIMIT ? OFFSET ?`,
      args: [tenantId, boundedInteger(limit, 50, 500), Number.isSafeInteger(offset) && offset > 0 ? offset : 0] })).rows
    return { total, list: rows.map(row => ({
      tenantId, archiveId: String(row.archive_id), eventCount: Number(row.event_count),
      firstId: Number(row.first_id), lastId: Number(row.last_id), firstAt: Number(row.first_at), lastAt: Number(row.last_at),
      compressedBytes: Number(row.compressed_bytes), actor: String(row.actor), createdAt: Number(row.created_at),
    })) }
  }

  async readArchive(tenantId: string, archiveId: string): Promise<Buffer | undefined> {
    const row = (await this.database().execute({ sql: 'SELECT * FROM security_audit_archives WHERE tenant_id=? AND archive_id=?', args: [tenantId, archiveId] })).rows[0]
    if (!row) return undefined
    return readAuditArchive(this.archiveDirectory(), { archiveId, relativePath: String(row.relative_path), compressedBytes: Number(row.compressed_bytes) })
  }

  private async archiveMatching(db: Client, where: string, args: Array<string | number>, options: Omit<AuditArchiveOptions, 'tenantId'>): Promise<number> {
    const limit = boundedInteger(options.batchSize, 250, 500), maxBatches = boundedInteger(options.maxBatches, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)
    let removed = 0
    for (let batch = 0; batch < maxBatches && !options.signal?.aborted; batch++) {
      const first = (await db.execute({ sql: `SELECT a.tenant_id FROM security_audit_log a WHERE ${where} ORDER BY a.id LIMIT 1`, args })).rows[0]
      if (!first) break
      const tenantId = String(first.tenant_id)
      const candidates = (await db.execute({ sql: `SELECT a.id,
        coalesce(p_target.raw_bytes,length(CAST(a.target AS BLOB)),0)+coalesce(p_details.raw_bytes,length(CAST(a.details AS BLOB)),0)+
        coalesce(p_reason.raw_bytes,length(CAST(a.reason AS BLOB)),0) AS evidence_bytes
        FROM security_audit_log a ${auditEvidenceJoins} WHERE (${where}) AND a.tenant_id=? ORDER BY a.id LIMIT ?`,
        args: [...args, tenantId, limit] })).rows
      const ids = boundedAuditIds(candidates, options.maxBatchBytes)
      const rows = ids.length ? (await db.execute({ sql: `${evidenceRows} WHERE a.tenant_id=? AND a.id IN (${ids.map(() => '?').join(',')}) ORDER BY a.id`,
        args: [tenantId, ...ids] })).rows : []
      if (!rows.length || options.signal?.aborted) break
      const receipt = await writeAuditArchive(this.archiveDirectory(), tenantId, rows)
      // Once publishing begins, finish the matching receipt transaction before shutdown. A crash before COMMIT leaves all online rows intact.
      removed += await this.commitArchive(db, rows, receipt, options.actor ?? 'system:manual')
    }
    return removed
  }

  private async commitArchive(db: Client, rows: Row[], receipt: AuditArchiveReceipt, actor: string): Promise<number> {
    const tx = await db.transaction('write')
    try {
      await tx.execute({ sql: `INSERT OR IGNORE INTO security_audit_archives
        (tenant_id,archive_id,relative_path,event_count,first_id,last_id,first_at,last_at,compressed_bytes,actor) VALUES(?,?,?,?,?,?,?,?,?,?)`,
        args: [receipt.tenantId, receipt.archiveId, receipt.relativePath, receipt.eventCount, receipt.firstId, receipt.lastId,
          receipt.firstAt, receipt.lastAt, receipt.compressedBytes, actor] })
      const deleted = await tx.execute({ sql: `DELETE FROM security_audit_log WHERE tenant_id=? AND id IN (${rows.map(() => '?').join(',')})`,
        args: [receipt.tenantId, ...rows.map(row => row.id)] })
      const refs = [...new Set(rows.flatMap(row => [row.target_ref, row.details_ref, row.reason_ref]).filter((value): value is string => typeof value === 'string'))]
      if (refs.length) await tx.execute({ sql: `DELETE FROM security_audit_payloads WHERE tenant_id=? AND digest IN (${refs.map(() => '?').join(',')})
        AND NOT EXISTS(SELECT 1 FROM security_audit_log WHERE tenant_id=security_audit_payloads.tenant_id AND target_ref=security_audit_payloads.digest)
        AND NOT EXISTS(SELECT 1 FROM security_audit_log WHERE tenant_id=security_audit_payloads.tenant_id AND details_ref=security_audit_payloads.digest)
        AND NOT EXISTS(SELECT 1 FROM security_audit_log WHERE tenant_id=security_audit_payloads.tenant_id AND reason_ref=security_audit_payloads.digest)`,
        args: [receipt.tenantId, ...refs] })
      if (deleted.rowsAffected) await tx.batch(entryStatement({ tenantId: receipt.tenantId, category: 'fs', decision: 'allow', target: 'security-audit-archive',
        reason: '审计事件已持久归档，移出在线表', details: { archiveId: receipt.archiveId, eventCount: deleted.rowsAffected, actor } }))
      await tx.commit()
      return deleted.rowsAffected
    } catch (error) { await tx.rollback(); throw error }
    finally { tx.close() }
  }
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s) } catch { return s }
}

export const auditLogStore = new AuditLogStore()
