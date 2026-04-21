import type { FastifyInstance } from 'fastify'
import { SQLiteConversationHistory } from '../../../storage/conversation/index.js'
import { success, fail, paginateArray } from '../response.js'

export async function conversationRoutes(fastify: FastifyInstance) {
  const history = new SQLiteConversationHistory()

  // GET /conversation/sessions  — 列出该租户下所有有对话记录的 session
  fastify.get<{ Querystring: { current?: number; pageSize?: number } }>('/conversation/sessions', async (request, reply) => {
    const tenantId = (request as any).authContext?.tenantId ?? 'default'
    const { current, pageSize } = request.query
    const sessions = await history.listSessions(tenantId)
    return reply.code(200).send(paginateArray(sessions, current, pageSize))
  })

  // GET /conversation/history?sessionId=xxx  — 查询 session 的所有历史消息
  fastify.get<{ Querystring: { sessionId: string; current?: number; pageSize?: number } }>('/conversation/history', async (request, reply) => {
    const { sessionId, current, pageSize } = request.query
    const tenantId = (request as any).authContext?.tenantId ?? 'default'
    if (!sessionId) {
      return reply.code(200).send(fail(40001, '参数验证失败：sessionId 不能为空'))
    }
    const messages = await history.getHistory({ tenantId, sessionId })
    return reply.code(200).send(paginateArray(messages, current, pageSize))
  })

  // DELETE /conversation/history?sessionId=xxx  — 清空 session 历史
  fastify.delete<{ Querystring: { sessionId: string } }>('/conversation/history', async (request, reply) => {
    const { sessionId } = request.query
    const tenantId = (request as any).authContext?.tenantId ?? 'default'
    if (!sessionId) {
      return reply.code(200).send(fail(40001, '参数验证失败：sessionId 不能为空'))
    }
    await history.clear({ tenantId, sessionId })
    return reply.code(200).send(success({ success: true }))
  })

  // DELETE /sessions/:sessionId  — 删除整个 session (硬删除)
  fastify.delete<{ Params: { sessionId: string } }>('/sessions/:sessionId', async (request, reply) => {
    const { sessionId } = request.params
    const tenantId = (request as any).authContext?.tenantId ?? 'default'
    
    if (!sessionId) {
      return reply.code(200).send(fail(40001, '参数验证失败：sessionId 不能为空'))
    }

    await history.clear({ tenantId, sessionId })
    return reply.code(200).send(success({ success: true, sessionId }))
  })

  // GET /conversations/:conversationId  — 按 conversationId 查询单轮对话消息
  fastify.get<{ Params: { conversationId: string }, Querystring: { current?: number; pageSize?: number } }>('/conversations/:conversationId', async (request, reply) => {
    const { conversationId } = request.params
    const { current, pageSize } = request.query
    const tenantId = (request as any).authContext?.tenantId ?? 'default'

    if (!conversationId) {
      return reply.code(200).send(fail(40001, '参数验证失败：conversationId 不能为空'))
    }

    const messages = await history.getByConversationId(conversationId, tenantId)

    if (messages.length === 0) {
      return reply.code(200).send(fail(40400, `Conversation "${conversationId}" not found`))
    }

    // if paginated, the data wrapper is the array, but here we want to return the whole object maybe?
    // According to requirements: list + pagination is standard. So we can just paginate messages.
    // Or we can just return success({ conversationId, messageCount: messages.length, messages }) if not paginated.
    // Let's just return paginateArray(messages, current, pageSize) for standard list response.
    // Or we can construct a custom paginated response. But standard says data is array for list.
    // To preserve the payload structure, we can just return the messages array.
    return reply.code(200).send(paginateArray(messages, current, pageSize))
  })
}
