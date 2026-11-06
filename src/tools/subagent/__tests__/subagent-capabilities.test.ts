import { describe, expect, it, vi } from 'vitest'
import type { AgentContext, IToolRegistry } from '../../../core/agent-context/types.js'
import { createSubagentToolRegistry, subagentTool } from '../subagent-tool.js'
import { ToolRegistry } from '../../../core/tool-registry/index.js'
import { trustBuiltinTool } from '../../../security/tool-policy.js'

describe('subagent capability intersection', () => {
  it('does not restore retired utility tools or grant shell access to a read-only reviewer', async () => {
    const parent = new ToolRegistry()
    const execute = vi.fn().mockResolvedValue({ success: true, output: 'unexpected legacy execution' })
    // Even an already-resolved legacy parent cannot reintroduce removed model
    // capabilities by retaining a previously trusted readonly implementation.
    const retired = ['calculate', 'get_time', 'install_package', 'list_packages', 'get_current_context', 'get_tool_details']
    for (const name of retired) parent.register(trustBuiltinTool({ name, description: 'retired fixture', parameters: {}, execute }, 'readonly'))
    for (const name of ['execute_cmd', 'run_skill_script', 'write_file']) parent.register({ name, description: name, parameters: {}, execute })
    parent.register(trustBuiltinTool({ name: 'read_file', description: 'read', parameters: {}, execute: vi.fn() }, 'readonly'))
    const child = createSubagentToolRegistry(parent, true)
    expect(child.list().map(tool => tool.name)).toEqual(['read_file', 'plan_update'])
    for (const name of [...retired, 'execute_cmd', 'run_skill_script', 'write_file']) {
      expect(child.has(name)).toBe(false)
      expect(await child.execute(name, {}, {} as AgentContext)).toMatchObject({ success: false, metadata: { blocked: true, code: 'TOOL_NOT_ALLOWED' } })
    }
    expect(execute).not.toHaveBeenCalled()
  })

  it('does not restore retired utility names from parent extensions in either child mode', async () => {
    const parent = new ToolRegistry()
    const execute = vi.fn()
    const retired = ['calculate', 'get_time', 'install_package', 'list_packages', 'get_current_context', 'get_tool_details']
    for (const name of retired) parent.register({ name, description: 'extension', parameters: {}, source: 'skill', execute })
    for (const readOnly of [true, false]) {
      const child = createSubagentToolRegistry(parent, readOnly)
      expect(child.list().map(tool => tool.name)).toEqual(['plan_update'])
      for (const name of retired) expect(await child.preflight?.(name, {}, {} as AgentContext))
        .toMatchObject({ success: false, metadata: { blocked: true, code: 'TOOL_NOT_ALLOWED' } })
    }
    expect(execute).not.toHaveBeenCalled()
  })

  function registry(): IToolRegistry {
    const tools = ['read_file', 'write_file', 'ask_user', 'subagent', 'inline_mcp_query', 'get_skill'].map((name) => ({ name, description: name, parameters: { type: 'object' } }))
    return { register: vi.fn(), unregister: vi.fn(), has: (name) => tools.some((tool) => tool.name === name), list: () => tools, execute: vi.fn().mockResolvedValue({ success: true, output: 'fixture' }) }
  }

  it('research cannot gain writes, recursive delegation or arbitrary MCP capabilities', async () => {
    const parent = registry()
    const child = createSubagentToolRegistry(parent, true)
    expect(child.list().map((tool) => tool.name)).toEqual(['read_file', 'get_skill', 'plan_update'])
    const result = await child.execute('write_file', { path: 'README.md' }, {} as AgentContext)
    expect(result).toMatchObject({ success: false, metadata: { blocked: true, code: 'TOOL_NOT_ALLOWED' } })
    expect(parent.execute).not.toHaveBeenCalled()
  })

  it('implementation reuses the resolved parent MCP/skill objects without broadening its catalog', async () => {
    const parent = registry()
    const child = createSubagentToolRegistry(parent, false)
    expect(child.has('inline_mcp_query')).toBe(true)
    expect(child.has('ask_user')).toBe(false)
    expect(child.has('subagent')).toBe(false)
    const ctx = {} as AgentContext
    await child.execute('inline_mcp_query', { query: 'fixture' }, ctx)
    expect(parent.execute).toHaveBeenCalledWith('inline_mcp_query', { query: 'fixture' }, ctx)
  })

  it('does not expose a model-controlled step ceiling', () => {
    const properties = (subagentTool.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(properties).not.toHaveProperty('maxSteps')
  })

  it('blocks index creation before either preflight or execution and advertises only read actions', async () => {
    const parent = new ToolRegistry()
    const execute = vi.fn().mockResolvedValue({ success: true, output: 'existing symbols' })
    const preflight = vi.fn()
    parent.register(trustBuiltinTool({ name: 'codegraph', description: 'query or build index',
      parameters: { type: 'object', properties: { action: { type: 'string', enum: ['search', 'index'] } } }, execute, preflight }))
    const child = createSubagentToolRegistry(parent, true)
    expect(child.list().find(tool => tool.name === 'codegraph')?.parameters.properties?.action.enum)
      .toEqual(['status', 'search', 'callers', 'callees', 'impact', 'files'])
    for (const args of [{ action: 'index' }, { action: 'reindex' }, {}, null]) {
      expect(await child.preflight?.('codegraph', args, {} as AgentContext)).toMatchObject({ success: false, metadata: { code: 'TOOL_ACTION_NOT_ALLOWED' } })
      expect(await child.execute('codegraph', args, {} as AgentContext)).toMatchObject({ success: false, metadata: { code: 'TOOL_ACTION_NOT_ALLOWED' } })
    }
    expect(execute).not.toHaveBeenCalled()
    expect(preflight).not.toHaveBeenCalled()
    await child.execute('codegraph', { action: 'search', query: 'worker' }, {} as AgentContext)
    expect(execute).toHaveBeenCalledOnce()
    expect(execute).toHaveBeenCalledWith({ action: 'search', query: 'worker' }, {})
    expect(parent.list().find(tool => tool.name === 'codegraph')?.parameters.properties?.action.enum).toContain('index')
  })

  it('keeps root publication and wake dispatch out of every child catalog', async () => {
    const parent = new ToolRegistry()
    const execute = vi.fn()
    for (const name of ['deliver_files', 'subagent_followup', 'subagent_directory', 'subagent_send', 'subagent_request_input']) {
      parent.register({ name, description: name, parameters: {}, execute })
    }
    for (const readOnly of [true, false]) {
      const child = createSubagentToolRegistry(parent, readOnly)
      expect(child.has('subagent_directory')).toBe(true)
      expect(child.has('subagent_send')).toBe(true)
      expect(child.has('subagent_request_input')).toBe(true)
      for (const name of ['deliver_files', 'subagent_followup']) {
        expect(child.has(name)).toBe(false)
        expect(await child.execute(name, {}, {} as AgentContext)).toMatchObject({ success: false, metadata: { code: 'TOOL_NOT_ALLOWED' } })
      }
    }
    expect(execute).not.toHaveBeenCalled()
  })

  it('does not start environment diagnostic commands in a research child', async () => {
    const parent = new ToolRegistry()
    const execute = vi.fn()
    parent.register(trustBuiltinTool({ name: 'office_environment', description: 'readonly host command probe', parameters: {}, execute }, 'readonly'))
    const child = createSubagentToolRegistry(parent, true)
    expect(child.has('office_environment')).toBe(false)
    expect(await child.execute('office_environment', {}, {} as AgentContext)).toMatchObject({ success: false, metadata: { code: 'TOOL_NOT_ALLOWED' } })
    expect(execute).not.toHaveBeenCalled()
    expect(createSubagentToolRegistry(parent, false).has('office_environment')).toBe(true)
  })
})


describe('child planning ownership', () => {
  it('does not delegate the reserved plan identity to a parent extension', async () => {
    const definitions = ['plan_update', 'write_file'].map(name => ({ name, description: 'unsafe fixture', parameters: { type: 'object' } }))
    const parent: IToolRegistry = { register: vi.fn(), unregister: vi.fn(), list: () => definitions,
      has: name => definitions.some(item => item.name === name), preflight: vi.fn().mockResolvedValue({ success: false, output: 'spoofed preflight' }),
      execute: vi.fn().mockResolvedValue({ success: true, output: 'spoofed execution' }) }
    const child = createSubagentToolRegistry(parent, true)
    expect(child.list().map(item => item.name)).toEqual(['plan_update'])
    expect(child.list()[0].description).not.toBe('unsafe fixture')
    expect(child.executionMode?.('plan_update', {})).toBe('serial')
    expect(await child.preflight?.('plan_update', { plan: [] }, { tenantId: 'fixture', sessionId: 'child' } as AgentContext)).toBeUndefined()
    expect(parent.preflight).not.toHaveBeenCalled()
    expect(parent.execute).not.toHaveBeenCalled()
    expect(await child.execute('write_file', {}, {} as AgentContext)).toMatchObject({ success: false, metadata: { code: 'TOOL_NOT_ALLOWED' } })
  })
})
