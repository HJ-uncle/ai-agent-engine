import type { FastifyInstance } from 'fastify'
import { SQLiteTaskQueue } from '../../../storage/task-queue/index.js'

const taskQueue = new SQLiteTaskQueue()
taskQueue.start()

export async function taskRoutes(fastify: FastifyInstance) {
  fastify.post<{ Body: { type: string; payload: Record<string, unknown> } }>('/tasks', async (request, reply) => {
    const { type, payload } = request.body
    const tenantId = (request as any).authContext?.tenantId ?? 'default'
    const jobId = await taskQueue.enqueue({ type, payload, tenantId })
    return reply.code(201).send({ jobId })
  })

  fastify.get<{ Params: { jobId: string } }>('/tasks/:jobId', async (request, reply) => {
    const { jobId } = request.params
    const job = await taskQueue.getStatus(jobId)
    if (!job) {
      return reply.code(404).send({ error: 'Job not found' })
    }
    return reply.send(job)
  })

  fastify.delete<{ Params: { jobId: string } }>('/tasks/:jobId', async (request, reply) => {
    const { jobId } = request.params
    const cancelled = await taskQueue.cancel(jobId)
    return reply.send({ cancelled })
  })
}
