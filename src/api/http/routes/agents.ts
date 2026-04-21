import type { FastifyInstance } from 'fastify'
import { SQLiteAgentStore, CreateAgentInput, UpdateAgentInput } from '../../../storage/agent/index.js'

export async function agentRoutes(fastify: FastifyInstance) {
  const store = new SQLiteAgentStore()

  // 创建 Agent
  fastify.post<{ Body: CreateAgentInput }>('/agents', async (request, reply) => {
    const tenantId = (request as any).authContext?.tenantId ?? 'default'
    const input = request.body

    if (!input.name) {
      return reply.code(400).send({ error: 'name is required' })
    }

    try {
      const agent = await store.create(tenantId, {
        ...input,
        skills: input.skills ?? [],
        mcpServers: input.mcpServers ?? [],
        knowledgeBases: input.knowledgeBases ?? [],
      })
      return reply.code(201).send(agent)
    } catch (err: any) {
      return reply.code(500).send({ error: err.message })
    }
  })

  // 列出所有 Agents
  fastify.get('/agents', async (request, reply) => {
    const tenantId = (request as any).authContext?.tenantId ?? 'default'
    try {
      const agents = await store.list(tenantId)
      return reply.send({ agents })
    } catch (err: any) {
      return reply.code(500).send({ error: err.message })
    }
  })

  // 获取单个 Agent
  fastify.get<{ Params: { id: string } }>('/agents/:id', async (request, reply) => {
    const tenantId = (request as any).authContext?.tenantId ?? 'default'
    const { id } = request.params

    try {
      const agent = await store.getById(id, tenantId)
      if (!agent) {
        return reply.code(404).send({ error: 'Agent not found' })
      }
      return reply.send(agent)
    } catch (err: any) {
      return reply.code(500).send({ error: err.message })
    }
  })

  // 更新 Agent
  fastify.put<{ Params: { id: string }; Body: UpdateAgentInput }>('/agents/:id', async (request, reply) => {
    const tenantId = (request as any).authContext?.tenantId ?? 'default'
    const { id } = request.params
    const input = request.body

    try {
      const updated = await store.update(id, tenantId, input)
      if (!updated) {
        return reply.code(404).send({ error: 'Agent not found' })
      }
      return reply.send(updated)
    } catch (err: any) {
      return reply.code(500).send({ error: err.message })
    }
  })

  // 删除 Agent
  fastify.delete<{ Params: { id: string } }>('/agents/:id', async (request, reply) => {
    const tenantId = (request as any).authContext?.tenantId ?? 'default'
    const { id } = request.params

    try {
      const deleted = await store.delete(id, tenantId)
      if (!deleted) {
        return reply.code(404).send({ error: 'Agent not found' })
      }
      return reply.send({ success: true, id })
    } catch (err: any) {
      return reply.code(500).send({ error: err.message })
    }
  })
}
