/** Covers canonical project config writes, non-destructive legacy reads and explicit/global isolation. */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getProjectAetherDir, loadAetherConfig } from '../aether-config.js'
import { getProjectContextBlock } from '../project-context.js'
import { createServer, deleteServer, exportConfigDocument, importConfigDocument, listServers, updateServer } from '../../storage/mcp/mcp-config.js'

const fixtureRoot = path.resolve('.e2e-tmp', 'project-config-storage')
let fixture: string
let project: string
let globalDir: string

function write(file: string, content: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content), 'utf8')
}
function projectFile(...parts: string[]): string { return path.join(project, ...parts) }
function server(name: string) {
  return { name, description: '', enabled: true, transportType: 'http' as const, url: 'https://example.invalid/mcp', isBuiltIn: false }
}
function readCanonical(): { mcpServers: Record<string, { description: string; name: string }> } {
  return JSON.parse(fs.readFileSync(projectFile('.ae', 'mcp.json'), 'utf8'))
}

beforeEach(() => {
  fs.mkdirSync(fixtureRoot, { recursive: true })
  fixture = fs.mkdtempSync(path.join(fixtureRoot, 'case-'))
  project = path.join(fixture, 'project')
  globalDir = path.join(fixture, 'global')
  fs.mkdirSync(project, { recursive: true })
  vi.stubEnv('MCP_CONFIG_PATH', '')
  vi.stubEnv('AETHER_GLOBAL_DIR', globalDir)
  vi.spyOn(process, 'cwd').mockReturnValue(project)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  const resolved = path.resolve(fixture)
  if (path.dirname(resolved) !== fixtureRoot || !path.basename(resolved).startsWith('case-')) throw new Error('Unsafe config fixture cleanup')
  fs.rmSync(resolved, { recursive: true, force: true })
})

describe('project MCP storage', () => {
  it('creates only .ae/mcp.json and keeps global entries out of project writes', () => {
    write(path.join(globalDir, 'mcp.json'), { mcpServers: { shared: server('Shared') } })
    createServer({ id: 'local', ...server('Local') }, project)
    expect(Object.keys(readCanonical().mcpServers)).toEqual(['local'])
    expect(listServers(project).map(item => item.id).sort()).toEqual(['local', 'shared'])
    expect(fs.readdirSync(project)).toEqual(['.ae'])
  })

  it.each([['.aether', 'mcp.json'], ['mcp.config.json']])('reads %j without writes and carries its entries into the first canonical edit', (...parts) => {
    const legacy = projectFile(...parts)
    write(legacy, { mcpServers: { first: server('First'), keep: server('Keep') } })
    const before = fs.readFileSync(legacy, 'utf8')
    expect(listServers(project).map(item => item.id)).toEqual(['first', 'keep'])
    expect(fs.existsSync(projectFile('.ae'))).toBe(false)
    expect(updateServer('first', { description: 'edited' }, project)?.description).toBe('edited')
    expect(readCanonical().mcpServers).toMatchObject({ first: { description: 'edited' }, keep: { name: 'Keep' } })
    expect(fs.readFileSync(legacy, 'utf8')).toBe(before)
    expect(deleteServer('first', 'project', project)).toBe(true)
    expect(deleteServer('keep', 'project', project)).toBe(true)
    expect(readCanonical().mcpServers).toEqual({})
    expect(listServers(project)).toEqual([])
    expect(exportConfigDocument(project, 'project')).toEqual({ mcpServers: {} })
  })

  it('prefers canonical config to both legacy locations without reviving removed records', () => {
    write(projectFile('mcp.config.json'), { mcpServers: { root: server('Root') } })
    write(projectFile('.aether', 'mcp.json'), { mcpServers: { old: server('Old') } })
    expect(listServers(project).map(item => item.id)).toEqual(['old'])
    write(projectFile('.ae', 'mcp.json'), { mcpServers: { fresh: server('Fresh') } })
    expect(listServers(project).map(item => item.id)).toEqual(['fresh'])
    deleteServer('fresh', 'project', project)
    expect(listServers(project)).toEqual([])
  })

  it('imports into canonical config while preserving other legacy entries', () => {
    write(projectFile('.aether', 'mcp.json'), { mcpServers: { keep: server('Keep') } })
    importConfigDocument({ mcpServers: { added: { type: 'http', url: 'https://example.invalid/new' } } }, 'project', project)
    expect(Object.keys(readCanonical().mcpServers).sort()).toEqual(['added', 'keep'])
  })

  it('preserves explicit MCP_CONFIG_PATH single-file behavior and global scope', () => {
    const explicit = path.join(fixture, 'deployment', 'mcp.json')
    vi.stubEnv('MCP_CONFIG_PATH', explicit)
    write(path.join(globalDir, 'mcp.json'), { mcpServers: { shared: server('Shared') } })
    write(projectFile('.ae', 'mcp.json'), { mcpServers: { ignored: server('Ignored') } })
    createServer({ id: 'explicit', ...server('Explicit') }, project)
    expect(listServers(project).map(item => item.id)).toEqual(['explicit'])
    expect(JSON.parse(fs.readFileSync(explicit, 'utf8')).mcpServers.explicit.name).toBe('Explicit')
    expect(Object.keys(readCanonical().mcpServers)).toEqual(['ignored'])
    updateServer('shared', { description: 'global edit' }, project, 'global')
    expect(JSON.parse(fs.readFileSync(path.join(globalDir, 'mcp.json'), 'utf8')).mcpServers.shared.description).toBe('global edit')
    expect(JSON.parse(fs.readFileSync(explicit, 'utf8')).mcpServers.shared).toBeUndefined()
  })
})

