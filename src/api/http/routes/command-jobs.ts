import type { FastifyInstance, FastifyRequest } from 'fastify'
import { commandJobs } from '../../../core/command-jobs/index.js'
import { CommandRestartError, restartStoredCommand } from '../../../tools/cmd/restart-command.js'
import { logger } from '../../../observability/index.js'
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

  fastify.get<{ Params: { jobId: string }; Querystring: { sessionId: string; cursor?: string; cursorOffset?: string; maxBytes?: string; tail?: string } }>('/command-jobs/:jobId/output', async (request, reply) => {
    const { sessionId, cursor: rawCursor, cursorOffset: rawOffset, maxBytes: rawMaxBytes, tail: rawTail } = request.query
    if (!validSession(sessionId)) return reply.code(400).send(fail(40001, 'sessionId is required'))
    if (rawTail !== undefined && rawTail !== 'true' && rawTail !== 'false' || rawTail === 'true' && (rawCursor !== undefined || rawOffset !== undefined)) {
      return reply.code(400).send(fail(40001, 'tail must be true or false; tail=true cannot include cursor or cursorOffset'))
    }
    const cursor = rawCursor === undefined ? 0 : Number(rawCursor)
    const maxBytes = rawMaxBytes === undefined ? undefined : Number(rawMaxBytes)
    const cursorOffset = rawOffset === undefined ? undefined : Number(rawOffset)
    if (!Number.isSafeInteger(cursor) || cursor < 0 || (cursorOffset !== undefined && (!Number.isSafeInteger(cursorOffset) || cursorOffset < 0)) || (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes <= 0))) {
      return reply.code(400).send(fail(40001, 'cursor, cursorOffset and maxBytes must be valid nonnegative/positive integers'))
    }
    const scope = scopeFor(request, sessionId)
    const job = await commandJobs.get(scope, request.params.jobId)
    if (!job) return reply.code(404).send(fail(40400, 'Command job not found'))
    if (cursor > job.cursor) return reply.code(400).send(fail(40001, 'cursor exceeds latest output'))
    try {
      const output = await commandJobs.output(scope, request.params.jobId, { ...(rawTail === 'true' ? { tail: true } : { cursor, cursorOffset }), maxBytes })
      return output ? reply.send(success(output)) : reply.code(404).send(fail(40400, 'Command job not found'))
    } catch (error) {
      if (error instanceof Error && 'statusCode' in error && error.statusCode === 400) {
        return reply.code(400).send(fail(40001, error.message))
      }
      throw error
    }
  })

  fastify.post<{ Params: { jobId: string }; Body: { sessionId: string } }>('/command-jobs/:jobId/restart', async (request, reply) => {
    if (!validSession(request.body?.sessionId)) return reply.code(400).send(fail(40001, 'sessionId is required'))
    const scope = scopeFor(request, request.body.sessionId)
    try {
      const job = await restartStoredCommand({ ...scope, logger: logger.child({ requestId: request.id }) }, request.params.jobId)
      return job ? reply.send(success(job)) : reply.code(404).send(fail(40400, 'Command job not found'))
    } catch (error) {
      if (error instanceof CommandRestartError) {
        return reply.code(error.statusCode).send({ ...fail(error.statusCode === 403 ? 40300 : 40900, error.message),
          metadata: { code: error.code } })
      }
      throw error
    }
  })

  fastify.delete<{ Params: { jobId: string }; Querystring: { sessionId: string } }>('/command-jobs/:jobId', async (request, reply) => {
    if (!validSession(request.query.sessionId)) return reply.code(400).send(fail(40001, 'sessionId is required'))
    try {
      const deleted = await commandJobs.delete(scopeFor(request, request.query.sessionId), request.params.jobId)
      return deleted ? reply.send(success({ deleted: true })) : reply.code(404).send(fail(40400, 'Command job not found'))
    } catch (error) {
      if (error instanceof Error && 'statusCode' in error && error.statusCode === 409) {
        return reply.code(409).send(fail(40900, error.message))
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
