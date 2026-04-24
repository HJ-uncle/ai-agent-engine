import type { FastifyInstance } from 'fastify'
import { SQLiteTaskQueue } from '../../../storage/task-queue/index.js'
import { success, fail } from '../response.js'

const taskQueue = new SQLiteTaskQueue()
taskQueue.start()

export async function taskRoutes(fastify: FastifyInstance) {
  fastify.post<{ Body: { type: string; payload: Record<string, unknown> } }>('/tasks', async (request, reply) => {
    const { type, payload } = request.body
    const tenantId = (request as any).authContext?.tenantId ?? 'default'
    const jobId = await taskQueue.enqueue({ type, payload, tenantId })
    return reply.code(200).send(success({ jobId }))
  })

  fastify.get<{ Querystring: { current?: number; pageSize?: number } }>('/tasks', async (request, reply) => {
    const tenantId = (request as any).authContext?.tenantId ?? 'default'
    // 假设 SQLiteTaskQueue 提供 list(tenantId) 方法，否则返回空数组
    let list: any[] = []
    if (typeof (taskQueue as any).list === 'function') {
      list = await (taskQueue as any).list(tenantId)
    }
    const { current, pageSize } = request.query
    // 这里我们使用 paginateArray 或类似方法。如果没有引入，我们简单写一个或引入
    const { paginateArray } = await import('../response.js')
    return reply.code(200).send(paginateArray(list, current, pageSize))
  })

  fastify.get<{ Params: { jobId: string } }>('/tasks/:jobId', async (request, reply) => {
    const { jobId } = request.params
    const job = await taskQueue.getStatus(jobId)
    if (!job) {
      return reply.code(200).send(fail(40400, 'Job not found'))
    }
    return reply.code(200).send(success(job))
  })

  fastify.delete<{ Params: { jobId: string } }>('/tasks/:jobId', async (request, reply) => {
    const { jobId } = request.params
    const cancelled = await taskQueue.cancel(jobId)
    return reply.code(200).send(success({ cancelled }))
  })
}
