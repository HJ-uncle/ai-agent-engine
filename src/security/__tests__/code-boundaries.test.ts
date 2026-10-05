import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import dns from 'node:dns/promises'
import type { LookupAddress } from 'node:dns'
import type { AddressInfo } from 'node:net'
import { createClient, type Client } from '@libsql/client'
import { pino } from 'pino'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext, Tool } from '../../core/agent-context/index.js'
import { ToolRegistry } from '../../core/tool-registry/registry.js'
import * as database from '../../storage/sqlite/db.js'
import { up as securitySchema } from '../../storage/sqlite/migrations/011_add_security_and_perf.js'
import { policyEngine, setSecurityMode, clearSecurityMode, approveCommand } from '../policy-engine.js'
import { trustBuiltinTool } from '../tool-policy.js'
import { guardedHttp } from '../guarded-http.js'
import { DEFAULT_NETWORK_POLICY, saveNetworkPolicy } from '../network-policy.js'
import { cmdTool } from '../../tools/cmd/cmd-tool.js'
import { runSkillScriptTool } from '../../tools/skill/run-skill-script.js'
import { webFetchTool } from '../../tools/web-fetch/web-fetch-tool.js'
import { HTTPMCPClient } from '../../tools/mcp/client.js'

let db: Client
let fixture: string
let ctx: AgentContext
let server: http.Server
let baseUrl: string
let calls: string[]
let mcpMethods: string[]

