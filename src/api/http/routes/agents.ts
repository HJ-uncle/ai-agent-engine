import type { FastifyInstance, FastifyRequest } from 'fastify'
import { AgentManagementService, agentManagementFailure } from '../../../core/agent-management.js'
import { success, fail, paginateArray } from '../response.js'

const getTenantId = (req: FastifyRequest) => (req as any).authContext?.tenantId ?? 'default'
const failed = (error: unknown) => { const { code, message } = agentManagementFailure(error); return fail(code, message) }

/** Direct user edits keep the existing REST response shape; model tools additionally wait for approval. */
export async function agentRoutes(fastify: FastifyInstance) {
  const manager = new AgentManagementService()

  fastify.post('/agents', async (request, reply) => {
    try { return reply.code(200).send(success(await manager.create(getTenantId(request), request.body))) }
    catch (error) { return reply.code(200).send(failed(error)) }
  })

  fastify.get<{ Querystring: { current?: number; pageSize?: number } }>('/agents', async (request, reply) => {
    try {
      const agents = await manager.list(getTenantId(request))
      return reply.code(200).send(paginateArray(agents, request.query.current, request.query.pageSize))
    } catch (error) { return reply.code(200).send(failed(error)) }
  })

  fastify.get<{ Params: { id: string } }>('/agents/:id', async (request, reply) => {
    try { return reply.code(200).send(success(await manager.get(getTenantId(request), request.params.id))) }
    catch (error) { return reply.code(200).send(failed(error)) }
  })

  fastify.put<{ Params: { id: string } }>('/agents/:id', async (request, reply) => {
    try { return reply.code(200).send(success(await manager.update(getTenantId(request), request.params.id, request.body))) }
    catch (error) { return reply.code(200).send(failed(error)) }
  })

  fastify.delete<{ Params: { id: string } }>('/agents/:id', async (request, reply) => {
    try { return reply.code(200).send(success(await manager.delete(getTenantId(request), request.params.id))) }
    catch (error) { return reply.code(200).send(failed(error)) }
  })
}
