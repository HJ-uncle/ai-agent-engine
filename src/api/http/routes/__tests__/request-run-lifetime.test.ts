// Real HTTP disconnection policy; the model is held after root admission and never calls a provider.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getRequestRunLifetime } from '../../tool-profile.js'
import { chatRoutes } from '../chat.js'
import { initDb, closeDb, getDb } from '../../../../storage/sqlite/db.js'
import type { LocalSqliteProcessClient } from '../../../../storage/sqlite/local-process-client.js'
import { closeMemoryDb } from '../../../../storage/memory/db.js'
import { ReActStrategy } from '../../../../core/agent-loop/index.js'
import { activeStreams, type StreamBus } from '../../../../core/stream-pipeline/stream-bus.js'
import { rootRunStore } from '../../../../storage/root-runs/index.js'
import * as toolFactory from '../../../../tools/registry-factory.js'

describe('request run lifetime header', () => {
  it('keeps the historical defaults when no lifetime header was sent', () => {
    expect(getRequestRunLifetime({ headers: {} })).toBe('attached')
    expect(getRequestRunLifetime({ headers: { 'x-aether-tool-profile': 'general' } })).toBe('attached')
    expect(getRequestRunLifetime({ headers: { 'x-aether-tool-profile': 'code' } })).toBe('durable')
  })

  it.each(['general', 'code'])('lets %s select either lifetime independently of its tool profile', profile => {
    expect(getRequestRunLifetime({ headers: { 'x-aether-tool-profile': profile, 'x-aether-run-lifetime': 'durable' } })).toBe('durable')
    expect(getRequestRunLifetime({ headers: { 'x-aether-tool-profile': profile, 'x-aether-run-lifetime': 'attached' } })).toBe('attached')
  })

  it.each(['', 'Durable', 'unknown', 'durable,attached', 'durable, durable', ['durable', 'durable'], ['durable', 'attached']])('rejects invalid or repeated lifetime %j', lifetime => {
    expect(() => getRequestRunLifetime({ headers: { 'x-aether-run-lifetime': lifetime } })).toThrow('X-Aether-Run-Lifetime must be durable or attached')
    try { getRequestRunLifetime({ headers: { 'x-aether-run-lifetime': lifetime } }) }
    catch (error) { expect(error).toMatchObject({ statusCode: 400 }) }
  })

  it('does not let a body or query upgrade the request lifetime', () => {
    const request = { headers: { 'x-aether-tool-profile': 'general' }, body: { runLifetime: 'durable' }, query: { runLifetime: 'durable' } }
    expect(getRequestRunLifetime(request)).toBe('attached')
  })
})

