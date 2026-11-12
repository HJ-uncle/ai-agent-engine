import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext, ToolResult } from '../../../core/agent-context/index.js'
import { workspaceManager } from '../../../workspace/index.js'
import { withFileLocks } from '../../../shared/file-version.js'
import { clearSecurityMode, setSecurityMode } from '../../../security/policy-engine.js'
import { assertMcpManagementAccess, McpManagementService, type McpManagementContext } from '../../../storage/mcp/management-service.js'
import { createMcpManagementTools } from '../management-tools.js'
import { HTTPMCPClient } from '../client.js'

const fixtureParent = path.resolve('.e2e-tmp', 'mcp-management')
let root: string, project: string, config: string, context: McpManagementContext, service: McpManagementService
const ctx = (): AgentContext => ({ tenantId: 'default', sessionId: path.basename(root), currentToolCallId: 'call-1',
  managementPrincipal: { tenantId: 'default', method: 'none' }, projectRoot: project }) as AgentContext
const createArgs = () => ({ id: 'example', name: 'Example', scope: 'project', transportType: 'http', url: 'https://example.invalid/mcp' })
function approved(name: string, raw: Record<string, unknown>, waiting: ToolResult, signal?: AbortSignal): AgentContext {
  return { ...ctx(), signal, approvedToolCallId: 'call-1', resumeToolCall: { decision: 'approved',
    toolCall: { id: 'call-1', name, args: raw }, pendingAction: JSON.parse(JSON.stringify(waiting.pendingAction)) } }
}
function seed(entries: Record<string, Record<string, unknown>>, target = config) {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, JSON.stringify({ preservedRootMetadata: true, mcpServers: entries }))
}
const base = () => ({ name: 'Example', transportType: 'http', enabled: false, url: 'https://example.invalid/mcp', unknownField: { keep: true } })
const selected = () => ({ id: 'example', scope: 'project', expectedRevision: service.get(context, 'example', 'project').revision })
async function call(name: string, raw: Record<string, unknown>, manager = service) {
  const tool = createMcpManagementTools(manager).find(tool => tool.name === name)!
  const waiting = await tool.execute(raw, ctx())
  expect(waiting).toMatchObject({ status: 'waiting', needsConfirmation: true })
  return tool.execute(raw, approved(name, raw, waiting))
}

