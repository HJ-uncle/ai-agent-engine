import type { FastifyInstance, FastifyRequest } from 'fastify'
import { SQLiteTaskQueue } from '../../../storage/task-queue/index.js'
import { success, fail, paginateArray } from '../response.js'

// ── Helpers ──────────────────────────────────────────────────────────────────
const getTenantId = (req: FastifyRequest) => (req as FastifyRequest & { authContext?: { tenantId?: string } }).authContext?.tenantId ?? 'default'

export async function taskRoutes(fastify: FastifyInstance) {
  // The HTTP instance owns its poller. Module-level timers survive server.close()
  // and keep embedded/imported runtimes alive after their transport has stopped.
  const taskQueue = new SQLiteTaskQueue()
  fastify.addHook('onReady', async () => { taskQueue.start() })
  fastify.addHook('onClose', async () => { await taskQueue.stop() })
  fastify.post<{ Body: { type: string; payload: Record<string, unknown> } }>('/tasks', async (request, reply) => {
    const body = request.body
    if (!body || typeof body.type !== 'string' || !body.type.trim() || body.type.length > 128 || !body.payload || typeof body.payload !== 'object' || Array.isArray(body.payload))
      return reply.code(400).send(fail(40001, 'A task type and object payload are required'))
    const { type, payload } = body
    if (!taskQueue.supportedTypes().includes(type))
      return reply.code(501).send(fail(50100, 'This background task type has no registered executor'))
    const tenantId = getTenantId(request)
    const jobId = await taskQueue.enqueue({ type, payload, tenantId })
    return reply.code(200).send(success({ jobId }))
  })

  fastify.get<{ Querystring: { current?: number; pageSize?: number } }>('/tasks', async (request, reply) => {
    const tenantId = getTenantId(request)
    const list = await taskQueue.list(tenantId)
    const { current, pageSize } = request.query
    return reply.code(200).send(paginateArray(list, current, pageSize))
  })

  fastify.get<{ Params: { jobId: string } }>('/tasks/:jobId', async (request, reply) => {
    const { jobId } = request.params
    const job = await taskQueue.getStatus(jobId, getTenantId(request))
    if (!job) {
      return reply.code(200).send(fail(40400, 'Job not found'))
    }
    return reply.code(200).send(success(job))
  })

  fastify.delete<{ Params: { jobId: string } }>('/tasks/:jobId', async (request, reply) => {
    const { jobId } = request.params
    const cancelled = await taskQueue.cancel(jobId, getTenantId(request))
    return reply.code(200).send(success({ cancelled }))
  })
}
