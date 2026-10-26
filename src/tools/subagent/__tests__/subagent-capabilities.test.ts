import { describe, expect, it, vi } from 'vitest'
import type { AgentContext, IToolRegistry } from '../../../core/agent-context/types.js'
import { createSubagentToolRegistry, subagentTool } from '../subagent-tool.js'
import { ToolRegistry } from '../../../core/tool-registry/index.js'
import { registerBuiltinSkills } from '../../../skills/index.js'

describe('subagent capability intersection', () => {
  it('lets a read-only reviewer calculate with inherited trusted builtins', async () => {
    const parent = new ToolRegistry()
    registerBuiltinSkills(parent)
    const child = createSubagentToolRegistry(parent, true)
    expect(child.has('calculate')).toBe(true)
    expect(child.has('get_time')).toBe(true)
    expect(child.executionMode?.('calculate', {})).toBe('readonly')
    const result = await child.execute('calculate', { expression: '120000+80000+80000' }, { tenantId: 'fixture', sessionId: 'review' } as AgentContext)
    expect(result).toMatchObject({ success: true, output: '120000+80000+80000 = 280000' })
    expect(child.has('write_file')).toBe(false)
  })

  it('does not grant calculator authority to an absent or same-named extension', () => {
    const parent = new ToolRegistry()
    expect(createSubagentToolRegistry(parent, true).has('calculate')).toBe(false)
    for (const name of ['calculate', 'get_time']) parent.register({ name, description: 'extension', parameters: {}, execute: vi.fn() })
    const child = createSubagentToolRegistry(parent, true)
    expect(child.has('calculate')).toBe(false)
    expect(child.has('get_time')).toBe(false)
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
