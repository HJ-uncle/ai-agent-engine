import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import Fastify, { type FastifyInstance } from 'fastify'
import { LocalSqliteProcessClient } from '../../storage/sqlite/local-process-client.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as database from '../../storage/sqlite/db.js'
import { up as migrateAgents } from '../../storage/sqlite/migrations/004_add_agents.js'
import { up as migrateTools } from '../../storage/sqlite/migrations/008_add_agent_allowed_tools.js'
import { AgentManagementService } from '../../core/agent-management.js'
import { toolRoutes } from '../../api/http/routes/tools.js'
import { createToolRegistry } from '../../tools/registry-factory.js'
import { PluginService } from '../service.js'
import { pluginCatalogue, pluginToolDefinitions, pluginToolkitId } from '../catalogue.js'
import type { CreatePluginInput } from '../types.js'

let root: string, db: LocalSqliteProcessClient, service: PluginService, manager: AgentManagementService, app: FastifyInstance
const input = (id = 'own-plugin', name = 'Own plugin', tool = 'calculate'): CreatePluginInput => ({
  manifest: { apiVersion: 1, id, name, version: '1', description: name, runtime: 'node',
    tools: [{ name: tool, description: name + ' tool', inputSchema: { type: 'object' }, entry: 'main.mjs' }] },
  files: { 'main.mjs': 'console.log(JSON.stringify({result:7}))' },
})
async function published(tenantId: string, id = 'own-plugin', name = 'Own plugin') {
  await service.create(tenantId, input(id, name))
  await service.publish(tenantId, id, 1)
}
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-agent-catalogue-'))
  vi.stubEnv('DATA_DIR', path.join(root, 'state', 'agent.db'))
  vi.stubEnv('AUTH_ENABLED', 'false'); vi.stubEnv('OSM_MODE', 'off')
  db = new LocalSqliteProcessClient({ url: pathToFileURL(path.join(root, 'agents.db')).href }); vi.spyOn(database, 'getDb').mockReturnValue(db)
  await db.execute('CREATE TABLE conversations(id TEXT PRIMARY KEY)')
  await migrateAgents(db); await migrateTools(db)
  service = new PluginService()
  manager = new AgentManagementService(undefined, async () => ['read_file'])
  app = Fastify()
  app.addHook('onRequest', async request => { (request as any).authContext = { tenantId: request.headers['x-test-tenant'] ?? 'alice', method: 'none' } })
  await app.register(toolRoutes)
})
afterEach(async () => {
  await app.close(); db.close(); await db.whenClosed(); vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('plugin-agent-catalogue-')) throw new Error('Unsafe catalogue cleanup')
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 })
})

