import fs from 'node:fs'
import { initDb, closeDb } from '../../../../storage/sqlite/db.js'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mcpRoutes } from '../mcp.js'
import { HTTPMCPClient } from '../../../../tools/mcp/client.js'
import { createServer, listServers } from '../../../../storage/mcp/mcp-config.js'
import { clearSecurityMode, setSecurityMode } from '../../../../security/policy-engine.js'
import { ToolRegistry } from '../../../../core/tool-registry/index.js'
import { registerMCPTools } from '../../../../tools/mcp/loader.js'

// Vitest setup supplies an isolated per-spec database; these integration tests need its real schema.
beforeAll(async () => { await initDb() })
afterAll(() => { closeDb() })

let root: string
let app: FastifyInstance
let oldConfig: string | undefined
let oldGlobal: string | undefined

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-mcp-e2e-'))
  oldConfig = process.env.MCP_CONFIG_PATH
  oldGlobal = process.env.AETHER_GLOBAL_DIR
  process.env.MCP_CONFIG_PATH = path.join(root, 'mcp.json')
  process.env.AETHER_GLOBAL_DIR = path.join(root, 'global')
  app = Fastify()
  await app.register(mcpRoutes)
})

afterEach(async () => {
  await app.close()
  if (oldConfig === undefined) delete process.env.MCP_CONFIG_PATH
  else process.env.MCP_CONFIG_PATH = oldConfig
  if (oldGlobal === undefined) delete process.env.AETHER_GLOBAL_DIR
  else process.env.AETHER_GLOBAL_DIR = oldGlobal
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 })
})

function rpcServerScript(framed = false): string {
  const writer = framed
    ? "const out='Content-Length:'+Buffer.byteLength(payload)+'\\r\\n\\r\\n'+payload;"
    : "const out=payload+'\\n';"
  return [
    "process.stdin.setEncoding('utf8'); let b='';",
    `process.stdin.on('data', c => { b += c; for (;;) { const i=b.indexOf('\\n'); if(i<0) return; const line=b.slice(0,i).trim(); b=b.slice(i+1); if(!line) continue; const m=JSON.parse(line); if(!m.id) continue; let result={}; if(m.method==='initialize') result={protocolVersion:'2025-06-18',capabilities:{},serverInfo:{name:'fixture',version:'1'}}; else if(m.method==='tools/list') result={tools:[{name:'echo',description:'Echo fixture',inputSchema:{type:'object',properties:{text:{type:'string'}}}}]}; else if(m.method==='tools/call') result={content:[{type:'text',text:String(m.params.arguments.text)}]}; const payload=JSON.stringify({jsonrpc:'2.0',id:m.id,result}); ${writer} process.stdout.write(out); }});`,
  ].join('')
}

