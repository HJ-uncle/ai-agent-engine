import type { FastifyInstance } from 'fastify'
import { TodoStore } from '../../../storage/todo/index.js'
import { success, fail, paginateArray } from '../response.js'

const store = new TodoStore()

export async function todoRoutes(fastify: FastifyInstance) {
  fastify.get<{ Querystring: { sessionId?: string; status?: string; current?: number; pageSize?: number } }>(
    '/todos', async (req, reply) => {
      const tenantId = (req as any).authContext?.tenantId ?? 'default'
      const { sessionId, status, current, pageSize } = req.query
      let list = await store.list(tenantId, sessionId)
      if (status) list = list.filter(t => t.status === status)
      return reply.send(paginateArray(list, current, pageSize))
    }
  )

  fastify.post<{ Body: any }>('/todos', async (req, reply) => {
    const tenantId = (req as any).authContext?.tenantId ?? 'default'
    const body = req.body as any
    const { title, description, priority, dueAt, sessionId } = body
    if (!title) return reply.send(fail(40001, 'title is required'))
    const todo = await store.create(tenantId, {
      title, description, priority, sessionId,
      dueAt: dueAt ? new Date(dueAt).getTime() : undefined,
    })
    return reply.send(success(todo))
  })

  fastify.put<{ Params: { id: string }; Body: any }>('/todos/:id', async (req, reply) => {
    const tenantId = (req as any).authContext?.tenantId ?? 'default'
    const { title, description, priority, status, dueAt } = req.body as any
    const updated = await store.update(req.params.id, tenantId, {
      title, description, priority, status,
      dueAt: dueAt ? new Date(dueAt).getTime() : undefined,
    })
    if (!updated) return reply.send(fail(40400, 'Todo not found'))
    return reply.send(success(updated))
  })

  fastify.delete<{ Params: { id: string } }>('/todos/:id', async (req, reply) => {
    const tenantId = (req as any).authContext?.tenantId ?? 'default'
    const deleted = await store.delete(req.params.id, tenantId)
    if (!deleted) return reply.send(fail(40400, 'Todo not found'))
    return reply.send(success({ deleted: true }))
  })
}
