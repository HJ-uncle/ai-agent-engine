import type { FastifyInstance, FastifyRequest } from 'fastify'
import { getSubagentStore } from '../../../core/subagent/store.js'
import { getSubagentRunner } from '../../../core/subagent/runner.js'
import { success, fail } from '../response.js'
import { DiscoveryRecoveryError, DISCOVERY_PAGE_BYTES } from '../../../core/subagent/discovery.js'

const tenant = (request: FastifyRequest): string =>
  (request as FastifyRequest & { authContext?: { tenantId?: string } }).authContext?.tenantId ?? 'default'

type RunScope = { parentSessionId?: string; rootSessionId?: string }
type ViewQuery = RunScope & { view?: string; atSeq?: string }
type RunParams = { runId: string }

function integer(value: string | undefined, name: string, options: { min?: number; max?: number; required?: boolean } = {}): number | undefined {
  if (value === undefined && !options.required) return undefined
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) throw new RangeError(`${name} must be an integer`)
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < (options.min ?? 0) || result > (options.max ?? Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${name} is outside its supported range`)
  }
  return result
}

function text(value: string | undefined, name: string, maxLength = 4096): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value.length || value.length > maxLength) throw new RangeError(`${name} is invalid`)
  return value
}

function negotiated(value: string | undefined, name: 'view' | 'format'): boolean {
  const modern = name === 'view' ? 'summary' : 'delta'
  // An omitted selector is the explicit v1 compatibility endpoint. Never
  // disguise a bounded page as the old complete-array response.
  if (value === undefined || value === 'legacy') return false
  if (value === modern) return true
  throw new RangeError(`Unsupported subagent ${name}`)
}

function owned(run: { parentSessionId: string; rootSessionId: string } | null, scope: RunScope): boolean {
  return !!run && (!scope.parentSessionId || scope.parentSessionId === run.parentSessionId)
    && (!scope.rootSessionId || scope.rootSessionId === run.rootSessionId)
}

function errorResponse(error: unknown) {
  if (error instanceof RangeError) return fail(40001, error.message)
  if (error instanceof Error && error.message.startsWith('SUBAGENT_RECOVERY_REQUIRED')) {
    return fail(40901, 'Subagent checkpoint required', { checkpointRequired: true })
  }
  throw error
}

export async function subagentRoutes(fastify: FastifyInstance): Promise<void> {
  const store = getSubagentStore()
  fastify.get('/subagent/capabilities', async (_request, reply) => reply.send(success({
    schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'],
    toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true,
    activeDiscovery: true, lifecycleChanges: true, discoveryProtocol: 1,
  })))
  fastify.get<{ Querystring: { parentSessionId: string; rootSessionId?: string; parentConversationId?: string; mode?: string; cursor?: string; afterRevision?: string; limit?: string } }>('/subagent/discovery', async (request, reply) => {
    try {
      const parentSessionId = text(request.query.parentSessionId, 'parentSessionId')
      if (!parentSessionId) throw new RangeError('parentSessionId required')
      const mode = request.query.mode ?? 'active'
      if (mode !== 'active' && mode !== 'changes') throw new RangeError('Unsupported discovery mode')
      const result = await store.listDiscoveryPage(tenant(request), parentSessionId, {
        mode, rootSessionId: text(request.query.rootSessionId, 'rootSessionId'),
        parentConversationId: text(request.query.parentConversationId, 'parentConversationId'),
        cursor: text(request.query.cursor, 'cursor'), afterRevision: integer(request.query.afterRevision, 'afterRevision'),
        limit: integer(request.query.limit, 'limit', { min: 1, max: 200 }),
      })
      const envelope = success(result)
      if (Buffer.byteLength(JSON.stringify(envelope), 'utf8') > DISCOVERY_PAGE_BYTES) throw new DiscoveryRecoveryError('oversized_identity', 'Discovery response exceeds the complete-envelope budget')
      return reply.send(envelope)
    } catch (error) {
      if (error instanceof RangeError) return reply.code(400).send(fail(40001, error.message))
      if (error instanceof DiscoveryRecoveryError) return reply.code(409).send(fail(40901, error.message, { discoveryRequired: true, reason: error.reason }))
      throw error
    }
  })
  fastify.get<{ Querystring: { parentSessionId: string; view?: string; cursor?: string; limit?: string } }>('/subagent/runs', async (request, reply) => {
    try {
      const parentSessionId = text(request.query.parentSessionId, 'parentSessionId')
      if (!parentSessionId) return reply.send(fail(40001, 'parentSessionId required'))
      if (!negotiated(request.query.view, 'view')) {
        if (request.query.cursor !== undefined || request.query.limit !== undefined) throw new RangeError('Paging requires view=summary')
        return reply.send(success(await store.listRunsForParent(tenant(request), parentSessionId)))
      }
      const result = await store.listRunViewsPage(tenant(request), parentSessionId, {
        cursor: text(request.query.cursor, 'cursor'),
        limit: integer(request.query.limit, 'limit', { min: 1, max: 200 }),
      })
      return reply.send(success(result))
    } catch (error) { return reply.send(errorResponse(error)) }
  })

  fastify.get<{ Params: RunParams; Querystring: ViewQuery }>('/subagent/runs/:runId', async (request, reply) => {
    try {
      const modern = negotiated(request.query.view, 'view')
      const atSeq = integer(request.query.atSeq, 'atSeq', { min: 1 })
      if (!modern && atSeq !== undefined) throw new RangeError('atSeq requires view=summary')
      if (modern && atSeq !== undefined) {
        const current = await store.getRunView(tenant(request), request.params.runId)
        if (!owned(current, request.query)) return reply.send(fail(40400, 'Subagent run not found'))
        const historical = await store.getRunView(tenant(request), request.params.runId, { atSeq })
        return reply.send(historical ? success(historical) : fail(40901, 'Subagent checkpoint required', { checkpointRequired: true }))
      }
      const run = modern
        ? await store.getRunView(tenant(request), request.params.runId)
        : await store.getRun(tenant(request), request.params.runId)
      return reply.send(owned(run, request.query) ? success(run) : fail(40400, 'Subagent run not found'))
    } catch (error) { return reply.send(errorResponse(error)) }
  })

  fastify.get<{ Params: RunParams; Querystring: RunScope & { atSeq?: string; cursor?: string; limit?: string } }>('/subagent/runs/:runId/tools', async (request, reply) => {
    try {
      const atSeq = integer(request.query.atSeq, 'atSeq', { min: 1, required: true })!
      const current = await store.getRunView(tenant(request), request.params.runId)
      if (!owned(current, request.query)) return reply.send(fail(40400, 'Subagent run not found'))
      const page = await store.listToolsPage(tenant(request), request.params.runId, {
        atSeq, cursor: text(request.query.cursor, 'cursor'),
        limit: integer(request.query.limit, 'limit', { min: 1, max: 200 }),
      })
      return reply.send(page ? success(page) : fail(40901, 'Subagent checkpoint required', { checkpointRequired: true }))
    } catch (error) { return reply.send(errorResponse(error)) }
  })

  fastify.get<{ Params: RunParams & { toolCallId: string }; Querystring: RunScope & { atSeq?: string; offset?: string; limitBytes?: string } }>('/subagent/runs/:runId/tools/:toolCallId', async (request, reply) => {
    try {
      const atSeq = integer(request.query.atSeq, 'atSeq', { min: 1, required: true })!
      const current = await store.getRunView(tenant(request), request.params.runId)
      if (!owned(current, request.query)) return reply.send(fail(40400, 'Subagent run not found'))
      const historical = await store.getRunView(tenant(request), request.params.runId, { atSeq })
      if (!historical) return reply.send(fail(40901, 'Subagent checkpoint required', { checkpointRequired: true }))
      const detail = await store.getToolDetail(tenant(request), request.params.runId, request.params.toolCallId, {
        atSeq, offset: integer(request.query.offset, 'offset'),
        limitBytes: integer(request.query.limitBytes, 'limitBytes', { min: 4, max: 128 * 1024 }),
      })
      return reply.send(detail ? success(detail) : fail(40400, 'Subagent tool not found'))
    } catch (error) { return reply.send(errorResponse(error)) }
  })

  fastify.get<{ Params: RunParams; Querystring: RunScope & { afterSeq?: string; format?: string; limit?: string } }>('/subagent/runs/:runId/events', async (request, reply) => {
    try {
      const modern = negotiated(request.query.format, 'format')
      const afterSeq = modern ? integer(request.query.afterSeq, 'afterSeq') ?? 0 : Math.max(0, Number(request.query.afterSeq) || 0)
      const run = modern
        ? await store.getRunView(tenant(request), request.params.runId)
        : await store.getRun(tenant(request), request.params.runId)
      if (!owned(run, request.query)) return reply.send(fail(40400, 'Subagent run not found'))
      if (!modern) {
        if (request.query.limit !== undefined) throw new RangeError('Paging requires format=delta')
        return reply.send(success(await store.listEvents(tenant(request), request.params.runId, afterSeq)))
      }
      const page = await store.listEventsPage(tenant(request), request.params.runId, {
        afterSeq, limit: integer(request.query.limit, 'limit', { min: 1, max: 200 }),
      })
      return reply.send(page ? success(page) : fail(40901, 'Subagent checkpoint required', { checkpointRequired: true }))
    } catch (error) { return reply.send(errorResponse(error)) }
  })

  fastify.post<{ Params: RunParams; Querystring: ViewQuery }>('/subagent/runs/:runId/cancel', async (request, reply) => {
    try {
      const modern = negotiated(request.query.view, 'view')
      if (request.query.atSeq !== undefined) throw new RangeError('Cancellation cannot use a historical watermark')
      // Check the caller's source before any mutation, including when a stale
      // session supplies a run ID that is valid elsewhere in the same tenant.
      const current = await store.getRunView(tenant(request), request.params.runId)
      if (!owned(current, request.query)) return reply.send(fail(40400, 'Subagent run not found'))
      const cancelled = await getSubagentRunner().cancel(tenant(request), request.params.runId)
      if (!cancelled) return reply.send(fail(40400, 'Subagent run not found'))
      const result = modern ? await store.getRunView(tenant(request), request.params.runId) : await store.getRun(tenant(request), request.params.runId)
      return reply.send(result ? success(result) : fail(40400, 'Subagent run not found'))
    } catch (error) { return reply.send(errorResponse(error)) }
  })
}
