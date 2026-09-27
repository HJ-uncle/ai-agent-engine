import type { FastifyInstance } from 'fastify'
import { success } from '../response.js'
import { getDbStats, getDb } from '../../../storage/sqlite/db.js'
import { getGlobalToolPool, setGlobalToolPoolLimit } from '../../../core/utils/concurrency-pool.js'

export async function performanceRoutes(fastify: FastifyInstance) {
  fastify.get('/performance/stats', async (_request, reply) => {
    const dbPragmas = await getDbStats()
    const pool = getGlobalToolPool()

    // 最近 24h 工具执行统计（平均耗时 / 成功率 / 调用次数）
    const db = getDb()
    let toolStats: Array<{ tool: string; count: number; avgMs: number; successRate: number }> = []
    try {
      const res = await db.execute(`
        SELECT tool_name       AS tool,
               COUNT(*)        AS count,
               AVG(duration_ms) AS avg_ms,
               AVG(success)    AS success_rate
        FROM tool_metrics
        WHERE created_at >= unixepoch() - 86400
        GROUP BY tool_name
        ORDER BY count DESC
        LIMIT 50
      `)
      toolStats = res.rows.map((r: any) => ({
        tool: r.tool as string,
        count: Number(r.count),
        avgMs: Math.round(Number(r.avg_ms) || 0),
        successRate: Math.round((Number(r.success_rate) || 0) * 100) / 100,
      }))
    } catch { /* 表可能尚未写入数据，忽略 */ }

    return reply.code(200).send(success({
      sqlite: dbPragmas,
      toolPool: { size: pool.size, active: pool.active, pending: pool.pending },
      toolStats,
    }))
  })

  // 动态调整工具并发池大小（立即生效，不持久化；持久化通过 /settings 的 TOOL_CONCURRENCY_LIMIT）
  fastify.post<{ Body: { limit: number } }>('/performance/tool-pool', async (request, reply) => {
    const limit = Math.max(1, Math.min(64, parseInt(String(request.body?.limit ?? 8), 10)))
    setGlobalToolPoolLimit(limit)
    return reply.code(200).send(success({ limit }))
  })
}
