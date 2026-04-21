import type { FastifyInstance } from 'fastify'
import { SQLiteAgentStore, CreateAgentInput, UpdateAgentInput } from '../../../storage/agent/index.js'
import { success, fail, paginateArray } from '../response.js'

export async function agentRoutes(fastify: FastifyInstance) {
  const store = new SQLiteAgentStore()

  // 创建 Agent
  fastify.post<{ Body: CreateAgentInput }>('/agents', async (request, reply) => {
    const tenantId = (request as any).authContext?.tenantId ?? 'default'
    const input = request.body

    if (!input.name) {
      return reply.code(200).send(fail(40001, '参数验证失败：name 不能为空'))
    }

    try {
      const agent = await store.create(tenantId, {
        ...input,
        skills: input.skills ?? [],
        mcpServers: input.mcpServers ?? [],
        knowledgeBases: input.knowledgeBases ?? [],
      })
      return reply.code(200).send(success(agent))
    } catch (err: any) {
      return reply.code(200).send(fail(50000, err.message))
    }
  })

  // 列出所有 Agents
  fastify.get<{ Querystring: { current?: number; pageSize?: number } }>('/agents', async (request, reply) => {
    const tenantId = (request as any).authContext?.tenantId ?? 'default'
    const { current, pageSize } = request.query
    try {
      const agents = await store.list(tenantId)
      return reply.code(200).send(paginateArray(agents, current, pageSize))
    } catch (err: any) {
      return reply.code(200).send(fail(50000, err.message))
    }
  })

  // 获取单个 Agent
  fastify.get<{ Params: { id: string } }>('/agents/:id', async (request, reply) => {
    const tenantId = (request as any).authContext?.tenantId ?? 'default'
    const { id } = request.params

    try {
      const agent = await store.getById(id, tenantId)
      if (!agent) {
        return reply.code(200).send(fail(40400, 'Agent not found'))
      }
      return reply.code(200).send(success(agent))
    } catch (err: any) {
      return reply.code(200).send(fail(50000, err.message))
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
        return reply.code(200).send(fail(40400, 'Agent not found'))
      }
      return reply.code(200).send(success(updated))
    } catch (err: any) {
      return reply.code(200).send(fail(50000, err.message))
    }
  })

  // 删除 Agent
  fastify.delete<{ Params: { id: string } }>('/agents/:id', async (request, reply) => {
    const tenantId = (request as any).authContext?.tenantId ?? 'default'
    const { id } = request.params

    try {
      const deleted = await store.delete(id, tenantId)
      if (!deleted) {
        return reply.code(200).send(fail(40400, 'Agent not found'))
      }
      return reply.code(200).send(success({ id }))
    } catch (err: any) {
      return reply.code(200).send(fail(50000, err.message))
    }
  })
}