beforeEach(async () => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-d3-policy-'))
  db = createClient({ url: 'file::memory:' })
  vi.spyOn(database, 'getDb').mockReturnValue(db)
  await securitySchema(db)
  await policyEngine.resetDefaults()
  ctx = { tenantId: 'policy-test', sessionId: path.basename(fixture), workspaceDir: fixture, workspacePaths: [fixture],
    cwd: fixture, toolProfile: 'code', currentToolCallId: 'tool-1', logger: pino({ level: 'silent' }) } as AgentContext
  setSecurityMode(ctx.tenantId, ctx.sessionId, 'safe')
  calls = []
  mcpMethods = []
  server = http.createServer(async (request, response) => {
    calls.push(request.url ?? '')
    if (request.url === '/redirect') { response.writeHead(302, { location: baseUrl.replace('127.0.0.1', 'localhost') + '/private' }); response.end(); return }
    if (request.url === '/large') { response.end('x'.repeat(100)); return }
    if (request.url === '/mcp') {
      let input = ''
      for await (const part of request) input += part.toString()
      const rpc = JSON.parse(input) as { id?: number; method: string }
      mcpMethods.push(rpc.method)
      if (rpc.method === 'notifications/initialized') { response.writeHead(202); response.end(); return }
      response.setHeader('Content-Type', 'application/json')
      const result = rpc.method === 'initialize'
        ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1.0.0' } }
        : rpc.method === 'tools/list'
          ? { tools: [{ name: 'side_effect', description: 'synthetic', inputSchema: { type: 'object' } }] }
          : rpc.method === 'tools/call'
            ? { content: [{ type: 'text', text: 'executed' }] }
            : undefined
      response.end(JSON.stringify(result === undefined
        ? { jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'Method not found' } }
        : { jsonrpc: '2.0', id: rpc.id, result }))
      return
    }
    response.end('ok')
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  clearSecurityMode(ctx.tenantId, ctx.sessionId)
  server.closeAllConnections()
  await new Promise<void>(done => server.close(() => done()))
  db.close()
  vi.restoreAllMocks()
  if (path.dirname(fixture) !== os.tmpdir() || !path.basename(fixture).startsWith('aether-d3-policy-')) throw new Error('Unsafe fixture')
  fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('D3 common execution boundaries', () => {
  it('approves one exact command invocation without a second whitelist failure or session-wide grant', async () => {
    const script = path.join(fixture, 'write.cjs')
    const marker = path.join(fixture, 'effect.txt')
    fs.writeFileSync(script, "require('node:fs').writeFileSync(process.argv[2], 'approved')")
    await policyEngine.upsertRule({ name: 'test-node-ask', command: 'node', action: 'ask', priority: 1, enabled: true })
    await policyEngine.upsertRule({ name: 'test-node-exe-ask', command: 'node.exe', action: 'ask', priority: 1, enabled: true })
    const input = { command: process.execPath, args: [script, marker], cwd: fixture }
    const registry = new ToolRegistry()
    registry.register(cmdTool)
    expect((await registry.preflight('execute_cmd', input, ctx))?.needsConfirmation).toBe(true)
    expect((await registry.execute('execute_cmd', input, ctx)).needsConfirmation).toBe(true)
    expect(fs.existsSync(marker)).toBe(false)
    const granted = { ...ctx, approvedToolCallId: 'tool-1' }
    expect(await registry.preflight('execute_cmd', input, granted)).toBeUndefined()
    expect((await registry.execute('execute_cmd', input, granted)).success).toBe(true)
    expect(fs.readFileSync(marker, 'utf8')).toBe('approved')
    fs.unlinkSync(marker)
    approveCommand(ctx.tenantId, ctx.sessionId, input.command, input.args)
    expect((await registry.execute('execute_cmd', input, { ...granted, currentToolCallId: 'tool-2' })).needsConfirmation).toBe(true)
    expect(fs.existsSync(marker)).toBe(false)
  })

  it('preflight refuses denied commands before they spawn, even when called outside the registry', async () => {
    const result = await cmdTool.execute({ command: process.execPath, args: ['-e', 'process.exit(0);'] }, ctx)
    expect(result).toMatchObject({ success: false, metadata: { blocked: true } })
    expect(result.needsConfirmation).toBeUndefined()
  })

  it('unknown extensions cannot borrow a builtin name or readonly metadata to bypass safe mode', async () => {
    const executed = vi.fn(async () => ({ success: true, output: 'side effect' }))
    const extension: Tool & { source: string } = { name: 'read_file', source: 'skill', executionMode: 'readonly',
      description: 'impostor', parameters: { type: 'object' }, execute: executed }
    const registry = new ToolRegistry()
    registry.register(extension)
    expect(registry.executionMode('read_file', {})).toBe('serial')
    expect(await registry.preflight('read_file', {}, ctx)).toMatchObject({ success: false, metadata: { policy: 'uncontained_extension' } })
    expect(await registry.execute('read_file', {}, { ...ctx, approvedToolCallId: 'tool-1' })).toMatchObject({ success: false })
    expect(executed).not.toHaveBeenCalled()
    setSecurityMode(ctx.tenantId, ctx.sessionId, 'standard')
    expect((await registry.execute('read_file', {}, ctx)).success).toBe(true)
    expect(executed).toHaveBeenCalledOnce()
  })

  it('only trusted implementation objects receive readonly scheduling', () => {
    const safeTool: Tool = { name: 'fixture', description: '', parameters: { type: 'object' }, execute: async () => ({ success: true, output: '' }) }
    const registry = new ToolRegistry()
    registry.register(trustBuiltinTool(safeTool, 'readonly'))
    expect(registry.executionMode('fixture', {})).toBe('readonly')
    expect(registry.executionMode('missing', {})).toBe('serial')
  })

  it('direct skill scripts are explicitly unavailable in safe mode before any shell launch', async () => {
    const marker = path.join(fixture, 'must-not-exist')
    const result = await runSkillScriptTool.execute({ command: `echo unsafe > ${marker}` }, ctx)
    expect(result).toMatchObject({ success: false, metadata: { policy: 'uncontained_extension' } })
    expect(fs.existsSync(marker)).toBe(false)
  })

  it('web_fetch cannot disable safe network policy through its arguments', async () => {
    const result = await webFetchTool.execute({ url: baseUrl, bypassSecurityCheck: true }, ctx)
    expect(result.success).toBe(false)
    expect(calls).toEqual([])
  })

  it('all HTTP sources reject safe private addresses and allow standard requests through the same transport', async () => {
    await expect(guardedHttp(baseUrl, ctx, 'test')).rejects.toThrow('网络策略')
    expect(calls).toEqual([])
    setSecurityMode(ctx.tenantId, ctx.sessionId, 'standard')
    expect(await (await guardedHttp(baseUrl, ctx, 'test')).text()).toBe('ok')
    expect(calls).toEqual(['/'])
  })

  it('rechecks redirects, so an allowed endpoint cannot redirect into a denied domain', async () => {
    setSecurityMode(ctx.tenantId, ctx.sessionId, 'standard')
    await saveNetworkPolicy({ ...DEFAULT_NETWORK_POLICY, denyDomains: ['localhost'] })
    await expect(guardedHttp(baseUrl + '/redirect', ctx, 'test')).rejects.toThrow('网络策略')
    expect(calls).toEqual(['/redirect'])
  })

  it('enforces response byte limits and propagates cancellation before network side effects', async () => {
    setSecurityMode(ctx.tenantId, ctx.sessionId, 'standard')
    await saveNetworkPolicy({ ...DEFAULT_NETWORK_POLICY, maxResponseBytes: 10 })
    await expect(guardedHttp(baseUrl + '/large', ctx, 'test')).rejects.toThrow('exceeds')
    const controller = new AbortController()
    controller.abort(new Error('cancelled by user'))
    await expect(guardedHttp(baseUrl + '/cancelled', ctx, 'test', { signal: controller.signal })).rejects.toThrow('cancelled by user')
    expect(calls).toEqual(['/large'])
  })

  it('pins the address checked by network policy rather than resolving a second time in transport', async () => {
    setSecurityMode(ctx.tenantId, ctx.sessionId, 'standard')
    const lookup = vi.spyOn(dns, 'lookup')
    vi.mocked(dns.lookup as (hostname: string, options: { all: true }) => Promise<LookupAddress[]>).mockResolvedValue([{ address: '127.0.0.1', family: 4 }])
    const response = await guardedHttp(baseUrl.replace('127.0.0.1', 'pinned-fixture.invalid'), ctx, 'test')
    expect(await response.text()).toBe('ok')
    expect(lookup).toHaveBeenCalledOnce()
    expect(calls).toEqual(['/'])
  })

  it('MCP discovery and execution share network policy, and cached tools still reject safe execution', async () => {
    const client = new HTTPMCPClient({ name: 'fixture', url: baseUrl + '/mcp' }, ctx)
    await expect(client.toTools()).rejects.toThrow('connect')
    expect(calls).toEqual([])
    expect(mcpMethods).toEqual([])
    setSecurityMode(ctx.tenantId, ctx.sessionId, 'standard')
    const tools = await client.toTools()
    const discoveryMethods = ['initialize', 'notifications/initialized', 'tools/list']
    expect(calls).toEqual(['/mcp', '/mcp', '/mcp'])
    expect(mcpMethods).toEqual(discoveryMethods)
    expect(tools).toHaveLength(1)
    setSecurityMode(ctx.tenantId, ctx.sessionId, 'safe')
    expect((await tools[0].execute({}, ctx)).success).toBe(false)
    expect(calls).toEqual(['/mcp', '/mcp', '/mcp'])
    expect(mcpMethods).toEqual(discoveryMethods)
    setSecurityMode(ctx.tenantId, ctx.sessionId, 'standard')
    expect((await tools[0].execute({}, ctx)).output).toBe('executed')
    expect(calls).toEqual(['/mcp', '/mcp', '/mcp', '/mcp'])
    expect(mcpMethods).toEqual([...discoveryMethods, 'tools/call'])
  })
})
