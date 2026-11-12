import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext } from '../../core/agent-context/types.js'
import * as database from '../../storage/sqlite/db.js'
import { ChangeStore } from '../../storage/changes/index.js'
import { PluginService } from '../service.js'
import { createSelectedPluginTools, pluginCatalogue, pluginToolkitId } from '../catalogue.js'
import { createPluginManagementTools } from '../management-tools.js'
import { pluginRoutes } from '../../api/http/routes/plugins.js'
import { setSecurityMode, clearSecurityMode } from '../../security/policy-engine.js'
import { createToolRegistry } from '../../tools/registry-factory.js'
import { normalizeToolkits } from '../../tools/toolkits.js'
import type { CreatePluginInput } from '../types.js'

let root: string, db: Client, service: PluginService, ctx: AgentContext
const input = (value = 7): CreatePluginInput => ({ manifest: { apiVersion: 1, id: 'fixture-plugin', name: 'Fixture Plugin', version: String(value), description: 'Fixture', runtime: 'node',
  tools: [{ name: 'calculate', description: 'Calculate', inputSchema: { type: 'object', properties: {} }, entry: 'main.mjs' }] },
  files: { 'main.mjs': `let text='';for await(const c of process.stdin)text+=c;const {args}=JSON.parse(text);console.log(JSON.stringify({result:${value},artifacts:args.artifacts??[]}))` } })
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-integration-'))
  vi.stubEnv('DATA_DIR', path.join(root, 'state', 'agent.db')); vi.stubEnv('AUTH_ENABLED', 'false'); vi.stubEnv('OSM_MODE', 'off')
  db = createClient({ url: 'file::memory:' }); vi.spyOn(database, 'getDb').mockReturnValue(db)
  service = new PluginService()
  ctx = { tenantId: 'default', sessionId: 'plugin-test', workspacePaths: [root], projectRoot: root, cwd: root, toolProfile: 'general',
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as unknown as AgentContext
  setSecurityMode(ctx.tenantId, ctx.sessionId, 'standard')
})
afterEach(() => {
  db.close(); clearSecurityMode(ctx.tenantId, ctx.sessionId); vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('plugin-integration-')) throw new Error('Unsafe test cleanup')
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 })
})
describe('plugin HTTP, capability and approval integration', () => {
  it('reports explicit plugin failures through REST tests, approved model tests and exported tools even when the child exits zero', async () => {
    const authored = input()
    authored.files['main.mjs'] = 'console.log(JSON.stringify({error:{code:"NO_INPUT",message:"request payload missing"}}))'
    await service.create('default', authored); await service.publish('default', 'fixture-plugin', 1)
    const app = Fastify(); await app.register(pluginRoutes)
    try {
      const response = await app.inject({ method: 'POST', url: '/plugins/fixture-plugin/test', payload: { tool: 'calculate', args: {} } })
      expect(response.statusCode).toBe(400)
      expect(response.json().message).toContain('[NO_INPUT] request payload missing')
    } finally { await app.close() }
    const modelTest = createPluginManagementTools(service).find(tool => tool.name === 'plugin_test')!
    ctx.currentToolCallId = 'test-explicit-error'
    const args = { id: 'fixture-plugin', revision: 1, tool: 'calculate', args: {} }
    const pending = await modelTest.preflight!(args, ctx)
    expect(pending?.needsConfirmation).toBe(true)
    ctx.approvedToolCallId = ctx.currentToolCallId
    ctx.resumeToolCall = { toolCall: { id: ctx.currentToolCallId, name: modelTest.name, args }, decision: 'approved', pendingAction: pending!.pendingAction }
    const tested = await modelTest.execute(args, ctx)
    expect(tested.success).toBe(false); expect(tested.output).toContain('[NO_INPUT] request payload missing')
    const [selected] = await createSelectedPluginTools('default', [pluginToolkitId('fixture-plugin', 1)])
    const execution = await selected.execute({}, ctx)
    expect(execution.success).toBe(false); expect(execution.output).toContain('[NO_INPUT] request payload missing')
  })
  it('handles actual HTTP draft/test/publish/update/conflict/disable/delete lifecycle', async () => {
    const app = Fastify(); await app.register(pluginRoutes)
    const call = async (method: 'GET'|'POST'|'PUT'|'PATCH'|'DELETE', url: string, payload?: unknown) => (await app.inject({ method, url, ...(payload ? { payload } : {}) })).json()
    try {
      expect((await call('POST', '/plugins', input())).data.plugin.enabled).toBe(false)
      expect((await call('POST', '/plugins/fixture-plugin/test', { tool: 'calculate', args: {} })).data.result).toBe(7)
      expect((await call('POST', '/plugins/fixture-plugin/publish', { expectedRevision: 1 })).data.plugin.publishedRevision).toBe(1)
      expect((await call('PUT', '/plugins/fixture-plugin', { ...input(8), expectedRevision: 1 })).data.plugin.revision).toBe(2)
      expect((await call('PUT', '/plugins/fixture-plugin', { ...input(9), expectedRevision: 1 })).statusCode).toBe(409)
      expect((await call('GET', '/plugins')).data.plugins[0].files).toBeUndefined()
      expect((await call('PATCH', '/plugins/fixture-plugin', { enabled: false })).data.plugin.enabled).toBe(false)
      expect((await pluginCatalogue('default'))[0].available).toBe(false)
      expect((await call('DELETE', '/plugins/fixture-plugin')).data.deleted).toBe(true)
    } finally { await app.close() }
  })
  it('pins revisions, checks ceilings and rejects forged/draft/other-tenant selections', async () => {
    await service.create('default', input()); await service.publish('default', 'fixture-plugin', 1)
    const selected = [pluginToolkitId('fixture-plugin', 1)]
    const tools = await createSelectedPluginTools('default', selected)
    await service.update('default', 'fixture-plugin', { ...input(8), expectedRevision: 1 })
    expect(JSON.parse((await tools[0].execute({}, ctx)).output).result).toBe(7)
    expect((await pluginCatalogue('default'))[0].description).toBe('Fixture')
    await expect(createSelectedPluginTools('default', [pluginToolkitId('fixture-plugin', 2)])).rejects.toThrow()
    await expect(createSelectedPluginTools('other', selected)).rejects.toThrow()
    await expect(createSelectedPluginTools('default', selected, [[]])).rejects.toThrow()
    expect(() => normalizeToolkits(['plugin-../../bad--r1'])).toThrow()
    await service.publish('default', 'fixture-plugin', 2)
    expect(JSON.parse((await (await createSelectedPluginTools('default', selected))[0].execute({}, ctx)).output).result).toBe(7)
    setSecurityMode('default', ctx.sessionId, 'safe')
    expect((await tools[0].execute({}, ctx)).metadata?.blocked).toBe(true)
    setSecurityMode('default', ctx.sessionId, 'standard')
    await service.setEnabled('default', 'fixture-plugin', false)
    expect((await tools[0].execute({}, ctx)).success).toBe(false)
  })
  it('writes exact text/binary artifacts with revert receipts and rejects overwrite before any writes', async () => {
    await service.create('default', input()); await service.publish('default', 'fixture-plugin', 1)
    const [tool] = await createSelectedPluginTools('default', [pluginToolkitId('fixture-plugin', 1)])
    const artifacts = [{ path: 'products/中文.json', content: '{ "a": 1 }\r\n' }, { path: 'products/image.bin', content: Buffer.from([0,255,128]).toString('base64'), encoding: 'base64' }]
    const result = await tool.execute({ artifacts }, ctx)
    expect(result.success, result.output).toBe(true); expect(result.changes).toHaveLength(2)
    expect(fs.readFileSync(path.join(root, artifacts[0].path), 'utf8')).toBe(artifacts[0].content)
    expect(fs.readFileSync(path.join(root, artifacts[1].path))).toEqual(Buffer.from([0,255,128]))
    const store = new ChangeStore(); expect(await store.list('default', ctx.sessionId)).toHaveLength(2)
    const conflict = await tool.execute({ artifacts: [{ path: 'new.txt', content: 'should not exist' }, artifacts[0]] }, ctx)
    expect(conflict.success).toBe(false); expect(fs.existsSync(path.join(root, 'new.txt'))).toBe(false)
    await store.revertBatch('default', { sessionId: ctx.sessionId })
    expect(fs.existsSync(path.join(root, 'products'))).toBe(false)
  })
  it('freezes exact AI approvals and never writes when argument or revision changes', async () => {
    const tool = createPluginManagementTools(service).find(tool => tool.name === 'plugin_create')!
    ctx.currentToolCallId = 'create-call'
    const args = input(), pending = await tool.preflight!(args, ctx)
    expect(pending?.needsConfirmation).toBe(true); expect(await service.list('default')).toHaveLength(0)
    ctx.approvedToolCallId = 'create-call'; ctx.resumeToolCall = { toolCall: { id: 'create-call', name: tool.name, args: args as unknown as Record<string, unknown> }, decision: 'approved', pendingAction: pending!.pendingAction }
    expect((await tool.execute(input(8), ctx)).success).toBe(false)
    const result = await tool.execute(args, ctx)
    expect(result.success, result.output).toBe(true); expect(result.metadata?.resourceChange).toEqual({ kind: 'plugin', action: 'create', id: 'fixture-plugin' })
  })
  it('keeps the default registry lean and exposes only explicitly selected trusted plugin objects', async () => {
    await service.create('default', input()); await service.publish('default', 'fixture-plugin', 1)
    const opts = { allowedMcpServers: [], allowedSkills: [], strictSkillBindings: true, securityContext: { tenantId: 'default', sessionId: ctx.sessionId } }
    expect((await createToolRegistry(opts)).registry.list().some(tool => tool.name.startsWith('plugin_'))).toBe(false)
    const selected = await createToolRegistry({ ...opts, toolkits: [pluginToolkitId('fixture-plugin', 1)] })
    expect(selected.registry.listForRequest().some(tool => tool.name === 'plugin_fixture_plugin_calculate')).toBe(true)
    selected.registry.register({ name: 'plugin_forged', source: 'plugin', description: '', parameters: {}, execute: async () => ({ success: true, output: '' }) })
    expect(selected.registry.has('plugin_forged')).toBe(false)
  })
})
