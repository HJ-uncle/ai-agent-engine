import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import Fastify from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { HTTPMCPClient } from '../client.js'
import type { MCPServerConfig } from '../types.js'
import type { AgentContext } from '../../../core/agent-context/index.js'
import { mcpRoutes } from '../../../api/http/routes/mcp.js'
import { registerMCPTools } from '../loader.js'
import { ToolRegistry } from '../../../core/tool-registry/index.js'
import { initDb, closeDb } from '../../../storage/sqlite/db.js'
import { DEFAULT_NETWORK_POLICY, loadNetworkPolicy, saveNetworkPolicy } from '../../../security/network-policy.js'
import { guardedHttp } from '../../../security/guarded-http.js'
import { clearSecurityMode, setSecurityMode } from '../../../security/policy-engine.js'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
let root: string
let ctx: AgentContext
const clients: HTTPMCPClient[] = []
const servers: http.Server[] = []
beforeAll(async () => { await initDb() })
afterAll(() => closeDb())
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-mcp-deadlines-'))
  vi.stubEnv('MCP_CONFIG_PATH', path.join(root, 'mcp.json'))
  vi.stubEnv('AETHER_GLOBAL_DIR', path.join(root, 'global'))
  ctx = { tenantId: 'mcp-deadlines', sessionId: path.basename(root), projectRoot: root } as AgentContext
  setSecurityMode(ctx.tenantId, ctx.sessionId, 'standard')
})
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.disconnect()))
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) })))
  await saveNetworkPolicy({ ...DEFAULT_NETWORK_POLICY })
  clearSecurityMode(ctx.tenantId, ctx.sessionId)
  vi.unstubAllEnvs()
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 })
})
function fixtureConfig(timeoutMs?: number, marker?: string): MCPServerConfig {
  const script = path.join(root, `server-${clients.length}-${Math.random().toString(16).slice(2)}.cjs`)
  fs.writeFileSync(script, `const rl=require('readline').createInterface({input:process.stdin}); const send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n'); rl.on('line',line=>{const m=JSON.parse(line); if(!m.id)return; if(m.method==='initialize')return send(m.id,{protocolVersion:'2025-06-18'}); if(m.method==='tools/list')return send(m.id,{tools:[{name:'delay',description:'Real delayed fixture',inputSchema:{type:'object'}}]}); if(m.method==='tools/call'){ ${marker ? `const child=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); require('fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify({leader:process.pid,child:child.pid}));` : ''} setTimeout(()=>send(m.id,{content:[{type:'text',text:'completed '+m.params.arguments.ms}]}),m.params.arguments.ms); }});`)
  return { id: 'fixture', name: 'Fixture', transportType: 'stdio', command: process.execPath, args: [script], ...(timeoutMs === undefined ? {} : { timeoutMs }) }
}
function client(config: MCPServerConfig) {
  const value = new HTTPMCPClient(config, ctx); clients.push(value); return value
}
async function httpFixture(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler); servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}