beforeEach(() => {
  fs.mkdirSync(fixtureParent, { recursive: true }); root = fs.mkdtempSync(path.join(fixtureParent, 'fixture-'))
  project = path.join(root, 'project'); fs.mkdirSync(project)
  config = path.join(project, '.ae', 'mcp.json')
  vi.stubEnv('AUTH_ENABLED', 'false'); vi.stubEnv('MCP_CONFIG_PATH', ''); vi.stubEnv('AETHER_GLOBAL_DIR', path.join(root, 'global'))
  context = { tenantId: 'default', sessionId: path.basename(root), projectRoot: project, principal: { tenantId: 'default', method: 'none' } }
  service = new McpManagementService()
  vi.spyOn(workspaceManager, 'getWorkingDirectory').mockImplementation(() => project)
  setSecurityMode(context.tenantId, context.sessionId, 'standard')
})
afterEach(() => {
  clearSecurityMode(context.tenantId, context.sessionId)
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (path.dirname(root) !== fixtureParent || !path.basename(root).startsWith('fixture-')) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

describe('MCP management permissions and frozen configuration', () => {
  it('publishes exactly seven trusted management tools and creates only after approval, disabled by default', async () => {
    const tools = createMcpManagementTools(service)
    expect(tools.map(tool => tool.name)).toEqual(['mcp_server_list', 'mcp_server_get', 'mcp_server_create', 'mcp_server_update', 'mcp_server_set_enabled', 'mcp_server_delete', 'mcp_server_test'])
    expect(tools.every(tool => tool.source === 'builtin')).toBe(true)
    const tool = tools.find(tool => tool.name === 'mcp_server_create')!, raw = createArgs()
    const waiting = await tool.execute(raw, ctx())
    expect(waiting.needsConfirmation).toBe(true); expect(fs.existsSync(config)).toBe(false)
    expect((await tool.execute(raw, approved(tool.name, raw, waiting))).success).toBe(true)
    expect(JSON.parse(fs.readFileSync(config, 'utf8')).mcpServers.example).toMatchObject({ enabled: false, transportType: 'http', url: raw.url })
    expect((await tool.execute(raw, approved(tool.name, raw, waiting))).success).toBe(false)
  })

  it('rejects missing, foreign, unauthenticated and non-manager identities', () => {
    expect(() => assertMcpManagementAccess('default')).toThrow(/可信/)
    expect(() => assertMcpManagementAccess('other', { tenantId: 'other', method: 'jwt', roles: ['admin'] })).toThrow(/共享/)
    expect(() => assertMcpManagementAccess('default', { tenantId: 'other', method: 'jwt', roles: ['admin'] })).toThrow(/可信/)
    expect(() => assertMcpManagementAccess('default', { tenantId: 'default', method: 'jwt', roles: [] })).toThrow(/权限/)
    expect(() => assertMcpManagementAccess('default', { tenantId: 'default', method: 'jwt', roles: ['mcp-manager'] })).not.toThrow()
    vi.stubEnv('AUTH_ENABLED', 'true')
    expect(() => assertMcpManagementAccess('default', context.principal)).toThrow(/权限/)
  })

  it('redacts existing secrets in list/get, approval snapshots, mutation receipts and preserves credentials', async () => {
    const secrets = ['header-secret-123', 'environment-secret-234', 'argument-secret-345', 'url-password-456', 'query-secret-567', 'path-secret-678']
    seed({ example: { ...base(), url: `https://user:${secrets[3]}@example.invalid/${secrets[5]}?token=${secrets[4]}`,
      headers: { Authorization: secrets[0] }, env: { TOKEN: secrets[1] }, args: [secrets[2]], description: 'Header is ' + secrets[0] } })
    const list = service.list(context), get = service.get(context, 'example', 'project')
    const raw = { ...selected(), changes: { name: 'Edited' } }, tool = createMcpManagementTools(service).find(tool => tool.name === 'mcp_server_update')!
    const waiting = await tool.execute(raw, ctx())
    const result = await tool.execute(raw, approved(tool.name, raw, waiting))
    expect(result.success).toBe(true)
    const visible = JSON.stringify({ list, get, waiting, result })
    for (const secret of secrets) expect(visible).not.toContain(secret)
    const saved = JSON.parse(fs.readFileSync(config, 'utf8'))
    expect(saved.preservedRootMetadata).toBe(true)
    expect(saved.mcpServers.example.headers.Authorization).toBe(secrets[0])
    expect(saved.mcpServers.example.url).toContain(secrets[4])
    expect(saved.mcpServers.example.unknownField).toEqual({ keep: true })
  })

  it('does not echo newly submitted URL/args in frozen pendingAction or previews', async () => {
    const raw = { ...createArgs(), url: 'https://example.invalid/path-new-secret?token=query-new-secret' }
    const tool = createMcpManagementTools(service).find(tool => tool.name === 'mcp_server_create')!
    const waiting = await tool.execute(raw, ctx())
    expect(waiting.needsConfirmation).toBe(true)
    expect(JSON.stringify(waiting)).not.toContain('query-new-secret')
    expect(JSON.stringify(waiting)).not.toContain('path-new-secret')
    expect((await tool.execute(raw, approved(tool.name, raw, waiting))).success).toBe(true)
  })

  it('does not echo malformed scalar metadata from an existing file', () => {
    seed({ example: { ...base(), transportType: { token: 'malformed-secret' }, timeoutMs: { token: 'timeout-secret' } } })
    const visible = JSON.stringify(service.list(context))
    expect(visible).not.toContain('malformed-secret'); expect(visible).not.toContain('timeout-secret')
    expect(service.get(context, 'example', 'project')).toMatchObject({ transportType: 'invalid' })
  })

  it('keeps old credentials hidden after removing their transport fields', async () => {
    seed({ example: { ...base(), name: 'Server opaque-secret', description: 'Use opaque-secret', headers: { Authorization: 'Bearer opaque-secret' } } })
    const raw = { ...selected(), changes: { transportType: 'stdio', command: 'node', args: ['--token=new-arg-secret'] } }
    const tool = createMcpManagementTools(service).find(tool => tool.name === 'mcp_server_update')!
    const waiting = await tool.execute(raw, ctx()), result = await tool.execute(raw, approved(tool.name, raw, waiting))
    expect(result.success).toBe(true)
    const visible = JSON.stringify({ waiting, result, listed: service.list(context) })
    expect(visible).not.toContain('opaque-secret'); expect(visible).not.toContain('new-arg-secret')
    expect(JSON.parse(fs.readFileSync(config, 'utf8')).mcpServers.example).not.toHaveProperty('headers')
  })

  it.each(['url', 'args'])('keeps rotated %s secrets out of unchanged display metadata', async field => {
    seed({ example: field === 'url' ? { ...base(), url: 'https://example.invalid/mcp?token=old-rotated-secret', description: 'Uses old-rotated-secret' }
      : { ...base(), transportType: 'stdio', command: 'node', args: ['--token=old-rotated-secret'], url: undefined, description: 'Uses old-rotated-secret' } })
    const changes = field === 'url' ? { url: 'https://example.invalid/mcp?token=new-rotated-secret' } : { args: ['--token=new-rotated-secret'] }
    const result = await call('mcp_server_update', { ...selected(), changes })
    expect(result.success).toBe(true)
    const visible = JSON.stringify({ result, listed: service.list(context) })
    expect(visible).not.toContain('old-rotated-secret'); expect(visible).not.toContain('new-rotated-secret')
  })

  it('rejects changed approval arguments, child execution and forbidden configuration fields', async () => {
    const tool = createMcpManagementTools(service).find(tool => tool.name === 'mcp_server_create')!, raw = createArgs()
    const waiting = await tool.execute(raw, ctx())
    expect((await tool.execute({ ...raw, url: 'https://different.invalid' }, approved(tool.name, raw, waiting))).success).toBe(false)
    expect((await tool.execute(raw, { ...ctx(), parentSessionId: 'parent' })).success).toBe(false)
    for (const extra of [{ env: { KEY: 'secret' } }, { headers: { Authorization: 'secret' } }, { projectRoot: root }, { enabled: true }, { isBuiltIn: true }])
      expect((await tool.execute({ ...raw, ...extra }, ctx())).success).toBe(false)
    expect(fs.existsSync(config)).toBe(false)
  })

  it.each(['update', 'set_enabled', 'delete', 'test'])('rejects a stale %s approval including external credential changes', async action => {
    seed({ example: base() })
    const raw = { ...selected(), ...(action === 'update' ? { changes: { name: 'New' } } : action === 'set_enabled' ? { enabled: true } : {}) }
    const tool = createMcpManagementTools(service).find(tool => tool.name === 'mcp_server_' + action)!
    const waiting = await tool.execute(raw, ctx())
    expect(waiting.needsConfirmation).toBe(true)
    seed({ example: { ...base(), headers: { Authorization: 'updated-outside' } } })
    const result = await tool.execute(raw, approved(tool.name, raw, waiting))
    expect(result.success).toBe(false); expect(result.output).toContain('变化')
    expect(fs.readFileSync(config, 'utf8')).toContain('updated-outside')
  })

  it('keeps same-ID scope copies separate and never promotes a global entry implicitly', async () => {
    const global = path.join(root, 'global', 'mcp.json')
    seed({ example: { ...base(), name: 'Global' } }, global)
    expect(() => service.get(context, 'example', 'project')).toThrow(/不存在/)
    seed({ example: { ...base(), name: 'Project' } })
    expect(service.list(context).map(server => server.scope)).toEqual(['project', 'global'])
    expect((await call('mcp_server_delete', selected())).success).toBe(true)
    expect(service.get(context, 'example', 'global').name).toBe('Global')
    expect(JSON.parse(fs.readFileSync(config, 'utf8')).mcpServers).toEqual({})
  })

  it('carries a legacy file forward atomically without changing the original or other entries', async () => {
    const legacy = path.join(project, '.aether', 'mcp.json')
    seed({ example: base(), untouched: { ...base(), name: 'Untouched' } }, legacy)
    const original = fs.readFileSync(legacy, 'utf8')
    expect((await call('mcp_server_update', { ...selected(), changes: { description: 'Updated' } })).success).toBe(true)
    expect(fs.readFileSync(legacy, 'utf8')).toBe(original)
    expect(JSON.parse(fs.readFileSync(config, 'utf8')).mcpServers.untouched.name).toBe('Untouched')
    expect(service.get(context, 'example', 'project').description).toBe('Updated')
  })

  it('preserves malformed JSON and rejects project or global junctions', async () => {
    fs.mkdirSync(path.dirname(config)); fs.writeFileSync(config, '{broken existing config')
    expect((await createMcpManagementTools(service)[2].execute(createArgs(), ctx())).success).toBe(false)
    expect(fs.readFileSync(config, 'utf8')).toBe('{broken existing config')
    const outside = path.join(root, 'outside'); fs.mkdirSync(outside)
    const junctionProject = path.join(root, 'linked-project'); fs.mkdirSync(junctionProject)
    fs.symlinkSync(outside, path.join(junctionProject, '.ae'), 'junction')
    expect(() => service.prepare({ ...context, projectRoot: junctionProject }, 'create', createArgs())).toThrow(/联接/)
    fs.symlinkSync(outside, path.join(root, 'global'), 'junction')
    expect(() => service.list(context, 'global')).toThrow(/联接/)
    expect(fs.readdirSync(outside)).toEqual([])
  })

  it('rechecks authority and aborts a write after waiting for the shared file lock', async () => {
    seed({ example: base() })
    const raw = { ...selected(), changes: { name: 'Never saved' } }, operation = service.prepare(context, 'update', raw)
    await expect(service.apply({ ...context, principal: { tenantId: 'default', method: 'jwt', roles: [] } }, operation, raw)).rejects.toThrow(/权限/)
    let release!: () => void, acquired!: () => void
    const held = new Promise<void>(resolve => { release = resolve }), ready = new Promise<void>(resolve => { acquired = resolve })
    const owner = withFileLocks([config], async () => { acquired(); await held }); await ready
    const controller = new AbortController(), pending = service.apply({ ...context, signal: controller.signal }, operation, raw)
    controller.abort(new DOMException('Stopped', 'AbortError')); release(); await owner
    await expect(pending).rejects.toThrow('Stopped')
    expect(service.get(context, 'example', 'project').name).toBe('Example')
  })
})

describe('MCP management discovery', () => {
  it('discovers a real isolated stdio server only after approval and closes the process without a business call', async () => {
    const pidPath = path.join(root, 'server.pid'), called = path.join(root, 'called.txt'), script = path.join(root, 'fixture.cjs')
    fs.writeFileSync(script, `const fs=require('fs');fs.writeFileSync(${JSON.stringify(pidPath)},String(process.pid));const rl=require('readline').createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);if(!m.id)return;let result={};if(m.method==='initialize')result={protocolVersion:'2025-06-18',capabilities:{},serverInfo:{name:'fixture',version:'1'}};if(m.method==='tools/list')result={tools:[{name:'inspect',description:'Test-only fixture',inputSchema:{type:'object'}}]};if(m.method==='tools/call')fs.writeFileSync(${JSON.stringify(called)},'unexpected');process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`)
    seed({ example: { ...base(), transportType: 'stdio', command: process.execPath, args: [script], url: undefined } })
    const disconnect = vi.spyOn(HTTPMCPClient.prototype, 'disconnect')
    const raw = selected(), tool = createMcpManagementTools(service).find(tool => tool.name === 'mcp_server_test')!
    const waiting = await tool.execute(raw, ctx())
    expect(waiting.needsConfirmation).toBe(true); expect(fs.existsSync(pidPath)).toBe(false)
    const result = await tool.execute(raw, approved(tool.name, raw, waiting))
    expect(result.success).toBe(true)
    expect(JSON.parse(result.output)).toMatchObject({ toolCount: 1, tools: [{ name: 'mcp_example_inspect' }] })
    expect(disconnect).toHaveBeenCalled()
    expect(fs.existsSync(called)).toBe(false)
    const pid = Number(fs.readFileSync(pidPath, 'utf8'))
    expect(() => process.kill(pid, 0)).toThrow()
    expect(service.get(context, 'example', 'project').enabled).toBe(false)
  }, 15_000)

  it('rechecks safe mode at approval and does not construct a client', async () => {
    seed({ example: base() })
    const factory = vi.fn(), manager = new McpManagementService(factory), raw = selected()
    const tool = createMcpManagementTools(manager).find(tool => tool.name === 'mcp_server_test')!
    const waiting = await tool.execute(raw, ctx())
    setSecurityMode(context.tenantId, context.sessionId, 'safe')
    expect((await tool.execute(raw, approved(tool.name, raw, waiting))).success).toBe(false)
    expect((await tool.execute(raw, ctx())).success).toBe(false)
    expect(factory).not.toHaveBeenCalled()
  })

  it('bounds discovered names, hides credentials and never returns schemas or remote descriptions', async () => {
    seed({ example: { ...base(), headers: { Authorization: 'fixture-secret' } } })
    const disconnect = vi.fn(async () => {}), execute = vi.fn()
    const manager = new McpManagementService(() => ({ disconnect, toTools: async () => Array.from({ length: 80 }, (_, i) => ({
      name: `fixture-secret-${i}`, description: 'fixture-secret', parameters: { type: 'object', secret: 'fixture-secret' }, execute,
    })) }))
    const result = await call('mcp_server_test', selected(), manager)
    const body = JSON.parse(result.output)
    expect(body).toMatchObject({ success: true, toolCount: 80, truncated: true })
    expect(body.tools).toHaveLength(50); expect(result.output).not.toContain('fixture-secret')
    expect(body.tools[0]).not.toHaveProperty('parameters'); expect(body.tools[0]).not.toHaveProperty('description')
    expect(execute).not.toHaveBeenCalled(); expect(disconnect).toHaveBeenCalledTimes(1)
  })

  it('sanitizes remote failures and disconnects on failure and cancellation', async () => {
    seed({ example: base() })
    const disconnect = vi.fn(async () => { throw new Error('cleanup-secret') })
    const manager = new McpManagementService(() => ({ disconnect, toTools: async () => { throw new Error('remote-response-secret') } }))
    const result = await call('mcp_server_test', selected(), manager)
    expect(result.success).toBe(false); expect(JSON.stringify(result)).not.toContain('secret'); expect(disconnect).toHaveBeenCalledOnce()
    let entered!: () => void
    const running = new Promise<void>(resolve => { entered = resolve }), controller = new AbortController()
    const cancelManager = new McpManagementService(() => ({ disconnect, toTools: signal => new Promise((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }); entered()
    }) }))
    const raw = selected(), tool = createMcpManagementTools(cancelManager).find(tool => tool.name === 'mcp_server_test')!, waiting = await tool.execute(raw, ctx())
    const pending = tool.execute(raw, approved(tool.name, raw, waiting, controller.signal))
    await running; controller.abort(new DOMException('Stopped', 'AbortError'))
    expect(await pending).toMatchObject({ success: false, status: 'cancelled' })
    expect(disconnect).toHaveBeenCalledTimes(2)
  })
})
