import type { AgentContext, Pending, ToolCall, ToolOutcomeStatus, ToolResult } from '../agent-context/index.js'
import { isAbortError } from '../utils/abort.js'

export interface ParsedToolCall extends ToolCall {
  _parseError?: string
  _rawArgs?: string
}

export interface RegisteredToolCall {
  call: ParsedToolCall
  messageId: string
}

export interface BatchExecution {
  results: ToolResult[]
  pending?: Pending
}

function statusResult(status: ToolOutcomeStatus, output: string, error?: string): ToolResult {
  return { success: status === 'succeeded', status, output, error, durationMs: 0 }
}

export function normalizeToolResult(result: ToolResult, durationMs = result.durationMs ?? 0): ToolResult {
  const metadataStatus = result.metadata?.status ?? result.metadata?.diagnosticStatus
  const status = result.status ?? (result.needsConfirmation ? 'waiting'
    : metadataStatus === 'cancelled' ? 'cancelled'
    : metadataStatus === 'interrupted' ? 'interrupted'
    : result.success ? 'succeeded' : 'failed')
  return { ...result, success: status === 'succeeded', status, durationMs: result.durationMs ?? durationMs }
}

function invocationContext(ctx: AgentContext, item: RegisteredToolCall): AgentContext {
  return { ...ctx, currentToolCallId: item.call.id, currentMessageId: item.messageId }
}

function pendingFor(item: RegisteredToolCall, result: ToolResult): Pending {
  const { call, messageId } = item
  const ask = call.name === 'ask_user'
  const question = ask ? String(call.args.question ?? '')
    : `安全策略拦截了此操作，是否允许执行？\n原因：${result.pendingAction?.reason ?? result.output}`
  return {
    requestId: call.id, toolCallId: call.id, toolName: call.name, args: call.args,
    messageId, kind: ask ? 'ask' : 'permission', status: 'pending', question,
    options: ask ? (Array.isArray(call.args.options) ? call.args.options : undefined) : ['approved', 'rejected'],
    pendingAction: result.pendingAction,
  }
}

export async function executeRegisteredTool(item: RegisteredToolCall, ctx: AgentContext): Promise<ToolResult> {
  if (ctx.signal?.aborted) return statusResult('cancelled', 'Tool execution cancelled before start', 'Cancelled')
  const started = Date.now()
  try {
    await ctx.runObserver?.onToolStart?.({ toolCallId: item.call.id, name: item.call.name, args: item.call.args })
    const result = await ctx.tools.execute(item.call.name, item.call.args, invocationContext(ctx, item))
    return normalizeToolResult(result, Date.now() - started)
  } catch (error) {
    const cancelled = isAbortError(error, ctx.signal)
    return {
      ...statusResult(cancelled ? 'cancelled' : 'failed', cancelled ? 'Tool execution cancelled' : `Tool error: ${error instanceof Error ? error.message : String(error)}`,
        cancelled ? 'Cancelled' : error instanceof Error ? error.message : String(error)),
      durationMs: Date.now() - started,
    }
  }
}

/** All decisions precede side effects; only explicitly classified groups overlap. */
export async function executeToolBatch(items: RegisteredToolCall[], ctx: AgentContext): Promise<BatchExecution> {
  const results: Array<ToolResult | undefined> = new Array(items.length)
  for (let index = 0; index < items.length; index++) {
    const item = items[index]
    if (ctx.signal?.aborted) {
      results[index] = statusResult('cancelled', 'Tool execution cancelled before start', 'Cancelled')
      continue
    }
    if (item.call._parseError) {
      results[index] = statusResult('failed', `Tool error: SyntaxError in arguments JSON: ${item.call._parseError}\nRaw args: ${item.call._rawArgs}`, item.call._parseError)
      continue
    }
    try {
      const decision = await ctx.tools.preflight?.(item.call.name, item.call.args, invocationContext(ctx, item))
      if (decision) results[index] = normalizeToolResult(decision)
      else if (item.call.name === 'ask_user') results[index] = { ...statusResult('waiting', '等待用户回答'), needsConfirmation: true }
    } catch (error) {
      results[index] = statusResult(isAbortError(error, ctx.signal) ? 'cancelled' : 'failed', `Tool preflight failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  let waitingIndex = results.findIndex(result => result?.status === 'waiting')
  if (waitingIndex === -1) {
    for (let index = 0; index < items.length;) {
      if (results[index]) { index++; continue }
      const mode = ctx.tools.executionMode?.(items[index].call.name, items[index].call.args) ?? 'serial'
      const indexes = [index++]
      if (mode !== 'serial') {
        while (index < items.length && !results[index] && ctx.tools.executionMode?.(items[index].call.name, items[index].call.args) === mode) indexes.push(index++)
      }
      // Each wrapper captures execution errors; every launched sibling finishes.
      await Promise.all(indexes.map(async i => { results[i] = await executeRegisteredTool(items[i], ctx) }))
      waitingIndex = results.findIndex(result => result?.status === 'waiting')
      if (waitingIndex !== -1) break
    }
  }

  if (waitingIndex !== -1 && !ctx.signal?.aborted) {
    const pending = pendingFor(items[waitingIndex], results[waitingIndex]!)
    for (let index = 0; index < items.length; index++) {
      if (index !== waitingIndex && (!results[index] || results[index]?.status === 'waiting')) {
        results[index] = statusResult('interrupted', '本轮等待用户应答，此工具未执行；继续后可重新规划')
      }
    }
    return { results: results as ToolResult[], pending }
  }
  return {
    results: items.map((_item, index) => results[index]?.status === 'waiting'
      ? statusResult('cancelled', '等待请求已取消', 'Cancelled')
      : results[index] ?? statusResult('cancelled', 'Tool execution cancelled before start', 'Cancelled')),
  }
}
