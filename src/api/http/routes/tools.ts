import type { FastifyInstance } from 'fastify'
import { createToolRegistry } from '../../../tools/registry-factory.js'
import { paginateArray } from '../response.js'

export async function toolRoutes(fastify: FastifyInstance) {
  fastify.get<{ Querystring: { current?: number; pageSize?: number } }>('/tools', async (request, reply) => {
    // 统一工厂：与 chat / messages 路由完全一致的工具集
    const { registry } = await createToolRegistry()
    const toolsList = registry.list().map(t => ({
      name: t.name,
      displayName: (t as any).displayName,
      description: t.description,
      parameters: t.parameters,
      source: 'builtin'
    }))
    const { current, pageSize } = request.query
    return reply.code(200).send(paginateArray(toolsList, current, pageSize))
  })
}
