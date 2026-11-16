import fs from 'node:fs'
import path from 'node:path'
import Fastify, { type FastifyRequest } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pluginRoutes } from '../plugins.js'
import { PluginService } from '../../../../plugins/service.js'
import { getPluginTemplate } from '../../../../plugins/templates.js'
import { writePluginProject } from '../../../../plugins/project.js'
import { configureRequestAuthentication } from '../../middleware.js'
import type { AuthContext } from '../../../../auth/types.js'
import type { LLMAdapterOptions } from '../../../../core/llm-adapter/types.js'
import { closeDb } from '../../../../storage/sqlite/db.js'

const mocks = vi.hoisted(() => ({ models: vi.fn(), resolve: vi.fn(), adapter: vi.fn(), stream: vi.fn() }))
vi.mock('../../../../storage/sqlite/models.js', () => ({ ModelsStore: class { getModels = mocks.models } }))
vi.mock('../../../../core/llm-adapter/resolve-model.js', () => ({ resolveModelConfig: mocks.resolve, createAdapterFromResolved: mocks.adapter }))
const fixtures = path.resolve('.e2e-tmp/plugin-stream-http')
const headers = { 'x-aether-instance-token': 'isolated-stream-instance' }
const payload = { capability: 'ai.run', method: 'stream', args: { modelId: 'configured', prompt: 'Stream result' }, expectedRevision: 1 }
let root: string, app: ReturnType<typeof Fastify>, principal: AuthContext, service: PluginService
const frames = (body: string) => body.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
beforeEach(async () => {
  fs.mkdirSync(fixtures, { recursive: true }); root = fs.mkdtempSync(path.join(fixtures, 'case-'))
  vi.stubEnv('DATA_DIR', path.join(root, 'state', 'agent.db')); vi.stubEnv('AUTH_ENABLED', 'false'); vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('AETHER_INSTANCE_TOKEN', headers['x-aether-instance-token']); vi.stubEnv('AETHER_DEV_PLUGIN_ROOTS', root)
  configureRequestAuthentication({ desktopOwned: true, listenHost: '127.0.0.1' })
  principal = { tenantId: 'alice', userId: 'alice', roles: ['tenant-admin'], method: 'jwt' } as AuthContext
  app = Fastify({ bodyLimit: 100 * 1024 * 1024 }) // Same shared request policy as the engine server.
  app.addHook('onRequest', async (request: FastifyRequest) => { (request as typeof request & { authContext: AuthContext }).authContext = principal })
  await app.register(pluginRoutes)
  service = new PluginService()
  const template = getPluginTemplate('json-tool'); template.manifest.permissions = { requested: ['ai.run'] }
  await service.create('alice', template); await service.publish('alice', template.manifest.id, 1)
  mocks.models.mockResolvedValue([{ id: 'configured', modelId: 'model', isEnabled: true }])
  mocks.resolve.mockResolvedValue({ model: 'model', capabilities: { contextWindow: 32_000 } })
  mocks.adapter.mockReturnValue({ stream: mocks.stream })
  mocks.stream.mockImplementation(async function* () { yield { content: 'live text', done: false }; yield { done: true, finishReason: 'stop' } })
})
afterEach(async () => {
  await app.close()
  // The plugin close hooks inspect persisted waiting Agents through the shared
  // SQLite process. Join that fixture-owned process before unlinking the DB.
  const closed = await closeDb()
  if (closed) expect(closed.healthy, closed.errors.join('\n')).toBe(true)
  vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.resetAllMocks(); configureRequestAuthentication()
  if (path.dirname(root) !== fixtures || !path.basename(root).startsWith('case-') || fs.lstatSync(root).isSymbolicLink()) throw new Error('Unsafe stream fixture cleanup')
  await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 })
  if (!fs.readdirSync(fixtures).length) fs.rmdirSync(fixtures)
})
async function grant() { await service.setPermissionGrants('alice', 'my-json-tool', ['ai.run'], 1) }
async function liveRequest(signal?: AbortSignal) {
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  return fetch(address + '/plugins/my-json-tool/capabilities/stream', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(payload), signal })
}
describe('published and development capability SSE endpoints', () => {
  it('inherits the shared HTTP body policy and returns events above the former plugin sizes', async () => {
    await grant()
    const content = 'large-result'.repeat(200000)
    mocks.stream.mockImplementation(async function* () { yield { content, done: true, finishReason: 'stop' } })
    const streamed = await app.inject({ method: 'POST', url: '/plugins/my-json-tool/capabilities/stream', headers,
      payload: { ...payload, args: { modelId: 'configured', messages: Array.from({ length: 6 }, () => ({ role: 'user', content: 'x'.repeat(200000) })) } } })
    expect(streamed.statusCode).toBe(200)
    expect(frames(streamed.body).at(-1)).toMatchObject({ type: 'complete', result: { text: content } })
  })
  it('checks tenant, revision and grants before starting SSE', async () => {
    const request = { method: 'POST' as const, url: '/plugins/my-json-tool/capabilities/stream', headers, payload }
    expect((await app.inject(request)).statusCode).toBe(403)
    await grant()
    const streamed = await app.inject(request)
    expect(streamed.headers['content-type']).toContain('text/event-stream')
    expect(frames(streamed.body).map(event => event.type)).toEqual(['started', 'text-delta', 'complete'])
    expect(frames(streamed.body).at(-1).result.text).toBe('live text')
    expect((await app.inject({ ...request, payload: { ...payload, expectedRevision: 2 } })).statusCode).toBe(409)
    principal = { ...principal, tenantId: 'bob' }
    expect((await app.inject(request)).statusCode).toBe(404)
  })
  it('uses the same native SSE protocol for development and rejects changed source hashes', async () => {
    const template = getPluginTemplate('json-tool'); template.manifest.permissions = { requested: ['ai.run'] }
    const directory = path.join(root, 'source'); writePluginProject(directory, template)
    const opened = await app.inject({ method: 'POST', url: '/plugins/dev/open', headers, payload: { path: directory } })
    const current = opened.json().data.session, endpoint = `/plugins/dev/${current.devSessionId}`
    const body = { ...payload, expectedRevision: current.revision, hash: current.hash }
    expect((await app.inject({ method: 'POST', url: `${endpoint}/capabilities/stream`, headers, payload: body })).statusCode).toBe(403)
    await app.inject({ method: 'PUT', url: `${endpoint}/permissions`, headers, payload: { grants: ['ai.run'], revision: current.revision, hash: current.hash } })
    const streamed = await app.inject({ method: 'POST', url: `${endpoint}/capabilities/stream`, headers, payload: body })
    expect(frames(streamed.body).at(-1)).toMatchObject({ type: 'complete', result: { text: 'live text' } })
    fs.appendFileSync(path.join(directory, 'main.mjs'), '\n// edited source\n')
    expect((await app.inject({ method: 'POST', url: `${endpoint}/capabilities/stream`, headers, payload: body })).statusCode).toBe(409)
  })
  it('sends provider interruption as error, never complete', async () => {
    await grant()
    mocks.stream.mockImplementation(async function* () { yield { content: 'partial', done: false } })
    const streamed = await app.inject({ method: 'POST', url: '/plugins/my-json-tool/capabilities/stream', headers, payload })
    const events = frames(streamed.body)
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'PLUGIN_AI_INCOMPLETE' } })
    expect(events.some(event => event.type === 'complete')).toBe(false)
  })
  it('delivers text before completion and cancels the provider when the HTTP client disconnects', async () => {
    await grant()
    let providerSignal: AbortSignal | undefined
    mocks.stream.mockImplementation(async function* (_messages, options: LLMAdapterOptions) {
      providerSignal = options.signal
      yield { content: 'first visible text', done: false }
      await new Promise<void>((_resolve, reject) => providerSignal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
    })
    const abort = new AbortController(), response = await liveRequest(abort.signal), reader = response.body!.getReader()
    let body = ''
    while (!body.includes('text-delta')) body += new TextDecoder().decode((await reader.read()).value)
    expect(body).toContain('first visible text'); expect(body).not.toContain('complete')
    abort.abort(); await reader.cancel().catch(() => undefined)
    await vi.waitFor(() => expect(providerSignal?.aborted).toBe(true))
  })
  it('revokes an already open SSE stream even while its provider is silent', async () => {
    await grant()
    let providerSignal: AbortSignal | undefined
    mocks.stream.mockImplementation(async function* (_messages, options: LLMAdapterOptions) {
      providerSignal = options.signal
      yield { content: 'initial text', done: false }
      await new Promise<void>((_resolve, reject) => providerSignal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
    })
    const response = await liveRequest(), reader = response.body!.getReader()
    let body = ''
    while (!body.includes('text-delta')) body += new TextDecoder().decode((await reader.read()).value)
    await service.setPermissionGrants('alice', 'my-json-tool', [], 1)
    while (true) { const next = await reader.read(); if (next.done) break; body += new TextDecoder().decode(next.value) }
    expect(frames(body).at(-1)).toMatchObject({ type: 'error', error: { code: 'PLUGIN_PERMISSION' } })
    expect(frames(body).some(event => event.type === 'complete')).toBe(false)
    expect(providerSignal?.aborted).toBe(true)
  })
  it('stops a running development stream when its source changes', async () => {
    const template = getPluginTemplate('json-tool'); template.manifest.permissions = { requested: ['ai.run'] }
    const directory = path.join(root, 'source'); writePluginProject(directory, template)
    const current = (await app.inject({ method: 'POST', url: '/plugins/dev/open', headers, payload: { path: directory } })).json().data.session
    const endpoint = `/plugins/dev/${current.devSessionId}`
    await app.inject({ method: 'PUT', url: `${endpoint}/permissions`, headers, payload: { grants: ['ai.run'], revision: current.revision, hash: current.hash } })
    let waiting = false
    mocks.stream.mockImplementation(async function* (_messages, options: LLMAdapterOptions) {
      yield { content: 'first', done: false }; waiting = true
      await new Promise<void>((_resolve, reject) => options.signal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
    })
    const pending = app.inject({ method: 'POST', url: `${endpoint}/capabilities/stream`, headers, payload: { ...payload, hash: current.hash } })
    await vi.waitFor(() => expect(waiting).toBe(true))
    fs.appendFileSync(path.join(directory, 'main.mjs'), '\n// changed during stream\n')
    const result = await pending
    expect(frames(result.body).at(-1)).toMatchObject({ type: 'error', error: { code: 'PLUGIN_DEV_CHANGED' } })
    expect(frames(result.body).some(event => event.type === 'complete')).toBe(false)
  })
  it('closes active streams and their providers during server shutdown', async () => {
    await grant()
    let providerSignal: AbortSignal | undefined
    mocks.stream.mockImplementation(async function* (_messages, options: LLMAdapterOptions) {
      providerSignal = options.signal
      yield { content: 'first', done: false }
      await new Promise<void>((_resolve, reject) => providerSignal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
    })
    const response = await liveRequest()
    const body = response.text()
    await vi.waitFor(() => expect(providerSignal).toBeDefined())
    await app.close()
    expect(providerSignal?.aborted).toBe(true)
    expect(frames(await body).some(event => event.type === 'complete')).toBe(false)
  })
})
