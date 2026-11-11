import type { AgentContext, Tool, ToolResult } from '../../core/agent-context/index.js'
import { isAbortError, throwIfAborted } from '../../core/utils/abort.js'

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
  apply: (operation: T, ctx: AgentContext) => Promise<ToolResult>
  preview?: (operation: T) => unknown
}): Tool {
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
  const preflight: NonNullable<Tool['preflight']> = async (raw, ctx) => {
    try {
      throwIfAborted(ctx.signal)
      if (approved(raw, ctx)) return undefined
      const operation = await options.prepare(raw, ctx)
      throwIfAborted(ctx.signal)
      if (operation.tenantId !== ctx.tenantId) throw new Error('操作租户不匹配')
      const reason = `${options.displayName}确认\n\n${JSON.stringify(options.preview?.(operation) ?? operation, null, 2)}\n\n确认后执行以上操作。`
      return { success: false, status: 'waiting', needsConfirmation: true, output: reason,
        pendingAction: { type: options.name, operation, reason } }
    } catch (error) { return failure(error, ctx.signal) }
  }
  return { name: options.name, displayName: options.displayName,
    description: `${options.description} 写入前展示具体变更并等待用户确认，批准后自动恢复原调用，无需另调 ask_user。`,
    parameters: options.parameters, preflight,
    async execute(raw, ctx) {
      const blocked = await preflight(raw, ctx)
      if (blocked) return blocked
      try {
        throwIfAborted(ctx.signal)
        return await options.apply(approved(raw, ctx)!, ctx)
      } catch (error) { return failure(error, ctx.signal) }
    },
  }
}
