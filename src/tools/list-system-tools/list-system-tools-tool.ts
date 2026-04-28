import type { Tool, AgentContext, ToolResult } from '../../core/agent-context/index.js'

/**
 * list_system_tools 工具
 *
 * 列出当前会话中所有已注册的系统工具名称。
 * 直接读取注册表，返回真实全量列表，不受 LLM 工具窗口影响。
 */
export const listSystemToolsTool: Tool = {
  name: 'list_system_tools',
  displayName: '查询系统工具列表',
  description: '返回当前所有已注册工具的名称列表。用户询问"有哪些工具"、"能做什么"时调用此工具。',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  async execute(_rawArgs: unknown, ctx: AgentContext): Promise<ToolResult> {
    try {
      const names = ctx.tools.list().map(t => t.name)
      return {
        success: true,
        output: `已注册工具（共 ${names.length} 个）：\n${names.join('\n')}`,
      }
    } catch (err: any) {
      return { success: false, output: `获取工具列表失败: ${err.message}` }
    }
  },
}