describe('project settings and context reads', () => {
  it('loads legacy settings until canonical exists and merges only the selected project file with global', () => {
    write(path.join(globalDir, 'aether.json'), { agent: { maxIterations: 7, tokenBudget: 100 } })
    const legacy = projectFile('.aether', 'aether.json')
    write(legacy, { agent: { tokenBudget: 200 }, osmMode: 'balanced' })
    expect(loadAetherConfig()).toEqual({ agent: { maxIterations: 7, tokenBudget: 200 }, osmMode: 'balanced' })
    expect(getProjectAetherDir()).toBe(projectFile('.ae'))
    expect(fs.existsSync(projectFile('.ae'))).toBe(false)
    write(projectFile('.ae', 'aether.json'), { agent: { tokenBudget: 300 } })
    expect(loadAetherConfig()).toEqual({ agent: { maxIterations: 7, tokenBudget: 300 } })
    write(projectFile('.ae', 'aether.json'), {})
    expect(loadAetherConfig()).toEqual({ agent: { maxIterations: 7, tokenBudget: 100 } })
    expect(JSON.parse(fs.readFileSync(legacy, 'utf8')).osmMode).toBe('balanced')
  })

  it('keeps global and unmigrated project context, then prefers .ae without duplicates', () => {
    write(path.join(globalDir, 'AE.md'), 'global-marker')
    write(projectFile('.aether', 'AE.md'), 'legacy-marker')
    write(projectFile('AE.md'), 'root-marker')
    let block = getProjectContextBlock(project)
    expect(block).toContain('global-marker')
    expect(block).toContain('legacy-marker')
    expect(block).toContain('root-marker')
    expect(fs.existsSync(projectFile('.ae'))).toBe(false)
    write(projectFile('.ae', 'AE.md'), 'canonical-marker')
    block = getProjectContextBlock(project)
    expect(block).toContain('global-marker')
    expect(block).toContain('canonical-marker')
    expect(block).not.toContain('legacy-marker')
    expect(block).not.toContain('root-marker')
    write(projectFile('.ae', 'AE.md'), '')
    expect(getProjectContextBlock(project)).toContain('global-marker')
    expect(getProjectContextBlock(project)).not.toContain('legacy-marker')
    expect(fs.readFileSync(projectFile('AE.md'), 'utf8')).toBe('root-marker')
  })
})
