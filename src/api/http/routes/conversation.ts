import type { FastifyInstance } from 'fastify'
import { SQLiteConversationHistory } from '../../../storage/conversation/index.js'

export async function conversationRoutes(fastify: FastifyInstance) {
  const history = new SQLiteConversationHistory()

  fastify.get<{ Querystring: { sessionId: string } }>('/conversation/history', async (request, reply) => {
    const { sessionId } = request.query
    const tenantId = (request as any).authContext?.tenantId ?? 'default'
    const messages = await history.getHistory({ tenantId, sessionId })
    return reply.send({ messages })
  })

  fastify.delete<{ Querystring: { sessionId: string } }>('/conversation/history', async (request, reply) => {
    const { sessionId } = request.query
    const tenantId = (request as any).authContext?.tenantId ?? 'default'
    await history.clear({ tenantId, sessionId })
    return reply.send({ success: true })
  })
}
