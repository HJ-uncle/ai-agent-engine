import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { EventEmitter } from 'node:events'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import { PluginService } from '../service.js'
import { PluginCatalogueStream } from '../catalogue-stream.js'
import { notifyPluginChanged } from '../change-events.js'
import { pluginRoutes } from '../../api/http/routes/plugins.js'
import type { AuthContext } from '../../auth/types.js'
import type { CreatePluginInput } from '../types.js'

const scratch = path.resolve('.e2e-tmp/plugin-catalogue-stream')
const input = (id: string): CreatePluginInput => ({ manifest: { apiVersion: 1, id, name: id, version: '1.0.0', description: 'Stream fixture', runtime: 'node', tools: [{ name: 'echo', description: 'Echo', entry: 'main.mjs', inputSchema: { type: 'object' } }] }, files: { 'main.mjs': 'throw new Error("NEVER_EXECUTE")' } })
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))
type Change = { kind: string; action: string; id: string }
type Stream = { response: IncomingMessage; frames: Change[]; text: () => string; next(): Promise<Change>; close(): void }
let root: string, app: FastifyInstance, service: PluginService, address: string, clients: Stream[]
beforeEach(async () => {
  await fs.mkdir(scratch, { recursive: true }); root = await fs.mkdtemp(path.join(scratch, 'run-'))
  vi.stubEnv('DATA_DIR', path.join(root, 'state/agent.db')); vi.stubEnv('AUTH_ENABLED', 'true')
  clients = []; service = new PluginService(); app = Fastify()
  app.addHook('onRequest', async request => { (request as FastifyRequest & { authContext?: AuthContext }).authContext = { tenantId: String(request.headers['x-test-tenant'] ?? 'tenant-a'), method: 'jwt', roles: [String(request.headers['x-test-role'] ?? 'plugin-manager')] } })
  await app.register(pluginRoutes); address = await app.listen({ host: '127.0.0.1', port: 0 })
})
afterEach(async () => {
  for (const client of clients) client.close()
  await app.close(); vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (path.dirname(root) !== scratch || (await fs.lstat(root)).isSymbolicLink()) throw new Error('Unsafe stream fixture cleanup')
  await fs.rm(root, { recursive: true, force: true })
})
afterAll(async () => { if ((await fs.readdir(scratch)).length === 0) await fs.rmdir(scratch) })
async function stream(tenant = 'tenant-a'): Promise<Stream> {
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const request = httpRequest(address + '/plugins/runtime/changes', { headers: { 'x-test-tenant': tenant } }, resolve)
    request.once('error', reject); request.end()
  })
  expect(response.statusCode).toBe(200); expect(response.headers['content-type']).toContain('text/event-stream')
  let text = '', buffered = '', consumed = 0
  const frames: Change[] = [], waiters: (() => void)[] = []
  response.setEncoding('utf8')
  response.on('data', (chunk: string) => {
    text += chunk; buffered += chunk
    for (;;) { const end = buffered.indexOf('\n\n'); if (end < 0) break; const value = buffered.slice(0, end); buffered = buffered.slice(end + 2); if (value.startsWith('data: ')) frames.push(JSON.parse(value.slice(6)).pluginCatalogueChange) }
    for (const notify of waiters.splice(0)) notify()
  })
  response.on('error', () => undefined)
  const client: Stream = { response, frames, text: () => text, close: () => response.destroy(), next: async () => {
    if (frames[consumed]) return frames[consumed++]
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('SSE event timed out')), 3000)
      const notify = () => { if (frames[consumed]) { clearTimeout(timeout); resolve() } else waiters.push(notify) }; waiters.push(notify)
    })
    return frames[consumed++]
  } }
  clients.push(client); return client
}

