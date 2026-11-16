import fs from 'node:fs'
import path from 'node:path'
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invokePluginCapability, type CapabilityAccess } from '../capability-runtime.js'
import { getPluginTemplate } from '../templates.js'
import { PLUGIN_CAPABILITY_IDS, type PluginCapabilityId } from '../capabilities.js'
import { WorkspaceManager, workspaceManager } from '../../workspace/index.js'
import * as database from '../../storage/sqlite/db.js'
import { createKnowledgeBase } from '../../storage/knowledge/kb-repo.js'
import { auditLogStore } from '../../security/audit-log.js'
import { projectDataPath } from '../../core/project-storage.js'

const fixtures = path.resolve('.e2e-tmp/plugin-capability-services')
let root: string, workspace: string, server: ReturnType<typeof Fastify> | undefined, access: CapabilityAccess
beforeEach(async () => {
  fs.mkdirSync(fixtures, { recursive: true }); root = fs.mkdtempSync(path.join(fixtures, 'case-'))
  workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace)
  vi.stubEnv('DATA_DIR', path.join(root, 'state', 'agent.db')); vi.stubEnv('AUTH_ENABLED', 'false'); vi.stubEnv('DEFAULT_SECURITY_MODE', 'full-access')
  vi.stubEnv('MCP_CONFIG_PATH', path.join(root, 'mcp.json')); vi.stubEnv('AETHER_GLOBAL_DIR', path.join(root, 'global'))
  const manager = new WorkspaceManager(workspace)
  await manager.bindSnapshotAsync({ tenantId: 'tenant-a', sessionId: 'bound' }, workspace)
  vi.spyOn(workspaceManager, 'withBindingLease').mockImplementation(manager.withBindingLease.bind(manager))
  vi.spyOn(workspaceManager, 'getBindingSnapshot').mockImplementation(manager.getBindingSnapshot.bind(manager))
  await database.initDb()
  vi.spyOn(auditLogStore, 'append').mockResolvedValue()
  const manifest = getPluginTemplate('json-tool').manifest; manifest.permissions = { requested: [...PLUGIN_CAPABILITY_IDS] }
  access = { id: manifest.id, revision: 1, manifest, grants: [...PLUGIN_CAPABILITY_IDS], getSettings: async () => ({}), setSettings: async value => value }
})
afterEach(async () => {
  await server?.close(); server = undefined; await database.closeDb(); vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (path.dirname(root) !== fixtures || fs.lstatSync(root).isSymbolicLink()) throw new Error('Unsafe capability fixture cleanup')
  await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 })
  if (!fs.readdirSync(fixtures).length) fs.rmdirSync(fixtures)
})
function call(capability: PluginCapabilityId, method: string, args = {}, tenantId = 'tenant-a') {
  return invokePluginCapability(access, tenantId, { capability, method, args, expectedRevision: 1, sessionId: 'bound' })
}
describe('plugin capabilities use real platform storage and transports', () => {
  it('discovers a workspace skill and reads its actual local contents', async () => {
    const directory = projectDataPath(workspace, 'skills', 'plugin-review')
    fs.mkdirSync(directory, { recursive: true })
    const file = path.join(directory, 'SKILL.md')
    const content = '---\nname: plugin-review\ndescription: Review plugin requirements.\n---\n检查选择的消息和真实交付证据。\n'
    fs.writeFileSync(file, content)
    const listed = await call('skills.read', 'list') as { skills: Array<{ id: string; name: string }> }
    const skill = listed.skills.find(item => item.name === 'plugin-review')
    expect(skill).toBeDefined()
    expect(await call('skills.read', 'get', { id: skill!.id })).toEqual({ id: skill!.id, name: 'plugin-review', content })
    fs.unlinkSync(file)
    await expect(call('skills.read', 'get', { id: skill!.id })).rejects.toMatchObject({ code: 'PLUGIN_NOT_FOUND' })
  })
  it('reads and writes disk but rejects traversal and junctions even in full access mode', async () => {
    expect(await call('workspace.write', 'write', { path: 'notes/result.md', content: '完成' })).toEqual({ path: 'notes/result.md', written: true })
    expect(fs.readFileSync(path.join(workspace, 'notes/result.md'), 'utf8')).toBe('完成')
    expect(await call('workspace.read', 'read', { path: 'notes/result.md' })).toMatchObject({ content: '完成', size: 6 })
    const large = 'text'.repeat(300000)
    fs.writeFileSync(path.join(workspace, 'large.txt'), large)
    expect(await call('workspace.read', 'read', { path: 'large.txt' })).toMatchObject({ content: large, size: Buffer.byteLength(large) })
    expect(await call('workspace.read', 'list', { path: 'notes' })).toMatchObject({ entries: [{ name: 'result.md', type: 'file', path: 'notes/result.md' }] })
    await expect(call('workspace.write', 'write', { path: '../escape.txt', content: 'bad' })).rejects.toMatchObject({ code: 'PLUGIN_PATH' })
    await expect(call('workspace.read', 'read', { path: path.join(root, 'outside.txt') })).rejects.toMatchObject({ code: 'PLUGIN_PATH' })
    const linked = path.join(workspace, 'outside'); fs.symlinkSync(root, linked, 'junction')
    try { await expect(call('workspace.write', 'write', { path: 'outside/escape.txt', content: 'bad' })).rejects.toMatchObject({ code: 'PLUGIN_PATH' }) }
    finally { fs.unlinkSync(linked) }
    expect(fs.existsSync(path.join(root, 'escape.txt'))).toBe(false)
    await expect(call('workspace.read', 'read', { path: 'notes/result.md', sessionId: 'other' })).rejects.toThrow()
  })
  it('creates, searches and updates knowledge using tenant-scoped repositories', async () => {
    const base = await createKnowledgeBase('tenant-a', '插件知识测试')
    expect(await call('knowledge.read', 'list')).toMatchObject({ bases: [{ id: base.id, name: '插件知识测试' }] })
    const document = await call('knowledge.write', 'create', { knowledgeBaseId: base.id, filename: 'requirements.txt', content: 'Aetherplugin requires a working host capability bridge.' }) as { id: string }
    expect(await call('knowledge.read', 'get', { id: document.id })).toMatchObject({ filename: 'requirements.txt' })
    const found = await call('knowledge.read', 'search', { query: 'Aetherplugin' }) as { results: unknown[] }
    expect(found.results.length).toBeGreaterThan(0)
    await call('knowledge.write', 'update', { id: document.id, content: 'Aetherplugin validated successfully.' })
    expect(JSON.stringify(await call('knowledge.read', 'get', { id: document.id }))).toContain('validated successfully')
    expect(await call('knowledge.read', 'get', { id: document.id }, 'tenant-b')).toBeNull()
    expect(await call('knowledge.read', 'search', { query: 'Aetherplugin' }, 'tenant-b')).toEqual({ results: [] })
  })
  it('calls an enabled MCP server over real JSON-RPC and rejects disabled tools', async () => {
    const requests: unknown[] = []; server = Fastify()
    server.post('/rpc', async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as { id?: string | number; method: string; params?: unknown }
      if (body.id === undefined) return reply.code(202).send()
      if (body.method === 'initialize') return { jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } }
      if (body.method === 'tools/list') return { jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }, { name: 'disabled', description: 'Disabled', inputSchema: { type: 'object' } }] } }
      requests.push(body.params)
      return { jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'MCP真实传输已完成' }] } }
    })
    const base = await server.listen({ host: '127.0.0.1', port: 0 })
    fs.writeFileSync(path.join(root, 'mcp.json'), JSON.stringify({ mcpServers: { fixture: { name: 'Test MCP', enabled: true, transportType: 'streamableHttp', url: base + '/rpc', headers: { 'x-private': 'not-for-plugin' }, disabledTools: ['disabled'] } } }))
    const listed = await call('mcp.read', 'list')
    expect(listed).toMatchObject({ servers: [{ id: 'fixture', name: 'Test MCP' }] }); expect(JSON.stringify(listed)).not.toContain('not-for-plugin')
    const definitions = await call('mcp.read', 'tools', { serverId: 'fixture' })
    expect(definitions).toEqual({ tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }] })
    expect(JSON.stringify(definitions)).not.toContain('not-for-plugin')
    await expect(call('mcp.read', 'tools', { serverId: 'missing' })).rejects.toMatchObject({ code: 'PLUGIN_FORBIDDEN' })
    expect(await call('mcp.invoke', 'call', { serverId: 'fixture', tool: 'echo', arguments: { text: 'hello' } })).toMatchObject({ output: expect.stringContaining('MCP真实传输已完成') })
    expect(requests).toEqual([{ name: 'echo', arguments: { text: 'hello' } }])
    await expect(call('mcp.invoke', 'call', { serverId: 'fixture', tool: 'disabled' })).rejects.toMatchObject({ code: 'PLUGIN_FORBIDDEN' })
  })
})
