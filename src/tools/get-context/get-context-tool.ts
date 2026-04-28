import type { Tool, AgentContext, ToolResult } from '../../core/agent-context/index.js'

/**
 * Get Current Context 工具
 *
 * 获取当前 Agent 的上下文信息，包括会话 ID、工作区路径、已注册工具列表等
 */
export const getCurrentContextTool: Tool = {
  name: 'get_current_context',
  displayName: '获取当前上下文',
  description: '获取当前会话上下文（会话ID、工作区、记忆、系统状态）。可选返回工具列表和历史摘要。',
  parameters: {
    type: 'object',
    properties: {
      includeTools: { type: 'boolean', description: '是否包含工具列表，默认 true' },
      includeHistory: { type: 'boolean', description: '是否包含对话历史，默认 false' }
    },
    required: []
  },
  async execute(rawArgs: unknown, ctx: AgentContext): Promise<ToolResult> {
    const { includeTools = true, includeHistory = false } = rawArgs as any

    try {
      const contextInfo: string[] = [
        `## ✅ 当前上下文信息`,
        ``,
        `### 会话信息`,
        `- **会话ID**: ${ctx.sessionId}`,
        `- **租户ID**: ${ctx.tenantId}`,
        `- **请求ID**: ${ctx.requestId || 'N/A'}`,
        ``,
        `### 工作区信息`,
        `- **工作区路径**: ${ctx.workspaceDir}`,
        `- **Token 预算**: ${ctx.tokenBudget}`,
        `- **Token 剩余**: ${ctx.tokenBudget - (ctx as any)._usedTokens || ctx.tokenBudget}`,
      ]

      // 获取工具列表
      if (includeTools) {
        const tools = ctx.tools.list()
        contextInfo.push(``)
        contextInfo.push(`### 已注册工具 (${tools.length} 个)`)
        contextInfo.push(`| 工具名 | 描述 |`)
        contextInfo.push(`|--------|------|`)
        for (const tool of tools) {
          const desc = tool.description?.slice(0, 50) || ''
          contextInfo.push(`| ${tool.name} | ${desc}... |`)
        }
      }

      // 获取对话历史摘要
      if (includeHistory) {
        contextInfo.push(``)
        contextInfo.push(`### 对话历史摘要`)
        try {
          const history = await ctx.history.getHistory(ctx)
          contextInfo.push(`**最近 ${history.length} 条消息**\n`)
          for (const msg of history.slice(-10)) {
            const role = msg.role.padEnd(10)
            const content = typeof msg.content === 'string'
              ? msg.content.slice(0, 100)
              : '[多模态内容]'
            contextInfo.push(`- [${role}] ${content}${content.length >= 100 ? '...' : ''}`)
          }
        } catch (e) {
          contextInfo.push(`*无法获取对话历史: ${(e as Error).message}*`)
        }
      }

      // 获取内存摘要
      contextInfo.push(``)
      contextInfo.push(`### 记忆信息`)
      try {
        const memories = await ctx.memory.list({ tenantId: ctx.tenantId, sessionId: ctx.sessionId })
        contextInfo.push(`**已存储 ${memories.length} 条记忆**\n`)
        for (const mem of memories.slice(0, 5)) {
          const value = typeof mem.value === 'string' ? mem.value.slice(0, 80) : JSON.stringify(mem.value).slice(0, 80)
          contextInfo.push(`- **${mem.key}**: ${value}${value.length >= 80 ? '...' : ''}`)
        }
        if (memories.length > 5) {
          contextInfo.push(`- ...还有 ${memories.length - 5} 条记忆`)
        }
      } catch (e) {
        contextInfo.push(`*无法获取记忆信息: ${(e as Error).message}*`)
      }

      // 获取当前信号状态
      contextInfo.push(``)
      contextInfo.push(`### 系统状态`)
      contextInfo.push(`- **请求信号**: ${ctx.signal?.aborted ? '已中止' : '活动中'}`)
      contextInfo.push(`- **继承上下文**: ${ctx.inheritContext ? '是' : '否'}`)

      ctx.logger.info(`[get_current_context] Context retrieved for session ${ctx.sessionId}`)

      return {
        success: true,
        output: contextInfo.join('\n')
      }
    } catch (err: any) {
      ctx.logger.error(`[get_current_context] Failed to get context: ${err.message}`)
      return {
        success: false,
        output: `❌ 获取上下文失败: ${err.message}`
      }
    }
  }
}
