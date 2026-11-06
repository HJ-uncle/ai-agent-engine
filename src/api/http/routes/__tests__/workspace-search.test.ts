/** Real route/worker/disk integration: authenticated workspace binding, strict
 * request ownership and cancellation. No model or Electron process is started. */
import fs from 'node:fs'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WorkspaceManager, workspaceManager } from '../../../../workspace/index.js'
import { workspaceRoutes } from '../workspace.js'

const identity = { tenantId: 'search-tenant', sessionId: 'work-search' }
let fixture: string, project: string, other: string, app: FastifyInstance, manager: WorkspaceManager
let nextId = 0

beforeEach(async () => {
  fs.mkdirSync('.e2e-tmp', { recursive: true })
  fixture = fs.mkdtempSync(path.resolve('.e2e-tmp/workspace-search-route-'))
  project = path.join(fixture, 'project'); other = path.join(fixture, 'other')
  fs.mkdirSync(project); fs.mkdirSync(other)
  fs.writeFileSync(path.join(project, 'owned.txt'), 'needle owned')
  fs.writeFileSync(path.join(other, 'foreign.txt'), 'needle foreign')
  vi.stubEnv('AUTH_ENABLED', 'true')
  vi.stubEnv('AETHER_ALLOWED_WORKSPACE_ROOTS', fixture)
  vi.stubEnv('AETHER_WORKSPACE_BINDINGS_FILE', path.join(fixture, 'state', 'bindings.json'))
  // Isolate this non-Git workspace from the repository containing .e2e-tmp.
  vi.stubEnv('GIT_CEILING_DIRECTORIES', fixture)
  manager = new WorkspaceManager(path.join(fixture, 'private'))
  manager.bind(identity, project)
  vi.spyOn(workspaceManager, 'bindingReadGuard').mockImplementation((context, expected) => manager.bindingReadGuard(context, expected))
  vi.spyOn(workspaceManager, 'resolveSafePathForSnapshot').mockImplementation((context, snapshot, name) => manager.resolveSafePathForSnapshot(context, snapshot, name))
  app = Fastify()
  app.decorateRequest('authContext', null)
  app.addHook('onRequest', async request => { Object.assign(request, { authContext: { tenantId: request.headers['x-tenant'] ?? identity.tenantId } }) })
  await app.register(workspaceRoutes, { prefix: '/api/v1' })
  await app.ready()
})

afterEach(async () => {
  await app.close()
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (path.dirname(fixture) !== path.resolve('.e2e-tmp') || !path.basename(fixture).startsWith('workspace-search-route-')) throw new Error('Unsafe search fixture cleanup')
  fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function payload(patch: Record<string, unknown> = {}) {
  return { sessionId: identity.sessionId, expectedRoot: project, bindingEpoch: manager.getBindingSnapshot(identity).epoch,
    requestId: `search-${++nextId}`, query: 'needle', options: { caseSensitive: false, wholeWord: false, useRegex: false, include: '', exclude: '' },
    excludes: {}, useIgnoreFiles: true, ...patch }
}
function search(body = payload()) { return app.inject({ method: 'POST', url: '/api/v1/workspace/search', payload: body }) }

it('searches the authenticated root with one request and returns exact file coordinates', async () => {
  const response = (await search()).json()
  expect(response.code).toBe(200)
  expect(response.data).toMatchObject({ root: project, bindingEpoch: manager.getBindingSnapshot(identity).epoch,
    truncated: false, strategy: 'scan', hits: [{ path: 'owned.txt', line: 1, column: 1, length: 6, text: 'needle owned' }] })
})

it('rejects a forged root or stale epoch instead of scanning another local directory', async () => {
  for (const patch of [{ expectedRoot: other }, { bindingEpoch: 'stale-epoch' }, { expectedRoot: '../other' }]) {
    const response = (await search(payload(patch))).json()
    expect(response.code).not.toBe(200)
    expect(response.data).toBeNull()
    expect(JSON.stringify(response)).not.toContain('needle foreign')
  }
})

it('normalizes Windows root casing and separators without changing the authoritative returned root', async () => {
  if (process.platform !== 'win32') return
  const response = (await search(payload({ expectedRoot: project.toUpperCase().replace(/\\/g, '/') }))).json()
  expect(response.code).toBe(200)
  expect(response.data.root).toBe(project)
  expect(response.data.hits).toHaveLength(1)
})

it('does not let the same session ID under another tenant reuse the binding', async () => {
  const response = (await app.inject({ method: 'POST', url: '/api/v1/workspace/search', headers: { 'x-tenant': 'different-tenant' }, payload: payload() })).json()
  expect(response.code).not.toBe(200)
  expect(JSON.stringify(response)).not.toContain('needle owned')
})

it('accepts a root-only legacy guard but still rejects a binding change during worker I/O', async () => {
  const legacy = payload(); delete (legacy as Partial<typeof legacy>).bindingEpoch
  expect((await search(legacy)).json().code).toBe(200)
  let captured!: () => void
  const ready = new Promise<void>(done => { captured = done })
  vi.mocked(workspaceManager.bindingReadGuard).mockImplementation((context, expected) => {
    const guard = manager.bindingReadGuard(context, expected)
    captured()
    return guard
  })
  const pending = search(payload()).then(response => response.json())
  await ready
  manager.bind(identity, other)
  const response = await pending
  expect(response.code).not.toBe(200)
  expect(response.data).toBeNull()
})

it('cancels only the authenticated tenant/session/request tuple, including overtaken requests', async () => {
  const body = payload({ requestId: 'same-request' })
  await app.inject({ method: 'POST', url: '/api/v1/workspace/search/cancel', headers: { 'x-tenant': 'different-tenant' },
    payload: { sessionId: identity.sessionId, requestId: body.requestId } })
  expect((await search(body)).json().code).toBe(200)
  await app.inject({ method: 'POST', url: '/api/v1/workspace/search/cancel', payload: { sessionId: identity.sessionId, requestId: 'cancelled-before-dispatch' } })
  const cancelled = (await search(payload({ requestId: 'cancelled-before-dispatch' }))).json()
  expect(cancelled.code).not.toBe(200)
  expect(cancelled.message).toContain('取消')
  expect((await search()).json().code).toBe(200)
})

it('returns useful partial results at the hit limit instead of failing the entire search', async () => {
  fs.writeFileSync(path.join(project, 'many.txt'), Array.from({ length: 700 }, (_, index) => `needle ${index}`).join('\n'))
  const response = (await search()).json()
  expect(response.code).toBe(200)
  expect(response.data.truncated).toBe(true)
  expect(response.data.hits).toHaveLength(500)
})

it('reports invalid regex as a search result while malformed requests fail schema validation', async () => {
  const body = payload()
  body.query = '['; body.options.useRegex = true
  const response = (await search(body)).json()
  expect(response.code).toBe(200)
  expect(response.data).toMatchObject({ hits: [], error: '正则表达式无效' })
  expect((await app.inject({ method: 'POST', url: '/api/v1/workspace/search', payload: { sessionId: identity.sessionId } })).statusCode).toBe(400)
})
