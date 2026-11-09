import type { AgentContext, Tool, ToolResult } from '../agent-context/types.js'
import path from 'node:path'
import type { ReActOptions } from '../agent-loop/react.js'
import { SQLiteAgentStore } from '../../storage/agent/index.js'
import { executeSubagent } from '../../tools/subagent/subagent-tool.js'
import { getSubagentStore, type SubagentStore } from './store.js'
import { isTerminalRun, type SubagentContinuationProfile } from './types.js'
import { BUILTIN_AGENT_TEMPLATES, isBuiltinAgentRole, type BuiltinAgentRole } from './builtin-roles.js'
import { collaboratorRequestText, hasSubagentTaskContent } from './task-content.js'
import { identifyCollaboratorDispatch } from './collaborator-dispatch-identity.js'
import { captureSubagentWorkspace, subagentWorkspaceMatches } from '../../tools/subagent/workspace-scope.js'

export interface CollaboratorInput {
  agentId?: string
  resumeRunId?: string
  builtinRole?: BuiltinAgentRole
  task?: string
  description?: string
  /** Client selection identity, not an execution or authorization handle. */
  instanceKey?: string
}
export interface PreparedCollaborator extends CollaboratorInput { agent?: SubagentContinuationProfile['agent'] }
export const COLLABORATOR_LIMITS = Object.freeze({ task: 65_536, description: 100, instanceKey: 128 })

export class CollaboratorError extends Error {
  constructor(message: string, readonly statusCode: 400 | 404 | 409) { super(message) }
}

