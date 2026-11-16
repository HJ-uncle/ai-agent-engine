import type { AgentContext, Tool, ToolResult } from '../../core/agent-context/index.js'
import { isAbortError, throwIfAborted } from '../../core/utils/abort.js'
import { getSecurityMode } from '../../security/policy-engine.js'

export interface PreparedManagementMutation { version: 1; tenantId: string }

function failure(error: unknown, signal?: AbortSignal): ToolResult {
  const message = error instanceof Error ? error.message : String(error)
  return { success: false, status: isAbortError(error, signal) ? 'cancelled' : 'failed', output: message, error: message }
}

/** A durable approval executes the exact prepared operation, never newly generated arguments. */
export function createApprovedMutationTool<T extends PreparedManagementMutation>(options: {
  name: string
  displayName: string
  description: string
  parameters: Tool['parameters']
  prepare: (raw: unknown, ctx: AgentContext) => Promise<T>
  apply: (operation: T, ctx: AgentContext, raw: unknown) => Promise<ToolResult>
  preview?: (operation: T) => unknown
  confirmationText?: (operation: T) => string
  failure?: (error: unknown) => ToolResult
}): Tool {
  const failed = (error: unknown, ctx: AgentContext): ToolResult =>
    isAbortError(error, ctx.signal) ? failure(error, ctx.signal) : options.failure?.(error) ?? failure(error, ctx.signal)
  const fullAccess = (ctx: AgentContext): boolean =>
    getSecurityMode(ctx.tenantId, ctx.rootSessionId ?? ctx.sessionId) === 'full-access'
  const confirmation = (operation: T): ToolResult => {
    const reason = options.confirmationText?.(operation) ?? `${options.displayName}确认\n\n${JSON.stringify(options.preview?.(operation) ?? operation, null, 2)}\n\n确认后执行以上操作。`
    return { success: false, status: 'waiting', needsConfirmation: true, output: reason,
      pendingAction: { type: options.name, operation, reason } }
  }
  const approved = (args: unknown, ctx: AgentContext): T | undefined => {
    if (!ctx.currentToolCallId || ctx.currentToolCallId !== ctx.approvedToolCallId) return undefined
    const resume = ctx.resumeToolCall
    if (resume?.decision !== 'approved' || resume.toolCall.id !== ctx.currentToolCallId ||
      resume.toolCall.name !== options.name || JSON.stringify(args) !== JSON.stringify(resume.toolCall.args) ||
      resume.pendingAction?.type !== options.name) throw new Error('缺少该工具调用的有效确认记录，请重新发起操作')
    const operation = resume.pendingAction.operation as T | undefined
    if (!operation || operation.version !== 1 || operation.tenantId !== ctx.tenantId)
      throw new Error('确认记录与当前租户不匹配，请重新发起操作')
    return operation
  }
  const prepare = async (raw: unknown, ctx: AgentContext): Promise<{ operation: T; accepted: boolean; blocked?: ToolResult }> => {
    throwIfAborted(ctx.signal)
    const accepted = approved(raw, ctx)
    const operation = accepted ?? await options.prepare(raw, ctx)
    throwIfAborted(ctx.signal)
    if (operation.tenantId !== ctx.tenantId) throw new Error('操作租户不匹配')
    // Read the live session grant after preparation and again at execution, not
    // from model arguments or a cached preflight decision. Child tasks belong
    // to the same root conversation; unrelated sessions never inherit this.
    return { operation, accepted: Boolean(accepted), blocked: accepted || fullAccess(ctx) ? undefined : confirmation(operation) }
  }
  const preflight: NonNullable<Tool['preflight']> = async (raw, ctx) => {
    try { return (await prepare(raw, ctx)).blocked }
    catch (error) { return failed(error, ctx) }
  }
  return { name: options.name, displayName: options.displayName,
    description: `${options.description} 普通模式下展示具体变更并等待用户确认，批准后自动恢复原调用；本会话完全访问时自动执行，无需另调 ask_user。`,
    parameters: options.parameters, preflight,
    async execute(raw, ctx) {
      try {
        const { operation, accepted, blocked } = await prepare(raw, ctx)
        if (blocked) return blocked
        throwIfAborted(ctx.signal)
        if (!accepted && !fullAccess(ctx)) return confirmation(operation)
        return await options.apply(operation, ctx, raw)
      } catch (error) { return failed(error, ctx) }
    },
  }
}
