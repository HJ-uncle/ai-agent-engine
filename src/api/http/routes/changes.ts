import type { FastifyInstance, FastifyRequest } from 'fastify'
import { ChangeStore, type ChangeStatus, type RevertBatchInput } from '../../../storage/changes/index.js'
import { success, fail } from '../response.js'

const store = new ChangeStore()
const getTenantId = (req: FastifyRequest): string =>
  (req as FastifyRequest & { authContext?: { tenantId: string } }).authContext?.tenantId ?? 'default'

/** Complete scopes and file version checks live on the server, shared by all callers. */
export async function changeRoutes(fastify: FastifyInstance) {
  fastify.get<{ Querystring: { sessionId: string; status?: ChangeStatus; createdAfter?: number } }>('/changes', {
    schema: { querystring: { type: 'object', required: ['sessionId'], properties: {
      sessionId: { type: 'string', minLength: 1 }, status: { type: 'string', enum: ['pending', 'kept', 'reverted'] }, createdAfter: { type: 'number' }
    } } }
  }, async (req, reply) => reply.send(success(await store.list(getTenantId(req), req.query.sessionId, req.query.status, req.query.createdAfter))))

  fastify.post<{ Body: RevertBatchInput }>('/changes/revert-batch', {
    schema: { body: { type: 'object', required: ['sessionId'], additionalProperties: false, properties: {
      sessionId: { type: 'string', minLength: 1 },
      ids: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
      createdAfter: { type: 'number' }, scope: { type: 'string', enum: ['pending', 'all'] }, fromTurnId: { type: 'string', minLength: 1 }
    } } }
  }, async (req, reply) => reply.send(success(await store.revertBatch(getTenantId(req), req.body))))

  fastify.post<{ Params: { id: string } }>('/changes/:id/keep', async (req, reply) => {
    const updated = await store.markStatus(req.params.id, getTenantId(req), 'kept')
    if (!updated) return reply.send(fail(40400, 'Change not found'))
    if (updated.status === 'reverted') return reply.send(fail(40901, '已撤回的改动不能重新保留'))
    return reply.send(success(updated))
  })

  // Preserve the old success(FileChange) envelope, but run the same guarded batch path.
  fastify.post<{ Params: { id: string } }>('/changes/:id/revert', async (req, reply) => {
    const tenantId = getTenantId(req)
    const change = await store.getById(req.params.id, tenantId)
    if (!change) return reply.send(fail(40400, 'Change not found'))
    const batch = await store.revertBatch(tenantId, { sessionId: change.sessionId, ids: [change.id] })
    const result = batch.results[0]
    if (result.status === 'reverted' || result.status === 'already_reverted') return reply.send(success(await store.getById(change.id, tenantId)))
    const code = result.status === 'conflict' ? 40901 : result.status === 'unavailable' ? 40002 : 50000
    return reply.send(fail(code, result.message ?? '无法撤回改动'))
  })

  fastify.post<{ Body: { sessionId?: string } }>('/changes/keep-all', async (req, reply) => {
    const { sessionId } = req.body ?? {}
    if (!sessionId) return reply.send(fail(40001, 'sessionId 不能为空'))
    return reply.send(success({ kept: await store.keepAll(getTenantId(req), sessionId) }))
  })

  fastify.post<{ Body: { sessionId?: string; ids?: string[] } }>('/changes/keep-many', async (req, reply) => {
    const tenantId = getTenantId(req)
    const { ids, sessionId } = req.body ?? {}
    if (!Array.isArray(ids) || ids.length === 0 || ids.some(id => typeof id !== 'string' || !id)) return reply.send(fail(40001, 'ids 不能为空'))
    let kept = 0
    for (const id of new Set(ids)) {
      const existing = await store.getById(id, tenantId)
      if (!existing || (sessionId !== undefined && existing.sessionId !== sessionId)) continue
      const updated = await store.markStatus(id, tenantId, 'kept')
      if (updated?.status === 'kept') kept++
    }
    return reply.send(success({ kept }))
  })
}
