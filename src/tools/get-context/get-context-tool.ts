import type { Tool, AgentContext, ToolResult } from '../../core/agent-context/index.js'

/**
 * Get Current Context 工具
 *
 * 获取当前 Agent 的上下文信息，包括会话 ID、工作区路径、已注册工具列表等
 */
/**
 * 把消息 content 渲染成简短文本。
 * 注意：数组 content 不等于多模态——工具调用轮次的 content 也是数组
 * （text/tool_use 等块）。曾经一律显示「[多模态内容]」，导致子代理读到
 * 自己上一轮的工具调用记录后误以为任务是无法解析的多模态内容而拒答。
 */
function renderContentPreview(content: unknown): string {
  if (typeof content === 'string') return content.slice(0, 100)
  if (Array.isArray(content)) {
    const text = content
      .map((part) => (part && typeof part === 'object' ? (part as any).text : undefined))
      .filter((t): t is string => typeof t === 'string' && t.length > 0)
      .join(' ')
    if (text) return text.slice(0, 100)
    const kinds = content
      .map((part) => (part && typeof part === 'object' ? (part as any).type : undefined))
      .filter((t): t is string => typeof t === 'string')
    return kinds.length > 0 ? `[${kinds.join('/')}]` : '[空内容]'
  }
  return '[非文本内容]'
}

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
      // 工作区必须按「实际生效的绑定工作区」上报：
      // ctx.workspaceDir 是引擎给该会话分配的私有沙箱，只有当会话没有绑定
      // 用户工作区时它才是相对路径的基准。子代理继承主会话工作区后，
      // 旧实现仍把沙箱报成「工作区路径」，与相对路径的真实落点矛盾，
      // 会让 Agent 误判「工作目录不对」。
      const { workspaceManager } = await import('../../workspace/index.js')
      const workspacePaths = workspaceManager.getPaths(ctx)
      const [primaryWorkspace, ...otherWorkspaces] = workspacePaths

      const contextInfo: string[] = [
        `## ✅ 当前上下文信息`,
        ``,
        `### 会话信息`,
        `- **会话ID**: ${ctx.sessionId}`,
        `- **租户ID**: ${ctx.tenantId}`,
        `- **请求ID**: ${ctx.requestId || 'N/A'}`,
        ``,
        `### 工作区信息`,
        `- **主工作区**: ${primaryWorkspace}（相对路径以此为基准）`,
        ...(otherWorkspaces.length > 0
          ? [`- **其它绑定工作区**: ${otherWorkspaces.join('、')}`]
          : []),
        ...(primaryWorkspace !== ctx.workspaceDir
          ? [`- **本会话私有目录**: ${ctx.workspaceDir}`]
          : []),
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
            const content = renderContentPreview(msg.content)
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
        const { SQLiteMemoryManager } = await import('../../storage/memory/memory-manager.js')
        const manager = new SQLiteMemoryManager()
        const memories = await manager.listNodes({ limit: 5, orderBy: 'timestamp', orderDir: 'DESC' }, { tenantId: ctx.tenantId, sessionId: ctx.sessionId })
        contextInfo.push(`**已存储近期记忆**\n`)
        for (const mem of memories) {
          const value = typeof mem.summary === 'string' ? mem.summary.slice(0, 80) : ''
          contextInfo.push(`- **[${mem.type}]**: ${value}${value.length >= 80 ? '...' : ''}`)
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
