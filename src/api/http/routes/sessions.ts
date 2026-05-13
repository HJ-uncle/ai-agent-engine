import type { FastifyInstance, FastifyRequest } from 'fastify'
import { SessionStore } from '../../../storage/session/index.js'
import { SQLiteAgentStore } from '../../../storage/agent/index.js'
import { success, fail } from '../response.js'

// ── Helpers ──────────────────────────────────────────────────────────────────
const getTenantId = (req: FastifyRequest) => (req as any).authContext?.tenantId ?? 'default'

export async function sessionRoutes(fastify: FastifyInstance) {
  const sessionStore = new SessionStore()
  const agentStore = new SQLiteAgentStore()

  /**
   * GET /sessions/:sessionId/binding
   *
   * 返回会话的 Agent 绑定信息，供前端判断是否允许切换 Agent：
   * - started: false → 会话尚未开始，可以自由选择 Agent
   * - started: true  → 会话已开始，agentId 已锁定，不允许切换
   */
  fastify.get<{ Params: { sessionId: string } }>('/sessions/:sessionId/binding', async (request, reply) => {
    const { sessionId } = request.params
    const tenantId = getTenantId(request)

    const boundAgentId = await sessionStore.getBoundAgentId(sessionId, tenantId)

    if (boundAgentId === undefined) {
      // sessions 表中无记录 → 会话尚未开始
      return reply.code(200).send(success({
        started: false,
        agentId: null,
        agent: null,
      }))
    }

    // 有记录 → 会话已开始，返回绑定信息
    let agent = null
    if (boundAgentId) {
      try {
        agent = await agentStore.getById(boundAgentId, tenantId)
      } catch {
        // agent 已被删除，返回 null
      }
    }

    return reply.code(200).send(success({
      started: true,
      agentId: boundAgentId,
      agent: agent ? {
        id: agent.id,
        name: agent.name,
        description: agent.description,
      } : null,
    }))
  })

}
