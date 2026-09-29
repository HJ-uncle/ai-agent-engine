/** Real factory registrations and executions; only external MCP connectivity/configuration is mocked. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext, Tool } from '../../core/agent-context/types.js'
import { ToolNotFoundError } from '../../core/agent-context/types.js'
import { createToolRegistry } from '../registry-factory.js'
import { CODE_BUILTIN_TOOLS, normalizeAllowedTools, normalizeToolName } from '../tool-profile.js'
import { createSubagentToolRegistry } from '../subagent/subagent-tool.js'
import { skillsRegistry } from '../../skills/index.js'
import { clearSecurityMode, setSecurityMode } from '../../security/policy-engine.js'

const external = vi.hoisted(() => ({ tools: [] as Array<Tool & { source?: string }> }))
vi.mock('../../storage/mcp/mcp-config.js', () => ({ listServers: () => [] }))
vi.mock('../mcp/client.js', () => ({ HTTPMCPClient: class { async toTools() { return external.tools } } }))

const context = { tenantId: 'profile-test', sessionId: 'session' } as AgentContext
const mcpServers = [{ id: 'fixture', name: 'fixture', transportType: 'http' as const, url: 'http://fixture.invalid' }]
const excluded = [
  'calculate', 'get_time', 'remember', 'recall', 'search_memory', 'list_memories', 'forget', 'link_memories',
  'install_package', 'list_packages', 'cron_list', 'cron_create', 'cron_update', 'cron_delete',
  'agent_list', 'agent_get', 'agent_create', 'agent_do_create', 'agent_update', 'agent_do_update', 'agent_delete', 'agent_do_delete',
  'task_list', 'task_cancel', 'task_status',
]

function tool(name: string, source?: string): Tool & { source?: string } {
  return { name, source, description: 'Fixture tool', parameters: { type: 'object' }, execute: vi.fn(async () => ({ success: true, output: name })) }
}

function expectExactCategories(result: Awaited<ReturnType<typeof createToolRegistry>>) {
  const categories = Object.values(result.toolCategories).flat()
  expect(categories).toHaveLength(new Set(categories).size)
  expect(categories.slice().sort()).toEqual(result.registry.list().map(item => item.name).sort())
}

beforeEach(() => {
  vi.stubEnv('OSM_MODE', 'balanced')
  external.tools = []
  vi.spyOn(skillsRegistry, 'getSkills').mockReturnValue([])
})
afterEach(() => { clearSecurityMode(context.tenantId, context.sessionId); vi.restoreAllMocks(); vi.unstubAllEnvs() })

describe('executable tool profiles', () => {
  it.each(['off', 'balanced', 'methodology', 'max'])('keeps code capabilities independent of OSM %s', async mode => {
    vi.stubEnv('OSM_MODE', mode)
    const result = await createToolRegistry({ toolProfile: 'code' })
    expect(result.registry.list().map(item => item.name).sort()).toEqual([...CODE_BUILTIN_TOOLS].sort())
    for (const name of excluded) {
      expect(result.registry.has(name), name).toBe(false)
      await expect(result.registry.execute(name, {}, context)).rejects.toBeInstanceOf(ToolNotFoundError)
    }
    expectExactCategories(result)
  })

  it('defaults to general with existing service tools and executable utility skills', async () => {
    const implicit = await createToolRegistry()
    const explicit = await createToolRegistry({ toolProfile: 'general' })
    expect(implicit.registry.list()).toEqual(explicit.registry.list())
    expect(implicit.registry.list().map(item => item.name)).toEqual(expect.arrayContaining(excluded.filter(name => name !== 'search_memory')))
    expect(implicit.registry.has('execute_cmd')).toBe(true)
    expect(implicit.registry.has('glob_search')).toBe(true)
    const result = await implicit.registry.execute('get_time', {}, context)
    expect(result.success).toBe(true)
    expect(result.output).toContain('20')
    expect(implicit.toolCategories.skillTools).toEqual(expect.arrayContaining(['calculate', 'get_time', 'list_skills', 'get_skill', 'run_skill_script']))
    expectExactCategories(implicit)
  })

  it('keeps exact editing available by default when OSM is off and respects explicit narrowing', async () => {
    vi.stubEnv('OSM_MODE', 'off')
    const general = await createToolRegistry()
    expect(general.registry.has('edit_file')).toBe(true)
    expect(general.registry.executionMode('edit_file', {})).toBe('serial')
    expect(general.toolCategories.builtinTools).toContain('edit_file')
    const readOnlySelection = await createToolRegistry({ allowedTools: ['read_file'] })
    expect(readOnlySelection.registry.has('edit_file')).toBe(false)
    const editSelection = await createToolRegistry({ toolProfile: 'code', allowedTools: ['edit_file'] })
    expect(editSelection.registry.list().map(item => item.name)).toEqual(['edit_file'])
  })

  it('does not leak tool selections between general, code and subsequent general registries', async () => {
    const first = await createToolRegistry({ toolProfile: 'general' })
    const code = await createToolRegistry({ toolProfile: 'code' })
    const second = await createToolRegistry({ toolProfile: 'general' })
    expect(first.registry.list().map(item => item.name)).toEqual(second.registry.list().map(item => item.name))
    expect(first.registry.has('cron_create')).toBe(true)
    expect(second.registry.has('cron_create')).toBe(true)
    expect(code.registry.has('cron_create')).toBe(false)
    code.registry.register(tool('cron_create'))
    await expect(code.registry.execute('cron_create', {}, context)).rejects.toBeInstanceOf(ToolNotFoundError)
    expect(first.registry.has('cron_create')).toBe(true)
    expectExactCategories(first)
    expectExactCategories(code)
    expectExactCategories(second)
  })

  it('intersects explicit lists with code capabilities and does not restore excluded tools or mandatory helpers', async () => {
    const result = await createToolRegistry({ toolProfile: 'code', allowedTools: ['read_file', ...excluded] })
    expect(result.registry.list().map(item => item.name)).toEqual(['read_file'])
    await expect(result.registry.execute('cron_create', {}, context)).rejects.toBeInstanceOf(ToolNotFoundError)
    expectExactCategories(result)
    const empty = await createToolRegistry({ toolProfile: 'code', allowedTools: [] })
    expect(empty.registry.list()).toEqual([])
    expectExactCategories(empty)
  })

  it('normalizes legacy allowlist names into canonical executable tools without registering alias bypasses', async () => {
    expect(normalizeAllowedTools(['smart_read', 'read_file', 'run_command', 'glob', 'grep'])).toEqual(['read_file', 'execute_cmd', 'glob_search', 'grep_search'])
    expect(normalizeToolName('cron_create')).toBe('cron_create')
    expect(normalizeToolName('toString')).toBe('toString')
    const result = await createToolRegistry({ toolProfile: 'code', allowedTools: ['smart_read', 'run_command', 'glob', 'grep'] })
    expect(result.registry.list().map(item => item.name).sort()).toEqual(['read_file', 'execute_cmd', 'glob_search', 'grep_search'].sort())
    for (const name of ['smart_read', 'run_command', 'glob', 'grep']) {
      expect(result.registry.has(name)).toBe(false)
      await expect(result.registry.execute(name, {}, context)).rejects.toBeInstanceOf(ToolNotFoundError)
    }
    const canonical = await createToolRegistry({ allowedTools: ['execute_cmd', 'glob_search', 'grep_search'] })
    expect(canonical.registry.list().map(item => item.name)).toEqual(expect.arrayContaining(['execute_cmd', 'glob_search', 'grep_search']))
    expectExactCategories(result)
  })

  it('retains configured MCP and inline skill access with accurate categories and actual execution', async () => {
    setSecurityMode(context.tenantId, context.sessionId, 'standard')
    external.tools = [tool('mcp_fixture_query')]
    const result = await createToolRegistry({ toolProfile: 'code', inlineMcpServers: mcpServers,
      inlineSkills: [{ id: 'fixture-skill', name: 'Fixture Skill', promptContent: 'Fixture instructions' }],
    })
    expect(result.externalSkills.map(skill => skill.name)).toEqual(['Fixture Skill'])
    expect(result.toolCategories.mcpTools).toEqual(['mcp_fixture_query'])
    expect(result.toolCategories.skillTools).toEqual(['list_skills', 'get_skill', 'run_skill_script'])
    await expect(result.registry.execute('mcp_fixture_query', {}, context)).resolves.toEqual({ success: true, output: 'mcp_fixture_query' })
    expect((await result.registry.execute('list_skills', {}, context)).output).toContain('Fixture Skill')
    expect((await result.registry.execute('get_skill', { name: 'Fixture Skill' }, context)).output).toBe('Fixture instructions')
    expectExactCategories(result)
  })

  it('applies explicit narrowing to MCP and skills without auto-adding tools for selected skills', async () => {
    external.tools = [tool('mcp_fixture_query'), tool('mcp_fixture_write')]
    const result = await createToolRegistry({ toolProfile: 'code', allowedTools: ['get_skill', 'mcp_fixture_query'],
      allowedSkills: ['fixture-skill'], inlineMcpServers: mcpServers,
      inlineSkills: [{ id: 'fixture-skill', name: 'Fixture Skill', promptContent: 'Fixture instructions' }],
    })
    expect(result.registry.list().map(item => item.name).sort()).toEqual(['get_skill', 'mcp_fixture_query'])
    await expect(result.registry.execute('mcp_fixture_write', {}, context)).rejects.toBeInstanceOf(ToolNotFoundError)
    expectExactCategories(result)
  })

  it('blocks late registrations and external tools impersonating excluded builtins or legacy aliases', async () => {
    const impostors = [...excluded, 'run_command', 'smart_read', 'glob', 'grep'].map(name => tool(name, 'skill'))
    external.tools = [...impostors, tool('mcp_fixture_query')]
    const result = await createToolRegistry({ toolProfile: 'code', inlineMcpServers: mcpServers })
    for (const candidate of impostors) {
      result.registry.register(candidate)
      expect(result.registry.has(candidate.name)).toBe(false)
      await expect(result.registry.execute(candidate.name, {}, context)).rejects.toBeInstanceOf(ToolNotFoundError)
      expect(candidate.execute).not.toHaveBeenCalled()
    }
    expect(result.toolCategories.mcpTools).toEqual(['mcp_fixture_query'])
    expectExactCategories(result)
  })

  it('permits configured dynamic skill identities while rejecting general service identities', async () => {
    setSecurityMode(context.tenantId, context.sessionId, 'standard')
    const result = await createToolRegistry({ toolProfile: 'code' })
    const dynamic = tool('fixture_skill_action', 'skill')
    result.registry.register(dynamic)
    await expect(result.registry.execute(dynamic.name, {}, context)).resolves.toEqual({ success: true, output: dynamic.name })
    result.registry.register(tool('unclassified_builtin'))
    expect(result.registry.has('unclassified_builtin')).toBe(false)
    result.registry.register(tool('calculate', 'skill'))
    expect(result.registry.has('calculate')).toBe(false)
  })

  it('child registries inherit the profile and may only reduce the parent capability set', async () => {
    const parent = await createToolRegistry({ toolProfile: 'code' })
    const child = createSubagentToolRegistry(parent.registry, false)
    expect(child.has('execute_cmd')).toBe(true)
    expect(child.has('read_file')).toBe(true)
    expect(child.has('edit_file')).toBe(true)
    expect(child.executionMode?.('edit_file', {})).toBe('serial')
    expect(child.has('subagent')).toBe(false)
    expect(child.has('ask_user')).toBe(false)
    for (const name of excluded) {
      expect(child.has(name)).toBe(false)
      await expect(child.execute(name, {}, context)).resolves.toMatchObject({ success: false, metadata: { blocked: true } })
    }
    const readOnly = createSubagentToolRegistry(parent.registry, true)
    expect(readOnly.has('read_file')).toBe(true)
    expect(readOnly.has('execute_cmd')).toBe(false)
    expect(readOnly.has('edit_file')).toBe(false)
    await expect(readOnly.preflight?.('edit_file', {}, context)).resolves.toMatchObject({ success: false, metadata: { blocked: true, code: 'TOOL_NOT_ALLOWED' } })
    await expect(readOnly.execute('edit_file', {}, context)).resolves.toMatchObject({ success: false, metadata: { blocked: true, code: 'TOOL_NOT_ALLOWED' } })
    expect(readOnly.list().every(item => parent.registry.has(item.name))).toBe(true)
  })
})