describe('MCP explicit operation deadlines', () => {
  it('persists zero/custom deadlines through CRUD, JSON, loader and null resets', async () => {
    const app = Fastify(); await app.register(mcpRoutes)
    try {
      const config = fixtureConfig(0)
      expect((await app.inject({ method: 'POST', url: '/mcp/servers', payload: config })).json()).toMatchObject({ code: 200, data: { timeoutMs: 0 } })
      const exported = (await app.inject('/mcp/config/export?scope=project')).json().data
      expect(exported.mcpServers.fixture.timeoutMs).toBe(0)
      expect((await app.inject({ method: 'PATCH', url: '/mcp/servers/fixture', payload: { timeoutMs: 500 } })).json()).toMatchObject({ code: 200, data: { timeoutMs: 500 } })
      const registry = new ToolRegistry()
      await registerMCPTools(registry, undefined, undefined, ctx, root)
      const result = await registry.execute('mcp_fixture_delay', { ms: 1_000 }, ctx)
      expect(result).toMatchObject({ success: false, output: expect.stringContaining('timed out') })
      const reset = (await app.inject({ method: 'PATCH', url: '/mcp/servers/fixture', payload: { timeoutMs: null } })).json()
      expect(reset.code).toBe(200); expect(reset.data).not.toHaveProperty('timeoutMs')
      for (const timeoutMs of [-1, 1.5, 2_147_483_648, '100']) {
        expect((await app.inject({ method: 'PATCH', url: '/mcp/servers/fixture', payload: { timeoutMs } })).json().code).toBe(40001)
        expect((await app.inject({ method: 'POST', url: '/mcp/config/import', payload: { config: { mcpServers: { bad: { type: 'http', url: 'http://localhost', timeoutMs } } } } })).json().code).toBe(40001)
      }
      expect((await app.inject({ method: 'POST', url: '/mcp/config/import', payload: { config: { mcpServers: { imported: { type: 'http', url: 'http://localhost', timeoutMs: 0 } } } } })).json()).toMatchObject({ code: 200, data: { servers: expect.arrayContaining([expect.objectContaining({ id: 'imported', timeoutMs: 0 })]) } })
    } finally { await app.close() }
  }, 20_000)

  it('keeps the original 15s stdio default and lets zero/custom calls really run beyond it', async () => {
    const normal = client(fixtureConfig())
    const unlimited = client(fixtureConfig(0))
    const extended = client(fixtureConfig(20_000))
    await Promise.all([normal.connect(), unlimited.connect(), extended.connect()])
    const began = Date.now()
    const outcomes = await Promise.allSettled([normal.callTool('delay', { ms: 15_500 }), unlimited.callTool('delay', { ms: 15_500 }), extended.callTool('delay', { ms: 15_500 })])
    expect(outcomes[0]).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ message: 'MCP stdio request timed out' }) })
    expect(outcomes[1]).toMatchObject({ status: 'fulfilled', value: 'completed 15500' })
    expect(outcomes[2]).toMatchObject({ status: 'fulfilled', value: 'completed 15500' })
    expect(Date.now() - began).toBeGreaterThanOrEqual(15_000)
    expect((normal as unknown as { stdioPending: Map<number, unknown> }).stdioPending.size).toBe(0)
    expect(await normal.callTool('delay', { ms: 10 })).toBe('completed 10')
  }, 35_000)

  it('cancels an unlimited stdio invocation and reclaims its owned descendant', async () => {
    const marker = path.join(root, 'owned.json')
    const value = client(fixtureConfig(0, marker))
    const tools = await value.toTools()
    const controller = new AbortController()
    const task = tools[0].execute({ ms: 60_000 }, { ...ctx, signal: controller.signal })
    void task.catch(() => undefined)
    for (let attempt = 0; attempt < 200 && !fs.existsSync(marker); attempt++) await sleep(25)
    const owned = JSON.parse(fs.readFileSync(marker, 'utf8')) as { leader: number; child: number }
    expect(alive(owned.child)).toBe(true)
    controller.abort(new Error('cancelled by user'))
    await expect(task).rejects.toThrow('cancelled by user')
    expect(alive(owned.leader)).toBe(false)
    expect(alive(owned.child)).toBe(false)
    expect(alive(process.pid)).toBe(true)
  }, 20_000)

  it('applies custom/zero HTTP deadlines only to selected MCP and still honors user cancellation', async () => {
    const seen: string[] = []
    const url = await httpFixture(async (request, response) => {
      if (request.url === '/slow') { setTimeout(() => response.end('completed'), 220); return }
      let text = ''; for await (const part of request) text += String(part)
      const m = JSON.parse(text) as { id?: number; method: string }
      seen.push(m.method)
      if (!m.id) { response.writeHead(202); response.end(); return }
      const result = m.method === 'initialize' ? { protocolVersion: '2025-06-18' } : m.method === 'tools/list' ? { tools: [] } : { content: [{ type: 'text', text: 'http completed' }] }
      const send = () => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result })) }
      if (m.method === 'tools/call') setTimeout(send, 220); else send()
    })
    await saveNetworkPolicy({ ...DEFAULT_NETWORK_POLICY, timeoutMs: 100 })
    const normal = client({ name: 'normal', transportType: 'http', url })
    const unlimited = client({ name: 'unlimited', transportType: 'http', url, timeoutMs: 0 })
    const extended = client({ name: 'extended', transportType: 'http', url, timeoutMs: 1_000 })
    await expect(normal.callTool('delay', {})).rejects.toThrow()
    expect(await unlimited.callTool('delay', {})).toBe('http completed')
    expect(await extended.callTool('delay', {})).toBe('http completed')
    expect((await loadNetworkPolicy()).timeoutMs).toBe(100)
    await expect(guardedHttp(url + '/slow', ctx, 'ordinary-http', { timeoutMs: 0 })).rejects.toThrow()
    const controller = new AbortController()
    const pending = unlimited.callTool('delay', {}, controller.signal)
    void pending.catch(() => undefined)
    setTimeout(() => controller.abort(new Error('user stopped HTTP')), 30)
    await expect(pending).rejects.toThrow()
    expect(seen).toContain('tools/call')
  }, 10_000)

  it('explicit unlimited HTTP never bypasses private-address or response-byte policies', async () => {
    const url = await httpFixture((_request, response) => response.end('x'.repeat(100)))
    setSecurityMode(ctx.tenantId, ctx.sessionId, 'safe')
    await expect(guardedHttp(url, ctx, 'mcp', { timeoutMs: 0, overridePolicyTimeout: true })).rejects.toThrow('网络策略')
    setSecurityMode(ctx.tenantId, ctx.sessionId, 'standard')
    await saveNetworkPolicy({ ...DEFAULT_NETWORK_POLICY, maxResponseBytes: 10 })
    await expect(guardedHttp(url, ctx, 'mcp', { timeoutMs: 0, overridePolicyTimeout: true })).rejects.toThrow('exceeds')
  })

  it('cancels an unlimited initialization handshake and stops its owned process tree', async () => {
    const marker=path.join(root,'initializing.json'),script=path.join(root,'hang-init.cjs')
    fs.writeFileSync(script,`const child=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); require('fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify({leader:process.pid,child:child.pid})); process.stdin.resume(); setInterval(()=>{},1000)`)
    const value=client({name:'hung init',transportType:'stdio',command:process.execPath,args:[script],timeoutMs:0})
    const controller=new AbortController(),task=value.toTools(controller.signal)
    void task.catch(()=>undefined)
    for(let attempt=0;attempt<200&&!fs.existsSync(marker);attempt++) await sleep(25)
    const owned=JSON.parse(fs.readFileSync(marker,'utf8')) as {leader:number;child:number}
    controller.abort(new Error('cancelled during initialization'))
    await expect(task).rejects.toThrow('cancelled during initialization')
    expect(alive(owned.leader)).toBe(false); expect(alive(owned.child)).toBe(false)
    expect((value as unknown as {stdioPending:Map<number,unknown>}).stdioPending.size).toBe(0)
  },20_000)

  it('a real connection-test HTTP disconnect cancels an unlimited MCP handshake', async () => {
    const marker=path.join(root,'route-initializing.json'),script=path.join(root,'route-hang-init.cjs')
    fs.writeFileSync(script,`const child=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); require('fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify({leader:process.pid,child:child.pid})); process.stdin.resume(); setInterval(()=>{},1000)`)
    const app=Fastify(); await app.register(mcpRoutes)
    try {
      expect((await app.inject({method:'POST',url:'/mcp/servers',payload:{id:'route-hang',name:'Route hang',transportType:'stdio',command:process.execPath,args:[script],timeoutMs:0}})).json().code).toBe(200)
      const base=await app.listen({port:0,host:'127.0.0.1'})
      const request=http.request(base+'/mcp/servers/route-hang/test',{method:'POST'})
      request.on('error',()=>undefined); request.end()
      for(let attempt=0;attempt<200&&!fs.existsSync(marker);attempt++) await sleep(25)
      const owned=JSON.parse(fs.readFileSync(marker,'utf8')) as {leader:number;child:number}
      request.destroy(new Error('user closed connection test'))
      for(let attempt=0;attempt<200&&(alive(owned.leader)||alive(owned.child));attempt++) await sleep(25)
      expect(alive(owned.leader)).toBe(false); expect(alive(owned.child)).toBe(false)
      expect(alive(process.pid)).toBe(true)
    } finally { await app.close() }
  },20_000)
})
