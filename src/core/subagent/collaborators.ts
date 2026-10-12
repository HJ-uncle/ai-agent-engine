import type { AgentContext } from '../agent-context/types.js'
import path from 'node:path'
import type { ReActOptions } from '../agent-loop/react.js'
import { SQLiteAgentStore } from '../../storage/agent/index.js'
import { executeSubagent } from '../../tools/subagent/subagent-tool.js'
import { getSubagentStore, type SubagentStore } from './store.js'
import { isTerminalRun, type SubagentContinuationProfile } from './types.js'

export interface CollaboratorInput { agentId?: string; resumeRunId?: string }
export interface PreparedCollaborator extends CollaboratorInput { agent?: SubagentContinuationProfile['agent'] }

export class CollaboratorError extends Error {
  constructor(message: string, readonly statusCode: 400 | 404 | 409) { super(message) }
}

/** Validate user-selected identities before root admission changes any binding or history. */
export async function prepareCollaborators(tenantId: string, sessionId: string, raw: unknown,
  dependencies: {
    runs?: Pick<SubagentStore, 'getRun' | 'listRunsForParent'>
    agents?: Pick<SQLiteAgentStore, 'getById'>
    workspacePaths?: readonly string[]
  } = {}): Promise<PreparedCollaborator[]> {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > 8) throw new CollaboratorError('collaborators 必须为数组，一次最多选择 8 个子代理。', 400)
  const runs = dependencies.runs ?? getSubagentStore()
  const agents = dependencies.agents ?? new SQLiteAgentStore()
  const parentRuns = raw.length ? await runs.listRunsForParent(tenantId, sessionId) : []
  const plans: PreparedCollaborator[] = []
  const seen = new Set<string>()
  for (const value of raw) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CollaboratorError('collaborators 每项必须指定 agentId 或 resumeRunId。', 400)
    const item = value as Record<string, unknown>
    if ((item.agentId !== undefined && (typeof item.agentId !== 'string' || !item.agentId.trim())) ||
      (item.resumeRunId !== undefined && (typeof item.resumeRunId !== 'string' || !item.resumeRunId.trim()))) {
      throw new CollaboratorError('Agent 和续跑 ID 必须为非空字符串。', 400)
    }
    const agentId = typeof item.agentId === 'string' ? item.agentId.trim() : undefined
    const requestedResume = typeof item.resumeRunId === 'string' ? item.resumeRunId.trim() : undefined
    if (!agentId && !requestedResume) throw new CollaboratorError('请选择需要协作的 Agent 或需要继续的子代理。', 400)
    let prior = requestedResume ? await runs.getRun(tenantId, requestedResume) : undefined
    if (requestedResume && (!prior || prior.parentSessionId !== sessionId || prior.rootSessionId !== sessionId)) {
      throw new CollaboratorError('该子代理不属于当前任务，无法继续。', 404)
    }
    if (prior && agentId && prior.continuation?.agent?.id !== agentId) throw new CollaboratorError('续跑不能更换子代理的 Agent。', 409)
    if (!prior && agentId) {
      // @ the same Agent continues its latest child session instead of losing context on each turn.
      prior = parentRuns.filter(run => (run.agentId ?? run.continuation?.agent?.id) === agentId).at(-1)
    }
    if (prior && (!isTerminalRun(prior.status) || parentRuns.some(run => run.childSessionId === prior!.childSessionId && !isTerminalRun(run.status)))) {
      throw new CollaboratorError('该子代理仍在工作，请完成或停止后再继续。', 409)
    }
    if (prior && !prior.continuation) throw new CollaboratorError('旧子代理缺少可恢复的权限信息，请重新选择 Agent 创建子代理。', 409)
    if (prior?.continuation && dependencies.workspacePaths) {
      const normalizeRoot = (root: string) => process.platform === 'win32' ? path.resolve(root).toLowerCase() : path.resolve(root)
      const currentRoots = new Set(dependencies.workspacePaths.map(normalizeRoot))
      if (prior.continuation.workspacePaths.some(root => !currentRoots.has(normalizeRoot(root)))) {
        throw new CollaboratorError('原子代理目录不在当前任务授权范围内，请恢复原目录后继续。', 409)
      }
    }
    const agent = prior?.continuation?.agent ?? (agentId ? await agents.getById(agentId, tenantId) : undefined)
    if (agentId && !agent) throw new CollaboratorError('所选 Agent 不存在或已被删除，请刷新 Agent 列表。', 404)
    const identity = agent?.id ? `agent:${agent.id}` : `child:${prior!.childSessionId}`
    if (seen.has(identity)) continue
    seen.add(identity)
    plans.push({ agentId: agent?.id, resumeRunId: prior?.runId, ...(agent ? { agent } : {}) })
  }
  return plans
}

function promptText(prompt: string | unknown[] | null): string {
  if (typeof prompt === 'string') return prompt
  return (prompt ?? []).flatMap(value => value && typeof value === 'object' && 'text' in value && typeof value.text === 'string' ? [value.text] : []).join('\n')
}

/** Explicit user-selected children are launched deterministically, before the parent's first model call. */
export function collaboratorTools(plans: readonly PreparedCollaborator[], prompt: string | unknown[] | null,
  parent: AgentContext): NonNullable<ReActOptions['delegatedTools']> {
  return plans.map((plan, index) => {
    const args: Record<string, unknown> = {
      task: `用户明确委派你作为协作子代理，结合你的职责完成本次请求中与你相关的部分。保留此前上下文；以实际完成的结果、证据和未完成事项回复。\n\n当前用户请求：\n${promptText(prompt)}`,
      ...(plan.agentId ? { agentId: plan.agentId } : {}),
      ...(plan.resumeRunId ? { resumeRunId: plan.resumeRunId } : {}),
      description: plan.agent ? `${plan.agent.name} · 协作任务` : '继续子代理任务',
    }
    return {
      id: `collaborator:${parent.rootRunId ?? parent.conversationId}:${index}`,
      args,
      execute: async ctx => {
        if (!plan.resumeRunId) {
          const recent = (await ctx.history.getHistory(ctx)).filter(message =>
            (message.role === 'user' || message.role === 'assistant') && !message.toolCall && message.id !== ctx.userMessageId).slice(-6)
          const context = recent.map(message => `${message.role}: ${typeof message.content === 'string' ? message.content.slice(-2500) : '[附件消息]'}`).join('\n\n').slice(-10_000)
          if (context) args.task = `${String(args.task)}\n\n主任务最近的对话背景（用于理解指代，当前请求优先）：\n${context}`
        }
        return executeSubagent(args, ctx, { userDelegated: true, agent: plan.agent })
      },
    }
  })
}
