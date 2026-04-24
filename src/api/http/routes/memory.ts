import type { FastifyInstance } from 'fastify'
import { SQLiteMemoryStore } from '../../../storage/memory-store/index.js'
import { success, fail, paginateArray } from '../response.js'

export async function memoryRoutes(fastify: FastifyInstance) {
  const store = new SQLiteMemoryStore()

  fastify.post<{ Body: { key: string; value: string; sessionId: string } }>('/memory/remember', async (request, reply) => {
    const { key, value, sessionId } = request.body
    const tenantId = (request as any).authContext?.tenantId ?? 'default'
    await store.remember(key, value, { tenantId, sessionId })
    return reply.code(200).send(success({ success: true }))
  })

  fastify.get<{ Params: { key: string }; Querystring: { sessionId: string } }>(
    '/memory/recall/:key',
    async (request, reply) => {
      const { key } = request.params
      const { sessionId } = request.query
      const tenantId = (request as any).authContext?.tenantId ?? 'default'
      const value = await store.recall(key, { tenantId, sessionId })
      return reply.code(200).send(success({ key, value }))
    }
  )

  fastify.get<{ Querystring: { sessionId?: string; current?: number; pageSize?: number } }>('/memory/list', async (request, reply) => {
    const { sessionId, current, pageSize } = request.query
    const tenantId = (request as any).authContext?.tenantId ?? 'default'
    const items = await store.list({ tenantId, sessionId })
    return reply.code(200).send(paginateArray(items, current, pageSize))
  })

  fastify.delete<{ Params: { id: string } }>('/memory/:id', async (request, reply) => {
    const { id } = request.params
    const tenantId = (request as any).authContext?.tenantId ?? 'default'
    // since we don't have deleteById on interface, we can just run sql
    const db = (await import('../../../storage/sqlite/db.js')).getDb()
    await db.execute({
      sql: 'DELETE FROM memories WHERE id = ? AND tenant_id = ?',
      args: [id, tenantId]
    })
    return reply.code(200).send(success({ success: true }))
  })
}
