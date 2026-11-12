import { z } from 'zod'
import type { Tool, AgentContext, ToolResult, PendingAction } from '../../core/agent-context/index.js'
import { normalizeToolName } from '../tool-profile.js'
import { workspaceManager } from '../../workspace/index.js'
import { skillsRegistry } from '../../skills/index.js'
import {
  AgentManagementService, AgentManagementError, agentIdSchema, agentManagementFailure,
  type AgentMutation, type PreparedAgentMutation,
} from '../../core/agent-management.js'

/** Request-scoped, read-only client records. Local tenant records take precedence by ID. */
export interface InlineAgent {
  id: string
  name: string
  description?: string
  model?: string
  systemPrompt?: string
  skills?: string[]
  mcpServers?: string[]
  knowledgeBases?: string[]
  allowedTools?: string[]
}

const service = new AgentManagementService()
const AGENT_CONFIG_PROPS = {
  name: { type: 'string', minLength: 1 },
  description: { type: 'string' },
  model: { type: 'string' },
  temperature: { type: 'number', minimum: 0, maximum: 2 },
  systemPrompt: { type: 'string' },
  skills: { type: 'array', items: { type: 'string' }, description: '技能执行标识数组：使用 skill_list/skill_get/skill_create 返回的 executionId 或技能名称，不能使用 skill- 开头的管理 hash ID。项目技能在对应工作区使用。' },
  mcpServers: { type: 'array', items: { type: 'string' } },
  knowledgeBases: { type: 'array', items: { type: 'string' } },
  allowedTools: { type: 'array', items: { type: 'string' }, description: '创建时省略使用推荐工具；[] 禁用业务工具；更新时省略保持不变。' },
}
const idProperties = { id: { type: 'string', description: 'agent_list 返回的完整 ID；不接受名称或 ID 前缀。' } }
const labels = { create: '创建', update: '更新', delete: '删除' }

function failure(error: unknown): ToolResult {
  const { code, message } = agentManagementFailure(error)
  return { success: false, status: 'failed', output: message, error: message, metadata: { code } }
}

function approvedOperation(name: string, action: AgentMutation, args: unknown, ctx: AgentContext): PreparedAgentMutation | undefined {
  if (!ctx.currentToolCallId || ctx.currentToolCallId !== ctx.approvedToolCallId) return undefined
  const resume = ctx.resumeToolCall
  const pending = resume?.pendingAction
  if (resume?.decision !== 'approved' || resume.toolCall.id !== ctx.currentToolCallId || resume.toolCall.name !== name
    || JSON.stringify(args) !== JSON.stringify(resume.toolCall.args)
    || pending?.type !== `agent_${action}`) {
    throw new Error('缺少该工具调用的有效确认记录，请重新发起操作')
  }
  const operation = pending.operation as PreparedAgentMutation | undefined
  if (!operation || operation.version !== 1 || operation.action !== action || operation.tenantId !== ctx.tenantId) {
    throw new Error('Agent 确认记录无效，请重新发起操作')
  }
  return operation
}

async function prepare(action: AgentMutation, args: Record<string, unknown>, ctx: AgentContext, manager: AgentManagementService): Promise<PreparedAgentMutation> {
  if (action !== 'delete' && Array.isArray(args.skills)) {
    const hashIds = args.skills.filter((value): value is string => typeof value === 'string' && /^skill-[a-f0-9]{32}$/.test(value))
    if (hashIds.length) {
      // A manifest may legitimately choose a hash-shaped runtime ID. Reject only
      // values that cannot bind in this workspace; never infer a grant from the
      // management identity or silently save an unusable reference.
      const skills = skillsRegistry.getSkills(workspaceManager.getWorkingDirectory(ctx))
      const invalid = hashIds.filter(id => !skills.some(skill => skill.id === id || skill.name === id))
      if (invalid.length) throw new AgentManagementError(40001,
        'skills 需要执行标识：请使用 skill_list/skill_get/skill_create 返回的 executionId 或技能名称，不能使用管理 hash ID：' + invalid.join(', '))
    }
  }
  if (action === 'create') return manager.prepareCreate(ctx.tenantId, args)
  const { id, ...input } = args
  if (action === 'update') return manager.prepareUpdate(ctx.tenantId, id, input)
  z.object({ id: agentIdSchema }).strict().parse(args)
  return manager.prepareDelete(ctx.tenantId, id)
}

function preview(operation: PreparedAgentMutation): ToolResult {
  const config = operation.action === 'create' ? operation.input
    : operation.action === 'update' ? { id: operation.id, before: operation.before, changes: operation.input,
        after: { ...operation.before, ...operation.input } }
      : { id: operation.id, agent: operation.before }
  const text = `Agent ${labels[operation.action]}确认\n\n${JSON.stringify(config, null, 2)}\n\n确认后执行以上配置。`
  return { success: false, status: 'waiting', needsConfirmation: true, output: text,
    pendingAction: { type: `agent_${operation.action}`, operation, reason: text } }
}

