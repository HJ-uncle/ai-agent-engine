import type { Tool, AgentContext, ToolResult } from '../core/agent-context/index.js'
import { recordToolCall } from './metrics.js'

export function instrumentTool(tool: Tool): Tool {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    async execute(args: unknown, ctx: AgentContext): Promise<ToolResult> {
      const start = Date.now()
      let success = true
      try {
        const result = await tool.execute(args, ctx)
        success = result.success
        return { ...result, durationMs: Date.now() - start }
      } catch (err) {
        success = false
        throw err
      } finally {
        void recordToolCall({
          tenantId: ctx.tenantId,
          sessionId: ctx.sessionId,
          toolName: tool.name,
          durationMs: Date.now() - start,
          success,
        })
      }
    },
  }
}
