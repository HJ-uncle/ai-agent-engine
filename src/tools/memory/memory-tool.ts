import type { Tool, AgentContext, ToolResult } from '../../core/agent-context/index.js'
import type { MemoryStore } from '../../core/agent-context/index.js'

export function createMemoryTools(memory: MemoryStore): Tool[] {
  const rememberTool: Tool = {
    name: 'remember',
    displayName: '记忆存储',
    description: '存储键值对到记忆',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        value: { type: 'string' },
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
    displayName: '记忆召回',
    description: '按键检索记忆',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string' },
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
    displayName: '记忆列表',
    description: '列出所有记忆键',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    async execute(_args: unknown, ctx: AgentContext): Promise<ToolResult> {
      const items = await memory.list(ctx)
      if (items.length === 0) {
        return { success: true, output: 'No memories stored yet.' }
      }
      return { success: true, output: `Memory keys: ${items.map((i: any) => i.key).join(', ')}` }
    },
  }

  const forgetTool: Tool = {
    name: 'forget',
    displayName: '删除记忆',
    description: '删除记忆',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string' },
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
