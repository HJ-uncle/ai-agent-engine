import type { FastifyInstance, FastifyRequest } from 'fastify'
import { SQLiteMemoryManager } from '../../../storage/memory/memory-manager.js'
import { getMemoryDb } from '../../../storage/memory/db.js'
import { success, fail, paginateArray } from '../response.js'
import { MemoryConsolidator } from '../../../storage/memory/consolidation.js'

import crypto from 'crypto'

const manager = new SQLiteMemoryManager()

// ── Helpers ──────────────────────────────────────────────────────────────────
const getTenantId = (req: FastifyRequest) => (req as any).authContext?.tenantId ?? 'default'

export async function memoryRoutes(fastify: FastifyInstance) {

  fastify.post<{ Body: { key: string; value: string; sessionId: string } }>('/memory/remember', async (request, reply) => {
    const { key, value, sessionId } = request.body
    const tenantId = getTenantId(request)

    const node = await manager.createNode(
      {
        type: 'fact',
        summary: `${key}: ${value}`,
        importance: 0.7,
        sourceSessionId: sessionId,
        tags: ['memory_remember', key],
      },
      { tenantId, sessionId },
    )

    return reply.code(200).send(success({ success: true, id: node.id }))
  })

  fastify.get<{ Params: { key: string }; Querystring: { sessionId: string } }>(
    '/memory/recall/:key',
    async (request, reply) => {
      const { key } = request.params
      const { sessionId } = request.query
      const tenantId = getTenantId(request)
      
      const nodes = await manager.recallByTags([key], { tenantId, sessionId })
      const value = nodes.length > 0 ? nodes[0].summary.replace(`${key}: `, '') : null

      return reply.code(200).send(success({ key, value }))
    }
  )

  fastify.get<{ Querystring: { sessionId?: string; current?: number; pageSize?: number } }>('/memory/list', async (request, reply) => {
    const { sessionId, current, pageSize } = request.query
    const tenantId = getTenantId(request)
    
    const nodes = await manager.listNodes({ sessionId, orderBy: 'timestamp', orderDir: 'DESC', limit: 1000 }, { tenantId, sessionId: sessionId ?? '' })
    const items = nodes.map(n => ({
      id: n.id,
      key: n.type, // 将新的类型作为分类标题
      value: n.summary, // 将完整的摘要显示出来
      updated_at: n.updatedAt
    }))
    
    return reply.code(200).send(paginateArray(items, current, pageSize))
  })

  fastify.get<{ Querystring: { sessionId?: string } }>('/memory/graph', async (request, reply) => {
    const { sessionId } = request.query
    const tenantId = getTenantId(request)
    
    // 获取所有的节点
    const nodes = await manager.listNodes({ sessionId, limit: 1000 }, { tenantId, sessionId: sessionId ?? '' })
    
    // 我们也需要边 (edges) 数据，因为我们需要展示关系图谱
    const db = (manager as any).db || getMemoryDb()
    let edges: any[] = []
    
    try {
      let sql = 'SELECT * FROM memory_edges WHERE tenant_id = ?'
      let args = [tenantId]
      
      if (sessionId) {
        // 如果指定了 sessionId，我们只查询涉及到属于该 session 节点的边
        sql += ` AND (source_node_id IN (SELECT id FROM memory_nodes WHERE source_session_id = ?) 
                  OR target_node_id IN (SELECT id FROM memory_nodes WHERE source_session_id = ?))`
        args.push(sessionId, sessionId)
      }
      
      const result = await db.execute({ sql, args })
      edges = result.rows.map((row: any) => ({
        id: row.id,
        source: row.source_node_id,
        target: row.target_node_id,
        type: row.type,
        strength: row.strength,
        description: row.description
      }))
    } catch (e) {
      console.error('获取记忆图谱边失败:', e)
    }

    return reply.code(200).send(success({
      nodes: nodes.map(n => ({
        id: n.id,
        name: n.type, // UI 显示的主标题
        type: n.type,
        summary: n.summary,
        tags: n.tags,
        strength: n.strength
      })),
      edges
    }))
  })

  fastify.delete<{ Params: { id: string } }>('/memory/:id', async (request, reply) => {
    const { id } = request.params
    const tenantId = getTenantId(request)
    
    await manager.deleteNode(id, { tenantId, sessionId: '' })
    return reply.code(200).send(success({ success: true }))
  })

  // 新增：编辑记忆节点
  fastify.put<{ Params: { id: string }, Body: { summary: string, type?: string, importance?: number } }>('/memory/:id', async (request, reply) => {
    const { id } = request.params
    const { summary, type, importance } = request.body
    const tenantId = getTenantId(request)
    const db = (manager as any).db || getMemoryDb()
    
    const updates: string[] = []
    const args: any[] = []
    
    if (summary !== undefined) { updates.push('summary = ?'); args.push(summary) }
    if (type !== undefined) { updates.push('type = ?'); args.push(type) }
    if (importance !== undefined) { updates.push('importance = ?'); args.push(importance) }
    
    if (updates.length > 0) {
      updates.push('updated_at = unixepoch()')
      args.push(id, tenantId)
      await db.execute({
        sql: `UPDATE memory_nodes SET ${updates.join(', ')} WHERE id = ? AND tenant_id = ?`,
        args
      })
    }
    
    return reply.code(200).send(success({ success: true }))
  })

  // 新增：手动建立关联 (Link)
  fastify.post<{ Body: { sourceId: string, targetId: string, type: string, description: string } }>('/memory/link', async (request, reply) => {
    const { sourceId, targetId, type, description } = request.body
    const tenantId = getTenantId(request)
    const db = (manager as any).db || getMemoryDb()
    const id = 'EDGE-' + crypto.randomUUID()
    
    await db.execute({
      sql: `INSERT INTO memory_edges (id, tenant_id, source_node_id, target_node_id, type, strength, description) 
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [id, tenantId, sourceId, targetId, type, 0.8, description || '用户手动关联']
    })
    
    return reply.code(200).send(success({ success: true, id }))
  })

  // 新增：手动触发反思整理 (Consolidation) 与衰减模拟
  fastify.post('/memory/consolidate', async (request, reply) => {
    const tenantId = getTenantId(request)
    const consolidator = new MemoryConsolidator()
    
    // 执行衰减
    await consolidator.runConsolidation(tenantId)
    
    // 查询被筛选出的“待遗忘清单”
    const threshold = parseFloat(process.env.MEMORY_DECAY_THRESHOLD || '0.05')
    const safeThreshold = isNaN(threshold) ? 0.05 : threshold
    const db = getMemoryDb()
    const weakNodes = await db.execute({
      sql: `SELECT id, summary, strength FROM memory_nodes WHERE tenant_id = ? AND strength <= ? AND type NOT IN ('preference', 'decision')`,
      args: [tenantId, safeThreshold]
    })
    
    return reply.code(200).send(success({ 
      success: true, 
      message: '记忆衰减与整理已完成',
      forgottenCandidates: weakNodes.rows.map(r => ({ id: r.id, summary: r.summary, strength: r.strength }))
    }))
  })
}
