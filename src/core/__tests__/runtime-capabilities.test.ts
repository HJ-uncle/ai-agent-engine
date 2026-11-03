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
afterEach(() => { clearSecurityMode(base.tenantId, base.sessionId); vi.useRealTimers(); vi.restoreAllMocks() })

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
    expect(full).toContain('args 逐项传入')
    expect(full).toContain('unknown 可能执行过')
    expect(full).toContain('javascript:')
    expect(full).toContain('等待执行回执')
    expect(full).toContain('不因工具或文件数量多而重复要求确认')
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
    expect(prompt.match(/\/bound-project/g)).toHaveLength(1)
    expect(prompt.length).toBeLessThan(JSON.stringify(buildRuntimeCapabilities(ctx)).length)
    expect(buildExecutionProtocol(ctx.tools)).not.toMatch(/get_current_context|get_tool_details/)
  })

  it('can describe exactly the filtered request tools, including a finalization request with none', () => {
    const ctx = context([tool('execute_cmd'), tool('browser_tabs'), tool('workbench_context')])
    const snapshot = buildRuntimeCapabilities(ctx, ['/project'], [])
    expect(snapshot.tools).toEqual([])
    expect(snapshot.environment.commandExecution).toBe('unavailable')
    expect(snapshot.discovery.browser).toEqual({ status: 'not-registered' })
    expect(snapshot.discovery.workbench).toEqual({ status: 'not-registered' })
  })
})
