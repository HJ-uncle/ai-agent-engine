import type { FastifyInstance, FastifyRequest } from 'fastify'
import { TodoStore } from '../../../storage/todo/index.js'
import { success, fail, paginateArray } from '../response.js'
import { z } from 'zod'

const store = new TodoStore()

// ── Validation Schemas ──────────────────────────────────────────────────────
const CreateTodoSchema = z.object({
  title: z.string().min(1, 'title 不能为空'),
  description: z.string().optional(),
  priority: z.enum(['low', 'medium', 'high']).optional().default('medium'),
  dueAt: z.union([z.string(), z.number()]).optional(),
  sessionId: z.string().optional(),
})

const UpdateTodoSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  priority: z.enum(['low', 'medium', 'high']).optional(),
  status: z.enum(['pending', 'in_progress', 'done', 'cancelled']).optional(),
  dueAt: z.union([z.string(), z.number()]).optional(),
})

// ── Helpers ──────────────────────────────────────────────────────────────────
const getTenantId = (req: FastifyRequest) => (req as any).authContext?.tenantId ?? 'default'

export async function todoRoutes(fastify: FastifyInstance) {
  fastify.get<{ Querystring: { sessionId?: string; status?: string; current?: number; pageSize?: number } }>(
    '/todos', async (req, reply) => {
      const tenantId = getTenantId(req)
      const { sessionId, status, current, pageSize } = req.query
      let list = await store.list(tenantId, sessionId)
      if (status) list = list.filter(t => t.status === status)
      return reply.send(paginateArray(list, current, pageSize))
    }
  )

  fastify.post('/todos', async (req, reply) => {
    const tenantId = getTenantId(req)
    
    const result = CreateTodoSchema.safeParse(req.body)
    if (!result.success) {
      const firstError = result.error.errors[0]
      return reply.code(200).send(fail(40001, `参数验证失败：${firstError.message}`))
    }

    const { title, description, priority, dueAt, sessionId } = result.data
    const todo = await store.create(tenantId, {
      title, description, priority, sessionId,
      dueAt: dueAt ? new Date(dueAt).getTime() : undefined,
    })
    return reply.send(success(todo))
  })

  fastify.put<{ Params: { id: string } }>('/todos/:id', async (req, reply) => {
    const tenantId = getTenantId(req)
    
    const result = UpdateTodoSchema.safeParse(req.body)
    if (!result.success) {
      const firstError = result.error.errors[0]
      return reply.code(200).send(fail(40001, `参数验证失败：${firstError.message}`))
    }

    const { title, description, priority, status, dueAt } = result.data
    const updated = await store.update(req.params.id, tenantId, {
      title, description, priority, status,
      dueAt: dueAt ? new Date(dueAt).getTime() : undefined,
    })
    if (!updated) return reply.send(fail(40400, 'Todo not found'))
    return reply.send(success(updated))
  })

  fastify.delete<{ Params: { id: string } }>('/todos/:id', async (req, reply) => {
    const tenantId = getTenantId(req)
    const deleted = await store.delete(req.params.id, tenantId)
    if (!deleted) return reply.send(fail(40400, 'Todo not found'))
    return reply.send(success({ deleted: true }))
  })
}
