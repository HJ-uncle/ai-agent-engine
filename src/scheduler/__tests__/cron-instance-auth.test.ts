import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CronScheduler } from '../cron-scheduler.js'
import { authMiddlewareHook, configureRequestAuthentication } from '../../api/http/middleware.js'

const fixtureToken = 'cron-runtime-auth-fixture-token'
const apps: FastifyInstance[] = []
interface FireJob { fireJob(job: { id: string; name: string; message: string; sessionId: string; agentId?: string }): Promise<void> }
const fire = (scheduler: CronScheduler) => (scheduler as unknown as FireJob).fireJob.bind(scheduler)
const job = { id: 'owned-cron', name: 'owned cron', message: 'continue development', sessionId: 'cron-session', agentId: 'fixture-agent' }

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close()
  vi.unstubAllEnvs()
  configureRequestAuthentication()
})

describe('Owned-instance cron transport', () => {
  it('uses the dedicated engine port instead of the inherited project PORT', async () => {
    vi.stubEnv('AUTH_ENABLED', 'false')
    vi.stubEnv('AETHER_INSTANCE_TOKEN', fixtureToken)
    configureRequestAuthentication()
    const app = Fastify()
    apps.push(app)
    app.addHook('onRequest', authMiddlewareHook)
    let calls = 0
    app.post('/api/v1/chat', async (_request, reply) => {
      calls++
      return reply.type('text/event-stream').send('data: {"type":"done"}\n\n')
    })
    const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 })
    vi.stubEnv('AETHER_ENGINE_PORT', new URL(baseUrl).port)
    vi.stubEnv('PORT', '0')
    await fire(new CronScheduler())(job)
    expect(calls).toBe(1)
    expect(process.env.PORT).toBe('0')
  })

  it('reaches real instance-protected chat HTTP authentication in local single-user mode', async () => {
    vi.stubEnv('AUTH_ENABLED', 'false')
    vi.stubEnv('AETHER_INSTANCE_TOKEN', fixtureToken)
    configureRequestAuthentication()
    const app = Fastify()
    apps.push(app)
    app.addHook('onRequest', authMiddlewareHook)
    let calls = 0
    let delivered: unknown
    app.post('/api/v1/chat', async (request, reply) => {
      calls++
      delivered = request.body
      expect(request.headers['x-aether-instance-token']).toBe(fixtureToken)
      return reply.type('text/event-stream').send('data: {"type":"done"}\n\n')
    })
    const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 })
    expect((await fetch(baseUrl + '/api/v1/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(job) })).status).toBe(401)
    expect(calls).toBe(0)
    await fire(new CronScheduler(baseUrl))(job)
    expect(calls).toBe(1)
    expect(delivered).toEqual({ message: job.message, sessionId: job.sessionId, agentId: job.agentId })
  })

  it('does not forward instance credentials to a remote target', async () => {
    vi.stubEnv('AETHER_INSTANCE_TOKEN', fixtureToken)
    await expect(fire(new CronScheduler('https://example.invalid'))(job)).rejects.toThrow('loopback target')
  })

  it('does not follow a redirect that could leak the instance credential', async () => {
    vi.stubEnv('AETHER_INSTANCE_TOKEN', fixtureToken)
    const destination = Fastify()
    const redirector = Fastify()
    apps.push(destination, redirector)
    let leakedRequests = 0
    destination.post('/sink', async () => { leakedRequests++; return 'unexpected' })
    const destinationUrl = await destination.listen({ host: '127.0.0.1', port: 0 })
    redirector.post('/api/v1/chat', async (_, reply) => reply.code(307).header('Location', destinationUrl + '/sink').send())
    const baseUrl = await redirector.listen({ host: '127.0.0.1', port: 0 })
    await expect(fire(new CronScheduler(baseUrl))(job)).rejects.toThrow()
    expect(leakedRequests).toBe(0)
  })
})