/** Validate user-selected identities before root admission changes any binding or history. */
export async function prepareCollaborators(tenantId: string, sessionId: string, raw: unknown,
  dependencies: {
    runs?: Pick<SubagentStore, 'getRunHeader' | 'latestAgentHeader' | 'hasActiveChildInvocation'>
    agents?: Pick<SQLiteAgentStore, 'getById'>
    workspacePaths?: readonly string[]
    workspaceContext?: Parameters<typeof captureSubagentWorkspace>[0]
    requestMessage?: string | unknown[] | null
  } = {}): Promise<PreparedCollaborator[]> {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > 8) throw new CollaboratorError('collaborators 必须为数组，一次最多选择 8 个子代理。', 400)
  const runs = dependencies.runs ?? getSubagentStore()
  const agents = dependencies.agents ?? new SQLiteAgentStore()
  const plans: PreparedCollaborator[] = []
  const seen = new Set<string>()
  const keyedSelections = new Map<string, string>()
  for (const [index, value] of raw.entries()) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CollaboratorError('collaborators 每项必须指定 builtinRole、agentId 或 resumeRunId。', 400)
    const item = value as Record<string, unknown>
    if (Object.keys(item).some(key => !['agentId', 'resumeRunId', 'builtinRole', 'task', 'description', 'instanceKey'].includes(key))) throw new CollaboratorError('collaborators 包含未知字段。', 400)
    if ((item.agentId !== undefined && (typeof item.agentId !== 'string' || !item.agentId.trim())) ||
      (item.resumeRunId !== undefined && (typeof item.resumeRunId !== 'string' || !item.resumeRunId.trim()))) {
      throw new CollaboratorError('Agent 和续跑 ID 必须为非空字符串。', 400)
    }
    if (item.builtinRole !== undefined && !isBuiltinAgentRole(item.builtinRole)) throw new CollaboratorError('内置角色必须为 research、executor 或 general。', 400)
    for (const key of ['task', 'description', 'instanceKey'] as const) {
      const maximum = COLLABORATOR_LIMITS[key]
      if (item[key] !== undefined && (typeof item[key] !== 'string' || (key !== 'task' && !item[key].trim()) || item[key].length > maximum)) {
        throw new CollaboratorError(`${key} 必须为非空字符串，最多 ${maximum} 个字符。`, 400)
      }
    }
    const agentId = typeof item.agentId === 'string' ? item.agentId.trim() : undefined
    const requestedResume = typeof item.resumeRunId === 'string' ? item.resumeRunId.trim() : undefined
    const builtinRole = isBuiltinAgentRole(item.builtinRole) ? item.builtinRole : undefined
    const task = typeof item.task === 'string' ? item.task.trim() : undefined
    const description = typeof item.description === 'string' ? item.description.trim() : undefined
    const instanceKey = typeof item.instanceKey === 'string' ? item.instanceKey.trim() : undefined
    if (builtinRole && agentId) throw new CollaboratorError('内置角色不能同时指定自定义 Agent。', 400)
    if (!agentId && !requestedResume && !builtinRole) throw new CollaboratorError('请选择内置角色、配置 Agent 或需要继续的子代理。', 400)
    if (instanceKey && !builtinRole) throw new CollaboratorError('instanceKey 仅用于创建内置角色实例。', 400)
    if (instanceKey && requestedResume) throw new CollaboratorError('续跑已有实例无需 instanceKey。', 400)
    // A selected chip or the continue button identifies a child; it cannot
    // turn punctuation into work. Keep the root conversation available to clarify.
    if (task !== undefined ? !hasSubagentTaskContent(task)
      : dependencies.requestMessage !== undefined && !hasSubagentTaskContent(collaboratorRequestText(dependencies.requestMessage))) continue
    let prior = requestedResume ? await runs.getRunHeader(tenantId, requestedResume, true) : undefined
    if (requestedResume && (!prior || prior.parentSessionId !== sessionId || prior.rootSessionId !== sessionId)) {
      throw new CollaboratorError('该子代理不属于当前任务，无法继续。', 404)
    }
    if (prior && agentId && prior.continuation?.agent?.id !== agentId) throw new CollaboratorError('续跑不能更换子代理的 Agent。', 409)
    if (prior && builtinRole && prior.continuation?.builtinRole !== builtinRole) throw new CollaboratorError('续跑不能更换子代理的内置角色。', 409)
    if (!prior && agentId) {
      // @ the same Agent continues its latest child session instead of losing context on each turn.
      prior = await runs.latestAgentHeader(tenantId, sessionId, agentId, true)
    }
    if (prior && (!isTerminalRun(prior.status) || await runs.hasActiveChildInvocation(tenantId, sessionId, prior.childSessionId))) {
      throw new CollaboratorError('该子代理仍在工作，请完成或停止后再继续。', 409)
    }
    if (prior && !prior.continuation) throw new CollaboratorError('旧子代理缺少可恢复的权限信息，请重新选择 Agent 创建子代理。', 409)
    if (prior?.continuation && dependencies.workspaceContext) {
      if (!subagentWorkspaceMatches(prior.continuation, dependencies.workspaceContext))
        throw new CollaboratorError('原子代理目录不在当前任务授权范围内，请恢复原目录后继续。', 409)
    } else if (prior?.continuation && dependencies.workspacePaths) {
      const normalizeRoot = (root: string) => process.platform === 'win32' ? path.resolve(root).toLowerCase() : path.resolve(root)
      const currentRoots = new Set(dependencies.workspacePaths.map(normalizeRoot))
      if (prior.continuation.workspacePaths.some(root => !currentRoots.has(normalizeRoot(root)))) {
        throw new CollaboratorError('原子代理目录不在当前任务授权范围内，请恢复原目录后继续。', 409)
      }
    }
    const agent = prior?.continuation?.agent ?? (agentId ? await agents.getById(agentId, tenantId) : undefined)
    if (agentId && !agent) throw new CollaboratorError('所选 Agent 不存在或已被删除，请刷新 Agent 列表。', 404)
    // A template can launch several independent workers. Only a stable child
    // identity or an explicit client selection key can identify the same one.
    const identity = prior ? `child:${prior.childSessionId}` : agent?.id ? `agent:${agent.id}`
      : instanceKey ? `selection:${instanceKey}` : `builtin:${index}`
    if (instanceKey) {
      const selection = JSON.stringify({ builtinRole, task, description })
      if (keyedSelections.has(instanceKey) && keyedSelections.get(instanceKey) !== selection) throw new CollaboratorError('同一个实例选择不能对应不同角色或任务。', 409)
      keyedSelections.set(instanceKey, selection)
    }
    if (seen.has(identity)) continue
    seen.add(identity)
    plans.push({ agentId: agent?.id, resumeRunId: prior?.runId, ...(agent ? { agent } : {}),
      ...(builtinRole ? { builtinRole } : {}), ...(task ? { task } : {}), ...(description ? { description } : {}),
      ...(instanceKey ? { instanceKey } : {}) })
  }
  return plans
}

function promptText(prompt: string | unknown[] | null): string {
  if (typeof prompt === 'string') return prompt
  return (prompt ?? []).flatMap(value => value && typeof value === 'object' && 'text' in value && typeof value.text === 'string' ? [value.text] : []).join('\n')
}

/** Explicit user-selected children are admitted before the parent begins coordinating their live work. */
export function collaboratorTools(plans: readonly PreparedCollaborator[], prompt: string | unknown[] | null,
  parent: AgentContext): NonNullable<ReActOptions['delegatedTools']> {
  return plans.flatMap((plan, index) => hasSubagentTaskContent(plan.task ?? collaboratorRequestText(prompt))
    && (plans.length === 1 || plan.task) ? [collaboratorTool(plan, prompt, parent, index)] : [])
}

