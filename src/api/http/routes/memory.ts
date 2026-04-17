import type { FastifyInstance } from 'fastify'
import { SQLiteMemoryStore } from '../../../storage/memory-store/index.js'

export async function memoryRoutes(fastify: FastifyInstance) {
  const store = new SQLiteMemoryStore()

  fastify.post<{ Body: { key: string; value: string; sessionId: string } }>('/memory/remember', async (request, reply) => {
    const { key, value, sessionId } = request.body
    const tenantId = (request as any).authContext?.tenantId ?? 'default'
    await store.remember(key, value, { tenantId, sessionId })
    return reply.send({ success: true })
  })

  fastify.get<{ Params: { key: string }; Querystring: { sessionId: string } }>(
    '/memory/recall/:key',
    async (request, reply) => {
      const { key } = request.params
      const { sessionId } = request.query
      const tenantId = (request as any).authContext?.tenantId ?? 'default'
      const value = await store.recall(key, { tenantId, sessionId })
      return reply.send({ key, value })
    }
  )

  fastify.get<{ Querystring: { sessionId: string } }>('/memory/list', async (request, reply) => {
    const { sessionId } = request.query
    const tenantId = (request as any).authContext?.tenantId ?? 'default'
    const keys = await store.list({ tenantId, sessionId })
    return reply.send({ keys })
  })
}
