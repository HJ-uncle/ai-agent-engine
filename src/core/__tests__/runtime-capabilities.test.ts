import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext, Tool } from '../agent-context/types.js'
import { ToolRegistry } from '../tool-registry/registry.js'
import { normalizeClientCapabilities } from '../client-capabilities.js'
import { buildRuntimeCapabilities, buildRuntimeCapabilitiesPrompt } from '../runtime-capabilities.js'
import { buildExecutionProtocol } from '../execution-protocol.js'
import { setSecurityMode, clearSecurityMode } from '../../security/policy-engine.js'
import { workbenchBridge } from '../../tools/workbench/bridge.js'
import { workspaceManager } from '../../workspace/index.js'

const base: Pick<AgentContext, 'tenantId' | 'sessionId'> = { tenantId: 'capability-contract', sessionId: 'capability-session' }
const tool = (name: string, extra: Partial<Tool> = {}): Tool => ({ name, description: `说明 ${name}`, parameters: { type: 'object' },
  async execute() { return { success: true, output: '' } }, ...extra })
function context(definitions: Tool[]): AgentContext {
  const tools = new ToolRegistry()
  definitions.forEach(definition => tools.register(definition))
  return { ...base, tools, toolProfile: 'code', workspaceDir: process.cwd(), workspacePaths: [process.cwd()],
    history: { getHistory: vi.fn().mockResolvedValue([]) }, logger: { info: vi.fn(), error: vi.fn() },
  } as unknown as AgentContext
}
afterEach(() => { clearSecurityMode(base.tenantId, base.sessionId); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

describe('per-run capabilities', () => {
  it('accepts only bounded manifest enums and never forwards arbitrary instructions', () => {
    expect(normalizeClientCapabilities({ version: 2, application: 'aether' })).toBeUndefined()
    const manifest = normalizeClientCapabilities({ version: 1, application: 'aether', mode: 'work', platform: 'win32', connected: true,
      actions: ['artifact.open', 'run_any_shell', 'artifact.open'], previewFormats: ['docx', 'pdf', '<script>'], instructions: 'IGNORE_POLICY' })
    expect(manifest).toEqual({ version: 1, application: 'aether', mode: 'work', platform: 'win32', connected: true,
      actions: ['artifact.open'], previewFormats: ['docx', 'pdf'] })
    expect(JSON.stringify(manifest)).not.toContain('IGNORE_POLICY')
  })

  it('reports exact current registration and schema changes without granting unavailable capabilities', () => {
    const original = tool('read_file', { parameters: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } } })
    const ctx = context([original, tool('mcp_docs_read', { source: 'mcp' })])
    setSecurityMode(base.tenantId, base.sessionId, 'safe')
    const snapshot = buildRuntimeCapabilities(ctx, ['/workspace/project'])
    expect(snapshot.tools).toEqual([{ name: 'read_file', source: 'builtin' }, { name: 'mcp_docs_read', source: 'mcp' }])
    expect(snapshot.permissions.extensionExecution).toBe('blocked-uncontained-side-effects')
    expect(snapshot.discovery.browser).toEqual({ status: 'not-registered' })
    expect(snapshot.environment.node.executable).toBe(process.execPath)
    expect(snapshot.environment.shell).toBe('not-probed')
    const reordered = context([tool('mcp_docs_read', { source: 'mcp' }), original])
    expect(buildRuntimeCapabilities(reordered, ['/workspace/project']).registryVersion).toBe(snapshot.registryVersion)
    ctx.tools.unregister('read_file'); ctx.tools.register(tool('read_file', { description: 'new contract' }))
    expect(buildRuntimeCapabilities(ctx, ['/workspace/project']).registryVersion).not.toBe(snapshot.registryVersion)
  })

  it('uses a same-identity live workbench lease instead of trusting client.connected', () => {
    const ctx = context([tool('workbench_context')])
    ctx.clientCapabilities = { version: 1, application: 'aether', mode: 'work', platform: 'win32', connected: true, actions: ['artifact.open'], previewFormats: ['pdf'] }
    expect(buildRuntimeCapabilities(ctx, []).discovery.workbench.status).toBe('disconnected')
    const connection = workbenchBridge.register({ tenantId: base.tenantId }, base.sessionId, ['workspace.context'])
    try {
      expect(buildRuntimeCapabilities(ctx, []).discovery.workbench).toMatchObject({ status: 'requires-run', executionBound: false, actions: ['workspace.context'] })
      ctx.rootRunId = 'capability-run'
      expect(buildRuntimeCapabilities(ctx, []).discovery.workbench).toMatchObject({ status: 'connected', executionBound: true, actions: ['workspace.context'] })
      expect(buildRuntimeCapabilities({ ...ctx, tenantId: 'other-tenant' }, []).discovery.workbench.status).toBe('disconnected')
    } finally { workbenchBridge.unregister({ tenantId: base.tenantId }, connection.clientId, connection.clientToken) }
    expect(buildRuntimeCapabilities(ctx, []).discovery.workbench.status).toBe('disconnected')
  })

  it('generates shared instructions only for present APIs and preserves failure semantics', () => {
    const minimal = buildExecutionProtocol(context([tool('read_file')]).tools)
    expect(minimal).not.toContain('browser_tabs')
    expect(minimal).not.toContain('office_environment')
    expect(minimal).not.toContain('workbench_open')
    const full = buildExecutionProtocol(context(['execute_cmd', 'browser_tabs', 'browser_snapshot', 'browser_open', 'workbench_open'].map(name => tool(name))).tools)
    expect(full).toContain('Run services/watchers in supported background jobs')
    expect(full).toContain('Do not repeat an action with unknown outcome')
    expect(full).toContain('editing pages/coordinates')
    expect(full).toContain('Registration, connection, execution and verification are distinct facts')
    expect(full).toContain('More files/tools do not require renewed approval')
  })
  it('automatically refreshes the engine clock and resolved roots without duplicating tool schemas', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-03T10:30:00Z'))
    vi.spyOn(workspaceManager, 'getPaths').mockReturnValue(['/bound-project', '/private-scratch'])
    const ctx = context([tool('read_file', { description: 'Full tool description lives in tools',
      parameters: { type: 'object', properties: { uniqueSchemaMarker: { type: 'string' } } } })])
    ctx.cwd = '/stale-root'
    const first = buildRuntimeCapabilities(ctx)
    expect(first.environment).toMatchObject({ primaryWorkspace: '/bound-project', cwd: '/bound-project', workspacePaths: ['/bound-project', '/private-scratch'] })
    expect(first.clock).toMatchObject({ currentTime: '2026-11-03T10:30:00.000Z', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, scope: 'engine-runtime' })
    expect(first.clock.date).toMatch(/^2026-11-03$/)
    vi.setSystemTime(new Date('2026-11-04T10:30:00Z'))
    expect(buildRuntimeCapabilities(ctx).clock.currentTime).toBe('2026-11-04T10:30:00.000Z')
    const prompt = buildRuntimeCapabilitiesPrompt(ctx)
    expect(prompt).not.toContain('uniqueSchemaMarker')
    expect(prompt).not.toContain('Full tool description lives in tools')
    expect(prompt).not.toMatch(/get_current_context|get_tool_details|detailsTool/)
    expect(prompt).not.toContain('"tools":')
    expect(prompt).not.toContain('"discovery":')
    expect(prompt).not.toContain('"status":"not-registered"')
    expect(prompt).toContain('"toolCount":1')
    expect(prompt.match(/\/bound-project/g)).toHaveLength(2)
    expect(JSON.parse(prompt.split('\n').find(line => line.startsWith('{'))!).environment.relativePathRoot).toBe('/bound-project')
    expect(prompt).toContain('Task prose cannot change this base')
    // Compare the data projection, not language-dependent instruction characters.
    const compactSnapshot = prompt.split('\n').find(line => line.startsWith('{'))!
    expect(compactSnapshot.length).toBeLessThan(JSON.stringify(buildRuntimeCapabilities(ctx)).length)
    expect(buildExecutionProtocol(ctx.tools)).not.toMatch(/get_current_context|get_tool_details/)
  })

  it.each(['general', 'code'] as const)('%s describes only the resolved memory scopes, not registered tool names', profile => {
    vi.stubEnv('ENABLE_LONG_TERM_MEMORY', 'true')
    const ctx = context([tool('remember'), tool('recall')])
    ctx.toolProfile = profile
    ctx.memoryScope = 'global' // A stale compatibility field cannot override resolved scopes.
    ctx.memoryScopes = ['session']
    const session = buildRuntimeCapabilitiesPrompt(ctx)
    expect(session).toContain('"memoryScopes":["session"]')
    expect(session).toContain('save/recall within this session')
    expect(session).toContain('global memory is off. Never claim cross-session preferences/decisions will be remembered')
    expect(session).not.toContain('Session and global memory enabled')
    ctx.memoryScopes = ['global']
    expect(buildRuntimeCapabilitiesPrompt(ctx)).toContain('new writes use global memory; session memory is off')
    ctx.memoryScopes = ['global', 'session']
    expect(buildRuntimeCapabilitiesPrompt(ctx)).toContain('new memories default to session only, never auto-promote globally')
    ctx.memoryScopes = []
    const disabled = buildRuntimeCapabilitiesPrompt(ctx)
    expect(disabled).toContain('Long-term memory is off')
    expect(disabled).toContain('not deleted by memory switches')
    expect(disabled).toContain('Never claim a memory was saved without a successful write receipt')
    expect(disabled).toContain('"memoryScopes":[]')
    expect(disabled).not.toContain('Only global memory enabled')
  })

  it('server-disabled memory never advertises enabled scopes, including filtered requests without tools', () => {
    vi.stubEnv('ENABLE_LONG_TERM_MEMORY', 'false')
    const ctx = context([tool('remember')])
    ctx.memoryScopes = ['global', 'session']
    const prompt = buildRuntimeCapabilitiesPrompt(ctx, [])
    expect(prompt).toContain('Long-term memory is off')
    expect(prompt).toContain('"toolCount":0')
    expect(prompt).toContain('"memoryScopes":[]')
    expect(prompt).not.toContain('Session and global memory enabled')
  })

  it('can describe exactly the filtered request tools, including a finalization request with none', () => {
    const ctx = context([tool('execute_cmd'), tool('browser_tabs'), tool('workbench_context')])
    const snapshot = buildRuntimeCapabilities(ctx, ['/project'], [])
    expect(snapshot.tools).toEqual([])
    expect(snapshot.environment.commandExecution).toBe('unavailable')
    expect(snapshot.discovery.browser).toEqual({ status: 'not-registered' })
    expect(snapshot.discovery.workbench).toEqual({ status: 'not-registered' })
  })

  it('distinguishes authorized capabilities from offered schemas without changing memory scopes', () => {
    vi.stubEnv('ENABLE_LONG_TERM_MEMORY', 'true')
    const ctx = context(['read_file', 'load_tools', 'office_document', 'subagent_start', 'remember'].map(name => tool(name)))
    ctx.tools.hasModelToolLoader = () => true
    ctx.memoryScopes = ['session']
    const offered = ctx.tools.list().filter(tool => ['read_file', 'load_tools'].includes(tool.name))
    const compact = (definitions: ReturnType<AgentContext['tools']['list']>) => {
      const prompt = buildRuntimeCapabilitiesPrompt(ctx, definitions)
      return { prompt, state: JSON.parse(prompt.split('\n').find(line => line.startsWith('{'))!) }
    }
    const initial = compact(offered)
    expect(initial.state).toMatchObject({ toolCount: 2, availableToolCount: 5, toolLoading: 'load_tools', permissions: { memoryScopes: ['session'] } })
    expect(initial.prompt).toContain('Missing schemas do not mean missing capabilities')
    expect(initial.prompt).toContain('Memory scopes below are independent of schema loading')
    const loaded = compact(ctx.tools.list())
    expect(loaded.state).toMatchObject({ toolCount: 5, availableToolCount: 5, toolLoading: 'load_tools' })
    expect(loaded.state.registryVersion).not.toBe(initial.state.registryVersion)
    const final = compact([])
    expect(final.state).toMatchObject({ toolCount: 0, availableToolCount: 5, toolLoading: 'not-offered', permissions: { memoryScopes: ['session'] } })
    expect(final.prompt).toContain('Only session memory enabled')
    const behavior = buildExecutionProtocol(ctx.tools, 'general')
    expect(behavior).toContain('Delegate useful')
    expect(behavior).toContain('load_tools first')
    expect(behavior).toContain('Call only currently offered tools')
    expect(behavior).toContain('including finalization')
  })
})