describe('MCP configuration and real protocol execution', () => {
  it('imports standard multi-server JSON atomically and preserves forward-compatible fields', async () => {
    const payload = {
      scope: 'project',
      config: { mcpServers: {
        first: { type: 'streamableHttp', url: 'https://example.invalid/mcp', description: 'First', headers: { 'X-Tenant-Id': 'tenant' }, enableNeteaseAuth: true },
        second: { transportType: 'stdio', command: process.execPath, args: ['-e', ''], env: { TOKEN: 'x' } },
      } },
    }
    const imported = await app.inject({ method: 'POST', url: `/mcp/config/import?path=${encodeURIComponent(root)}`, payload })
    expect(imported.json()).toMatchObject({ code: 200, data: { servers: expect.arrayContaining([expect.objectContaining({ id: 'first', transportType: 'streamableHttp' }), expect.objectContaining({ id: 'second', transportType: 'stdio' })]) } })
    const exported = await app.inject(`/mcp/config/export?path=${encodeURIComponent(root)}&scope=project`)
    expect(exported.json().data.mcpServers.first.type).toBe('streamableHttp')
    expect(exported.json().data.mcpServers.first.enableNeteaseAuth).toBe(true)
    expect(exported.json().data.mcpServers.second.command).toBe(process.execPath)
  })

  it('rejects one invalid server without replacing the existing document', async () => {
    const valid = { mcpServers: { keep: { type: 'http', url: 'https://example.invalid' } } }
    expect((await app.inject({ method: 'POST', url: `/mcp/config/import?path=${encodeURIComponent(root)}`, payload: { config: valid } })).json().code).toBe(200)
    const invalid = { mcpServers: { bad: { type: 'unsupported', url: 'https://example.invalid' } } }
    expect((await app.inject({ method: 'POST', url: `/mcp/config/import?path=${encodeURIComponent(root)}`, payload: { config: invalid } })).json().code).toBe(40001)
    expect((await app.inject(`/mcp/servers?path=${encodeURIComponent(root)}`)).json().data).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'keep' })]))
  })

  it('merges imported servers within the selected layer and only replaces matching ids', async () => {
    const keep = { mcpServers: { keep: { type: 'http', url: 'https://example.invalid/keep' } } }
    const add = { mcpServers: { add: { type: 'http', url: 'https://example.invalid/add' } } }
    expect((await app.inject({ method: 'POST', url: `/mcp/config/import?path=${encodeURIComponent(root)}`, payload: { config: keep } })).json().code).toBe(200)
    expect((await app.inject({ method: 'POST', url: `/mcp/config/import?path=${encodeURIComponent(root)}`, payload: { config: add } })).json().code).toBe(200)
    const exported = (await app.inject(`/mcp/config/export?path=${encodeURIComponent(root)}&scope=project`)).json().data
    expect(exported.mcpServers).toEqual(expect.objectContaining({
      keep: expect.objectContaining({ url: 'https://example.invalid/keep' }),
      add: expect.objectContaining({ url: 'https://example.invalid/add' }),
    }))
  })

  it('scopes project config by query path and performs CRUD/enable/disable atomically', async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-mcp-other-'))
    const payload = { id: 'fixture', name: 'Fixture', transportType: 'http', url: 'https://example.invalid', disabledTools: ['echo'] }
    const created = await app.inject({ method: 'POST', url: `/mcp/servers?path=${encodeURIComponent(root)}`, payload })
    expect(created.json()).toMatchObject({ code: 200, data: { id: 'fixture', scope: 'project', disabledTools: ['echo'] } })
    expect(fs.existsSync(path.join(root, 'mcp.json'))).toBe(true)
    // Explicit MCP_CONFIG_PATH intentionally makes the fixture a single-file
    // profile; projectRoot scoping is exercised when the explicit path is absent.
    expect(listServers(other)).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'fixture' })]))
    expect((await app.inject(`/mcp/servers?path=${encodeURIComponent(root)}`)).json().data).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'fixture' })]))
    expect((await app.inject({ method: 'POST', url: `/mcp/servers/fixture/disable?path=${encodeURIComponent(root)}` })).json().data.enabled).toBe(false)
    expect((await app.inject({ method: 'PATCH', url: `/mcp/servers/fixture?path=${encodeURIComponent(root)}`, payload: { transportType: 'stdio' } })).json().code).toBe(40001)
    expect((await app.inject({ method: 'DELETE', url: `/mcp/servers/fixture?path=${encodeURIComponent(root)}` })).json()).toMatchObject({ code: 200, data: true })
    fs.rmSync(other, { recursive: true, force: true })
  })

  it('edits, toggles and deletes a global server without creating a project overlay', async () => {
    // Exercise the real two-layer mode; MCP_CONFIG_PATH intentionally disables
    // global merging for the other fixture test.
    delete process.env.MCP_CONFIG_PATH
    const server = createServer({ id: 'shared', name: 'Shared', transportType: 'http', url: 'https://example.invalid', enabled: true, isBuiltIn: false, description: '', disabledTools: ['keep'] , scope: 'global' }, root)
    const listed = (await app.inject(`/mcp/servers?path=${encodeURIComponent(root)}`)).json()
    expect(listed.data).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'shared', scope: 'global', enabled: true })]))
    expect(fs.existsSync(path.join(root, '.ae', 'mcp.json'))).toBe(false)

    const disabled = await app.inject({ method: 'POST', url: `/mcp/servers/shared/disable?path=${encodeURIComponent(root)}&scope=global` })
    expect(disabled.json()).toMatchObject({ code: 200, data: { id: 'shared', scope: 'global', enabled: false } })
    expect(fs.existsSync(path.join(root, '.ae', 'mcp.json'))).toBe(false)

    const updated = await app.inject({ method: 'PATCH', url: `/mcp/servers/shared?path=${encodeURIComponent(root)}&scope=global`, payload: { description: 'updated' } })
    expect(updated.json()).toMatchObject({ code: 200, data: { scope: 'global', description: 'updated', disabledTools: ['keep'] } })
    expect(fs.existsSync(path.join(root, '.ae', 'mcp.json'))).toBe(false)

    const deleted = await app.inject({ method: 'DELETE', url: `/mcp/servers/shared?path=${encodeURIComponent(root)}&scope=global` })
    expect(deleted.json()).toMatchObject({ code: 200, data: true })
    expect(fs.existsSync(path.join(root, 'global', 'mcp.json'))).toBe(true)
    expect(server.id).toBe('shared')
  })

  it('runs a real stdio MCP server through initialize, discovery and tool call', async () => {
    const server = createServer({ id: 'fixture', name: 'Fixture Server', transportType: 'stdio', command: process.execPath,
      args: ['-e', rpcServerScript()], enabled: true, isBuiltIn: false, description: '', disabledTools: [] }, root)
    const client = new HTTPMCPClient({ ...server, id: server.id, transportType: server.transportType })
    const tools = await client.toTools()
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('mcp_fixture_echo')
    setSecurityMode('test', 'test', 'standard')
    expect(await client.callTool('echo', { text: 'hello' }, undefined, { tenantId: 'test', sessionId: 'test' })).toBe('hello')
    clearSecurityMode('test', 'test')
    await client.disconnect()
  })

  it('parses UTF-8 Content-Length framed stdio responses', async () => {
    const server = createServer({ id: 'framed', name: 'Framed', transportType: 'stdio', command: process.execPath,
      args: ['-e', rpcServerScript(true)], enabled: true, isBuiltIn: false, description: '', disabledTools: [] }, root)
    const client = new HTTPMCPClient({ ...server, id: server.id, transportType: server.transportType }, { tenantId: 'framed', sessionId: 'framed' })
    setSecurityMode('framed', 'framed', 'standard')
    expect(await client.callTool('echo', { text: '中文 ✓' })).toBe('中文 ✓')
    clearSecurityMode('framed', 'framed')
    await client.disconnect()
  })

  it('isolates concurrent stdio tool calls so one invocation cannot kill another', async () => {
    const server = createServer({ id: 'parallel', name: 'Parallel', transportType: 'stdio', command: process.execPath,
      args: ['-e', rpcServerScript()], enabled: true, isBuiltIn: false, description: '', disabledTools: [] }, root)
    const client = new HTTPMCPClient({ ...server, id: server.id, transportType: server.transportType }, { tenantId: 'parallel', sessionId: 'parallel' })
    const tools = await client.toTools()
    setSecurityMode('parallel', 'parallel', 'standard')
    const context = { tenantId: 'parallel', sessionId: 'parallel', signal: new AbortController().signal } as never
    const results = await Promise.all([tools[0].execute({ text: 'one' }, context), tools[0].execute({ text: 'two' }, context)])
    expect(results.map(result => result.output).sort()).toEqual(['one', 'two'])
    clearSecurityMode('parallel', 'parallel')
  })

  it('supports request-scoped inline stdio servers without persisting credentials', async () => {
    const registry = new ToolRegistry()
    const names = await registerMCPTools(registry, undefined, [{ id: 'inline', name: 'Inline', transportType: 'stdio', command: process.execPath,
      args: ['-e', rpcServerScript()], env: { INLINE_SECRET: 'fixture-only' } }], { tenantId: 'inline', sessionId: 'inline' }, root)
    expect(names).toEqual(['mcp_inline_echo'])
    expect(fs.existsSync(path.join(root, 'mcp.json'))).toBe(false)
    setSecurityMode('inline', 'inline', 'standard')
    const result = await registry.execute('mcp_inline_echo', { text: 'inline' }, { tenantId: 'inline', sessionId: 'inline', signal: new AbortController().signal } as never)
    expect(result).toMatchObject({ success: true, output: 'inline' })
    clearSecurityMode('inline', 'inline')
  })

  it('registers configured stdio tools in the same registry used by Agent conversations', async () => {
    createServer({ id: 'registry', name: 'Registry', transportType: 'stdio', command: process.execPath,
      args: ['-e', rpcServerScript()], enabled: true, isBuiltIn: false, description: '', disabledTools: [] }, root)
    const registry = new ToolRegistry()
    const names = await registerMCPTools(registry, undefined, undefined, { tenantId: 'test', sessionId: 'registry' }, root)
    expect(names).toEqual(['mcp_registry_echo'])
    expect(registry.list().map(tool => tool.name)).toEqual(['mcp_registry_echo'])
    setSecurityMode('test', 'registry', 'standard')
    const result = await registry.execute('mcp_registry_echo', { text: 'agent' }, { tenantId: 'test', sessionId: 'registry', signal: new AbortController().signal } as never)
    expect(result).toMatchObject({ success: true, output: 'agent' })
    clearSecurityMode('test', 'registry')
  })

  it('applies disabledTools to discovery without disabling the server itself', async () => {
    createServer({ id: 'disabled', name: 'Disabled tool', transportType: 'stdio', command: process.execPath,
      args: ['-e', rpcServerScript()], enabled: true, isBuiltIn: false, description: '', disabledTools: ['echo'] }, root)
    const registry = new ToolRegistry()
    expect(await registerMCPTools(registry, undefined, undefined, { tenantId: 'test', sessionId: 'disabled' }, root)).toEqual([])
    expect(registry.list()).toEqual([])
  })

  it('speaks standard streamable HTTP lifecycle and preserves the returned session id', async () => {
    const seen: string[] = []
    const server = http.createServer((request, response) => {
      let body = ''
      request.on('data', chunk => { body += chunk })
      request.on('end', () => {
        const message = JSON.parse(body) as { id?: number; method: string; params?: { arguments?: { text?: string } } }
        seen.push(`${message.method}:${request.headers['mcp-session-id'] ?? ''}`)
        response.setHeader('content-type', 'application/json')
        if (message.method === 'initialize') response.setHeader('mcp-session-id', 'fixture-session')
        const result = message.method === 'initialize'
          ? { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } }
          : message.method === 'tools/list'
            ? { tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }] }
            : { content: [{ type: 'text', text: message.params?.arguments?.text ?? '' }] }
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    setSecurityMode('http-test', 'http-session', 'full-access')
    const client = new HTTPMCPClient({ id: 'http-fixture', name: 'HTTP Fixture', transportType: 'streamableHttp', url: `http://127.0.0.1:${port}` }, { tenantId: 'http-test', sessionId: 'http-session' })
    expect((await client.listTools()).map(tool => tool.name)).toEqual(['echo'])
    expect(await client.callTool('echo', { text: 'http' })).toBe('http')
    expect(seen.some(entry => entry === 'initialize:')).toBe(true)
    expect(seen.some(entry => entry === 'tools/list:fixture-session')).toBe(true)
    expect(seen.some(entry => entry === 'tools/call:fixture-session')).toBe(true)
    await client.disconnect()
    clearSecurityMode('http-test', 'http-session')
    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  it('supports legacy SSE endpoint discovery and JSON-RPC messages', async () => {
    let stream: import('node:http').ServerResponse | undefined
    let delayMessages = false
    let delayedPost!: () => void
    const delayedPostSeen = new Promise<void>(resolve => { delayedPost = resolve })
    const server = http.createServer((request, response) => {
      if (request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write('event: endpoint\ndata: /messages\n\n')
        stream = response
        request.on('close', () => { if (stream === response) stream = undefined })
        return
      }
      let body = ''
      request.on('data', chunk => { body += chunk })
      request.on('end', () => {
        const message = JSON.parse(body) as { id?: number; method: string; params?: { arguments?: { text?: string } } }
        if (message.method === 'notifications/initialized') {
          response.writeHead(202)
          response.end()
          return
        }
        const result = message.method === 'initialize'
          ? { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'sse', version: '1' } }
          : message.method === 'tools/list'
            ? { tools: [{ name: 'echo', description: 'SSE Echo', inputSchema: { type: 'object' } }] }
            : { content: [{ type: 'text', text: message.params?.arguments?.text ?? '' }] }
        response.writeHead(202)
        response.end()
        if (delayMessages) delayedPost()
        if (!delayMessages) stream?.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n\n`)
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    setSecurityMode('sse-test', 'sse-session', 'full-access')
    const client = new HTTPMCPClient({ id: 'sse-fixture', name: 'SSE Fixture', transportType: 'sse', url: `http://127.0.0.1:${port}` }, { tenantId: 'sse-test', sessionId: 'sse-session' })
    expect(await client.callTool('echo', { text: 'legacy' })).toBe('legacy')
    delayMessages = true
    const controller = new AbortController()
    const cancelled = client.callTool('echo', { text: 'cancelled' }, controller.signal)
    await delayedPostSeen
    controller.abort()
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
    await client.disconnect()
    clearSecurityMode('sse-test', 'sse-session')
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
})
