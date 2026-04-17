import type { FastifyInstance } from 'fastify'
import { getMetrics } from '../../../observability/index.js'

export async function metricsRoutes(fastify: FastifyInstance) {
  fastify.get('/health', async (_request, reply) => {
    return reply.send({ status: 'ok', timestamp: new Date().toISOString() })
  })

  fastify.get('/metrics', async (request, reply) => {
    const tenantId = (request as any).authContext?.tenantId
    const metrics = await getMetrics(tenantId)
    return reply.send(metrics)
  })
}
