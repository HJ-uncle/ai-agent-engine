import type { FastifyInstance, FastifyRequest } from 'fastify'
import { SQLiteAgentStore } from '../../../storage/agent/index.js'
import { success, fail, paginateArray } from '../response.js'
import { z } from 'zod'

// ── Validation Schemas ──────────────────────────────────────────────────────
const CreateAgentSchema = z.object({
  name: z.string().min(1, 'name 不能为空'),
  description: z.string().optional(),
  systemPrompt: z.string().optional(),
  model: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  skills: z.array(z.string()).optional().default([]),
  mcpServers: z.array(z.string()).optional().default([]),
  knowledgeBases: z.array(z.string()).optional().default([]),
  allowedTools: z.array(z.string()).optional().default([]),
})

const UpdateAgentSchema = CreateAgentSchema.partial()

// ── Helpers ──────────────────────────────────────────────────────────────────
const getTenantId = (req: FastifyRequest) => (req as any).authContext?.tenantId ?? 'default'

export async function agentRoutes(fastify: FastifyInstance) {
  const store = new SQLiteAgentStore()

  // 创建 Agent
  fastify.post('/agents', async (request, reply) => {
    const tenantId = getTenantId(request)
    
    const result = CreateAgentSchema.safeParse(request.body)
    if (!result.success) {
      const firstError = result.error.errors[0]
      return reply.code(200).send(fail(40001, `参数验证失败：${firstError.message}`))
    }

    try {
      const agent = await store.create(tenantId, result.data)
      return reply.code(200).send(success(agent))
    } catch (err: any) {
      return reply.code(200).send(fail(50000, err.message))
    }
  })

  // 列出所有 Agents
  fastify.get<{ Querystring: { current?: number; pageSize?: number } }>('/agents', async (request, reply) => {
    const tenantId = getTenantId(request)
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
    const tenantId = getTenantId(request)
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
  fastify.put<{ Params: { id: string } }>('/agents/:id', async (request, reply) => {
    const tenantId = getTenantId(request)
    const { id } = request.params
    
    const result = UpdateAgentSchema.safeParse(request.body)
    if (!result.success) {
      const firstError = result.error.errors[0]
      return reply.code(200).send(fail(40001, `参数验证失败：${firstError.message}`))
    }

    try {
      const updated = await store.update(id, tenantId, result.data)
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
    const tenantId = getTenantId(request)
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
