import type { Tool, AgentContext, ToolResult } from '../../core/agent-context/index.js'
import { SQLiteAgentStore } from '../../storage/agent/index.js'
import type { CreateAgentInput } from '../../storage/agent/index.js'

const store = new SQLiteAgentStore()

// ── 共享参数定义（避免重复声明，节省 tool schema tokens）──────────────────────
const AGENT_CONFIG_PROPS = {
  name: { type: 'string' as const },
  description: { type: 'string' as const },
  model: { type: 'string' as const },
  temperature: { type: 'number' as const },
  systemPrompt: { type: 'string' as const },
  skills: { type: 'array' as const, items: { type: 'string' as const } },
  mcpServers: { type: 'array' as const, items: { type: 'string' as const } },
  knowledgeBases: { type: 'array' as const, items: { type: 'string' as const } },
  allowedTools: { type: 'array' as const, items: { type: 'string' as const } },
}

export const agentTools: Tool[] = [
  {
    name: 'agent_list',
    displayName: '列出 Agent',
    description: '列出所有 Agent',
    parameters: {
      type: 'object',
      properties: {
        search: { type: 'string' },
      },
      required: [],
    },
    async execute(rawArgs: unknown, ctx: AgentContext): Promise<ToolResult> {
      const { search } = rawArgs as { search?: string }
      try {
        const agents = await store.list(ctx.tenantId)
        let filtered = agents
        if (search) {
          filtered = agents.filter(a => a.name.toLowerCase().includes(search.toLowerCase()))
        }
        if (filtered.length === 0) {
          return { success: true, output: '暂无 Agent' }
        }
        const lines = filtered.map(a => {
          const skills = a.skills.length > 0 ? ` [技能: ${a.skills.join(', ')}]` : ''
          const desc = a.description ? ` - ${a.description}` : ''
          return `[${a.id}] **${a.name}**${desc}${skills}`
        })
        return { success: true, output: `共 ${filtered.length} 个 Agent:\n\n${lines.join('\n')}` }
      } catch (err) {
        return { success: false, output: `列出 Agent 失败: ${String(err)}` }
      }
    },
  },
  {
    name: 'agent_get',
    displayName: '查看 Agent 详情',
    description: '查看 Agent 配置',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
      },
      required: ['id'],
    },
    async execute(rawArgs: unknown, ctx: AgentContext): Promise<ToolResult> {
      const { id } = rawArgs as { id: string }
      try {
        const agents = await store.list(ctx.tenantId)
        const agent = agents.find(a => a.id === id || a.id.startsWith(id))
        if (!agent) {
          return { success: false, output: `Agent "${id}" 不存在` }
        }
        const lines = [
          `**ID**: ${agent.id}`,
          `**名称**: ${agent.name}`,
          `**描述**: ${agent.description || '(无)'}`,
          `**模型**: ${agent.model || '(默认)'}`,
          `**Temperature**: ${agent.temperature ?? 0.7}`,
          `**技能**: ${agent.skills.length > 0 ? agent.skills.join(', ') : '(无)'}`,
          `**MCP Servers**: ${agent.mcpServers.length > 0 ? agent.mcpServers.join(', ') : '(无)'}`,
          `**知识库**: ${agent.knowledgeBases.length > 0 ? agent.knowledgeBases.join(', ') : '(无)'}`,
          `**System Prompt**: ${agent.systemPrompt || '(无)'}`,
          `**创建时间**: ${new Date(agent.createdAt).toLocaleString('zh-CN')}`,
          `**更新时间**: ${new Date(agent.updatedAt).toLocaleString('zh-CN')}`,
        ]
        return { success: true, output: lines.join('\n') }
      } catch (err) {
        return { success: false, output: `查看 Agent 详情失败: ${String(err)}` }
      }
    },
  },
  {
    name: 'agent_create',
    displayName: '创建 Agent',
    description: '创建 Agent 并预览，需 ask_user 确认后调 agent_do_create',
    parameters: {
      type: 'object',
      properties: AGENT_CONFIG_PROPS,
      required: ['name'],
    },
    async execute(rawArgs: unknown, ctx: AgentContext): Promise<ToolResult> {
      const input = rawArgs as Partial<CreateAgentInput>
      if (!input.name) {
        return { success: false, output: 'Agent 名称不能为空' }
      }
      try {
        const preview = {
          name: input.name || '',
          description: input.description || '',
          model: input.model || '',
          temperature: input.temperature ?? 0.7,
          systemPrompt: input.systemPrompt || '',
          skills: input.skills || [],
          mcpServers: input.mcpServers || [],
          knowledgeBases: input.knowledgeBases || [],
          allowedTools: input.allowedTools || [],
        }
        return {
          success: true,
          output: `📋 Agent 创建预览\n\n配置如下：\n\`\`\`json\n${JSON.stringify(preview, null, 2)}\n\`\`\`\n\n请先调用 ask_user 工具请求用户确认。`,
          pendingAction: {
            type: 'agent_create',
            input: preview,
          },
        }
      } catch (err) {
        return { success: false, output: `创建 Agent 失败: ${String(err)}` }
      }
    },
  },
  {
    name: 'agent_do_create',
    displayName: '执行创建 Agent',
    description: '用户确认后执行创建，参数同 agent_create 加 confirmed',
    parameters: {
      type: 'object',
      properties: {
        confirmed: { type: 'boolean' },
        ...AGENT_CONFIG_PROPS,
      },
      required: ['confirmed', 'name'],
    },
    async execute(rawArgs: unknown, ctx: AgentContext): Promise<ToolResult> {
      const args = rawArgs as any
      if (!args.confirmed) {
        return { success: false, output: '用户未确认创建 Agent 操作已取消' }
      }
      try {
        // 检查是否已存在同名 Agent（防止重复创建）
        const existingAgents = await store.list(ctx.tenantId)
        const existingAgent = existingAgents.find((a: any) => a.name === args.name)
        if (existingAgent) {
          return { 
            success: true, 
            output: `⚠️ 已存在名为 "${args.name}" 的 Agent，无需重复创建。\n\nAgent 详细信息：\nID: ${existingAgent.id}\n描述: ${existingAgent.description || '无'}\n技能: ${(existingAgent.skills || []).join(', ') || '无'}` 
          }
        }
        
        const agent = await store.create(ctx.tenantId, {
          name: args.name,
          description: args.description,
          model: args.model,
          temperature: args.temperature,
          systemPrompt: args.systemPrompt,
          skills: args.skills || [],
          mcpServers: args.mcpServers || [],
          knowledgeBases: args.knowledgeBases || [],
          allowedTools: args.allowedTools || [],
        })
        return { success: true, output: `✅ Agent "${agent.name}" 创建成功 (ID: ${agent.id})` }
      } catch (err) {
        return { success: false, output: `创建 Agent 失败: ${String(err)}` }
      }
    },
  },
  {
    name: 'agent_update',
    displayName: '更新 Agent',
    description: '更新 Agent 配置，需 ask_user 确认后调 agent_do_update',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        ...AGENT_CONFIG_PROPS,
      },
      required: ['id'],
    },
    async execute(rawArgs: unknown, ctx: AgentContext): Promise<ToolResult> {
      const { id, ...updates } = rawArgs as any
      if (!id) {
        return { success: false, output: 'Agent ID 不能为空' }
      }
      try {
        const agents = await store.list(ctx.tenantId)
        const existing = agents.find(a => a.id === id || a.id.startsWith(id))
        if (!existing) {
          return { success: false, output: `Agent "${id}" 不存在` }
        }
        return {
          success: true,
          output: `📋 Agent 更新预览\n\n即将更新 **${existing.name}** (${existing.id}...)，变更如下：\n\`\`\`json\n${JSON.stringify(updates, null, 2)}\n\`\`\`\n\n请先调用 ask_user 工具请求用户确认。`,
          pendingAction: {
            type: 'agent_update',
            id: existing.id,
            originalName: existing.name,
            input: updates,
          },
        }
      } catch (err) {
        return { success: false, output: `更新 Agent 失败: ${String(err)}` }
      }
    },
  },
  {
    name: 'agent_do_update',
    displayName: '执行更新 Agent',
    description: '用户确认后执行更新，参数同 agent_update 加 confirmed',
    parameters: {
      type: 'object',
      properties: {
        confirmed: { type: 'boolean' },
        id: { type: 'string' },
        ...AGENT_CONFIG_PROPS,
      },
      required: ['confirmed', 'id'],
    },
    async execute(rawArgs: unknown, ctx: AgentContext): Promise<ToolResult> {
      const args = rawArgs as any
      if (!args.confirmed) {
        return { success: false, output: '用户未确认更新 Agent 操作已取消' }
      }
      try {
        const updates: Record<string, unknown> = {}
        if (args.name !== undefined) updates.name = args.name
        if (args.description !== undefined) updates.description = args.description
        if (args.model !== undefined) updates.model = args.model
        if (args.temperature !== undefined) updates.temperature = args.temperature
        if (args.systemPrompt !== undefined) updates.systemPrompt = args.systemPrompt
        if (args.skills !== undefined) updates.skills = args.skills
        if (args.mcpServers !== undefined) updates.mcpServers = args.mcpServers
        if (args.knowledgeBases !== undefined) updates.knowledgeBases = args.knowledgeBases
        if (args.allowedTools !== undefined) updates.allowedTools = args.allowedTools
        const updated = await store.update(args.id, ctx.tenantId, updates)
        if (!updated) {
          return { success: false, output: 'Agent 不存在或更新失败' }
        }
        return { success: true, output: `✅ Agent "${updated.name}" 更新成功` }
      } catch (err) {
        return { success: false, output: `更新 Agent 失败: ${String(err)}` }
      }
    },
  },
  {
    name: 'agent_delete',
    displayName: '删除 Agent',
    description: '删除 Agent（不可恢复），需 ask_user 确认后调 agent_do_delete',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
      },
      required: ['id'],
    },
    async execute(rawArgs: unknown, ctx: AgentContext): Promise<ToolResult> {
      const { id } = rawArgs as { id: string }
      if (!id) {
        return { success: false, output: 'Agent ID 不能为空' }
      }
      try {
        const agents = await store.list(ctx.tenantId)
        const existing = agents.find(a => a.id === id || a.id.startsWith(id))
        if (!existing) {
          return { success: false, output: `Agent "${id}" 不存在` }
        }
        return {
          success: true,
          output: `⚠️ 删除确认\n\n确定要删除 Agent **${existing.name}** (${existing.id}...) 吗？\n\n此操作不可恢复！\n\n请先调用 ask_user 工具请求用户确认。`,
          pendingAction: {
            type: 'agent_delete',
            id: existing.id,
            agentName: existing.name,
          },
        }
      } catch (err) {
        return { success: false, output: `删除 Agent 失败: ${String(err)}` }
      }
    },
  },
  {
    name: 'agent_do_delete',
    displayName: '执行删除 Agent',
    description: '用户确认后执行删除',
    parameters: {
      type: 'object',
      properties: {
        confirmed: { type: 'boolean' },
        id: { type: 'string' },
        agentName: { type: 'string' },
      },
      required: ['confirmed', 'id'],
    },
    async execute(rawArgs: unknown, ctx: AgentContext): Promise<ToolResult> {
      const args = rawArgs as any
      if (!args.confirmed) {
        return { success: false, output: '用户未确认删除 Agent 操作已取消' }
      }
      try {
        await store.delete(args.id, ctx.tenantId)
        return { success: true, output: `🗑️ Agent "${args.agentName}" 已删除` }
      } catch (err) {
        return { success: false, output: `删除 Agent 失败: ${String(err)}` }
      }
    },
  },
]

export async function executePendingAgentAction(
  action: { type: string; id?: string; input?: any; agentName?: string },
  ctx: AgentContext
): Promise<ToolResult> {
  try {
    switch (action.type) {
      case 'agent_create': {
        const agent = await store.create(ctx.tenantId, {
          ...action.input,
          skills: action.input.skills || [],
          mcpServers: action.input.mcpServers || [],
          knowledgeBases: action.input.knowledgeBases || [],
          allowedTools: action.input.allowedTools || [],
        })
        return { success: true, output: `✅ Agent "${agent.name}" 创建成功 (ID: ${agent.id})` }
      }
      case 'agent_update': {
        const updated = await store.update(action.id!, ctx.tenantId, action.input)
        if (!updated) {
          return { success: false, output: 'Agent 不存在或更新失败' }
        }
        return { success: true, output: `✅ Agent "${updated.name}" 更新成功` }
      }
      case 'agent_delete': {
        await store.delete(action.id!, ctx.tenantId)
        return { success: true, output: `🗑️ Agent "${action.agentName}" 已删除` }
      }
      default:
        return { success: false, output: `未知操作类型: ${action.type}` }
    }
  } catch (err) {
    return { success: false, output: `操作失败: ${String(err)}` }
  }
}