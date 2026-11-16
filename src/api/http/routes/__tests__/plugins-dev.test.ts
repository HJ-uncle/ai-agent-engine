import fs from 'node:fs'
import path from 'node:path'
import Fastify, { type FastifyRequest } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPluginProject } from '../../../../plugins/project.js'
import { getDevPlugin } from '../../../../plugins/dev-session.js'
import { pluginRoutes } from '../plugins.js'
import { configureRequestAuthentication } from '../../middleware.js'
import type { AuthContext } from '../../../../auth/types.js'
import { PluginService } from '../../../../plugins/service.js'
import { getPluginTemplate } from '../../../../plugins/templates.js'
import { devCapabilityAccess } from '../../../../plugins/dev-session.js'
import { randomUUID } from 'node:crypto'
import * as agentCapabilities from '../../../../plugins/agent-capability.js'
import { closeDb } from '../../../../storage/sqlite/db.js'

let root: string, app: ReturnType<typeof Fastify>, principal: AuthContext
const fixtures = path.resolve('.e2e-tmp/plugin-dev-http'), headers = { 'x-aether-instance-token': 'fixture-owned-instance-token' }
beforeEach(async () => {
  fs.mkdirSync(fixtures, { recursive: true }); root = fs.mkdtempSync(path.join(fixtures, 'case-'))
  vi.stubEnv('DATA_DIR', path.join(root, 'state', 'agent.db')); vi.stubEnv('AUTH_ENABLED', 'false'); vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('AETHER_INSTANCE_TOKEN', headers['x-aether-instance-token']); vi.stubEnv('AETHER_DEV_PLUGIN_ROOTS', root); vi.stubEnv('DEFAULT_SECURITY_MODE', 'standard')
  vi.stubEnv('OSM_MODE', 'off'); vi.stubEnv('WORKSPACE_ROOT', path.join(root, 'workspace')); vi.stubEnv('AETHER_GLOBAL_DIR', path.join(root, 'global')); vi.stubEnv('MCP_CONFIG_PATH', path.join(root, 'mcp.json'))
  configureRequestAuthentication({ desktopOwned: true, listenHost: '127.0.0.1' })
  principal = { tenantId: 'alice', userId: 'alice', roles: ['tenant-admin'], method: 'jwt' } as AuthContext
  app = Fastify({ bodyLimit: 100 * 1024 * 1024 }); app.addHook('onRequest', async (request: FastifyRequest) => { (request as typeof request & { authContext: AuthContext }).authContext = principal }); await app.register(pluginRoutes)
})
afterEach(async () => {
  await app.close(); await closeDb(); vi.restoreAllMocks(); vi.unstubAllEnvs(); configureRequestAuthentication()
  if (path.dirname(root) !== fixtures || !path.basename(root).startsWith('case-')) throw new Error('Unsafe dev HTTP fixture cleanup')
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 })
  if (!fs.readdirSync(fixtures).length) fs.rmdirSync(fixtures)
})
async function open() {
  const directory = path.join(root, 'project'); createPluginProject(directory, 'json-tool', 'dev-http')
  const result = await app.inject({ method: 'POST', url: '/plugins/dev/open', payload: { path: directory }, headers }); expect(result.statusCode, result.body).toBe(200)
  return result.json().data.session
}
function listedTool(response: { json(): { data: { tools: Array<{ name: string }> } } }, name: string) {
  return response.json().data.tools.find(tool => tool.name === name)
}
describe('local development plugin HTTP API', () => {
  it('routes authenticated host replies with server-owned identity and rejects approval payload injection', async () => {
    const service = new PluginService(), input = getPluginTemplate('json-tool')
    input.manifest.permissions = { requested: ['agents.manage'] }
    await service.create('alice', input); await service.publish('alice', input.manifest.id, 1)
    await service.setPermissionGrants('alice', input.manifest.id, ['agents.manage'], 1)
    const reply = vi.spyOn(agentCapabilities, 'respondPluginAgent').mockImplementation(async (_access, _tenant, answer, execution) => {
      expect(execution?.browserPrincipal).toMatchObject({ tenantId: 'alice', userId: 'alice', method: 'jwt' })
      expect(execution?.browserAuthority).toEqual({ kind: 'account', tenantId: 'alice', userId: 'alice' })
      expect(execution?.controllerSubject).toMatchObject({ tenantId: 'alice', kind: 'account', method: 'jwt' })
      expect(execution?.workspaceContext).toEqual({ tenantId: 'alice', sessionId: 'host-session' })
      expect(answer).toEqual({ runId: 'owned-run', requestId: 'request', toolCallId: 'call', output: 'approved' })
      await execution?.onEvent?.({ type: 'text-delta', text: 'Resumed result', runId: answer.runId })
      return { runId: answer.runId, status: 'succeeded' }
    })
    const url = `/plugins/${input.manifest.id}/agents/owned-run/respond`
    const payload = { expectedRevision: 1, sessionId: 'host-session', requestId: 'request', toolCallId: 'call', output: 'approved' }
    vi.stubEnv('AUTH_ENABLED', 'true'); configureRequestAuthentication({ desktopOwned: false, listenHost: '0.0.0.0' })
    principal = { ...principal, roles: ['plugin-manager'] }
    const response = await app.inject({ method: 'POST', url, payload, remoteAddress: '192.0.2.1' })
    expect(response.statusCode, response.body).toBe(200)
    const events = response.body.split('\n').filter((line: string) => line.startsWith('data: ')).map((line: string) => JSON.parse(line.slice(6)))
    expect(events.map((event: { type: string }) => event.type)).toEqual(['text-delta', 'complete'])
    expect(events.at(-1).result).toMatchObject({ status: 'succeeded' })
    expect(reply).toHaveBeenCalledTimes(1)
    expect((await app.inject({ method: 'POST', url, payload: { ...payload, pendingAction: { operation: 'forged' } } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url, payload: { ...payload, browserPrincipal: { userId: 'other-user' } } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url, payload: { ...payload, expectedRevision: 2 } })).statusCode).toBe(409)
    principal = { ...principal, roles: ['viewer'] }
    expect((await app.inject({ method: 'POST', url, payload })).statusCode).toBe(403)
    expect(reply).toHaveBeenCalledTimes(1)
  })

  it('requires a trusted host before accepting replies even when local plugin management is open', async () => {
    principal = { tenantId: 'default', roles: [], method: 'none' } as AuthContext
    const response = await app.inject({ method: 'POST', url: '/plugins/anything/agents/run/respond', payload: {
      expectedRevision: 1, sessionId: 'host-session', requestId: 'request', toolCallId: 'call', output: 'approved',
    } })
    expect(response.statusCode, response.body).toBe(403)
    expect(response.body).toContain('宿主窗口')
  })

  it('binds development host replies to the exact currently granted source revision', async () => {
    const current = await open(), manifestPath = path.join(current.path, 'aether-plugin.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); manifest.permissions = { requested: ['agents.manage'] }
    fs.writeFileSync(manifestPath, JSON.stringify(manifest))
    const endpoint = `/plugins/dev/${current.devSessionId}`
    const refreshed = (await app.inject({ method: 'POST', url: `${endpoint}/refresh`, headers })).json().data.session
    const payload = { revision: refreshed.revision, hash: refreshed.hash, sessionId: 'host-session', requestId: 'request', toolCallId: 'call', output: 'answer' }
    const url = `${endpoint}/agents/dev-owned-run/respond`
    expect((await app.inject({ method: 'POST', url, headers, payload })).statusCode).toBe(403)
    await app.inject({ method: 'PUT', url: `${endpoint}/permissions`, headers, payload: { grants: ['agents.manage'], revision: refreshed.revision, hash: refreshed.hash } })
    const reply = vi.spyOn(agentCapabilities, 'respondPluginAgent').mockImplementation(async (access, tenantId, answer, execution) => {
      expect(access.id).toBe(`dev:${current.devSessionId}`); expect(tenantId).toBe('alice')
      expect(execution?.browserPrincipal?.userId).toBe('alice')
      return { runId: answer.runId, status: 'succeeded' }
    })
    expect((await app.inject({ method: 'POST', url, headers, payload })).statusCode).toBe(200)
    expect(reply).toHaveBeenCalledTimes(1)
    fs.appendFileSync(path.join(current.path, 'main.mjs'), '\n// changed after user saw the pending request\n')
    expect((await app.inject({ method: 'POST', url, headers, payload })).statusCode).toBe(409)
    expect(reply).toHaveBeenCalledTimes(1)
  })
  it('lists real tools for an ungranted draft and keeps user-owned disabled choices across publication', async () => {
    const service = new PluginService(), input = getPluginTemplate('json-tool'), marker = path.join(root, 'must-not-execute.txt')
    input.manifest.permissions = { requested: ['agents.read', 'agents.manage', 'engine.tools', 'settings.read', 'settings.write'] }
    input.files['main.mjs'] = `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'executed');console.log('{}')`
    await service.create('alice', input)
    const endpoint = `/plugins/${input.manifest.id}/agent-tools`
    const first = await app.inject({ url: endpoint, headers })
    expect(first.statusCode, first.body).toBe(200)
    expect(listedTool(first, 'read_file')).toMatchObject({ enabled: false, available: false })
    expect(listedTool(first, 'write_file')).toBeDefined()
    const changed = await app.inject({ method: 'PUT', url: endpoint, headers, payload: { disabledTools: ['read_file'], expectedRevision: 1 } })
    expect(changed.statusCode, changed.body).toBe(200)
    expect(changed.json().data.plugin.agentDisabledTools).toEqual(['read_file'])
    await service.update('alice', input.manifest.id, { ...input, expectedRevision: 1 })
    await service.publish('alice', input.manifest.id, 2)
    await service.setPermissionGrants('alice', input.manifest.id, input.manifest.permissions.requested, 2)
    const after = await app.inject({ url: endpoint, headers })
    expect(after.statusCode, after.body).toBe(200)
    expect(listedTool(after, 'read_file')).toMatchObject({ enabled: false, reason: '已由用户禁用' })
    expect(listedTool(after, 'write_file')).toMatchObject({ enabled: true })
    await service.setSettings('alice', input.manifest.id, { agentDisabledTools: [] })
    expect((await service.get('alice', input.manifest.id)).agentDisabledTools).toEqual(['read_file'])
    const sdk = await app.inject({ method: 'POST', url: `/plugins/${input.manifest.id}/capabilities/invoke`, headers,
      payload: { capability: 'agents.read', method: 'tools', args: { disabledTools: [] }, expectedRevision: 2 } })
    expect(sdk.json().data.result.tools.find((tool: { name: string }) => tool.name === 'read_file')).toMatchObject({ enabled: false })
    expect((await app.inject({ method: 'PUT', url: endpoint, headers, payload: { disabledTools: [], expectedRevision: 1 } })).statusCode).toBe(409)
    expect(fs.existsSync(marker)).toBe(false)
    principal = { ...principal, roles: ['viewer'] }
    expect((await app.inject({ method: 'PUT', url: endpoint, headers, payload: { disabledTools: [], expectedRevision: 2 } })).statusCode).toBe(403)
  })
  it('lists ungranted development tools and preserves management-only disabled choices after source refresh', async () => {
    const current = await open(), endpoint = `/plugins/dev/${current.devSessionId}`
    const first = await app.inject({ url: `${endpoint}/agent-tools`, headers })
    expect(first.statusCode, first.body).toBe(200)
    expect(listedTool(first, 'read_file')).toMatchObject({ enabled: false })
    const saved = await app.inject({ method: 'PUT', url: `${endpoint}/agent-tools`, headers,
      payload: { disabledTools: ['read_file'], revision: current.revision, hash: current.hash } })
    expect(saved.statusCode, saved.body).toBe(200)
    fs.appendFileSync(path.join(current.path, 'main.mjs'), '\n// developer changes source\n')
    const refreshed = (await app.inject({ method: 'POST', url: `${endpoint}/refresh`, headers })).json().data.session
    expect(refreshed.agentDisabledTools).toEqual(['read_file'])
    const access = devCapabilityAccess('alice', current.devSessionId, refreshed)
    await access.setSettings({ agentDisabledTools: [] })
    expect((await access.refresh!()).agentDisabledTools).toEqual(['read_file'])
    const after = await app.inject({ url: `${endpoint}/agent-tools`, headers })
    expect(after.statusCode, after.body).toBe(200)
    expect(listedTool(after, 'read_file')).toMatchObject({ enabled: false, reason: '已由用户禁用' })
    expect((await app.inject({ method: 'PUT', url: `${endpoint}/agent-tools`, headers,
      payload: { disabledTools: [], revision: current.revision, hash: current.hash } })).statusCode).toBe(409)
    expect((await app.inject({ method: 'PUT', url: `${endpoint}/agent-tools`,
      payload: { disabledTools: [], revision: refreshed.revision, hash: refreshed.hash } })).statusCode).toBe(403)
  })
  it('opens and runs in the formal local desktop, and closes without installing', async () => {
    const current = await open()
    const invoked = await app.inject({ method: 'POST', url: `/plugins/dev/${current.devSessionId}/invoke`, headers, payload: { tool: 'normalize_text', args: { text: ' a  b ' }, revision: current.revision, hash: current.hash } })
    expect(invoked.statusCode, invoked.body).toBe(200); expect(invoked.json().data.result).toEqual({ text: 'a b', characters: 3 })
    const refreshed = await app.inject({ method: 'POST', url: `/plugins/dev/${current.devSessionId}/refresh`, headers, payload: {} })
    expect(refreshed.json().data.session.revision).toBe(1)
    expect((await app.inject({ method: 'POST', url: `/plugins/dev/${current.devSessionId}/close`, headers })).json().data.closed).toBe(true)
    expect((await app.inject({ url: `/plugins/dev/${current.devSessionId}`, headers })).statusCode).toBe(404)
    expect(fs.existsSync(path.join(root, 'state', 'plugins'))).toBe(false)
  })
  it('inherits the normal HTTP body budget for plugin projects and host events', async () => {
    const input = getPluginTemplate('json-tool')
    input.files['resources/large.txt'] = 'x'.repeat(6 * 1024 * 1024)
    const created = await app.inject({ method: 'POST', url: '/plugins', headers, payload: input })
    expect(created.statusCode, created.body.slice(0, 300)).toBe(200)
    const updated = await app.inject({ method: 'PUT', url: `/plugins/${input.manifest.id}`, headers, payload: { ...input, expectedRevision: 1 } })
    expect(updated.statusCode, updated.body.slice(0, 300)).toBe(200)
    const emitted = await app.inject({ method: 'POST', url: '/plugins/runtime/events', headers,
      payload: { event: 'message.created', eventId: randomUUID(), sessionId: 'bound', payload: { text: 'x'.repeat(128 * 1024) } } })
    expect(emitted.statusCode, emitted.body.slice(0, 300)).toBe(200)
  })
  it('rejects remote peers, missing instance tokens and untrusted startup', async () => {
    const payload = { path: root }
    expect((await app.inject({ method: 'POST', url: '/plugins/dev/open', payload })).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: '/plugins/dev/open', headers, payload, remoteAddress: '192.0.2.1' })).statusCode).toBe(403)
    configureRequestAuthentication({ desktopOwned: false, listenHost: '127.0.0.1' })
    expect((await app.inject({ method: 'POST', url: '/plugins/dev/open', headers, payload })).statusCode).toBe(403)
  })
  it('releases open sessions during server shutdown', async () => {
    const current = await open(); await app.close()
    expect(() => getDevPlugin('alice', current.devSessionId)).toThrow('不存在')
  })
  it('authorizes the current development revision through the permission endpoint', async () => {
    const current = await open(), manifestPath = path.join(current.path, 'aether-plugin.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); manifest.permissions = { requested: ['settings.read'] }; fs.writeFileSync(manifestPath, JSON.stringify(manifest))
    const refreshed = (await app.inject({ method: 'POST', url: `/plugins/dev/${current.devSessionId}/refresh`, headers })).json().data.session
    const endpoint = `/plugins/dev/${current.devSessionId}`
    const payload = { capability: 'settings.read', method: 'get', args: {}, expectedRevision: refreshed.revision, hash: refreshed.hash }
    expect((await app.inject({ method: 'POST', url: `${endpoint}/capabilities/invoke`, headers, payload })).statusCode).toBe(403)
    const allowed = await app.inject({ method: 'PUT', url: `${endpoint}/permissions`, headers, payload: { grants: ['settings.read'], revision: refreshed.revision, hash: refreshed.hash } })
    expect(allowed.json().data.session.permissionGrants).toEqual(['settings.read'])
    expect((await app.inject({ method: 'POST', url: `${endpoint}/capabilities/invoke`, headers, payload })).json().data.result).toEqual({})
    principal = { ...principal, tenantId: 'bob' }
    expect((await app.inject({ method: 'GET', url: endpoint, headers })).statusCode).toBe(404)
  })
})
