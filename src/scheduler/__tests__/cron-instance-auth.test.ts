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
      return reply.type('text/event-stream').send('data: {"run":{"runId":"fixture-run","sessionId":"cron-session","status":"succeeded"}}\n\n')
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
      return reply.type('text/event-stream').send('data: {"run":{"runId":"fixture-run","sessionId":"cron-session","status":"succeeded"}}\n\n')
    })
    const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 })
    expect((await fetch(baseUrl + '/api/v1/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(job) })).status).toBe(401)
    expect(calls).toBe(0)
    await fire(new CronScheduler(baseUrl))(job)
    expect(calls).toBe(1)
    expect(delivered).toEqual({ message: job.message, sessionId: job.sessionId, agentId: job.agentId, cronJobId: job.id, cronTimeoutSeconds: 120 })
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

describe('cron thinking and execution isolation', () => {
  it('forwards explicit off, prevents overlap, aborts on stop and releases the job lock', async () => {
    let delivered: Record<string, unknown> = {}
    let calls = 0
    let signal: AbortSignal | undefined
    const original = globalThis.fetch
    globalThis.fetch = vi.fn(async (_url, init) => {
      if (String(_url).endsWith('/chat/cancel')) return new Response('ok')
      calls++
      delivered = JSON.parse(String(init?.body))
      signal = init?.signal as AbortSignal
      return await new Promise<Response>((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }))
    })
    const scheduler = new CronScheduler('http://127.0.0.1:12519')
    try {
      const configured = { ...job, thinkingMode: false }
      const first = fire(scheduler)(configured)
      const rejected = expect(first).rejects.toThrow('Cron scheduler stopped')
      await fire(scheduler)(configured)
      expect(calls).toBe(1)
      expect(delivered.thinkingMode).toBe(false)
      scheduler.stop()
      await rejected
      expect(signal?.aborted).toBe(true)
      globalThis.fetch = vi.fn(async () => new Response('data: {"run":{"runId":"fixture-run","sessionId":"cron-session","status":"succeeded"}}\n\n'))
      await fire(scheduler)(configured)
      expect(globalThis.fetch).toHaveBeenCalledTimes(1)
    } finally { scheduler.stop(); globalThis.fetch = original }
  })
})

describe('Cron does not confuse stream completion with task success', () => {
  it.each(['failed', 'cancelled', 'waiting', 'running'])('rejects %s root outcome even on HTTP 200', async status => {
    const original = globalThis.fetch
    globalThis.fetch = vi.fn(async url => String(url).endsWith('/chat/cancel') ? Response.json({code:200}) : new Response('data: ' + JSON.stringify({run:{runId:'fixture-run',sessionId:job.sessionId,status}}) + '\n\n'))
    try { await expect(fire(new CronScheduler('http://127.0.0.1'))(job)).rejects.toThrow('did not succeed') }
    finally { globalThis.fetch = original }
  })
  it('rejects missing terminal and a different session success', async () => {
    const original = globalThis.fetch
    globalThis.fetch = vi.fn(async () => new Response('data: ' + JSON.stringify({run:{runId:'fixture-run',sessionId:'other',status:'succeeded'}}) + '\n\n'))
    try { await expect(fire(new CronScheduler('http://127.0.0.1'))(job)).rejects.toThrow('missing terminal') }
    finally { globalThis.fetch = original }
  })
})


describe('Cron cancellation ownership', () => {
  it('sends only the observed runId and checks the cancellation response body', async () => {
    const original = globalThis.fetch
    let ready!: () => void
    const observed = new Promise<void>(resolve => { ready = resolve })
    let cancellation: unknown
    globalThis.fetch = vi.fn(async (url, init) => {
      if (String(url).endsWith('/chat/cancel')) {
        cancellation = JSON.parse(String(init?.body))
        return Response.json({code:40001})
      }
      const signal = init!.signal!
      const body = new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"run":{"runId":"cron-owned-run","sessionId":"cron-session","status":"running"}}\n\n'))
        signal.addEventListener('abort',()=>controller.error(signal.reason),{once:true})
      }, pull() { ready() } })
      return new Response(body,{headers:{'content-type':'text/event-stream'}})
    })
    const scheduler = new CronScheduler('http://127.0.0.1')
    try {
      const running = fire(scheduler)(job)
      const rejected = expect(running).rejects.toThrow('Cron cancellation rejected')
      await observed
      scheduler.stop()
      await rejected
      expect(cancellation).toEqual({sessionId:job.sessionId,runId:'cron-owned-run'})
    } finally { globalThis.fetch = original; scheduler.stop() }
  })
})


describe('Cron malformed stream cleanup', () => {
  it.each(['malformed','oversized'])('cancels only its observed run after %s stream failure', async kind => {
    const original = globalThis.fetch
    const calls: unknown[] = []
    const running = 'data: {"run":{"runId":"older-owned","sessionId":"cron-session","status":"running"}}\n\n'
    globalThis.fetch = vi.fn(async (url, init) => {
      if (String(url).endsWith('/chat/cancel')) { calls.push(JSON.parse(String(init?.body))); return Response.json({code:200,data:{cancelled:false}}) }
      return new Response(running + (kind === 'malformed' ? 'data: invalid-json\n\n' : 'data: ' + 'x'.repeat(1024*1024+1)),{headers:{'content-type':'text/event-stream'}})
    })
    try {
      await expect(fire(new CronScheduler('http://127.0.0.1'))(job)).rejects.toThrow(kind === 'malformed' ? 'malformed SSE' : 'size limit')
      expect(calls).toEqual([{sessionId:job.sessionId,runId:'older-owned'}])
    } finally { globalThis.fetch = original }
  })
})
