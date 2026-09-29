import type { FastifyInstance, FastifyRequest } from 'fastify'
import { commandJobs } from '../../../core/command-jobs/index.js'
import { success, fail } from '../response.js'

const scopeFor = (request: FastifyRequest, sessionId: string) => ({
  tenantId: (request as FastifyRequest & { authContext?: { tenantId?: string } }).authContext?.tenantId ?? 'default',
  sessionId,
})
const validSession = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

/** Jobs can only be launched by the policy-controlled command tool. */
export async function commandJobRoutes(fastify: FastifyInstance) {
  fastify.get<{ Querystring: { sessionId: string } }>('/command-jobs', async (request, reply) => {
    if (!validSession(request.query.sessionId)) return reply.code(400).send(fail(40001, 'sessionId is required'))
    return reply.send(success({ jobs: await commandJobs.list(scopeFor(request, request.query.sessionId)) }))
  })

  fastify.get<{ Params: { jobId: string }; Querystring: { sessionId: string } }>('/command-jobs/:jobId', async (request, reply) => {
    if (!validSession(request.query.sessionId)) return reply.code(400).send(fail(40001, 'sessionId is required'))
    const job = await commandJobs.get(scopeFor(request, request.query.sessionId), request.params.jobId)
    return job ? reply.send(success(job)) : reply.code(404).send(fail(40400, 'Command job not found'))
  })

  fastify.get<{ Params: { jobId: string }; Querystring: { sessionId: string; cursor?: string; maxBytes?: string } }>('/command-jobs/:jobId/output', async (request, reply) => {
    const { sessionId, cursor: rawCursor, maxBytes: rawMaxBytes } = request.query
    if (!validSession(sessionId)) return reply.code(400).send(fail(40001, 'sessionId is required'))
    const cursor = rawCursor === undefined ? 0 : Number(rawCursor)
    const maxBytes = rawMaxBytes === undefined ? undefined : Number(rawMaxBytes)
    if (!Number.isSafeInteger(cursor) || cursor < 0 || (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes <= 0))) {
      return reply.code(400).send(fail(40001, 'cursor and maxBytes must be valid nonnegative/positive integers'))
    }
    const scope = scopeFor(request, sessionId)
    const job = await commandJobs.get(scope, request.params.jobId)
    if (!job) return reply.code(404).send(fail(40400, 'Command job not found'))
    if (cursor > job.cursor) return reply.code(400).send(fail(40001, 'cursor exceeds latest output'))
    try {
      const output = await commandJobs.output(scope, request.params.jobId, { cursor, maxBytes })
      return output ? reply.send(success(output)) : reply.code(404).send(fail(40400, 'Command job not found'))
    } catch (error) {
      if (error instanceof Error && 'statusCode' in error && error.statusCode === 400) {
        return reply.code(400).send(fail(40001, error.message))
      }
      throw error
    }
  })

  fastify.post<{ Params: { jobId: string }; Body: { sessionId: string } }>('/command-jobs/:jobId/cancel', async (request, reply) => {
    if (!validSession(request.body?.sessionId)) return reply.code(400).send(fail(40001, 'sessionId is required'))
    const job = await commandJobs.cancel(scopeFor(request, request.body.sessionId), request.params.jobId, 'Cancelled by user')
    return job ? reply.send(success(job)) : reply.code(404).send(fail(40400, 'Command job not found'))
  })
}
