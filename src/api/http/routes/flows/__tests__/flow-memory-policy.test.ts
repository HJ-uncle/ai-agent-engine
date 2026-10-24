/** Real HTTP and durable preferences; synthetic executors never call a provider. */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { flowRoutes } from '../flow-routes.js'
import { ReActStrategy } from '../../../../../core/agent-loop/react.js'
import type { AgentContext } from '../../../../../core/agent-context/types.js'
import { ToolRegistry } from '../../../../../core/tool-registry/index.js'
import { closeMemoryDb } from '../../../../../storage/memory/db.js'
import { setMemoryPreferences } from '../../../../../storage/memory/settings.js'

const fixture = vi.hoisted(() => ({ registry: vi.fn() }))
vi.mock('../../../../../tools/registry-factory.js', () => ({ createToolRegistry: fixture.registry }))
vi.mock('../../../../../core/llm-adapter/index.js', () => ({ createLLMAdapter: vi.fn(() => ({})) }))

let app: FastifyInstance, directory: string, contexts: AgentContext[], release: (() => void) | undefined
beforeEach(async () => {
  directory = path.resolve('.e2e-tmp', 'flow-memory-' + randomUUID()); fs.mkdirSync(directory, { recursive: true })
  vi.stubEnv('MEMORY_DB_PATH', path.join(directory, 'memory.db'))
  vi.stubEnv('WORKSPACE_ROOT', path.join(directory, 'scratch'))
  vi.stubEnv('ENABLE_LONG_TERM_MEMORY', 'true'); vi.stubEnv('OSM_MODE', 'off')
  contexts = []; release = undefined
  fixture.registry.mockReset().mockResolvedValue({ registry: new ToolRegistry(), externalSkills: [] })
  vi.spyOn(ReActStrategy.prototype, 'run').mockImplementation(async function* (_prompt, ctx) {
    contexts.push(ctx); yield 'FLOW NODE COMPLETED'
  })
  app = Fastify(); app.decorateRequest('authContext', null)
  app.addHook('onRequest', async (request, reply) => {
    Object.assign(request, { authContext: { tenantId: request.headers['x-fixture-tenant'] ?? 'tenant-a' }, tenantId: 'untrusted-old-property' })
    reply.raw.setTimeout = () => reply.raw
  })
  await app.register(flowRoutes)
})
afterEach(async () => {
  release?.(); await app?.close(); await closeMemoryDb(); vi.restoreAllMocks(); vi.unstubAllEnvs()
})
function run(payload: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return app.inject({ method: 'POST', url: '/flows/run', headers, payload: {
    flowId: 'fixture', nodes: [{ nodeId: 'node', label: 'Node', nodeType: 'agent', prompt: 'Complete fixture' }], edges: [], ...payload,
  } })
}

it.each(['general', 'code'])('%s nodes honor disabled tenant preferences despite forged request policy', async profile => {
  await setMemoryPreferences('tenant-a', { globalEnabled: false, sessionDefaultEnabled: false })
  const result = await run({ tenantId: 'tenant-b', memoryScope: 'global', memoryScopes: ['global', 'session'] }, { 'x-aether-tool-profile': profile })
  expect(result.statusCode, result.body).toBe(200); expect(result.body).toContain('FLOW NODE COMPLETED')
  expect(contexts).toHaveLength(1)
  expect(contexts[0]).toMatchObject({ tenantId: 'tenant-a', toolProfile: profile, memoryScope: 'off', memoryScopes: [] })
  expect(fixture.registry).toHaveBeenCalledWith(expect.objectContaining({ memoryScopes: [], securityContext: {
    tenantId: 'tenant-a', sessionId: contexts[0].sessionId, toolProfile: profile,
  } }))
})
it('isolates equal Flow definitions across authenticated tenants', async () => {
  await setMemoryPreferences('tenant-a', { globalEnabled: true, sessionDefaultEnabled: false })
  await setMemoryPreferences('tenant-b', { globalEnabled: false, sessionDefaultEnabled: true })
  const results = await Promise.all([run(), run({}, { 'x-fixture-tenant': 'tenant-b' })])
  expect(results.map(result => result.statusCode)).toEqual([200, 200])
  expect(contexts.find(ctx => ctx.tenantId === 'tenant-a')).toMatchObject({ memoryScopes: ['global'] })
  expect(contexts.find(ctx => ctx.tenantId === 'tenant-b')).toMatchObject({ memoryScopes: ['session'] })
  expect(new Set(contexts.map(ctx => ctx.sessionId)).size).toBe(2)
})
it('resolves changed durable defaults again before the next dependent node', async () => {
  await setMemoryPreferences('tenant-a', { globalEnabled: true, sessionDefaultEnabled: true })
  vi.mocked(ReActStrategy.prototype.run).mockImplementation(async function* (_prompt, ctx) {
    contexts.push(ctx)
    if (contexts.length === 1) await setMemoryPreferences('tenant-a', { globalEnabled: false, sessionDefaultEnabled: false })
    yield 'FIRST OUTPUT'
  })
  const result = await run({ nodes: [
    { nodeId: 'first', label: 'First', nodeType: 'agent', prompt: 'First' },
    { nodeId: 'second', label: 'Second', nodeType: 'agent', prompt: '{{first}}' },
  ], edges: [{ id: 'edge', source: 'first', target: 'second' }] })
  expect(result.statusCode, result.body).toBe(200)
  expect(contexts.map(ctx => ctx.memoryScopes)).toEqual([['global', 'session'], []])
})
it('keeps saved preferences closed under a server capability refusal', async () => {
  await setMemoryPreferences('tenant-a', { globalEnabled: true, sessionDefaultEnabled: true })
  vi.stubEnv('ENABLE_LONG_TERM_MEMORY', 'false')
  const result = await run()
  expect(result.statusCode, result.body).toBe(200)
  expect(contexts[0]).toMatchObject({ memoryScope: 'off', memoryScopes: [] })
})
it('only the owning tenant can stop an active Flow', async () => {
  vi.mocked(ReActStrategy.prototype.run).mockImplementation(async function* (_prompt, ctx) {
    contexts.push(ctx)
    await new Promise<void>(resolve => { release = resolve; ctx.signal!.addEventListener('abort', () => resolve(), { once: true }) })
    yield 'STOPPED'
  })
  const completion = run({ nodes: [{ nodeId: 'held', label: 'Held', nodeType: 'agent', prompt: 'Wait' }] }).then(value => value)
  await vi.waitFor(() => expect(contexts).toHaveLength(1))
  const runId = contexts[0].sessionId.slice('flow-'.length, -'-held'.length)
  const foreign = await app.inject({ method: 'POST', url: `/flows/${runId}/stop`, headers: { 'x-fixture-tenant': 'tenant-b' } })
  expect(foreign.json().data.cancelled).toBe(false); expect(contexts[0].signal!.aborted).toBe(false)
  const owned = await app.inject({ method: 'POST', url: `/flows/${runId}/stop` })
  expect(owned.json().data.cancelled).toBe(true); expect(contexts[0].signal!.aborted).toBe(true)
  expect((await completion).statusCode).toBe(200)
})
