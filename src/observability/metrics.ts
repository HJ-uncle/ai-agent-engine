import { getDb } from '../storage/sqlite/db.js'

export interface TokenUsage {
  tenantId: string
  promptTokens: number
  completionTokens: number
}

export interface ToolMetric {
  tenantId: string
  sessionId: string
  toolName: string
  durationMs: number
  success: boolean
}

export async function recordTokenUsage(usage: TokenUsage): Promise<void> {
  const db = getDb()
  const date = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
  const total = usage.promptTokens + usage.completionTokens

  await db.execute({
    sql: `INSERT INTO quotas (tenant_id, date, tokens_used, requests_count)
          VALUES (?, ?, ?, 1)
          ON CONFLICT(tenant_id, date) DO UPDATE SET
            tokens_used = tokens_used + excluded.tokens_used,
            requests_count = requests_count + 1`,
    args: [usage.tenantId, date, total],
  })
}

export async function recordToolCall(metric: ToolMetric): Promise<void> {
  const db = getDb()
  await db.execute({
    sql: `INSERT INTO tool_metrics (tenant_id, session_id, tool_name, duration_ms, success)
          VALUES (?, ?, ?, ?, ?)`,
    args: [metric.tenantId, metric.sessionId, metric.toolName, metric.durationMs, metric.success ? 1 : 0],
  })
}

export async function getMetrics(tenantId?: string): Promise<{
  totalRequests: number
  totalTokens: number
  toolCallStats: Array<{ toolName: string; avgDurationMs: number; count: number; successRate: number }>
}> {
  const db = getDb()

  const quotaResult = await db.execute({
    sql: tenantId
      ? 'SELECT SUM(tokens_used) as tokens, SUM(requests_count) as reqs FROM quotas WHERE tenant_id = ?'
      : 'SELECT SUM(tokens_used) as tokens, SUM(requests_count) as reqs FROM quotas',
    args: tenantId ? [tenantId] : [],
  })
  const quotaRow = quotaResult.rows[0]
  const totalTokens = quotaRow ? Number(quotaRow['tokens'] ?? 0) : 0
  const totalRequests = quotaRow ? Number(quotaRow['reqs'] ?? 0) : 0

  const toolResult = await db.execute({
    sql: `SELECT 
            tool_name,
            COUNT(*) as count,
            AVG(duration_ms) as avg_duration,
            AVG(success) as success_rate
          FROM tool_metrics
          ${tenantId ? 'WHERE tenant_id = ?' : ''}
          GROUP BY tool_name
          ORDER BY count DESC`,
    args: tenantId ? [tenantId] : [],
  })

  return {
    totalRequests,
    totalTokens,
    toolCallStats: toolResult.rows.map((r) => ({
      toolName: r['tool_name'] as string,
      avgDurationMs: Math.round(Number(r['avg_duration'])),
      count: Number(r['count']),
      successRate: Math.round(Number(r['success_rate']) * 100) / 100,
    })),
  }
}
