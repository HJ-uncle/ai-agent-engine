/** Fastify + real WorkspaceManager: read-only empty scratch listings, first
 * manual creates, and missing-directory/binding boundaries. No live server. */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { clearSecurityMode, setSecurityMode } from '../../../../security/policy-engine.js'
import { WorkspaceManager, workspaceManager } from '../../../../workspace/index.js'
import { workspaceRoutes } from '../workspace.js'

const identity = { tenantId: 'directory-tenant', sessionId: 'work-home-empty' }
let fixture: string, scratch: string, project: string, manager: WorkspaceManager, app: FastifyInstance

beforeEach(async () => {
  fs.mkdirSync('.e2e-tmp', { recursive: true })
  fixture = fs.mkdtempSync(path.resolve('.e2e-tmp/workspace-directory-'))
  project = path.join(fixture, 'selected-project')
  fs.mkdirSync(project)
  vi.stubEnv('AUTH_ENABLED', 'false')
  vi.stubEnv('AETHER_ALLOWED_WORKSPACE_ROOTS', fixture)
  vi.stubEnv('AETHER_WORKSPACE_BINDINGS_FILE', path.join(fixture, 'state', 'bindings.json'))
  manager = new WorkspaceManager(path.join(fixture, 'private'))
  scratch = manager.getScratchDirectory(identity)
  setSecurityMode(identity.tenantId, identity.sessionId, 'safe')
  // Only replace singleton selection; filesystem, authorization and binding
  // validation remain real for both listing and the subsequent manual writes.
  vi.spyOn(workspaceManager, 'bindingReadGuard').mockImplementation((context, expected) => manager.bindingReadGuard(context, expected))
  vi.spyOn(workspaceManager, 'resolveSafePathForSnapshot').mockImplementation((context, snapshot, name) => manager.resolveSafePathForSnapshot(context, snapshot, name))
  vi.spyOn(workspaceManager, 'resolveSafePath').mockImplementation((context, name) => manager.resolveSafePath(context, name))
  vi.spyOn(workspaceManager, 'getScratchDirectory').mockImplementation(context => manager.getScratchDirectory(context))
  vi.spyOn(workspaceManager, 'getBoundDirectory').mockImplementation(context => manager.getBoundDirectory(context))
  app = Fastify()
  app.decorateRequest('authContext', null)
  app.addHook('onRequest', async request => { Object.assign(request, { authContext: { tenantId: identity.tenantId } }) })
  await app.register(workspaceRoutes, { prefix: '/api/v1' })
  await app.ready()
})

afterEach(async () => {
  await app.close()
  clearSecurityMode(identity.tenantId, identity.sessionId)
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  if (path.dirname(fixture) !== path.resolve('.e2e-tmp') || !path.basename(fixture).startsWith('workspace-directory-')) throw new Error('Unsafe directory fixture cleanup')
  fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
})

function listing(name = '.') {
  return app.inject({ method: 'GET', url: `/api/v1/workspace/directory?${new URLSearchParams({ sessionId: identity.sessionId, path: name })}` })
}

it.each(['false', 'true'])('returns an empty first scratch listing without creating storage when AUTH_ENABLED=%s', async authenticated => {
  vi.stubEnv('AUTH_ENABLED', authenticated)
  const expected = manager.getBindingSnapshot(identity)
  expect(fs.existsSync(scratch)).toBe(false)
  for (const name of ['.', scratch]) {
    const response = await listing(name)
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ code: 200, data: {
      root: expected.root, bindingEpoch: expected.epoch, contractVersion: 2, entries: []
    } })
  }
  expect(fs.existsSync(path.join(fixture, 'private'))).toBe(false)
  expect(fs.existsSync(path.join(fixture, 'state', 'bindings.json'))).toBe(false)
})

it.each([
  { route: 'file', name: 'notes/first.txt', directory: false },
  { route: 'folder', name: 'notes/drafts', directory: true }
])('a first manual $route create materializes the scratch after its empty listing', async ({ route, name, directory }) => {
  const initial = (await listing()).json<{ code: number; data: { root: string; bindingEpoch: string } }>()
  expect(initial.code).toBe(200)
  expect(fs.existsSync(scratch)).toBe(false)
  const created = await app.inject({ method: 'POST', url: `/api/v1/workspace/${route}/create`, payload: { sessionId: identity.sessionId, path: name } })
  expect(created.json()).toMatchObject({ code: 200, data: { path: name } })
  const target = path.join(scratch, name)
  expect(fs.statSync(target).isDirectory()).toBe(directory)
  if (!directory) expect(fs.readFileSync(target, 'utf8')).toBe('')
  expect((await listing()).json()).toMatchObject({ code: 200, data: {
    root: initial.data.root, bindingEpoch: initial.data.bindingEpoch,
    entries: [{ name: 'notes', path: 'notes', isDirectory: true }]
  } })
  expect((await listing('notes')).json()).toMatchObject({ code: 200, data: {
    entries: [{ name: path.basename(name), path: name, isDirectory: directory }]
  } })
})

it.each([false, true])('does not turn a missing child into an empty listing when its scratch exists=%s', async exists => {
  if (exists) fs.mkdirSync(scratch, { recursive: true })
  const response = await listing('missing-child')
  expect(response.json()).toMatchObject({ code: 40400 })
  expect(response.json().message).toContain('ENOENT')
  expect(fs.existsSync(path.join(scratch, 'missing-child'))).toBe(false)
})

it('keeps a missing explicit selection as an error without replacing it with scratch', async () => {
  manager.bind(identity, project)
  const moved = path.join(fixture, 'moved-project')
  fs.renameSync(project, moved)
  const response = await listing()
  expect(response.json()).toMatchObject({ code: 40400, message: 'Bound workspace is no longer available' })
  expect(fs.existsSync(project)).toBe(false)
  expect(fs.existsSync(scratch)).toBe(false)
  expect(fs.existsSync(moved)).toBe(true)
})

it('does not treat access errors at an unbound scratch root as an empty directory', async () => {
  const inaccessible = Object.assign(new Error('scratch access denied'), { code: 'EACCES' })
  vi.spyOn(fsp, 'stat').mockRejectedValueOnce(inaccessible)
  expect((await listing()).json()).toMatchObject({ code: 40400, message: 'scratch access denied' })
  expect(fs.existsSync(scratch)).toBe(false)
})

it('rejects an empty-root response if the session selects a project during the read', async () => {
  vi.spyOn(fsp, 'stat').mockImplementationOnce(async () => {
    manager.bind(identity, project)
    throw Object.assign(new Error('scratch disappeared during read'), { code: 'ENOENT' })
  })
  expect((await listing()).json()).toMatchObject({ code: 40400 })
  expect(manager.getBoundDirectory(identity)).toBe(fs.realpathSync(project))
  expect((await listing()).json()).toMatchObject({ code: 200, data: { root: fs.realpathSync(project), entries: [] } })
})

it('keeps out-of-workspace requests rejected before the empty-root fallback', async () => {
  expect((await listing('../other-session')).json()).toMatchObject({ code: 40400 })
  expect(fs.existsSync(scratch)).toBe(false)
})