describe('admitted chat disconnection lifetime', () => {
  const tenantId = 'run-lifetime-tenant'
  let fixture: string
  let app: FastifyInstance
  let baseUrl: string
  let sessionId: string
  let release: (() => void) | undefined
  let admittedSignal: AbortSignal | undefined
  let bus: StreamBus | undefined
  let socket: http.ClientRequest | undefined

  beforeEach(async () => {
    fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-run-lifetime-'))
    vi.stubEnv('DATA_DIR', path.join(fixture, 'agent.db'))
    vi.stubEnv('HISTORY_BACKEND', 'jsonl')
    vi.stubEnv('MEMORY_DB_PATH', path.join(fixture, 'memory.db'))
    vi.stubEnv('SKILLS_ROOT', path.join(fixture, 'skills'))
    await initDb()
    sessionId = path.basename(fixture)
    admittedSignal = undefined; release = undefined; bus = undefined; socket = undefined
    vi.spyOn(ReActStrategy.prototype, 'run').mockImplementation(async function* (_prompt, ctx) {
      const signal = ctx.signal
      if (!signal) throw new Error('Admitted chat must provide an abort signal')
      admittedSignal = signal
      yield 'model started'
      await new Promise<void>(resolve => {
        release = resolve
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', () => resolve(), { once: true })
      })
      if (!signal.aborted) {
        await ctx.runObserver?.onOutcome?.({ status: 'succeeded', stopReason: 'completed' })
        yield 'model completed'
      }
    })
    app = Fastify()
    app.decorateRequest('authContext', null)
    app.addHook('onRequest', async request => { Object.assign(request, { authContext: { tenantId } }) })
    await app.register(chatRoutes)
    baseUrl = await app.listen({ host: '127.0.0.1', port: 0 })
  })

  afterEach(async () => {
    socket?.destroy()
    if (bus?.disconnectTimeout) { clearTimeout(bus.disconnectTimeout); bus.disconnectTimeout = null }
    bus?.abortController.abort(); release?.(); bus?.end()
    await app.inject({ method: 'POST', url: '/chat/cancel', payload: { sessionId } })
    activeStreams.delete(`${tenantId}:${sessionId}`)
    await app.close()
    const db = getDb() as LocalSqliteProcessClient
    closeDb()
    await Promise.all([closeMemoryDb(), db.whenClosed()])
    vi.restoreAllMocks(); vi.unstubAllEnvs()
    if (path.dirname(fixture) !== path.resolve(os.tmpdir()) || !path.basename(fixture).startsWith('aether-run-lifetime-')) throw new Error('Unsafe fixture cleanup path')
    fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 5 })
  })

  async function begin(profile: string, lifetime?: string): Promise<StreamBus> {
    socket = http.request(baseUrl + '/chat', { method: 'POST', headers: {
      'content-type': 'application/json', 'x-aether-tool-profile': profile,
      ...(lifetime ? { 'x-aether-run-lifetime': lifetime } : {}),
    } })
    socket.on('error', () => undefined)
    socket.on('response', response => response.resume())
    socket.end(JSON.stringify({ message: 'work in the background', sessionId, model: 'fixture-model', memoryScope: 'off', workspacePaths: [fixture] }))
    await vi.waitFor(() => {
      expect(admittedSignal).toBeDefined()
      bus = activeStreams.get(`${tenantId}:${sessionId}`)
      expect(bus).toBeDefined()
    }, { timeout: 10_000 })
    return bus!
  }

  it.each(['general', 'code'])('%s durable keeps its admitted producer alive when its viewer disconnects', async profile => {
    const current = await begin(profile, 'durable')
    expect(current.retainOnDisconnect).toBe(true)
    socket!.destroy()
    await vi.waitFor(() => expect(current.emitter.listenerCount('data')).toBe(0))
    expect(current.disconnectTimeout).toBeNull()
    expect(admittedSignal!.aborted).toBe(false)
    // Work's previous regression cancelled at 15 seconds. Cross that actual
    // boundary once so an unintended delayed cancellation cannot pass unnoticed.
    if (profile === 'general') await new Promise(resolve => setTimeout(resolve, 15_100))
    expect(admittedSignal!.aborted).toBe(false)
    release!()
    await vi.waitFor(() => expect(current.finished).toBe(true), { timeout: 5_000 })
    expect((await rootRunStore.list(tenantId, sessionId)).at(-1)?.status).toBe('succeeded')
  }, 30_000)

  it.each(['general', 'code'])('%s attached preserves the 15-second cancellation grace after disconnect', async profile => {
    const timerSpy = vi.spyOn(globalThis, 'setTimeout')
    const current = await begin(profile, 'attached')
    expect(current.retainOnDisconnect).toBe(false)
    socket!.destroy()
    await vi.waitFor(() => expect(current.disconnectTimeout).not.toBeNull())
    await vi.waitFor(() => expect(current.emitter.listenerCount('data')).toBe(0))
    const graceIndex = timerSpy.mock.results.findIndex(result => result.type === 'return' && result.value === current.disconnectTimeout)
    expect(graceIndex).toBeGreaterThanOrEqual(0)
    const grace = timerSpy.mock.calls[graceIndex]
    expect(grace[1]).toBe(15_000)
    expect(admittedSignal!.aborted).toBe(false)
    clearTimeout(current.disconnectTimeout!)
    // Exercise the scheduled cancellation without adding another real 15s wait.
    const callback = grace[0]
    if (typeof callback !== 'function') throw new Error('Disconnect grace must schedule a callback')
    callback()
    expect(admittedSignal!.aborted).toBe(true)
  }, 15_000)

  it('rejects invalid lifetime before preparation or root admission', async () => {
    const response = await app.inject({ method: 'POST', url: '/chat', headers: { 'x-aether-run-lifetime': 'unknown' }, payload: { message: 'must not start', sessionId } })
    expect(response.statusCode).toBe(400)
    expect(response.json().message).toBe('X-Aether-Run-Lifetime must be durable or attached')
    expect(admittedSignal).toBeUndefined()
    expect(await rootRunStore.list(tenantId, sessionId)).toEqual([])
  })

  it('still cancels general durable discovery when the viewer leaves before root admission', async () => {
    let preparingSignal: AbortSignal | undefined
    vi.spyOn(toolFactory, 'createToolRegistry').mockImplementation(async (options = {}) => {
      const signal = options.signal
      if (!signal) throw new Error('Tool discovery must have an abort signal')
      preparingSignal = signal
      return new Promise((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason)
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    })
    socket = http.request(baseUrl + '/chat', { method: 'POST', headers: {
      'content-type': 'application/json', 'x-aether-tool-profile': 'general', 'x-aether-run-lifetime': 'durable',
    } })
    socket.on('error', () => undefined)
    socket.end(JSON.stringify({ message: 'work must first be admitted', sessionId, model: 'fixture-model', memoryScope: 'off', workspacePaths: [fixture] }))
    await vi.waitFor(() => expect(preparingSignal).toBeDefined())
    socket.destroy()
    await vi.waitFor(() => expect(preparingSignal!.aborted).toBe(true))
    expect(admittedSignal).toBeUndefined()
    expect(activeStreams.has(`${tenantId}:${sessionId}`)).toBe(false)
    expect(await rootRunStore.list(tenantId, sessionId)).toEqual([])
  })
})
