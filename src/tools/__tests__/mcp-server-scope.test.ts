/** Real project configuration, factory and loader; connections are isolated so server selection is observable. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext, Tool } from '../../core/agent-context/types.js'
import { ToolNotFoundError } from '../../core/agent-context/types.js'
import { createToolRegistry } from '../registry-factory.js'
import { createServer } from '../../storage/mcp/mcp-config.js'
import { skillsRegistry } from '../../skills/index.js'
import { clearSecurityMode, setSecurityMode } from '../../security/policy-engine.js'

const fixtures = vi.hoisted(() => ({ connected: [] as string[] }))
vi.mock('../mcp/client.js', () => ({
  HTTPMCPClient: class {
    constructor(private readonly config: { id: string }) { fixtures.connected.push(config.id) }
    async toTools(): Promise<Tool[]> {
      const name = `mcp_${this.config.id}_query`
      return [{ name, description: 'Scoped fixture', parameters: { type: 'object' }, execute: async () => ({ success: true, output: name }) }]
    }
  }
}))

let root: string
let marker: string
const context = { tenantId: 'mcp-scope-test', sessionId: 'session' } as AgentContext

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-mcp-scope-'))
  marker = randomUUID()
  fs.writeFileSync(path.join(root, '.fixture-owner'), marker)
  vi.stubEnv('MCP_CONFIG_PATH', '')
  vi.stubEnv('AETHER_GLOBAL_DIR', path.join(root, 'global'))
  vi.stubEnv('OSM_MODE', 'balanced')
  vi.spyOn(skillsRegistry, 'getSkills').mockReturnValue([])
  fixtures.connected = []
  setSecurityMode(context.tenantId, context.sessionId, 'standard')
  for (const id of ['alpha', 'beta']) createServer({ id, name: id, description: '', enabled: true, isBuiltIn: false, transportType: 'http', url: 'http://fixture.invalid' }, root)
})

afterEach(() => {
  clearSecurityMode(context.tenantId, context.sessionId)
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  const canonical = fs.realpathSync(root)
  expect(path.dirname(canonical).toLowerCase()).toBe(fs.realpathSync(os.tmpdir()).toLowerCase())
  expect(path.basename(canonical)).toMatch(/^aether-mcp-scope-/)
  expect(fs.readFileSync(path.join(canonical, '.fixture-owner'), 'utf8')).toBe(marker)
  fs.rmSync(canonical, { recursive: true, force: true })
})

describe('Agent MCP server scope', () => {
  it.each(['general', 'code'] as const)('%s connects and executes only the bound project server while retaining builtins', async toolProfile => {
    const result = await createToolRegistry({ toolProfile, workspaceRoot: root, allowedMcpServers: ['alpha'] })
    expect(fixtures.connected).toEqual(['alpha'])
    expect(result.toolCategories.mcpTools).toEqual(['mcp_alpha_query'])
    expect(result.registry.has('read_file')).toBe(true)
    expect(result.registry.has('mcp_beta_query')).toBe(false)
    await expect(result.registry.execute('mcp_beta_query', {}, context)).rejects.toBeInstanceOf(ToolNotFoundError)
    await expect(result.registry.execute('mcp_alpha_query', {}, context)).resolves.toEqual({ success: true, output: 'mcp_alpha_query' })
    expect(result.registry.has('agent_list')).toBe(toolProfile === 'general')
  })

  it.each([undefined, null])('preserves the full configured server catalogue when the whitelist is %s', async allowedMcpServers => {
    const result = await createToolRegistry({ toolProfile: 'general', workspaceRoot: root, allowedMcpServers })
    expect(fixtures.connected.slice().sort()).toEqual(['alpha', 'beta'])
    expect(result.toolCategories.mcpTools.slice().sort()).toEqual(['mcp_alpha_query', 'mcp_beta_query'])
  })

  it('an empty server whitelist disables all MCP without disabling builtin tools', async () => {
    const result = await createToolRegistry({ workspaceRoot: root, allowedMcpServers: [] })
    expect(fixtures.connected).toEqual([])
    expect(result.toolCategories.mcpTools).toEqual([])
    expect(result.registry.has('read_file')).toBe(true)
    await expect(result.registry.execute('mcp_alpha_query', {}, context)).rejects.toBeInstanceOf(ToolNotFoundError)
  })

  it('server IDs and explicit tool permissions intersect without widening either scope', async () => {
    const result = await createToolRegistry({ workspaceRoot: root, allowedMcpServers: ['alpha'], allowedTools: ['read_file', 'mcp_beta_query'] })
    expect(fixtures.connected).toEqual(['alpha'])
    expect(result.registry.list().map(tool => tool.name)).toEqual(['read_file'])
    await expect(result.registry.execute('mcp_alpha_query', {}, context)).rejects.toBeInstanceOf(ToolNotFoundError)
    await expect(result.registry.execute('mcp_beta_query', {}, context)).rejects.toBeInstanceOf(ToolNotFoundError)
  })

  it('applies the same exact server ID whitelist to inline definitions before connecting', async () => {
    const inlineMcpServers = ['gamma', 'delta'].map(id => ({ id, name: id, transportType: 'http' as const, url: 'http://fixture.invalid' }))
    const result = await createToolRegistry({ workspaceRoot: root, inlineMcpServers, allowedMcpServers: ['gamma'] })
    expect(fixtures.connected).toEqual(['gamma'])
    expect(result.toolCategories.mcpTools).toEqual(['mcp_gamma_query'])
    expect(result.registry.has('mcp_delta_query')).toBe(false)
    expect(result.registry.has('mcp_alpha_query')).toBe(false)
  })
})
