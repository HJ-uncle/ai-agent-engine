import type { FastifyInstance } from 'fastify'
import { getMetrics } from '../../../observability/index.js'
import { success } from '../response.js'
import * as fs from 'fs'
import * as path from 'path'

export async function metricsRoutes(fastify: FastifyInstance) {
  fastify.get('/health', async (_request, reply) => {
    return reply.code(200).send(success({ status: 'ok', timestamp: new Date().toISOString() }))
  })

  fastify.get('/metrics', async (request, reply) => {
    const tenantId = (request as any).authContext?.tenantId
    const metrics = await getMetrics(tenantId)
    return reply.type('text/plain').send(metrics)
  })

  // Serve openapi.json dynamically from docs/docs/openapi.json
  fastify.get('/openapi.json', async (_request, reply) => {
    try {
      const docsPath = path.resolve(process.cwd(), 'docs/docs/openapi.json')
      const content = await fs.promises.readFile(docsPath, 'utf-8')
      return reply.type('application/json').send(content)
    } catch (err) {
      return reply.code(404).send({ error: 'openapi.json not found' })
    }
  })
}