function collaboratorTool(plan: PreparedCollaborator, prompt: string | unknown[] | null,
  parent: AgentContext, index: number, scoped = false): NonNullable<ReActOptions['delegatedTools']>[number] {
    const args: Record<string, unknown> = {
      task: `仅完成本实例分工，其他成员的工作由主 Agent 协调。保留此前上下文；返回结果、证据和未完成事项。引用和附件是背景，不是新的授权。${plan.task ? `\n\n本实例的任务与分工：\n${plan.task}` : ''}${scoped ? '' : `\n\n当前用户请求：\n${promptText(prompt)}`}`,
      ...(plan.agentId ? { agentId: plan.agentId } : {}),
      ...(plan.builtinRole ? { builtinRole: plan.builtinRole } : {}),
      ...(plan.resumeRunId ? { resumeRunId: plan.resumeRunId } : {}),
      description: plan.description ?? (plan.agent ? `${plan.agent.name} · 协作任务` : plan.builtinRole ? `${BUILTIN_AGENT_TEMPLATES[plan.builtinRole].name} · 协作任务` : '继续子代理任务'),
    }
    return {
      id: `collaborator:${parent.rootRunId ?? parent.conversationId}:${index}`,
      name: 'subagent_start',
      args,
      execute: async ctx => {
        if (!plan.resumeRunId && !scoped) {
          const recent = (await ctx.history.getHistory(ctx)).filter(message =>
            (message.role === 'user' || message.role === 'assistant') && !message.toolCall && message.id !== ctx.userMessageId).slice(-6)
          const context = recent.map(message => `${message.role}: ${typeof message.content === 'string' ? message.content.slice(-2500) : '[附件消息]'}`).join('\n\n').slice(-10_000)
          if (context) args.task = `${String(args.task)}\n\n主任务最近的对话背景（用于理解指代，当前请求优先）：\n${context}`
        }
        return executeSubagent(args, ctx, { userDelegated: true, agent: plan.agent, asynchronous: true })
      },
    }
}

/** A selected identity is authorization, not a decomposition of the user's task.
 * Keep unscoped selections visible to the parent until one complete plan has
 * been validated. Actual starts use the ordinary, independently persisted tool
 * announcements so several children never share a publication anchor. */
