import type { Tool, AgentContext, ToolResult } from '../../core/agent-context/index.js'
import type { MemoryStore } from '../../core/agent-context/index.js'

export function createMemoryTools(memory: MemoryStore): Tool[] {
  const rememberTool: Tool = {
    name: 'remember',
    description: 'Store a key-value pair in memory for later recall',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'The memory key' },
        value: { type: 'string', description: 'The value to remember' },
      },
      required: ['key', 'value'],
    },
    async execute(args: unknown, ctx: AgentContext): Promise<ToolResult> {
      const { key, value } = args as { key: string; value: string }
      await memory.remember(key, value, ctx)
      return { success: true, output: `Remembered: ${key} = ${value}` }
    },
  }

  const recallTool: Tool = {
    name: 'recall',
    description: 'Retrieve a previously stored memory by key',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'The memory key to retrieve' },
      },
      required: ['key'],
    },
    async execute(args: unknown, ctx: AgentContext): Promise<ToolResult> {
      const { key } = args as { key: string }
      const value = await memory.recall(key, ctx)
      if (value === null) {
        return { success: true, output: `No memory found for key: ${key}` }
      }
      return { success: true, output: `${key}: ${value}` }
    },
  }

  const listMemoriesTool: Tool = {
    name: 'list_memories',
    description: 'List all memory keys stored in the current session',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    async execute(_args: unknown, ctx: AgentContext): Promise<ToolResult> {
      const keys = await memory.list(ctx)
      if (keys.length === 0) {
        return { success: true, output: 'No memories stored yet.' }
      }
      return { success: true, output: `Memory keys: ${keys.join(', ')}` }
    },
  }

  const forgetTool: Tool = {
    name: 'forget',
    description: 'Delete a specific memory by key',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'The memory key to delete' },
      },
      required: ['key'],
    },
    async execute(args: unknown, ctx: AgentContext): Promise<ToolResult> {
      const { key } = args as { key: string }
      await memory.forget(key, ctx)
      return { success: true, output: `Forgotten: ${key}` }
    },
  }

  return [rememberTool, recallTool, listMemoriesTool, forgetTool]
}
