/** Real factory registrations and executions; only external MCP connectivity/configuration is mocked. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentContext, IToolRegistry, Tool } from '../../core/agent-context/types.js'
import { ToolNotFoundError } from '../../core/agent-context/types.js'
import { createToolRegistry } from '../registry-factory.js'
import { CODE_BUILTIN_TOOLS, normalizeAllowedTools, normalizeToolName } from '../tool-profile.js'
import { isDefaultTool, OPTIONAL_TOOL_EXPOSURES, REMOVED_TOOL_NAMES } from '../tool-exposure.js'
import { createSubagentToolRegistry } from '../subagent/subagent-tool.js'
import { skillsRegistry } from '../../skills/index.js'
import { clearSecurityMode, setSecurityMode } from '../../security/policy-engine.js'
import { logger } from '../../observability/index.js'
import { createPptx } from '../office/pptx.js'
import { AGENT_MANAGEMENT_TOOLS, MCP_MANAGEMENT_TOOLS, KNOWLEDGE_READ_TOOLS, MANAGEMENT_TOOL_NAMES, TOOLKIT_IDS, toolkitToolNames, isAgentManagementTool, normalizeToolkits } from '../toolkits.js'
import { toolSource } from '../../core/runtime-capabilities.js'

const external = vi.hoisted(() => ({ tools: [] as Array<Tool & { source?: string }> }))
vi.mock('../../storage/mcp/mcp-config.js', () => ({ listServers: () => [] }))
vi.mock('../mcp/client.js', () => ({ HTTPMCPClient: class { async toTools() { return external.tools } } }))

const context = { tenantId: 'profile-test', sessionId: 'session' } as AgentContext
const mcpServers = [{ id: 'fixture', name: 'fixture', transportType: 'http' as const, url: 'http://fixture.invalid' }]
const excluded = [
  'calculate', 'get_time', 'remember', 'recall', 'search_memory', 'list_memories', 'forget', 'link_memories',
  'install_package', 'list_packages', 'office_document', 'office_environment', 'cron_list', 'cron_create', 'cron_update', 'cron_delete',
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
  it.each([undefined, [], ['read_file']])('provides only trusted reading capabilities for selected knowledge with business allowlist %j', async allowedTools => {
    const options = { allowedTools, allowedMcpServers: [], toolkitAllowedTools: [] }
    const normal = (await createToolRegistry(options)).registry
    const selected = await createToolRegistry({ ...options, knowledgeReadScope: ['selected-base'] })
    const reading = selected.registry
    for (const name of KNOWLEDGE_READ_TOOLS) {
      expect(normal.has(name)).toBe(false)
      expect(reading.listForRequest().map(tool => tool.name)).toContain(name)
      expect(reading.executionMode(name, {})).toBe('readonly')
      const impostor = tool(name, 'skill')
      reading.register(impostor)
      expect(reading.list().find(tool => tool.name === name)?.description).not.toBe('Fixture tool')
    }
    for (const name of ['knowledge_create', 'knowledge_delete', 'knowledge_import', 'knowledge_document_update']) expect(reading.has(name)).toBe(false)
    const empty = (await createToolRegistry({ ...options, knowledgeReadScope: [] })).registry
    const code = (await createToolRegistry({ ...options, toolProfile: 'code', knowledgeReadScope: ['selected-base'] })).registry
    for (const name of KNOWLEDGE_READ_TOOLS) { expect(empty.has(name)).toBe(false); expect(code.has(name)).toBe(false) }
    expectExactCategories(selected)
  })

  it.each(['off', 'balanced'])('loads the explicit Work toolkit initially without widening defaults under OSM %s', async mode => {
    vi.stubEnv('OSM_MODE', mode)
    const plain = (await createToolRegistry({ allowedMcpServers: [] })).registry
    const enabled = (await createToolRegistry({ allowedMcpServers: [], toolkits: ['agent-management'] })).registry
    expect(enabled.list().map(tool => tool.name).filter(name => !isAgentManagementTool(name)))
      .toEqual(plain.list().map(tool => tool.name))
    const offered = enabled.listForRequest().map(tool => tool.name)
    expect(offered.filter(isAgentManagementTool)).toEqual(AGENT_MANAGEMENT_TOOLS)
    expect(enabled.listForRequest([]).map(tool => tool.name)).toEqual(offered)
    const reconstructed = (await createToolRegistry({ allowedMcpServers: [], toolkits: ['agent-management'] })).registry
    expect(reconstructed.listForRequest([])).toEqual(enabled.listForRequest([]))
    const disabled = (await createToolRegistry({ allowedMcpServers: [], toolkits: [] })).registry
    expect(disabled.list()).toEqual(plain.list())
  })

  it('rejects unavailable toolkit IDs, Code use, and either request or bound Agent ceilings', async () => {
    for (const raw of ['agent-management', null, ['unknown'], ['agent-management', 'agent-management']])
      expect(() => normalizeToolkits(raw)).toThrow('toolkits')
    await expect(createToolRegistry({ toolProfile: 'code', toolkits: ['agent-management'] })).rejects.toThrow('Work')
    await expect(createToolRegistry({ toolkits: ['agent-management'], allowedTools: [] })).rejects.toThrow('白名单')
    await expect(createToolRegistry({ toolkits: ['agent-management'], allowedTools: [...AGENT_MANAGEMENT_TOOLS], toolkitAllowedTools: ['read_file'] })).rejects.toThrow('白名单')
    const permitted = (await createToolRegistry({ toolkits: ['agent-management'], allowedTools: [...AGENT_MANAGEMENT_TOOLS], toolkitAllowedTools: [...AGENT_MANAGEMENT_TOOLS] })).registry
    expect(permitted.listForRequest().map(tool => tool.name)).toEqual(expect.arrayContaining([...AGENT_MANAGEMENT_TOOLS]))
  })

  it('combines independent packages in stable order without leaking management into children or defaults', async () => {
    const { registry } = await createToolRegistry({ toolkits: [...TOOLKIT_IDS].reverse(), allowedMcpServers: [] })
    const names = toolkitToolNames(TOOLKIT_IDS)
    expect(normalizeToolkits([...TOOLKIT_IDS].reverse())).toEqual(TOOLKIT_IDS)
    for (const name of names) expect(registry.listForRequest().some(tool => tool.name === name), name).toBe(true)
    expect(new Set(names).size).toBe(names.length)
    const child = createSubagentToolRegistry(registry, false)
    for (const name of names) {
      expect(child.has(name), name).toBe(false)
      registry.register(tool(name, 'skill'))
      expect(registry.list().find(candidate => candidate.name === name)?.description, name).not.toBe('Fixture tool')
    }
    const reduced = (await createToolRegistry({ toolkits: ['skill-management'], allowedMcpServers: [] })).registry
    expect(reduced.has('skill_update')).toBe(true)
    expect(reduced.has('knowledge_create')).toBe(false)
    expect(reduced.has('cron_create')).toBe(false)
    expect(reduced.has('agent_create')).toBe(false)
  })

  it.each([true, false])('does not inherit root management tools or loaders into children (readOnly=%s)', async readOnly => {
    const parent = (await createToolRegistry({ toolkits: ['agent-management'], allowedMcpServers: [] })).registry
    const child = createSubagentToolRegistry(parent, readOnly)
    for (const name of AGENT_MANAGEMENT_TOOLS) expect(child.has(name), name).toBe(false)
    expect(() => child.loadForModel!(['agent_do_delete'])).toThrow('unavailable')
    expect(child.listForRequest!().every(tool => !isAgentManagementTool(tool.name))).toBe(true)
  })

  it('does not admit an extension impersonating an enabled toolkit builtin', async () => {
    const registry = (await createToolRegistry({ toolkits: ['agent-management'], allowedMcpServers: [] })).registry
    registry.unregister('agent_delete')
    registry.register(tool('agent_delete', 'skill'))
    expect(registry.has('agent_delete')).toBe(false)
    registry.register(tool('agent_do_delete', 'skill'))
    expect(registry.has('agent_do_delete')).toBe(false)
  })

  it('keeps MCP administration builtin and opt-in without blocking ordinary MCP tools in Code', async () => {
    external.tools = [tool('mcp_fixture_query', 'mcp'), tool('mcp_server_get', 'mcp')]
    const options = { inlineMcpServers: mcpServers }
    const normal = await createToolRegistry(options)
    const enabled = await createToolRegistry({ ...options, toolkits: ['mcp-management'] })
    const code = await createToolRegistry({ ...options, toolProfile: 'code', allowedTools: [...MCP_MANAGEMENT_TOOLS, 'mcp_fixture_query'] })
    const restricted = await createToolRegistry({ ...options, toolkitAllowedTools: [], allowedTools: [...MCP_MANAGEMENT_TOOLS] })
    for (const name of MCP_MANAGEMENT_TOOLS) {
      expect(normal.registry.has(name), name).toBe(false)
      expect(restricted.registry.has(name), name).toBe(false)
      expect(code.registry.has(name), name).toBe(false)
      const definition = enabled.registry.listForRequest().find(candidate => candidate.name === name)!
      expect(toolSource(definition)).toBe('builtin')
      expect(enabled.toolCategories.builtinTools).toContain(name)
      expect(enabled.toolCategories.mcpTools).not.toContain(name)
    }
    expect(code.registry.has('mcp_fixture_query')).toBe(true)
    for (const readOnly of [true, false]) {
      const child = createSubagentToolRegistry(enabled.registry, readOnly)
      for (const name of MCP_MANAGEMENT_TOOLS) expect(child.has(name)).toBe(false)
    }
  })

  it('merges legacy Agent permissions into five canonical capabilities without exposing executable aliases', async () => {
    const legacy = ['agent_list', 'agent_get', 'agent_do_create', 'agent_do_update', 'agent_do_delete']
    const registry = (await createToolRegistry({ toolkits: ['agent-management'], allowedTools: [...legacy, 'agent_create'],
      toolkitAllowedTools: legacy, allowedMcpServers: [] })).registry
    expect(normalizeAllowedTools([...legacy, 'agent_create'])).toEqual(AGENT_MANAGEMENT_TOOLS)
    expect(registry.list().filter(tool => tool.name.startsWith('agent_')).map(tool => tool.name)).toEqual(AGENT_MANAGEMENT_TOOLS)
    expect(registry.listForRequest().filter(tool => tool.name.startsWith('agent_')).map(tool => tool.name)).toEqual(AGENT_MANAGEMENT_TOOLS)
    expect(registry.listForRequest().find(tool => tool.name === 'load_tools')?.description).not.toContain('agent_do_')
    for (const name of legacy.filter(name => name.startsWith('agent_do_'))) {
      expect(registry.has(name)).toBe(false)
      expect(() => registry.loadForModel([name])).toThrow('unavailable')
      await expect(registry.execute(name, {}, context)).rejects.toBeInstanceOf(ToolNotFoundError)
    }
  })
  it('pairs only the actual native Office tool with its bundled guide under strict empty external bindings', async () => {
    vi.mocked(skillsRegistry.getSkills).mockReturnValue([
      { name: 'aether-office', description: 'UNSELECTED_EXTERNAL_OVERRIDE', skillMdPath: '', inlineContent: 'UNSELECTED_EXTERNAL_OVERRIDE', order: 0, enabled: true },
      { name: 'private-external', description: 'UNSELECTED_EXTERNAL', skillMdPath: '', inlineContent: 'UNSELECTED_EXTERNAL', order: 1, enabled: true },
    ])
    const office = await createToolRegistry({ toolProfile: 'general', allowedTools: ['office_document', 'get_skill'],
      allowedSkills: [], strictSkillBindings: true, allowedMcpServers: [] })
    expect(office.externalSkills).toHaveLength(1)
    expect(office.externalSkills[0]).toMatchObject({ name: 'aether-office', builtin: true })
    const guide = await office.registry.execute('get_skill', { name: 'aether-office' }, context)
    expect(guide.success).toBe(true)
    expect(guide.output).toContain('已有共享草稿直接复用')
    expect(guide.output).not.toContain('UNSELECTED_EXTERNAL')
    const withoutOffice = await createToolRegistry({ toolProfile: 'general', allowedTools: ['get_skill'],
      allowedSkills: [], strictSkillBindings: true, allowedMcpServers: [] })
    expect(withoutOffice.externalSkills).toEqual([])
    expect((withoutOffice.registry as IToolRegistry).skillsForPrompt?.()).toEqual([])
    withoutOffice.registry.register(tool('office_document', 'mcp'))
    expect((withoutOffice.registry as IToolRegistry).skillsForPrompt?.()).toEqual([])
    office.registry.unregister('office_document')
    office.registry.register(tool('office_document', 'mcp'))
    expect((office.registry as IToolRegistry).skillsForPrompt?.()).toEqual([])
  })

  it('does not advertise the bundled office workflow when its required API is excluded', async () => {
    vi.mocked(skillsRegistry.getSkills).mockReturnValue([{ name: 'aether-office', description: 'office', builtin: true, skillMdPath: '', order: 0, enabled: true },
      { name: 'external-office', description: 'independent workflow', skillMdPath: '', order: 1, enabled: true }])
    const code = await createToolRegistry({ toolProfile: 'code' })
    expect(code.externalSkills.map(skill => skill.name)).toEqual(['external-office'])
    const work = await createToolRegistry({ toolProfile: 'general' })
    expect(work.externalSkills.map(skill => skill.name)).toContain('aether-office')
    const restricted = await createToolRegistry({ toolProfile: 'general', allowedTools: ['get_skill'] })
    expect(restricted.externalSkills.map(skill => skill.name)).not.toContain('aether-office')
  })

  it('exposes workbench APIs under the normal profile and allowlist boundary', async () => {
    const code = await createToolRegistry({ toolProfile: 'code' })
    expect(code.registry.executionMode('workbench_context', {})).toBe('readonly')
    expect(code.registry.executionMode('workbench_open', {})).toBe('serial')
    const selected = await createToolRegistry({ toolProfile: 'code', allowedTools: ['workbench_context'] })
    expect(selected.registry.list().map(item => item.name).sort()).toEqual(['load_tools', 'plan_update', 'workbench_context'])
    expect(createSubagentToolRegistry(code.registry, true).has('workbench_context')).toBe(true)
  })

  it.each(['off', 'balanced', 'methodology', 'max'])('keeps code capabilities independent of OSM %s', async mode => {
    vi.stubEnv('OSM_MODE', mode)
    const result = await createToolRegistry({ toolProfile: 'code' })
    expect(result.registry.list().map(item => item.name).sort()).toEqual([...CODE_BUILTIN_TOOLS, 'load_tools'].filter(isDefaultTool).sort())
    for (const name of excluded) {
      expect(result.registry.has(name), name).toBe(false)
      await expect(result.registry.execute(name, {}, context)).rejects.toBeInstanceOf(ToolNotFoundError)
    }
    expectExactCategories(result)
  })

  it('registers only trusted memory tools from the resolved scopes and removes them when both are disabled', async () => {
    const warn = vi.spyOn(logger, 'warn')
    const enabled = await createToolRegistry({ toolProfile: 'code', memoryScopes: ['global', 'session'] })
    expect(enabled.registry.has('remember')).toBe(true)
    expect(enabled.registry.has('recall')).toBe(true)
    const disabled = await createToolRegistry({ toolProfile: 'general', memoryScope: 'global', memoryScopes: [] })
    expect(disabled.registry.has('remember')).toBe(false)
    expect(disabled.registry.has('recall')).toBe(false)
    vi.stubEnv('ENABLE_LONG_TERM_MEMORY', 'false')
    const serverDisabled = await createToolRegistry({ toolProfile: 'general', memoryScopes: ['global', 'session'] })
    expect(serverDisabled.registry.has('remember')).toBe(false)
    expect(warn.mock.calls.filter(args => args.some(value => typeof value === 'string' && value.startsWith('OSM: CORE tools not found')))).toEqual([])
  })

  it('defaults to general with core execution, excluding optional services and removed tools', async () => {
    const implicit = await createToolRegistry()
    const explicit = await createToolRegistry({ toolProfile: 'general' })
    expect(implicit.registry.list()).toEqual(explicit.registry.list())
    const memory = new Set(['remember', 'recall', 'search_memory', 'list_memories', 'forget', 'link_memories'])
    expect(implicit.registry.list().map(item => item.name)).toEqual(expect.arrayContaining(excluded.filter(name => !memory.has(name) && isDefaultTool(name))))
    for (const name of memory) expect(implicit.registry.has(name), name).toBe(false)
    for (const name of Object.keys(OPTIONAL_TOOL_EXPOSURES)) {
      expect(implicit.registry.has(name), name).toBe(false)
      await expect(implicit.registry.execute(name, {}, context)).rejects.toBeInstanceOf(ToolNotFoundError)
    }
    expect(implicit.registry.has('execute_cmd')).toBe(true)
    expect(implicit.registry.has('glob')).toBe(true)
    expect(implicit.toolCategories.skillTools).toEqual(expect.arrayContaining(['list_skills', 'get_skill', 'run_skill_script']))
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
    expect(editSelection.registry.list().map(item => item.name)).toEqual(['edit_file', 'plan_update'])
  })

  it('keeps office inspect and mutation trusted serial in general, with no widening of readonly children', async () => {
    vi.stubEnv('OSM_MODE', 'off')
    const general = await createToolRegistry({ toolProfile: 'general' })
    expect(general.registry.has('office_document')).toBe(true)
    for (const operation of ['inspect', 'create', 'edit']) expect(general.registry.executionMode('office_document', { operation })).toBe('serial')
    const readonlyChild = createSubagentToolRegistry(general.registry, true)
    expect(readonlyChild.has('office_document')).toBe(false)
    expect(createSubagentToolRegistry(general.registry, false).has('office_document')).toBe(true)
    const narrowed = await createToolRegistry({ allowedTools: ['read_file'] })
    expect(narrowed.registry.has('office_document')).toBe(false)
  })

  it('admits the office environment helper in Work and execution children while keeping research free of process probes', async () => {
    vi.stubEnv('OSM_MODE', 'off')
    vi.stubEnv('AETHER_WORKSPACE_RUNTIME', 'restricted-files')
    const general = await createToolRegistry({ toolProfile: 'general' })
    expect(general.registry.executionMode('office_environment', {})).toBe('readonly')
    const research = createSubagentToolRegistry(general.registry, true)
    expect(research.has('office_environment')).toBe(false)
    expect(await research.execute('office_environment', {}, context)).toMatchObject({ success: false, metadata: { code: 'TOOL_NOT_ALLOWED' } })
    const child = createSubagentToolRegistry(general.registry, false)
    expect(child.has('office_environment')).toBe(true)
    expect(child.executionMode?.('office_environment', {})).toBe('readonly')
    const observation = await child.execute('office_environment', {}, context)
    expect(observation).toMatchObject({ success: true, metadata: { readonly: true, fileMutationApplied: false } })
    expect(JSON.parse(observation.output)).toMatchObject({ runtime: 'restricted-files', status: 'unavailable' })
    const selected = await createToolRegistry({ allowedTools: ['office_environment'], allowedMcpServers: [] })
    expect(selected.registry.list().map(candidate => candidate.name).sort()).toEqual(['load_tools', 'office_environment', 'plan_update'])
    const narrowed = await createToolRegistry({ allowedTools: ['read_file'], allowedMcpServers: [] })
    expect(narrowed.registry.has('office_environment')).toBe(false)
    expect(createSubagentToolRegistry(narrowed.registry, true).has('office_environment')).toBe(false)
    general.registry.unregister('office_environment')
    general.registry.register(tool('office_environment', 'skill'))
    expect(createSubagentToolRegistry(general.registry, true).has('office_environment')).toBe(false)
  })

  it.each(['general', 'code'] as const)('%s trusts only the builtin office inspector and never expands explicit tool selections', async toolProfile => {
    const selected = await createToolRegistry({ toolProfile, allowedTools: ['office_inspect'], allowedMcpServers: [] })
    expect(selected.registry.list().map(candidate => candidate.name).sort()).toEqual(['load_tools', 'office_inspect', 'plan_update'])
    expect(selected.registry.executionMode('office_inspect', {})).toBe('readonly')
    expect(createSubagentToolRegistry(selected.registry, true).has('office_inspect')).toBe(true)
    for (const allowedTools of [[], ['read_file'], ['office_document']]) {
      const narrowed = await createToolRegistry({ toolProfile, allowedTools, allowedMcpServers: [] })
      expect(narrowed.registry.has('office_inspect')).toBe(false)
      expect(createSubagentToolRegistry(narrowed.registry, true).has('office_inspect')).toBe(false)
    }
    selected.registry.unregister('office_inspect')
    const impostor = tool('office_inspect', 'skill')
    selected.registry.register(impostor)
    expect(selected.registry.executionMode('office_inspect', {})).toBe('serial')
    const child = createSubagentToolRegistry(selected.registry, true)
    expect(child.has('office_inspect')).toBe(false)
    expect(await child.execute('office_inspect', {}, context)).toMatchObject({ success: false, metadata: { code: 'TOOL_NOT_ALLOWED' } })
    expect(impostor.execute).not.toHaveBeenCalled()
  })
  it('lets Code and its readonly children read real PPTX handoff text and notes without changing the file', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-code-office-read-'))
    try {
      vi.stubEnv('AUTH_ENABLED', 'false')
      const bytes = await createPptx({ slides: [{ title: 'Product handoff', bullets: ['Area scoring'], notes: 'Keep komi 7.5' }] })
      const file = path.join(root, 'handoff.pptx')
      fs.writeFileSync(file, bytes)
      const ctx = { ...context, toolProfile: 'code', workspacePaths: [root], projectRoot: root, cwd: root } as AgentContext
      const code = await createToolRegistry({ toolProfile: 'code', allowedMcpServers: [] })
      expect(code.registry.executionMode('office_inspect', {})).toBe('readonly')
      expect(code.registry.has('office_document')).toBe(false)
      expect(code.registry.has('office_environment')).toBe(false)
      const child = createSubagentToolRegistry(code.registry, true)
      for (const registry of [code.registry, child]) {
        const result = await registry.execute('office_inspect', { path: file }, ctx)
        expect(result).toMatchObject({ success: true, metadata: { fileMutationApplied: false } })
        const observation = JSON.parse(result.output)
        expect(observation.content).toContain('Area scoring')
        expect(observation.content).toContain('target=notes')
        expect(observation.content).toContain('Keep komi 7.5')
        expect(observation.expectedHash).toMatch(/^sha256:[a-f0-9]{64}$/)
        expect(observation.visualValidation).toBe('not-performed')
        expect(await registry.execute('office_inspect', { path: file, operation: 'edit' }, ctx)).toMatchObject({ success: false })
      }
      expect(fs.readFileSync(file)).toEqual(bytes)
    } finally {
      const resolved = path.resolve(root)
      if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('aether-code-office-read-')) throw new Error('Unsafe Office reader fixture cleanup')
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
    }
  })
  it('does not leak tool selections between general, code and subsequent general registries', async () => {
    const first = await createToolRegistry({ toolProfile: 'general' })
    const code = await createToolRegistry({ toolProfile: 'code' })
    const second = await createToolRegistry({ toolProfile: 'general' })
    expect(first.registry.list().map(item => item.name)).toEqual(second.registry.list().map(item => item.name))
    expect(first.registry.has('cron_create')).toBe(false)
    expect(second.registry.has('cron_create')).toBe(false)
    expect(code.registry.has('cron_create')).toBe(false)
    code.registry.register(tool('cron_create'))
    await expect(code.registry.execute('cron_create', {}, context)).rejects.toBeInstanceOf(ToolNotFoundError)
    expect(first.registry.has('cron_create')).toBe(false)
    expectExactCategories(first)
    expectExactCategories(code)
    expectExactCategories(second)
  })

  it('intersects explicit lists with code capabilities while preserving only the builtin plan helper', async () => {
    const result = await createToolRegistry({ toolProfile: 'code', allowedTools: ['read_file', ...excluded] })
    expect(result.registry.list().map(item => item.name)).toEqual(['read_file', 'plan_update'])
    await expect(result.registry.execute('cron_create', {}, context)).rejects.toBeInstanceOf(ToolNotFoundError)
    expectExactCategories(result)
    const empty = await createToolRegistry({ toolProfile: 'code', allowedTools: [] })
    expect(empty.registry.list().map(item => item.name)).toEqual(['plan_update'])
    expectExactCategories(empty)
  })

  it.each(['general', 'code'] as const)('%s provides only owned lifecycle controls for verified user delegations with no business tools', async toolProfile => {
    const result = await createToolRegistry({ toolProfile, allowedTools: [], allowedMcpServers: [], ownedCollaboration: true })
    expect(result.registry.list().map(candidate => candidate.name).sort()).toEqual([
      'load_tools', 'plan_update', 'subagent_wait', 'subagent_cancel', 'subagent_send', 'subagent_participants', 'subagent_inbox',
      'subagent_directory', 'subagent_followup', 'subagent_request_input', 'subagent_read_result',
    ].sort())
    for (const name of ['subagent', 'subagent_start', 'write_file', 'execute_cmd', 'http_request']) expect(result.registry.has(name)).toBe(false)
    expectExactCategories(result)
    const impostor = tool('subagent_send', 'skill')
    result.registry.register(impostor)
    // Missing actual execution ownership is still rejected by the true builtin.
    expect(await result.registry.execute('subagent_send', { recipientParticipantId: 'child:fake', message: 'x', requestKey: 'x' }, context))
      .toMatchObject({ success: false, metadata: { code: 'SUBAGENT_CONTROL_FAILED' } })
    expect(impostor.execute).not.toHaveBeenCalled()
    const ordinary = await createToolRegistry({ toolProfile, allowedTools: [], allowedMcpServers: [] })
    expect(ordinary.registry.list().map(candidate => candidate.name)).toEqual(['plan_update'])
  })

  it('normalizes legacy allowlist names into canonical executable tools without registering alias bypasses', async () => {
    expect(normalizeAllowedTools(['smart_read', 'read_file', 'run_command', 'glob', 'grep'])).toEqual(['read_file', 'execute_cmd', 'glob', 'grep'])
    expect(normalizeToolName('cron_create')).toBe('cron_create')
    expect(normalizeToolName('toString')).toBe('toString')
    const result = await createToolRegistry({ toolProfile: 'code', allowedTools: ['smart_read', 'run_command', 'glob', 'grep'] })
    expect(result.registry.list().map(item => item.name).sort()).toEqual(['read_file', 'execute_cmd', 'glob', 'grep', 'plan_update'].sort())
    for (const name of ['smart_read', 'run_command', 'glob_search', 'grep_search']) {
      expect(result.registry.has(name)).toBe(false)
      await expect(result.registry.execute(name, {}, context)).rejects.toBeInstanceOf(ToolNotFoundError)
    }
    const canonical = await createToolRegistry({ allowedTools: ['execute_cmd', 'glob', 'grep'] })
    expect(canonical.registry.list().map(item => item.name)).toEqual(expect.arrayContaining(['execute_cmd', 'glob', 'grep']))
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
    expect(result.registry.list().map(item => item.name).sort()).toEqual(['get_skill', 'mcp_fixture_query', 'plan_update'].sort())
    await expect(result.registry.execute('mcp_fixture_write', {}, context)).rejects.toBeInstanceOf(ToolNotFoundError)
    expectExactCategories(result)
  })

  it('blocks late registrations and external tools impersonating excluded builtins or legacy aliases', async () => {
    const impostors = [...excluded, 'run_command', 'smart_read', 'glob_search', 'grep_search'].map(name => tool(name, 'skill'))
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
    expect(child.has('command_output')).toBe(true)
    expect(child.has('cancel_command')).toBe(true)
    expect(child.executionMode?.('command_output', {})).toBe('readonly')
    expect(child.executionMode?.('cancel_command', {})).toBe('serial')
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
    expect(readOnly.has('plan_update')).toBe(true)
    expect(readOnly.executionMode?.('plan_update', {})).toBe('serial')
    expect(readOnly.has('execute_cmd')).toBe(false)
    expect(readOnly.has('cancel_command')).toBe(false)
    expect(readOnly.has('edit_file')).toBe(false)
    await expect(readOnly.preflight?.('edit_file', {}, context)).resolves.toMatchObject({ success: false, metadata: { blocked: true, code: 'TOOL_NOT_ALLOWED' } })
    await expect(readOnly.execute('edit_file', {}, context)).resolves.toMatchObject({ success: false, metadata: { blocked: true, code: 'TOOL_NOT_ALLOWED' } })
    expect(readOnly.list().every(item => parent.registry.has(item.name))).toBe(true)
  })
})

describe('lean execution defaults and selectable compatibility catalogue', () => {
  it.each(['general', 'code'] as const)('%s keeps its complete configurable catalogue without enabling it in ordinary runs', async toolProfile => {
    const options = { toolProfile, allowedMcpServers: [], memoryScopes: [] }
    const normal = await createToolRegistry(options)
    const catalogue = await createToolRegistry({ ...options, toolExposure: 'catalogue' })
    const later = await createToolRegistry(options)
    expect(later.registry.list()).toEqual(normal.registry.list())
    const optional = [...new Set([...Object.keys(OPTIONAL_TOOL_EXPOSURES), ...MANAGEMENT_TOOL_NAMES])].filter(name => toolProfile === 'general' || CODE_BUILTIN_TOOLS.has(name))
    expect(catalogue.registry.list().length - normal.registry.list().length).toBe(optional.length)
    for (const name of optional) {
      expect(catalogue.registry.has(name), name).toBe(true)
      expect(normal.registry.has(name), name).toBe(false)
      normal.registry.register(tool(name, 'skill'))
      expect(normal.registry.has(name), `${name} cannot be restored by late registration`).toBe(false)
    }
    for (const result of [normal, catalogue, later]) expectExactCategories(result)
    const schemaChars = (result: typeof normal) => JSON.stringify(result.registry.list().map(({ name, description, parameters }) => ({ name, description, parameters }))).length
    console.info('TOOL_EXPOSURE_AUDIT', JSON.stringify({ toolProfile, memoryScopes: [], catalogueCount: catalogue.registry.list().length,
      defaultCount: normal.registry.list().length, catalogueSchemaChars: schemaChars(catalogue), defaultSchemaChars: schemaChars(normal), optional }))
  })

  it('preserves explicitly selected legacy tools while enforcing profile and exact allowlists', async () => {
    const selected = await createToolRegistry({ allowedTools: ['agent_list'], allowedMcpServers: [] })
    expect(selected.registry.list().map(item => item.name).sort()).toEqual(['agent_list', 'load_tools', 'plan_update'])
    const code = await createToolRegistry({ toolProfile: 'code', allowedTools: ['todo_list', 'agent_list'], allowedMcpServers: [] })
    expect(code.registry.list().map(item => item.name).sort()).toEqual(['load_tools', 'plan_update', 'todo_list'])
    for (const toolExposure of ['runtime', 'catalogue'] as const) {
      const none = await createToolRegistry({ toolExposure, allowedTools: [], allowedMcpServers: [] })
      expect(none.registry.list().map(item => item.name)).toEqual(['plan_update'])
    }
  })

  it('keeps default and configured optional tools inside OSM off restrictions', async () => {
    vi.stubEnv('OSM_MODE', 'off')
    const normal = await createToolRegistry({ allowedMcpServers: [] })
    for (const name of ['todo_list', 'calculate', 'agent_list', 'task_list', 'install_package']) expect(normal.registry.has(name), name).toBe(false)
    const selected = await createToolRegistry({ allowedTools: ['todo_list', 'agent_list', 'read_file'], allowedMcpServers: [] })
    expect(selected.registry.list().map(item => item.name).sort()).toEqual(['load_tools', 'plan_update', 'read_file', 'todo_list'])
  })
})

describe('removed tools have no executable or catalogue compatibility path', () => {
  it.each(['general', 'code'] as const)('%s rejects removed implementations, explicit names and extension impersonation', async toolProfile => {
    for (const toolExposure of ['runtime', 'catalogue'] as const) {
      for (const allowedTools of [undefined, [...REMOVED_TOOL_NAMES], ['read_file', ...REMOVED_TOOL_NAMES]]) {
        const result = await createToolRegistry({ toolProfile, toolExposure, allowedTools, allowedMcpServers: [] })
        for (const name of REMOVED_TOOL_NAMES) {
          expect(result.registry.has(name), name).toBe(false)
          for (const source of [undefined, 'skill', 'mcp']) {
            result.registry.register(tool(name, source))
            expect(result.registry.has(name), name).toBe(false)
          }
          await expect(result.registry.execute(name, {}, context)).rejects.toBeInstanceOf(ToolNotFoundError)
        }
        expectExactCategories(result)
      }
    }
  })
})


describe('explicit whitelists for unattended and custom Agent runs', () => {
  it.each(['general', 'code'] as const)('%s never auto-registers ask_user or skills outside an explicit list', async toolProfile => {
    const result = await createToolRegistry({ toolProfile, allowedTools: ['read_file'], allowedSkills: ['fixture-skill'], inlineSkills: [{ id: 'fixture-skill', name: 'Fixture Skill', promptContent: 'read only' }] })
    expect(result.registry.list().map(item => item.name)).toEqual(['read_file', 'plan_update'])
    await expect(result.registry.preflight('ask_user', { question: 'unexpected pause' }, context)).rejects.toBeInstanceOf(ToolNotFoundError)
    result.registry.register(tool('ask_user'))
    expect(result.registry.has('ask_user')).toBe(false)
    expectExactCategories(result)
    const empty = await createToolRegistry({ toolProfile, allowedTools: [] })
    expect(empty.registry.list().map(item => item.name)).toEqual(['plan_update'])
  })
})


describe('session-local planning is builtin in every execution profile', () => {
  it.each(['general', 'code'] as const)('%s exposes planning with zero business capabilities in all security modes', async toolProfile => {
    for (const securityMode of ['safe', 'standard', 'full-access'] as const) {
      setSecurityMode(context.tenantId, context.sessionId, securityMode)
      const result = await createToolRegistry({ toolProfile, allowedTools: [], allowedMcpServers: [], allowedSkills: [] })
      expect(result.registry.list().map(item => item.name)).toEqual(['plan_update'])
      expect(result.registry.executionMode('plan_update', {})).toBe('serial')
      expect(await result.registry.preflight('plan_update', { plan: [] }, context)).toBeUndefined()
      for (const name of ['execute_cmd', 'write_file', 'ask_user', 'cron_create', 'todo_create']) {
        expect(result.registry.has(name), name).toBe(false)
        await expect(result.registry.execute(name, {}, context)).rejects.toBeInstanceOf(ToolNotFoundError)
      }
      expectExactCategories(result)
    }
  })

  it.each(['general', 'code'] as const)('%s rejects extensions and late registrations impersonating the builtin plan', async toolProfile => {
    const result = await createToolRegistry({ toolProfile, allowedTools: [], allowedMcpServers: [] })
    result.registry.unregister('plan_update')
    for (const source of [undefined, 'skill', 'mcp']) {
      const impostor = tool('plan_update', source)
      result.registry.register(impostor)
      expect(result.registry.has('plan_update')).toBe(false)
      await expect(result.registry.execute('plan_update', {}, context)).rejects.toBeInstanceOf(ToolNotFoundError)
      expect(impostor.execute).not.toHaveBeenCalled()
    }
  })
})