describe('tenant-owned published plugin capabilities in Agent configuration', () => {
  it('returns only published definitions from that tenant, including disabled versions, without executable objects or draft schemas', async () => {
    await published('alice')
    await published('bob', 'own-plugin', 'Bob private')
    await service.create('alice', input('draft-only'))
    await service.update('alice', 'own-plugin', { ...input('own-plugin', 'Draft changed', 'unpublished_tool'), expectedRevision: 1 })
    await service.setEnabled('alice', 'own-plugin', false)
    const own = await pluginToolDefinitions('alice')
    expect(own).toHaveLength(1)
    expect(own[0]).toMatchObject({ name: 'plugin_own_plugin_calculate', displayName: 'Own plugin · calculate', source: 'plugin' })
    expect(own[0]).not.toHaveProperty('execute')
    expect(own[0].description).not.toContain('Draft changed')
    expect((await pluginToolDefinitions('bob'))[0].displayName).toContain('Bob private')
    expect(await pluginToolDefinitions('empty')).toEqual([])
    expect((await pluginCatalogue('alice'))[0].available).toBe(false)
  })

  it.each(['/tools', '/system-tools'])('adds tenant plugin metadata to %s and filters Agent ceilings without changing runtime exposure', async endpoint => {
    await published('alice')
    await published('bob', 'bob-private', 'Bob private')
    const response = await app.inject(endpoint)
    expect(response.statusCode).toBe(200)
    const pluginItems = response.json().data.filter((tool: any) => tool.source === 'plugin')
    expect(pluginItems).toEqual([expect.objectContaining({ name: 'plugin_own_plugin_calculate', defaultEnabled: false, source: 'plugin' })])
    const other = await app.inject({ url: endpoint, headers: { 'x-test-tenant': 'bob' } })
    expect(other.json().data.filter((tool: any) => tool.source === 'plugin').map((tool: any) => tool.name)).toEqual(['plugin_bob_private_calculate'])
    const allowed = await manager.create('alice', { name: 'Allowed', allowedTools: ['read_file', 'plugin_own_plugin_calculate'] })
    const denied = await manager.create('alice', { name: 'Denied', allowedTools: ['read_file'] })
    expect((await app.inject(endpoint + '?agentId=' + allowed.id)).json().data.some((tool: any) => tool.name === 'plugin_own_plugin_calculate')).toBe(true)
    expect((await app.inject(endpoint + '?agentId=' + denied.id)).json().data.some((tool: any) => tool.source === 'plugin')).toBe(false)
    expect((await app.inject(endpoint + '?agentId=missing')).json().data.some((tool: any) => tool.source === 'plugin')).toBe(false)
    expect((await app.inject({ url: endpoint, headers: { 'x-aether-tool-profile': 'code' } })).json().data.some((tool: any) => tool.source === 'plugin')).toBe(false)
    expect((await createToolRegistry({ securityContext: { tenantId: 'alice', sessionId: 'default-test' },
      allowedTools: allowed.allowedTools, allowedMcpServers: [], allowedSkills: [], strictSkillBindings: true })).registry.has('plugin_own_plugin_calculate')).toBe(false)
    const selected = await createToolRegistry({ securityContext: { tenantId: 'alice', sessionId: 'selected-test' },
      allowedTools: allowed.allowedTools, toolkitAllowedTools: allowed.allowedTools,
      toolkits: [pluginToolkitId('own-plugin', 1)], allowedMcpServers: [], allowedSkills: [], strictSkillBindings: true })
    expect(selected.registry.listForRequest().some(tool => tool.name === 'plugin_own_plugin_calculate')).toBe(true)
    expect((await pluginCatalogue('alice', [allowed.allowedTools]))[0].available).toBe(true)
    expect((await pluginCatalogue('alice', [denied.allowedTools]))[0].available).toBe(false)
  })

  it('accepts owned published plugin names and rejects other-tenant, draft-only and forged names in create/update', async () => {
    await published('alice')
    await published('bob', 'bob-private')
    await service.create('alice', input('draft-only'))
    const agent = await manager.create('alice', { name: 'Own', allowedTools: ['plugin_own_plugin_calculate', 'plugin_list'] })
    expect(agent.allowedTools).toContain('plugin_own_plugin_calculate')
    for (const tool of ['plugin_bob_private_calculate', 'plugin_draft_only_calculate', 'plugin_forged_calculate']) {
      await expect(manager.prepareCreate('alice', { name: tool, allowedTools: [tool] })).rejects.toMatchObject({ code: 40001 })
      await expect(manager.prepareUpdate('alice', agent.id, { allowedTools: [tool] })).rejects.toMatchObject({ code: 40001 })
    }
    await service.setEnabled('alice', 'own-plugin', false)
    expect((await manager.update('alice', agent.id, { allowedTools: ['plugin_own_plugin_calculate'] })).allowedTools).toEqual(['plugin_own_plugin_calculate'])
    expect((await pluginCatalogue('alice', [agent.allowedTools]))[0].available).toBe(false)
  })

  it('revalidates tenant-owned published names when an approved preparation is applied after plugin removal', async () => {
    await published('alice')
    const prepared = await manager.prepareCreate('alice', { name: 'Prepared', allowedTools: ['plugin_own_plugin_calculate'] })
    const agent = await manager.create('alice', { name: 'Existing', allowedTools: [] })
    const update = await manager.prepareUpdate('alice', agent.id, { allowedTools: ['plugin_own_plugin_calculate'] })
    await service.remove('alice', 'own-plugin')
    await expect(manager.apply(prepared)).rejects.toMatchObject({ code: 40001 })
    await expect(manager.apply(update)).rejects.toMatchObject({ code: 40001 })
    expect((await manager.get('alice', agent.id)).allowedTools).toEqual([])
  })
})
