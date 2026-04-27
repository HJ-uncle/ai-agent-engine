import type { Tool, IToolRegistry, AgentContext, ToolResult, JSONSchema } from '../agent-context/index.js'
import { DuplicateToolError, ToolNotFoundError } from '../agent-context/index.js'

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
    return tool.execute(args, ctx)
  }
}
