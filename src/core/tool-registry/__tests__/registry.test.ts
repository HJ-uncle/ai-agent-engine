import { ToolRegistry } from '../registry.js'
import { DuplicateToolError, ToolNotFoundError } from '../../agent-context/index.js'
import type { Tool, AgentContext, ToolResult } from '../../agent-context/index.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTool(name: string, output = 'ok'): Tool {
  return {
    name,
    description: `Description for ${name}`,
    parameters: { type: 'object', properties: {}, required: [] },
    execute: vi.fn().mockResolvedValue({ success: true, output } as ToolResult),
  }
}

const mockCtx = {} as AgentContext

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ToolRegistry', () => {
  it('registers a tool and executes it successfully', async () => {
    const registry = new ToolRegistry()
    const tool = makeTool('myTool')

    registry.register(tool)
    const result = await registry.execute('myTool', {}, mockCtx)

    expect(result.success).toBe(true)
    expect(result.output).toBe('ok')
    expect(tool.execute).toHaveBeenCalledWith({}, mockCtx)
  })

  it('throws DuplicateToolError when registering a tool with the same name', () => {
    const registry = new ToolRegistry()
    registry.register(makeTool('dup'))

    expect(() => registry.register(makeTool('dup'))).toThrow(DuplicateToolError)
  })

  it('throws ToolNotFoundError when executing a non-existent tool', async () => {
    const registry = new ToolRegistry()

    await expect(registry.execute('ghost', {}, mockCtx)).rejects.toThrow(ToolNotFoundError)
  })

  it('has() returns true for registered tools and false otherwise', () => {
    const registry = new ToolRegistry()
    registry.register(makeTool('exists'))

    expect(registry.has('exists')).toBe(true)
    expect(registry.has('missing')).toBe(false)
  })

  it('unregister() removes the tool so it can no longer be executed', async () => {
    const registry = new ToolRegistry()
    registry.register(makeTool('removable'))

    registry.unregister('removable')

    expect(registry.has('removable')).toBe(false)
    await expect(registry.execute('removable', {}, mockCtx)).rejects.toThrow(ToolNotFoundError)
  })

  it('list() returns the schema of all registered tools', () => {
    const registry = new ToolRegistry()
    registry.register(makeTool('toolA'))
    registry.register(makeTool('toolB'))

    const list = registry.list()

    expect(list).toHaveLength(2)
    expect(list.map((t) => t.name)).toEqual(expect.arrayContaining(['toolA', 'toolB']))
    for (const entry of list) {
      expect(entry).toHaveProperty('name')
      expect(entry).toHaveProperty('description')
      expect(entry).toHaveProperty('parameters')
    }
  })

  it('list() returns empty array when no tools are registered', () => {
    const registry = new ToolRegistry()
    expect(registry.list()).toEqual([])
  })

  it('allows re-registering a tool after it has been unregistered', () => {
    const registry = new ToolRegistry()
    registry.register(makeTool('reusable'))
    registry.unregister('reusable')

    expect(() => registry.register(makeTool('reusable'))).not.toThrow()
    expect(registry.has('reusable')).toBe(true)
  })
})
