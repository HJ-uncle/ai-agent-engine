import type { FastifyInstance, FastifyRequest } from 'fastify'
import { success, fail } from '../response.js'
import { tenantConfigStore } from '../../../storage/sqlite/tenant-config.js'
import { z } from 'zod'

const getTenantId = (req: FastifyRequest) => (req as any).authContext?.tenantId ?? 'default'

const IdentitySchema = z.object({
  identity: z.string().min(1, '身份定义不能为空'),
})

export async function tenantRoutes(fastify: FastifyInstance) {
  /**
   * GET /api/v1/tenant/identity
   * 获取租户专属默认身份
   */
  fastify.get('/tenant/identity', async (request, reply) => {
    const tenantId = getTenantId(request)
    const identity = await tenantConfigStore.get(tenantId, 'default_identity')
    return reply.code(200).send(success({ identity: identity ?? '' }))
  })

  /**
   * PUT /api/v1/tenant/identity
   * 更新租户专属默认身份
   */
  fastify.put('/tenant/identity', async (request, reply) => {
    const tenantId = getTenantId(request)
    const result = IdentitySchema.safeParse(request.body)
    
    if (!result.success) {
      return reply.code(200).send(fail(40001, result.error.errors[0].message))
    }

    await tenantConfigStore.set(tenantId, 'default_identity', result.data.identity)
    return reply.code(200).send(success({ success: true }))
  })

  /**
   * DELETE /api/v1/tenant/identity
   * 清除租户专属默认身份
   */
  fastify.delete('/tenant/identity', async (request, reply) => {
    const tenantId = getTenantId(request)
    await tenantConfigStore.delete(tenantId, 'default_identity')
    return reply.code(200).send(success({ success: true }))
  })
}
