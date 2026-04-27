import type { FastifyInstance } from 'fastify'
import { CronStore } from '../../../storage/cron/index.js'
import { success, fail, paginateArray } from '../response.js'

const store = new CronStore()

export async function cronRoutes(fastify: FastifyInstance) {
  fastify.get<{ Querystring: { current?: number; pageSize?: number } }>(
    '/cron', async (req, reply) => {
      const tenantId = (req as any).authContext?.tenantId ?? 'default'
      const { current, pageSize } = req.query
      const list = await store.list(tenantId)
      return reply.send(paginateArray(list, current, pageSize))
    }
  )

  fastify.post<{ Body: any }>('/cron', async (req, reply) => {
    const tenantId = (req as any).authContext?.tenantId ?? 'default'
    const { name, cronExpr, message, sessionId, agentId, description, enabled } = req.body as any
    if (!name || !cronExpr || !message || !sessionId) {
      return reply.send(fail(40001, 'name, cronExpr, message, sessionId are required'))
    }
    const job = await store.create(tenantId, { name, cronExpr, message, sessionId, agentId, description, enabled })
    return reply.send(success(job))
  })

  fastify.put<{ Params: { id: string }; Body: any }>('/cron/:id', async (req, reply) => {
    const tenantId = (req as any).authContext?.tenantId ?? 'default'
    const updated = await store.update(req.params.id, tenantId, req.body as any)
    if (!updated) return reply.send(fail(40400, 'Cron job not found'))
    return reply.send(success(updated))
  })

  fastify.delete<{ Params: { id: string } }>('/cron/:id', async (req, reply) => {
    const tenantId = (req as any).authContext?.tenantId ?? 'default'
    const deleted = await store.delete(req.params.id, tenantId)
    if (!deleted) return reply.send(fail(40400, 'Cron job not found'))
    return reply.send(success({ deleted: true }))
  })

  // 启用/禁用快捷接口
  fastify.post<{ Params: { id: string } }>('/cron/:id/enable', async (req, reply) => {
    const tenantId = (req as any).authContext?.tenantId ?? 'default'
    const updated = await store.update(req.params.id, tenantId, { enabled: true })
    if (!updated) return reply.send(fail(40400, 'Cron job not found'))
    return reply.send(success(updated))
  })

  fastify.post<{ Params: { id: string } }>('/cron/:id/disable', async (req, reply) => {
    const tenantId = (req as any).authContext?.tenantId ?? 'default'
    const updated = await store.update(req.params.id, tenantId, { enabled: false })
    if (!updated) return reply.send(fail(40400, 'Cron job not found'))
    return reply.send(success(updated))
  })
}
