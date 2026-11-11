/** Real catalogue + factory + defaults; external discovery and database access are isolated. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentManagementService, recommendedAgentTools } from '../../../core/agent-management.js'
import { createToolRegistry } from '../../registry-factory.js'
import { skillsRegistry } from '../../../skills/index.js'
import { isDefaultTool } from '../../tool-exposure.js'
import type { AgentManagementStore } from '../../../core/agent-management.js'

vi.mock('../../../storage/sqlite/db.js', () => ({ getDb: () => { throw new Error('Defaults must not open a database') } }))
vi.mock('../../../storage/mcp/mcp-config.js', () => ({ listServers: () => [] }))

beforeEach(() => {
  vi.stubEnv('OSM_MODE', 'balanced')
  vi.spyOn(skillsRegistry, 'getSkills').mockReturnValue([])
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

describe('recommended Agent permissions from the real registry', () => {
  it('matches selectable defaults and reconstructs an executable Agent without widening its permissions', async () => {
    const defaults = await recommendedAgentTools()
    expect(defaults).toEqual(expect.arrayContaining(['read_file', 'write_file', 'edit_file', 'execute_cmd', 'grep', 'office_document']))
    expect(defaults).not.toEqual(expect.arrayContaining(['agent_create']))
    expect(defaults.every(name => isDefaultTool(name) && name !== 'plan_update' && name !== 'load_tools')).toBe(true)
    const catalogue = await createToolRegistry({ toolProfile: 'general', toolExposure: 'catalogue',
      allowedMcpServers: [], allowedSkills: [], strictSkillBindings: true })
    expect(defaults).toEqual(catalogue.registry.list().map(tool => tool.name)
      .filter(name => isDefaultTool(name) && name !== 'plan_update' && name !== 'load_tools'))
    const execution = await createToolRegistry({ allowedTools: defaults, allowedMcpServers: [], allowedSkills: [], strictSkillBindings: true })
    expect(execution.registry.list().map(tool => tool.name).filter(name => name !== 'plan_update' && name !== 'load_tools')).toEqual(defaults)
    expect(execution.registry.has('agent_do_delete')).toBe(false)
  })

  it('persists the real defaults when omitted while preserving explicit []', async () => {
    const store = { list: vi.fn(async () => []), create: vi.fn(async (tenantId, input) => ({ ...input, tenantId, id: 'synthetic', createdAt: 1, updatedAt: 1 })) } as unknown as AgentManagementStore
    const service = new AgentManagementService(store)
    const created = await service.create('test', { name: 'Default fixture' })
    expect(created.allowedTools).toEqual(await recommendedAgentTools())
    expect(created.allowedTools).toContain('write_file')
    const disabled = await service.create('test', { name: 'Empty fixture', allowedTools: [] })
    expect(disabled.allowedTools).toEqual([])
  })

  it('uses the current OSM policy when resolving a new default profile', async () => {
    vi.stubEnv('OSM_MODE', 'off')
    const defaults = await recommendedAgentTools()
    expect(defaults).toContain('read_file')
    expect(defaults).toContain('write_file')
    expect(defaults).not.toContain('execute_cmd')
    expect(defaults).not.toContain('agent_create')
  })
})
