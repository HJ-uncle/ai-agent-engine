import { getDb } from '../storage/sqlite/db.js'

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

/**
 * 安全审计日志：所有安全相关决策都要留痕。
 * - 命令执行通过/拒绝
 * - 网络访问通过/拒绝
 * - LSP 扫描结果（按需）
 *
 * 写入必须容错，不能阻塞业务；读取提供分页检索。
 */
export class AuditLogStore {
  async append(entry: AuditEntry): Promise<void> {
    try {
      const db = getDb()
      await db.execute({
        sql: `INSERT INTO security_audit_log
                (tenant_id, session_id, category, target, details, decision, rule_id, reason)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          entry.tenantId ?? 'default',
          entry.sessionId ?? null,
          entry.category,
          entry.target,
          entry.details === undefined ? null : JSON.stringify(entry.details),
          entry.decision,
          entry.ruleId ?? null,
          entry.reason ?? null,
        ],
      })
    } catch (e) {
      // 审计失败不能阻塞主流程
      // eslint-disable-next-line no-console
      console.warn('[AuditLog] append failed:', (e as Error).message)
    }
  }

  async query(q: AuditQuery = {}): Promise<{ list: AuditEntry[]; total: number }> {
    const db = getDb()
    const where: string[] = []
    const args: any[] = []
    if (q.tenantId) { where.push('tenant_id = ?'); args.push(q.tenantId) }
    if (q.category) { where.push('category = ?'); args.push(q.category) }
    if (q.decision) { where.push('decision = ?'); args.push(q.decision) }
    if (q.since)    { where.push('created_at >= ?'); args.push(q.since) }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''

    const countRes = await db.execute({
      sql: `SELECT COUNT(*) AS c FROM security_audit_log ${whereSql}`,
      args,
    })
    const total = Number(countRes.rows[0]?.c ?? 0)

    const limit  = Math.min(Math.max(q.limit ?? 50, 1), 500)
    const offset = Math.max(q.offset ?? 0, 0)
    const listRes = await db.execute({
      sql: `SELECT id, tenant_id, session_id, category, target, details, decision, rule_id, reason, created_at
            FROM security_audit_log ${whereSql}
            ORDER BY created_at DESC, id DESC
            LIMIT ? OFFSET ?`,
      args: [...args, limit, offset],
    })

    const list: AuditEntry[] = listRes.rows.map((r: any) => ({
      id: Number(r.id),
      tenantId: r.tenant_id as string,
      sessionId: r.session_id as string | null,
      category: r.category as AuditCategory,
      target: r.target as string,
      details: r.details ? safeParse(r.details as string) : null,
      decision: r.decision as AuditDecision,
      ruleId: r.rule_id != null ? Number(r.rule_id) : null,
      reason: (r.reason as string) ?? '',
      createdAt: Number(r.created_at),
    }))
    return { list, total }
  }

  /** 清理 N 天前的审计记录（可选定期任务调用） */
  async purgeOlderThan(days: number): Promise<number> {
    const cutoff = Math.floor(Date.now() / 1000) - days * 86400
    const db = getDb()
    const res = await db.execute({
      sql: 'DELETE FROM security_audit_log WHERE created_at < ?',
      args: [cutoff],
    })
    return Number((res as any).rowsAffected ?? 0)
  }
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s) } catch { return s }
}

export const auditLogStore = new AuditLogStore()