describe('real HTTP plugin catalogue changes', () => {
  it('pushes initial refresh and out-of-band service create/publish/toggle/delete without chat cursor or source data', async () => {
    const client = await stream()
    expect(await client.next()).toEqual({ kind: 'plugin', action: 'refresh', id: '*' })
    for (const operation of [() => service.create('tenant-a', input('external-plugin')), () => service.publish('tenant-a', 'external-plugin', 1), () => service.setEnabled('tenant-a', 'external-plugin', false), () => service.remove('tenant-a', 'external-plugin')]) {
      await operation(); expect(await client.next()).toEqual({ kind: 'plugin', action: 'update', id: 'external-plugin' })
    }
    expect(client.text()).not.toMatch(/^id:/m); expect(client.text()).not.toContain('NEVER_EXECUTE'); expect(client.text()).not.toContain(root)
    const reconnected = await stream(); expect(await reconnected.next()).toEqual({ kind: 'plugin', action: 'refresh', id: '*' })
  })
  it('isolates both the tenant and the storage root', async () => {
    const a = await stream('tenant-a'), b = await stream('tenant-b'); await a.next(); await b.next()
    await service.create('tenant-b', input('other-tenant')); expect((await b.next()).id).toBe('other-tenant')
    await new PluginService(path.join(root, 'another-store')).create('tenant-a', input('other-store'))
    await service.create('tenant-a', input('own-store')); expect((await a.next()).id).toBe('own-store')
    expect(a.frames.map(value => value.id)).toEqual(['*', 'own-store']); expect(b.frames.map(value => value.id)).toEqual(['*', 'other-tenant'])
  })
  it('requires management authorization before opening the stream', async () => {
    const response = await fetch(address + '/plugins/runtime/changes', { headers: { 'x-test-role': 'viewer' } })
    expect(response.status).toBe(403); expect(response.headers.get('content-type')).not.toContain('text/event-stream')
  })
  it('handles disconnected clients and closes live sockets before app shutdown', async () => {
    const disconnected = await stream(); await disconnected.next(); disconnected.close()
    await tick(); await service.create('tenant-a', input('after-disconnect'))
    const live = await stream(); await live.next()
    const closed = new Promise<void>(resolve => live.response.once('close', resolve))
    await app.close(); await closed
    await service.setEnabled('tenant-a', 'after-disconnect', false)
    expect(live.frames).toHaveLength(1)
  })
})

describe('catalogue stream resource bounds', () => {
  it('bounds stalled clients, coalesces a burst, resumes on drain and cleans all listeners', async () => {
    const request = new EventEmitter(), response = Object.assign(new EventEmitter(), { writeHead: vi.fn(), flushHeaders: vi.fn(), write: vi.fn((_text: string) => false), destroyed: false, destroy: vi.fn(() => { response.destroyed = true; response.emit('close') }) })
    const hub = new PluginCatalogueStream(service.rootDir)
    hub.open({ raw: request } as unknown as FastifyRequest, { raw: response, hijack: vi.fn() } as unknown as FastifyReply, 'tenant-a')
    expect(hub.connectionCount).toBe(1)
    for (let i = 0; i < 1000; i++) notifyPluginChanged(service.rootDir, 'tenant-a', 'plugin-' + i)
    await tick(); expect(response.write).toHaveBeenCalledTimes(1)
    response.write.mockReturnValue(true); response.emit('drain'); await tick()
    expect(response.write).toHaveBeenCalledTimes(2)
    expect(response.write.mock.calls[1]?.[0]).toContain('"action":"refresh","id":"*"')
    request.emit('aborted'); expect(hub.connectionCount).toBe(0)
    expect(response.listenerCount('drain')).toBe(0); expect(response.listenerCount('close')).toBe(0); expect(response.listenerCount('error')).toBe(0); expect(request.listenerCount('aborted')).toBe(0)
    hub.close(); notifyPluginChanged(service.rootDir, 'tenant-a', 'ignored'); await tick(); expect(response.write).toHaveBeenCalledTimes(2)
  })
  it('heartbeats without catalogue reads and terminates a permanently stalled connection', async () => {
    const request = new EventEmitter(), response = Object.assign(new EventEmitter(), { writeHead: vi.fn(), flushHeaders: vi.fn(), write: vi.fn((_text: string) => true), destroyed: false, destroy: vi.fn(() => { response.destroyed = true; response.emit('close') }) })
    const list = vi.spyOn(PluginService.prototype, 'list'), hub = new PluginCatalogueStream(service.rootDir, { heartbeatMs: 10, stalledMs: 25 })
    hub.open({ raw: request } as unknown as FastifyRequest, { raw: response, hijack: vi.fn() } as unknown as FastifyReply, 'tenant-a')
    try {
      await vi.waitFor(() => expect(response.write.mock.calls.some(([text]) => text === ': heartbeat\n\n')).toBe(true), { timeout: 500, interval: 10 })
      expect(list).not.toHaveBeenCalled()
      response.write.mockReturnValue(false); notifyPluginChanged(service.rootDir, 'tenant-a', 'blocked'); await tick()
      await vi.waitFor(() => expect(hub.connectionCount).toBe(0), { timeout: 500, interval: 10 })
      expect(response.destroy).toHaveBeenCalledOnce()
    } finally { hub.close() }
  })
})
