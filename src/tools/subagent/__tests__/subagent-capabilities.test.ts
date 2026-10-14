import { describe, expect, it, vi } from 'vitest'
import type { AgentContext, IToolRegistry } from '../../../core/agent-context/types.js'
import { createSubagentToolRegistry, subagentTool } from '../subagent-tool.js'

describe('subagent capability intersection', () => {
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
