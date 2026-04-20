import type { FastifyInstance } from 'fastify'
import { SQLiteConversationHistory } from '../../../storage/conversation/index.js'

export async function conversationRoutes(fastify: FastifyInstance) {
  const history = new SQLiteConversationHistory()

  // GET /conversation/history?sessionId=xxx  — 查询 session 的所有历史消息
  fastify.get<{ Querystring: { sessionId: string } }>('/conversation/history', async (request, reply) => {
    const { sessionId } = request.query
    const tenantId = (request as any).authContext?.tenantId ?? 'default'
    const messages = await history.getHistory({ tenantId, sessionId })
    return reply.send({ messages })
  })

  // DELETE /conversation/history?sessionId=xxx  — 清空 session 历史
  fastify.delete<{ Querystring: { sessionId: string } }>('/conversation/history', async (request, reply) => {
    const { sessionId } = request.query
    const tenantId = (request as any).authContext?.tenantId ?? 'default'
    await history.clear({ tenantId, sessionId })
    return reply.send({ success: true })
  })

  // GET /conversations/:conversationId  — 按 conversationId 查询单轮对话消息
  fastify.get<{ Params: { conversationId: string } }>('/conversations/:conversationId', async (request, reply) => {
    const { conversationId } = request.params
    const tenantId = (request as any).authContext?.tenantId ?? 'default'

    if (!conversationId) {
      return reply.code(400).send({ error: 'conversationId is required' })
    }

    const messages = await history.getByConversationId(conversationId, tenantId)

    if (messages.length === 0) {
      return reply.code(404).send({ error: `Conversation "${conversationId}" not found` })
    }

    return reply.send({
      conversationId,
      messageCount: messages.length,
      messages,
    })
  })
}