function mutationTool(action: AgentMutation, manager: AgentManagementService): Tool {
  const name = `agent_${action}`
  const preflight = async (raw: unknown, ctx: AgentContext): Promise<ToolResult | undefined> => {
    try {
      // A recovered legacy call may retain old args, but only its authenticated
      // frozen operation can execute. New calls use the canonical strict schema.
      if (approvedOperation(name, action, raw, ctx)) return undefined
      return preview(await prepare(action, z.record(z.unknown()).parse(raw), ctx, manager))
    } catch (error) { return failure(error) }
  }
  return {
    name, displayName: `${labels[action]} Agent`,
    description: `${labels[action]}持久化 Agent 配置。展示具体配置并等待用户确认，批准后自动恢复原调用；不要另调 ask_user 或 do_*。`,
    parameters: { type: 'object', properties: {
      ...(action === 'create' ? {} : idProperties),
      ...(action === 'delete' ? {} : AGENT_CONFIG_PROPS),
    }, required: action === 'create' ? ['name'] : ['id'], additionalProperties: false },
    preflight,
    async execute(raw, ctx) {
      const blocked = await preflight(raw, ctx)
      if (blocked) return blocked
      try {
        const operation = approvedOperation(name, action, raw, ctx)!
        const agentChange = await manager.apply(operation)
        return { success: true, status: 'succeeded',
          output: JSON.stringify({ message: `Agent ${labels[action]}成功`, agentChange }),
          metadata: { agentChange } }
      } catch (error) { return failure(error) }
    },
  }
}

export function createAgentTools(inlineAgents: InlineAgent[] = [], manager: AgentManagementService = service): Tool[] {
  const all = async (tenantId: string) => {
    const local = await manager.list(tenantId)
    const localIds = new Set(local.map(agent => agent.id))
    return { localIds, agents: [...local, ...inlineAgents.filter(agent => !localIds.has(agent.id))] }
  }
  return [
    {
      name: 'agent_list', displayName: '列出 Agent', description: '列出 Agent 与完整 ID，可按名称搜索。',
      parameters: { type: 'object', properties: { search: { type: 'string' } }, required: [], additionalProperties: false },
      async execute(raw, ctx) {
        try {
          const { search } = z.object({ search: z.string().optional() }).strict().parse(raw)
          const { agents, localIds } = await all(ctx.tenantId)
          const filtered = search ? agents.filter(agent => agent.name.toLowerCase().includes(search.toLowerCase())) : agents
          return { success: true, output: filtered.length ? JSON.stringify(filtered.map(agent => ({ id: agent.id, name: agent.name,
            description: agent.description, readonly: !localIds.has(agent.id) }))) : '暂无 Agent' }
        } catch (error) { return failure(error) }
      },
    },
    {
      name: 'agent_get', displayName: '查看 Agent 详情', description: '按完整 ID 查看 Agent 配置、工具权限和资源绑定。',
      parameters: { type: 'object', properties: idProperties, required: ['id'], additionalProperties: false },
      async execute(raw, ctx) {
        try {
          const { id } = z.object({ id: agentIdSchema }).strict().parse(raw)
          const { agents, localIds } = await all(ctx.tenantId)
          const agent = agents.find(candidate => candidate.id === id)
          if (!agent) return failure(new AgentManagementError(40400, `Agent "${id}" 不存在；请使用 agent_list 返回的完整 ID`))
          return { success: true, output: JSON.stringify({ ...agent, readonly: !localIds.has(id),
            allowedTools: agent.allowedTools ?? null,
            toolPermission: agent.allowedTools == null ? 'runtime_default' : agent.allowedTools.length ? 'explicit' : 'business_tools_disabled',
          }) }
        } catch (error) { return failure(error) }
      },
    },
    ...(['create', 'update', 'delete'] as const).map(action => mutationTool(action, manager)),
  ]
}

export const agentTools = createAgentTools()

/** Legacy entry point must use the same durable, server-authenticated approval as every tool. */
export async function executePendingAgentAction(action: PendingAction, ctx: AgentContext): Promise<ToolResult> {
  const resume = ctx.resumeToolCall
  if (!resume?.pendingAction || JSON.stringify(action) !== JSON.stringify(resume.pendingAction)) {
    return failure(new Error('请通过原工具调用的用户确认流程执行 Agent 操作'))
  }
  const name = normalizeToolName(resume.toolCall.name)
  const tool = agentTools.find(candidate => candidate.name === name)
  if (!tool || !/^agent_(?:create|update|delete)$/.test(tool.name)) {
    return failure(new Error('Agent 确认记录与操作不匹配'))
  }
  return tool.execute(resume.toolCall.args, { ...ctx, resumeToolCall: { ...resume, toolCall: { ...resume.toolCall, name } } })
}
