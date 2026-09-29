import type { FastifyInstance, FastifyRequest } from 'fastify'
import { getSubagentStore } from '../../../core/subagent/store.js'
import { getSubagentRunner } from '../../../core/subagent/runner.js'
import { success, fail } from '../response.js'

const tenant = (request: FastifyRequest): string =>
  (request as FastifyRequest & { authContext?: { tenantId?: string } }).authContext?.tenantId ?? 'default'

export async function subagentRoutes(fastify: FastifyInstance): Promise<void> {
  const store = getSubagentStore()
  fastify.get<{ Querystring: { parentSessionId: string } }>('/subagent/runs', async (request, reply) => {
    if (!request.query.parentSessionId) return reply.send(fail(40001, 'parentSessionId required'))
    return reply.send(success(await store.listRunsForParent(tenant(request), request.query.parentSessionId)))
  })
  fastify.get<{ Params: { runId: string } }>('/subagent/runs/:runId', async (request, reply) => {
    const run = await store.getRun(tenant(request), request.params.runId)
    return reply.send(run ? success(run) : fail(40400, 'Subagent run not found'))
  })
  fastify.get<{ Params: { runId: string }; Querystring: { afterSeq?: string } }>('/subagent/runs/:runId/events', async (request, reply) => {
    const run = await store.getRun(tenant(request), request.params.runId)
    if (!run) return reply.send(fail(40400, 'Subagent run not found'))
    const afterSeq = Math.max(0, Number(request.query.afterSeq) || 0)
    return reply.send(success(await store.listEvents(tenant(request), run.runId, afterSeq)))
  })
  fastify.post<{ Params: { runId: string } }>('/subagent/runs/:runId/cancel', async (request, reply) => {
    const run = await getSubagentRunner().cancel(tenant(request), request.params.runId)
    return reply.send(run ? success(run) : fail(40400, 'Subagent run not found'))
  })
}
