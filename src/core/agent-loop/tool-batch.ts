import type { AgentContext, Pending, ToolCall, ToolOutcomeStatus, ToolResult } from '../agent-context/index.js'
import { isAbortError } from '../utils/abort.js'

export interface ParsedToolCall extends ToolCall {
  _parseError?: string
  _rawArgs?: string
  _providerId?: string
}

export interface RegisteredToolCall {
  call: ParsedToolCall
  messageId: string
}

export interface BatchExecution {
  results: ToolResult[]
  pending?: Pending
  yieldedForUserInput?: boolean
  /** Propagate after all announced calls have durable terminal receipts. */
  inputCheckError?: unknown
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
    : result.pendingAction?.type === 'source_change'
      ? String(result.pendingAction.reason ?? result.output)
      : `安全策略拦截了此操作，是否允许执行？\n原因：${result.pendingAction?.reason ?? result.output}`
  const sourceChoices = result.pendingAction?.type === 'source_change' && Array.isArray(result.pendingAction.choices)
    ? result.pendingAction.choices.filter(choice => typeof choice === 'string') : undefined
  return {
    requestId: call.id, toolCallId: call.id, toolName: call.name, args: call.args,
    messageId, kind: ask ? 'ask' : 'permission', status: 'pending', question,
    options: ask ? (Array.isArray(call.args.options) ? call.args.options : undefined) : sourceChoices ?? ['approved', 'rejected'],
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
export async function executeToolBatch(items: RegisteredToolCall[], ctx: AgentContext, offeredTools?: ReadonlySet<string>,
  hasPendingUserInput?: () => Promise<boolean>): Promise<BatchExecution> {
  const results: Array<ToolResult | undefined> = new Array(items.length)
  const started = new Set<number>()
  const deferUnstarted = async (): Promise<BatchExecution | undefined> => {
    if (!hasPendingUserInput || ctx.signal?.aborted) return undefined
    let pending: boolean
    try { pending = await hasPendingUserInput() }
    catch (error) {
      for (let index = 0; index < items.length; index++) if (!started.has(index)) {
        results[index] = statusResult('interrupted', '用户补充检查失败，此工具未执行。', 'USER_INPUT_CHECK_FAILED')
      }
      return { results: results as ToolResult[], inputCheckError: error }
    }
    if (!pending) return undefined
    for (let index = 0; index < items.length; index++) if (!started.has(index)) {
      results[index] = statusResult('interrupted', '收到用户补充，此工具尚未执行；先处理最新要求，再重新规划。', 'USER_INPUT_PENDING')
    }
    return { results: results as ToolResult[], yieldedForUserInput: true }
  }
  const beforePreflight = await deferUnstarted()
  if (beforePreflight) return beforePreflight
  for (let index = 0; index < items.length; index++) {
    const item = items[index]
    if (ctx.signal?.aborted) {
      results[index] = statusResult('cancelled', 'Tool execution cancelled before start', 'Cancelled')
      continue
    }
    if (offeredTools && !offeredTools.has(item.call.name)) {
      const recoverable = ctx.tools.has(item.call.name) && offeredTools.has('load_tools')
      results[index] = statusResult('failed', JSON.stringify({
        code: 'TOOL_NOT_LOADED', toolName: item.call.name, retryable: recoverable,
        message: recoverable
          ? 'Tool not executed: its definition was not offered in this request. Call load_tools with this exact name, then use the complete schema in the next request.'
          : 'Tool not executed: this tool was not offered in the current request. Use the available definitions.',
      }))
      continue
    }
    if (item.call._parseError) {
      // Keep malformed provider output actionable without replaying the full
      // argument blob into the next model request. Large embedded workbooks,
      // shell snippets and escaped JSON can turn this receipt into a second
      // token sink, while the model only needs to know which call to regenerate.
      const output = JSON.stringify({
        code: 'TOOL_ARGUMENTS_INVALID',
        message: '工具参数不是有效 JSON，工具未执行。请重新生成一条完整的工具调用，不要追加到上一条参数片段；大型内容请先写入文件，再传路径或引用。',
        toolName: item.call.name,
        retryable: true,
        parseError: item.call._parseError,
        rawArgsCharacters: item.call._rawArgs?.length ?? 0,
      })
      results[index] = statusResult('failed', output, item.call._parseError)
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

  // Preflight awaits may admit steering while preparing an old approval. No
  // operation has run yet, so defer that approval with the unstarted batch.
  const afterPreflight = await deferUnstarted()
  if (afterPreflight) return afterPreflight
  let waitingIndex = results.findIndex(result => result?.status === 'waiting')
  if (waitingIndex === -1) {
    let deliveryStaged = false
    for (let index = 0; index < items.length;) {
      if (results[index]) { index++; continue }
      if (started.size) {
        const beforeNextGroup = await deferUnstarted()
        if (beforeNextGroup) return beforeNextGroup
      }
      if (deliveryStaged && !['plan_update', 'deliver_files'].includes(items[index].call.name)) {
        results[index++] = statusResult('failed', JSON.stringify({ code: 'FINAL_DELIVERY_CLOSEOUT',
          message: 'Tool not executed: the complete final file list was already registered in this batch. Reconcile the plan and answer. For a concrete repair, first clear deliver_files with items:[], then repair, validate and register again.' }))
        continue
      }
      const mode = items[index].call.name === 'deliver_files' ? 'serial'
        : ctx.tools.executionMode?.(items[index].call.name, items[index].call.args) ?? 'serial'
      const indexes = [index++]
      if (mode !== 'serial' && !deliveryStaged) {
        while (index < items.length && !results[index] && ctx.tools.executionMode?.(items[index].call.name, items[index].call.args) === mode
          && items[index].call.name !== 'deliver_files') indexes.push(index++)
      }
      // Each wrapper captures execution errors; every launched sibling finishes.
      await Promise.all(indexes.map(async i => { started.add(i); results[i] = await executeRegisteredTool(items[i], ctx) }))
      for (const i of indexes) if (!ctx.parentSessionId && ctx.rootRunId && ctx.turnId && items[i].call.name === 'deliver_files'
        && results[i]?.success && Array.isArray(items[i].call.args.items)) {
        deliveryStaged = (items[i].call.args.items as unknown[]).length > 0
      }
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
