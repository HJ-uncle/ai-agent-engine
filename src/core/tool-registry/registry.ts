import type { Tool, IToolRegistry, AgentContext, ToolResult, JSONSchema } from '../agent-context/index.js'
import { DuplicateToolError, ToolNotFoundError } from '../agent-context/index.js'
import { getGlobalToolPool } from '../utils/concurrency-pool.js'

export class ToolRegistry implements IToolRegistry {
  private tools = new Map<string, Tool>()

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new DuplicateToolError(tool.name)
    }
    this.tools.set(tool.name, tool)
  }

  unregister(name: string): void {
    this.tools.delete(name)
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  list(): Array<{ name: string; displayName?: string; description: string; parameters: JSONSchema; source?: string }> {
    return Array.from(this.tools.values()).map((tool) => ({
      name: tool.name,
      displayName: tool.displayName,
      description: tool.description,
      parameters: tool.parameters,
      source: (tool as any).source,
    }))
  }

  async execute(name: string, args: unknown, ctx: AgentContext): Promise<ToolResult> {
    const tool = this.tools.get(name)
    if (!tool) {
      throw new ToolNotFoundError(name)
    }
    // subagent 是长时间运行的编排调用，而且它内部的工具执行还要再走这个池。
    // 若把子代理本身也放进池里，一轮并发派发 N 个子代理就会占满池槽位，
    // 它们的内层工具永远排不到队 —— 互相等待形成死锁。因此子代理自身不占池，
    // 内层工具照旧受限流保护。
    if (name === 'subagent') {
      return tool.execute(args, ctx)
    }
    // 全局并发池：防止大量并发调用把服务器打爆
    const pool = getGlobalToolPool()
    return pool(() => tool.execute(args, ctx))
  }
}