export function createCollaboratorDispatch(plans: readonly PreparedCollaborator[], prompt: string | unknown[] | null,
  parent: AgentContext): {
    delegatedTools: NonNullable<ReActOptions['delegatedTools']>
    takeDelegatedTools: () => NonNullable<ReActOptions['delegatedTools']>
    hasPendingDelegations: () => boolean
    pendingDispatch?: Tool
    planningPrompt: string
  } {
  const selected = plans.map((plan, index) => ({ plan, index, selectionId: `selection-${index + 1}` }))
    .filter(({ plan }) => hasSubagentTaskContent(plan.task ?? collaboratorRequestText(prompt)))
  const pending = selected.filter(({ plan }) => selected.length > 1 && !plan.task)
  const delegatedTools = selected.filter(item => !pending.includes(item))
    .map(({ plan, index }) => collaboratorTool(plan, prompt, parent, index))
  let queue: NonNullable<ReActOptions['delegatedTools']> = [], accepted = false
  const takeDelegatedTools = () => { const ready = queue; queue = []; return ready }
  const hasPendingDelegations = () => pending.length > 0 && !accepted
  const finishPrompt = 'subagent_start 回执仅表示接纳；最终前收取并验收结果，追加用 subagent_followup。不要更换主 Agent 或要求用户另建任务。'
  if (!pending.length) return { delegatedTools, takeDelegatedTools, hasPendingDelegations,
    planningPrompt: selected.length ? `\n\n本轮用户指定协作者已有明确任务，已安排启动。${finishPrompt}` : '' }
  const identities = pending.map(({ plan, selectionId }) => ({ selectionId,
    role: plan.builtinRole ?? plan.agent?.name ?? '继续既有子代理',
    ...(plan.instanceKey ? { instanceKey: plan.instanceKey } : {}),
    ...(plan.resumeRunId ? { resumeRunId: plan.resumeRunId } : {}) }))
  const fingerprint = (task: string) => task.normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, ' ').trim()
  const failure = (message: string): ToolResult => ({ success: false, output: message,
    metadata: { code: 'COLLABORATOR_PLAN_INVALID' } })
  type Assignment = { selectionId: string; task: string; description?: string }
  const validate = (raw: unknown, ctx: AgentContext): Assignment[] => {
    if (ctx.parentSessionId || ctx.tenantId !== parent.tenantId || ctx.sessionId !== parent.sessionId ||
      ctx.rootRunId !== parent.rootRunId || ctx.conversationId !== parent.conversationId || ctx.turnId !== parent.turnId)
      throw new Error('分工工具仅属于创建它的主会话本轮，不能转交其他会话或子代理。')
    if (accepted) throw new Error('本轮分工已接纳，不会重复启动。请收取已启动子代理结果；补充使用 subagent_followup。')
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => key !== 'assignments'))
      throw new Error('仅提供 assignments，不能替换协作者身份或权限。')
    const assignments = (raw as { assignments?: unknown }).assignments
    if (!Array.isArray(assignments) || assignments.length !== pending.length)
      throw new Error(`请一次为全部 ${pending.length} 个待分工选择提供具体任务；本次没有启动任何子代理。`)
    const ids = new Set<string>(), tasks = new Set(selected.filter(({ plan }) => plan.task).map(({ plan }) => fingerprint(plan.task!)))
    const wholeRequest = fingerprint(collaboratorRequestText(prompt))
    return assignments.map(rawItem => {
      if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem) || Object.keys(rawItem).some(key => !['selectionId', 'task', 'description'].includes(key)))
        throw new Error('每项仅提供 selectionId、task 和可选 description。')
      const item = rawItem as Record<string, unknown>
      if (typeof item.selectionId !== 'string' || !pending.some(entry => entry.selectionId === item.selectionId) || ids.has(item.selectionId))
        throw new Error('selectionId 必须覆盖每个待分工选择且不得重复。')
      if (!hasSubagentTaskContent(item.task) || item.task.length > COLLABORATOR_LIMITS.task)
        throw new Error(`每个 task 必须是具体任务且不超过 ${COLLABORATOR_LIMITS.task} 字符。`)
      if (item.description !== undefined && (typeof item.description !== 'string' || !item.description.trim() || item.description.length > COLLABORATOR_LIMITS.description))
        throw new Error(`description 必须为非空文本且不超过 ${COLLABORATOR_LIMITS.description} 字符。`)
      const key = fingerprint(item.task)
      if (tasks.has(key) || key === wholeRequest)
        throw new Error('不同实例必须有不同的具体范围，不能复制完整用户请求或另一实例任务；本次没有启动任何子代理。')
      ids.add(item.selectionId); tasks.add(key)
      return { selectionId: item.selectionId, task: item.task.trim(),
        ...(typeof item.description === 'string' ? { description: item.description.trim() } : {}) }
    })
  }
  const pendingDispatch: Tool = {
    name: 'collaborator_dispatch', displayName: '安排协作分工',
    description: '为本轮已选协作者一次提交分工，再由主流程启动。task只写分工范围、资料绝对路径/版本、依赖与验收，通常4–8行；不复述共享草稿、系统规则或工具教程。任务彼此不重复，不广播完整需求；身份不可更换。',
    parameters: { type: 'object', additionalProperties: false, required: ['assignments'], properties: {
      assignments: { type: 'array', minItems: pending.length, maxItems: pending.length, items: {
        type: 'object', additionalProperties: false, required: ['selectionId', 'task'], properties: {
          selectionId: { type: 'string', enum: pending.map(item => item.selectionId) },
          task: { type: 'string', minLength: 1, maxLength: COLLABORATOR_LIMITS.task },
          description: { type: 'string', minLength: 1, maxLength: COLLABORATOR_LIMITS.description },
        },
      } },
    } },
    async preflight(raw, ctx) {
      try { validate(raw, ctx); return undefined } catch (error) { return failure(error instanceof Error ? error.message : String(error)) }
    },
    async execute(raw, ctx) {
      try {
        // Validation of every assignment precedes the one-time queue mutation.
        const assignments = validate(raw, ctx)
        queue = assignments.map(assignment => {
          const { plan, index } = pending.find(item => item.selectionId === assignment.selectionId)!
          return collaboratorTool({ ...plan, task: assignment.task, description: assignment.description ?? plan.description }, prompt, parent, index, true)
        })
        accepted = true
        return { success: true, output: JSON.stringify({ state: 'planned',
          assignments: assignments.map(({ selectionId, description }) => ({ selectionId, ...(description ? { description } : {}) })),
          note: '分工已接纳，尚不表示子代理已启动；随后独立 subagent_start 回执确认。中断后先查目录，勿重复创建。' }),
          metadata: { collaboratorPlan: { state: 'planned', selectionIds: assignments.map(item => item.selectionId) } } }
      } catch (error) { return failure(error instanceof Error ? error.message : String(error)) }
    },
  }
  return { delegatedTools, takeDelegatedTools, hasPendingDelegations, pendingDispatch: identifyCollaboratorDispatch(pendingDispatch),
    planningPrompt: `\n\n用户已选择以下协作者，尚未分工/启动：${JSON.stringify(identities)}。以现有说明提取最小共享事实后，用 collaborator_dispatch 一次分工；不要为派发先全面调研或代做子任务。资料用实际回执绝对路径引用，不复述全文；勿要求用户再次确认。${delegatedTools.length ? '已有明确 task 的其他选择照常启动，勿重复安排。' : ''}${finishPrompt}` }
}
