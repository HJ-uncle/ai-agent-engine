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
    expect(child.list().map((tool) => tool.name)).toEqual(['read_file', 'get_skill'])
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

  it.each([0, -1, 1.5, '24'])('rejects invalid maxSteps %s before any model call', async (maxSteps) => {
    const result = await subagentTool.execute({ task: 'fixture', maxSteps }, {} as AgentContext)
    expect(result.success).toBe(false)
    expect(result.output).toContain('大于等于 1')
  })
})
