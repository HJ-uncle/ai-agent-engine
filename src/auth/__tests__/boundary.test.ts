import { describe, expect, it, vi, afterEach } from 'vitest'
import Fastify from 'fastify'
import { DefaultAuthMiddleware } from '../middleware.js'
import { requireRoles } from '../guards.js'

afterEach(() => vi.unstubAllEnvs())

describe('authentication boundary', () => {
  it('rejects anonymous requests when authentication is enabled', async () => {
    vi.stubEnv('AUTH_ENABLED', 'true')
    await expect(new DefaultAuthMiddleware().authenticate({ headers: {} })).rejects.toThrow('Authentication required')
  })

  it('does not let viewer mutate an admin route', async () => {
    vi.stubEnv('AUTH_ENABLED', 'true')
    const app = Fastify()
    app.addHook('onRequest', async request => {
      ;(request as any).authContext = { tenantId: 't', method: 'jwt', roles: ['viewer'] }
    })
    app.put('/global', { preHandler: requireRoles('admin') }, async () => ({ ok: true }))
    const denied = await app.inject({ method: 'PUT', url: '/global' })
    expect(denied.json().code).toBe(41015)
    await app.close()
  })
})
