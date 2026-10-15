import Fastify, { type FastifyInstance } from 'fastify'
import { SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { authMiddlewareHook, configureRequestAuthentication } from '../../middleware.js'
import { performanceRoutes } from '../performance.js'

let app: FastifyInstance
const instanceToken = 'p1-runtime-fixture-instance'
const jwtSecret = 'p1-runtime-fixture-secret-with-sufficient-length'
beforeEach(async () => {
  vi.stubEnv('AUTH_ENABLED', 'true')
  vi.stubEnv('AETHER_INSTANCE_TOKEN', instanceToken)
  vi.stubEnv('JWT_SECRET', jwtSecret)
  configureRequestAuthentication()
  app = Fastify()
  app.addHook('onRequest', authMiddlewareHook)
  await app.register(performanceRoutes, { prefix: '/api/v1' })
})
afterEach(async () => {
  await app.close()
  vi.unstubAllEnvs()
  configureRequestAuthentication()
})

describe('authenticated runtime metrics route', () => {
  it('does not expose process metrics through the public health/meta exemption', async () => {
    for (const headers of [{}, { 'x-aether-instance-token': 'incorrect' }, { 'x-aether-instance-token': instanceToken }]) {
      const response = await app.inject({ method: 'GET', url: '/api/v1/performance/runtime', headers })
      expect(response.statusCode).toBe(401)
      expect(response.json().code).toBe(40100)
      expect(response.body).not.toContain('heapUsedBytes')
    }
  })
  it('returns real V8 memory with instance identity, no-store and a shared bounded sample', async () => {
    const jwt = await new SignJWT({ tenantId: 'p1-fixture' }).setProtectedHeader({ alg: 'HS256' })
      .setSubject('runtime-inspector').setExpirationTime('5m').sign(new TextEncoder().encode(jwtSecret))
    const headers = { 'x-aether-instance-token': instanceToken, authorization: `Bearer ${jwt}` }
    const response = await app.inject({ method: 'GET', url: '/api/v1/performance/runtime', headers })
    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    const sample = response.json().data
    expect(sample).toMatchObject({ schemaVersion: 1, pid: process.pid,
      collection: { minIntervalMs: 5000, idleTimeoutMs: 15000, delayResolutionMs: 20 },
      eventLoop: { state: 'warming', intervalMs: null, utilization: null, delay: null } })
    expect(sample.memory.heapUsedBytes).toBeGreaterThan(0)
    expect(sample.instanceId).toMatch(/^[a-f0-9-]{36}$/)
    const again = await app.inject({ method: 'GET', url: '/api/v1/performance/runtime', headers })
    expect(again.json().data).toEqual(sample)
    expect(response.body).not.toContain(instanceToken)
    expect(response.body).not.toContain(jwtSecret)
    expect(response.body).not.toContain(jwt)
  })
})
