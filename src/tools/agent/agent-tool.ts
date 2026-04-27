import type { Tool, AgentContext, ToolResult } from '../../core/agent-context/index.js'
import { SQLiteAgentStore } from '../../storage/agent/index.js'
import type { CreateAgentInput } from '../../storage/agent/index.js'

const store = new SQLiteAgentStore()

export const agentTools: Tool[] = [
  {
    name: 'agent_list',
    displayName: '列出 Agent',
    description: '列出当前租户下的所有 Agent，支持按名称搜索过滤',
    parameters: {
      type: 'object',
      properties: {
        search: { type: 'string', description: '按名称搜索过滤（可选）' },
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
          return `[${a.id.slice(0, 8)}] **${a.name}**${desc}${skills}`
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
    description: '查看单个 Agent 的完整配置信息',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Agent ID（可用前8位匹配）' },
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
    description: '创建新 Agent。调用此工具后需要使用 ask_user 工具请求用户确认配置，请提供确认选项（确认/修改/取消）。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Agent 名称（必填）' },
        description: { type: 'string', description: '简短描述 Agent 的用途' },
        model: { type: 'string', description: '使用的模型，如 gpt-4o' },
        temperature: { type: 'number', description: 'Temperature 值，0-2 之间，默认 0.7' },
        systemPrompt: { type: 'string', description: 'System Prompt 定义 Agent 行为' },
        skills: { type: 'array', items: { type: 'string' }, description: '技能列表，如 calculate, get_time' },
        mcpServers: { type: 'array', items: { type: 'string' }, description: 'MCP Server 列表' },
        knowledgeBases: { type: 'array', items: { type: 'string' }, description: '知识库 ID 列表' },
        allowedTools: { type: 'array', items: { type: 'string' }, description: '允许使用的系统工具列表，如 read_file, write_file, glob, grep 等。留空表示使用全部工具。' },
      },
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
    description: '在用户确认后执行实际的 Agent 创建操作。内部使用，请勿直接调用。',
    parameters: {
      type: 'object',
      properties: {
        confirmed: { type: 'boolean', description: '是否已确认' },
        name: { type: 'string', description: 'Agent 名称' },
        description: { type: 'string', description: '描述' },
        model: { type: 'string', description: '模型' },
        temperature: { type: 'number', description: 'Temperature' },
        systemPrompt: { type: 'string', description: 'System Prompt' },
        skills: { type: 'array', items: { type: 'string' }, description: '技能列表' },
        mcpServers: { type: 'array', items: { type: 'string' }, description: 'MCP Server 列表' },
        knowledgeBases: { type: 'array', items: { type: 'string' }, description: '知识库 ID 列表' },
        allowedTools: { type: 'array', items: { type: 'string' }, description: '允许的系统工具列表' },
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
        return { success: true, output: `✅ Agent "${agent.name}" 创建成功 (ID: ${agent.id.slice(0, 8)})` }
      } catch (err) {
        return { success: false, output: `创建 Agent 失败: ${String(err)}` }
      }
    },
  },
  {
    name: 'agent_update',
    displayName: '更新 Agent',
    description: '更新已有 Agent 的配置。调用此工具后需要使用 ask_user 工具请求用户确认变更。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Agent ID（必填，可用前8位匹配）' },
        name: { type: 'string', description: '新的 Agent 名称' },
        description: { type: 'string', description: '新的描述' },
        model: { type: 'string', description: '新的模型' },
        temperature: { type: 'number', description: '新的 Temperature 值' },
        systemPrompt: { type: 'string', description: '新的 System Prompt' },
        skills: { type: 'array', items: { type: 'string' }, description: '新的技能列表' },
        mcpServers: { type: 'array', items: { type: 'string' }, description: '新的 MCP Server 列表' },
        knowledgeBases: { type: 'array', items: { type: 'string' }, description: '新的知识库 ID 列表' },
        allowedTools: { type: 'array', items: { type: 'string' }, description: '新的允许系统工具列表' },
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
          output: `📋 Agent 更新预览\n\n即将更新 **${existing.name}** (${existing.id.slice(0, 8)}...)，变更如下：\n\`\`\`json\n${JSON.stringify(updates, null, 2)}\n\`\`\`\n\n请先调用 ask_user 工具请求用户确认。`,
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
    description: '在用户确认后执行实际的 Agent 更新操作。内部使用，请勿直接调用。',
    parameters: {
      type: 'object',
      properties: {
        confirmed: { type: 'boolean', description: '是否已确认' },
        id: { type: 'string', description: 'Agent ID' },
        name: { type: 'string', description: '新的名称' },
        description: { type: 'string', description: '新的描述' },
        model: { type: 'string', description: '新的模型' },
        temperature: { type: 'number', description: '新的 Temperature' },
        systemPrompt: { type: 'string', description: '新的 System Prompt' },
        skills: { type: 'array', items: { type: 'string' }, description: '新的技能列表' },
        mcpServers: { type: 'array', items: { type: 'string' }, description: '新的 MCP Server 列表' },
        knowledgeBases: { type: 'array', items: { type: 'string' }, description: '新的知识库 ID 列表' },
        allowedTools: { type: 'array', items: { type: 'string' }, description: '新的允许系统工具列表' },
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
    description: '删除指定的 Agent，此操作不可恢复。调用此工具后需要使用 ask_user 工具请求用户确认。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Agent ID（必填，可用前8位匹配）' },
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
          output: `⚠️ 删除确认\n\n确定要删除 Agent **${existing.name}** (${existing.id.slice(0, 8)}...) 吗？\n\n此操作不可恢复！\n\n请先调用 ask_user 工具请求用户确认。`,
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
    description: '在用户确认后执行实际的 Agent 删除操作。内部使用，请勿直接调用。',
    parameters: {
      type: 'object',
      properties: {
        confirmed: { type: 'boolean', description: '是否已确认' },
        id: { type: 'string', description: 'Agent ID' },
        agentName: { type: 'string', description: 'Agent 名称（用于日志）' },
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
        return { success: true, output: `✅ Agent "${agent.name}" 创建成功 (ID: ${agent.id.slice(0, 8)})` }
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