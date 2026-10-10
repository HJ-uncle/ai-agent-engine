import { isThinkingDisabled } from '../llm-adapter/thinking.js'
import type { LoopStrategy } from './strategy.js'
import type { AgentContext } from '../agent-context/index.js'
import type { LLMAdapter, LLMAdapterOptions } from '../llm-adapter/index.js'
import type { Message, ToolResult } from '../agent-context/index.js'
import { estimateTokens } from '../utils/tokens.js'
import { v4 as uuidv4 } from 'uuid'
import { applyOSMMultiplier, getOSMCompressRatio } from '../osm.js'
import { getCodeToolOutputMaxChars, getToolOutputMaxChars } from './tool-output-limit.js'
import { repairJson } from '../utils/json.js'
import { TodoStore } from '../../storage/todo/index.js'
import type { RunOutcome } from '../subagent/types.js'
import { FINALIZATION_PROMPT, estimateRequestInput, finalizationMessages, partialEvidence } from './finalization.js'
import { executeRegisteredTool, executeToolBatch, normalizeToolResult, type RegisteredToolCall, type ParsedToolCall } from './tool-batch.js'
import { resolveCapabilities } from '../model-capabilities/index.js'
import { ToolProgressTracker, toolFailureLimit } from './tool-progress.js'
import { estimateModelHistoryTokens, estimateModelMessageTokens, modelMessageContent } from '../utils/model-context.js'
import { createHash } from 'node:crypto'

const OUTPUT_CONTINUATION_PROMPT = 'The previous model response reached its single-response output limit. Continue the same user task from the retained partial response and history, starting exactly where the response stopped. Do not repeat text already emitted, restart completed work, or repeat executed tools. Use tools only for remaining work; finish normally when the original task is complete.'

/**
 * Truncate tool output that is too long.
 *
 * Real image data URLs must remain intact: adapters convert them to image
 * blocks, not model text. A boolean `hasDataUrl` marker or a non-image data
 * URL must not let arbitrary large text bypass the ordinary transcript cap.
 */
export function truncateToolOutput(output: string, maxChars: number = getToolOutputMaxChars()): string {
  if (output.length > maxChars && (output.includes('"dataUrl"') || output.includes('"hasDataUrl"'))) {
    try {
      const parsed = JSON.parse(output) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>
        const imageData = typeof record.dataUrl === 'string'
          ? /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(record.dataUrl)
          : null
        if (imageData && imageData[2].length % 4 === 0) {
          // Keep the payload and bounded identity fields; unrelated metadata
          // alongside a genuine image must not smuggle a megabyte text log.
          return JSON.stringify({
            filename: typeof record.filename === 'string' ? record.filename.slice(0, 512) : undefined,
            mimeType: imageData[1],
            description: typeof record.description === 'string' ? record.description.slice(0, 1024) : undefined,
            size: typeof record.size === 'number' ? record.size : undefined,
            dataUrl: record.dataUrl,
            hasDataUrl: true,
          })
        }
        if (typeof record.dataUrl === 'string' || record.hasDataUrl === true) {
          const compact: Record<string, unknown> = { ...record }
          delete compact.dataUrl
          compact.hasDataUrl = false
          compact.dataUrlStripped = true
          const compactText = JSON.stringify(compact)
          if (compactText.length <= maxChars) return compactText
          const minimal = JSON.stringify({
            filename: typeof record.filename === 'string' ? record.filename.slice(0, 512) : undefined,
            mimeType: typeof record.mimeType === 'string' ? record.mimeType : undefined,
            size: typeof record.size === 'number' ? record.size : undefined,
            hasDataUrl: false,
            dataUrlStripped: true,
          })
          if (minimal.length <= maxChars) return minimal
        }
      }
    } catch {
      // Could not parse — fall through to the ordinary head/tail truncation.
    }
  }
  if (output.length <= maxChars) return output
  const marker = `\n\n... [truncated ${output.length - maxChars} chars] ...\n\n`
  if (maxChars <= marker.length) return output.slice(0, maxChars)
  const available = Math.max(0, maxChars - marker.length)
  const half = Math.floor(available / 2)
  const head = output.slice(0, half)
  const tail = output.slice(-half)
  return `${head}${marker}${tail}`
}

/** 子代理输出末尾的执行元数据标记（subagent 工具附带，客户端专用，不进 LLM 历史） */
const SUBAGENT_META_MARKER = '__SUBAGENT_META__'

function stripSubagentMeta(output: string): string {
  const idx = output.lastIndexOf(SUBAGENT_META_MARKER)
  return idx === -1 ? output : output.slice(0, idx).trimEnd()
}

export interface TokenUsage {
  /** Per-request context occupancy; cumulative usage counters below remain separate. */
  currentPromptTokens?: number
  contextWindow?: number
  /** Tokens in the system prompt (excluding RAG context) */
  systemPromptTokens: number
  /** Tokens used by tool definitions (builtin + MCP combined, kept for backward compat) */
  systemToolsTokens: number
  /** Tokens from conversation messages (history window) */
  messagesTokens: number
  /** Tokens from skills prompt index */
  skillTokens: number
  /** Total prompt tokens (sum of above) */
  promptTokens: number
  /** Tokens generated in the final answer */
  completionTokens: number
  /** Grand total */
  totalTokens: number

  // ── Granular breakdown (new) ──────────────────────────────────────────
  /** Tokens from RAG / knowledge-base context injected into the system prompt */
  ragTokens: number
  /** Tokens used by built-in tool definitions only */
  builtinToolsTokens: number
  /** Tokens used by MCP tool definitions only */
  mcpToolsTokens: number
  /** Cumulative tokens from tool-call result messages in the ReAct loop */
  toolResultsTokens: number
  /** Tokens from the current user message */
  userInputTokens?: number

  // ── DeepSeek 专有 (KV Cache / Reasoning) ──────────────────────────────
  /** KV Cache 命中的 token 数（DeepSeek 计费 0.1元/百万） */
  cacheHitTokens?: number
  /** KV Cache 未命中的 token 数（按正常输入价计费） */
  cacheMissTokens?: number
  /** R1/V3 thinking 模式实际产生的推理 token 数 */
  reasoningTokens?: number
}

export interface ReActOptions {
  /** Reserve the final child iteration for returning evidence instead of starting more tools. */
  finalizeOnLimit?: boolean
  /** Code mode uses remaining context capacity without a fixed completion or cumulative budget. */
  unboundedCode?: boolean
  maxOutputTokens?: number
  maxIterations?: number
  maxAskUserCount?: number
  systemPrompt?: string
  temperature?: number
  /** Unique ID for this conversation round (one chat request = one conversationId) */
  conversationId?: string
  /** Pre-computed token counts for the injected prompts (optional) */
  promptBreakdown?: Pick<TokenUsage, 'systemPromptTokens' | 'systemToolsTokens' | 'skillTokens' | 'ragTokens' | 'builtinToolsTokens' | 'mcpToolsTokens'>
  thinkingEnabled?: boolean
  thinkingConfig?: Record<string, unknown> | null
  responseThinkingField?: string | null
  reasoningEffort?: 'low' | 'medium' | 'high'
  /**
   * 原始用户消息内容（含 workspace_image 等前端格式），用于存入历史 DB（UI 展示用）。
   * 与 input（LLM prompt）分离：LLM 看到文本化的 prompt，DB/UI 保留原始格式。
   */
  displayContent?: string | any[] | null
  /**
   * 业务元数据（可选）
   * 随 user 消息存入历史 DB。
   */
  metadata?: any
}

/** 会话级待办存储（仅用于向客户端推送清单快照，不在此做增删改） */
const todoStore = new TodoStore()

/**
 * 把会话待办清单作为结构化帧推送（\x00__todo__）。
 * 客户端据此渲染任务托盘；清单为空时也推送，让客户端能清掉残留展示。
 */
async function* yieldTodoFrame(ctx: AgentContext): AsyncGenerator<string> {
  try {
    const todos = await todoStore.list(ctx.tenantId, ctx.sessionId)
    yield `\x00__todo__${JSON.stringify({ todos })}`
  } catch {
    // 清单推送失败不影响主流程
  }
}

/** Parallel runs persist launch records first; providers still need adjacent call/result pairs. */
export function pairToolHistory(messages: Message[]): Message[] {
  const results = new Map(messages.filter(message => message.role === 'tool' && message.toolCallId).map(message => [message.toolCallId!, message]))
  const paired = new Set<string>()
  for (const message of messages) if (message.toolCall && results.has(message.toolCall.id)) paired.add(message.toolCall.id)
  return messages.flatMap(message => {
    if (message.role === 'tool' && message.toolCallId && paired.has(message.toolCallId)) return []
    const result = message.toolCall ? results.get(message.toolCall.id) : undefined
    return result ? [message, result] : [message]
  })
}

/** Read the complete active history so backend windows cannot hide system constraints. */
async function requestHistory(ctx: AgentContext): Promise<Message[]> {
  const all = typeof ctx.history.getFullHistory === 'function'
    ? await ctx.history.getFullHistory(ctx) : await ctx.history.getHistory(ctx)
  let selected = all
  if (ctx.inheritContext === false) {
    const lastUser = all.map(message => message.role).lastIndexOf('user')
    if (lastUser >= 0) selected = all.slice(lastUser)
  }
  return pairToolHistory(selected.map(projectModelMessage))
}

/** User replay evidence must not be counted or sent as live model context. */
export function projectModelMessage(message: Message): Message {
  const projected = { ...message, content: modelMessageContent(message) }
  if (!message.metadata || typeof message.metadata !== 'object') return projected
  const { outputPreview: _preview, __aetherMicroCompactArchive: _archive, ...metadata } = message.metadata
  return { ...projected, metadata }
}

export class ReActStrategy implements LoopStrategy {
  constructor(
    private readonly llm: LLMAdapter,
    private readonly options: ReActOptions = {},
  ) {}

  /** Settle one invocation without letting storage/observer failure skip siblings. */
  private async *settleTool(item: RegisteredToolCall, rawResult: ToolResult, ctx: AgentContext): AsyncGenerator<string, { tokens: number; failedToPersist: boolean }> {
    const result = normalizeToolResult(rawResult)
    const { call, messageId } = item
    const output = String(result.output)
    const metadata = { ...result.metadata, status: result.status, success: result.success, error: result.error,
      durationMs: result.durationMs, rootRunId: ctx.rootRunId, turnId: ctx.turnId,
      ...(result.change ? { change: { ...result.change, toolCallId: call.id } } : {}) }
    let failedToPersist = false
    // Code mode gets a larger cap for source and compiler diagnostics, but it
    // must still be bounded.  A complete build log can contain megabytes of
    // base64/minified text whose provider token count is far above our cheap
    // character estimate; persisting it verbatim makes the next request fail
    // before the loop has a chance to compact the history.
    const outputLimit = ctx.toolProfile === 'code' ? getCodeToolOutputMaxChars() : getToolOutputMaxChars()
    const truncated = truncateToolOutput(stripSubagentMeta(output), outputLimit)
    const outputWasTruncated = truncated.length < output.length
    if (outputWasTruncated) (metadata as Record<string, unknown>).outputTruncated = true
    const tokens = estimateTokens(truncated)
    if (result.status !== 'waiting') {
      const subagent = result.metadata?.subagent as { runId?: string } | undefined
      try {
        await ctx.history.append({
          id: subagent?.runId ? 'subagent-result:' + subagent.runId : `tool-result:${ctx.rootRunId ?? ctx.runId ?? ctx.conversationId ?? ctx.sessionId}:${call.id}`,
          role: 'tool', content: truncated, toolCallId: call.id, toolName: call.name,
          createdAt: Date.now(), tokens, metadata, conversationId: ctx.conversationId,
        } as Message, ctx)
      } catch (error) {
        failedToPersist = true
        ctx.logger.error({ err: error, toolCallId: call.id }, 'Failed to persist tool result')
      }
      try {
        await ctx.runObserver?.onToolEnd?.({ toolCallId: call.id, name: call.name,
          success: result.success, output: truncated, durationMs: result.durationMs,
          error: result.error ? { code: result.status === 'cancelled' ? 'CANCELLED' : 'TOOL_ERROR', message: result.error, retryable: false } : undefined })
      } catch (error) {
        failedToPersist = true
        ctx.logger.error({ err: error, toolCallId: call.id }, 'Failed to persist tool observer outcome')
      }
    }
    const frame = { toolCallId: call.id, toolName: call.name, name: call.name, messageId,
      success: result.success, status: result.status, output: truncated, outputPreview: truncated,
      error: result.error, metadata, durationMs: result.durationMs,
      rootRunId: ctx.rootRunId, turnId: ctx.turnId }
    yield `\x00__tool_end__${JSON.stringify(frame)}`
    yield `\x00__tool_result__${JSON.stringify(frame)}`
    if (call.name.startsWith('todo_') && result.status !== 'waiting') yield* yieldTodoFrame(ctx)
    // A writer may partially mutate before failing; its recorded change still matters.
    if (result.change) yield `\x00__file_change__${JSON.stringify({ ...result.change, toolCallId: call.id })}`
    return { tokens: result.status === 'waiting' ? 0 : tokens, failedToPersist }
  }

  /** Streaming may announce cards before the provider returns a valid batch. */
  private async *settleUnstarted(calls: ParsedToolCall[], ctx: AgentContext, reason: string): AsyncGenerator<string> {
    for (const call of calls) {
      const item = { call, messageId: uuidv4() }
      try {
        await ctx.history.append({ id: item.messageId, role: 'assistant', content: '', toolCall: call,
          toolCallId: call.id, createdAt: Date.now(), tokens: 0,
          metadata: { rootRunId: ctx.rootRunId, turnId: ctx.turnId }, conversationId: ctx.conversationId } as Message, ctx)
      } catch (error) { ctx.logger.error({ err: error, toolCallId: call.id }, 'Failed to persist interrupted tool announcement') }
      yield* this.settleTool(item, { success: false, status: ctx.signal?.aborted ? 'cancelled' : 'interrupted',
        output: reason, error: reason, durationMs: 0 }, ctx)
    }
  }

  async *run(input: string | any[] | null, ctx: AgentContext): AsyncIterable<string> {
    let outcome: RunOutcome | undefined
    const observer = ctx.runObserver
    const runCtx: AgentContext = { ...ctx, runObserver: {
      ...observer,
      onOutcome: async (value) => { outcome = value; await observer?.onOutcome?.(value) },
    } }
    try {
      // Arrays here are content blocks. Passing Message[] creates an invalid provider request.
      if (Array.isArray(input) && input.some(part => !part || typeof part !== 'object' || 'role' in part || typeof part.type !== 'string')) {
        throw new TypeError('Agent input must be text or content blocks, not a Message[]')
      }
      yield* this.runInternal(input, runCtx)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await runCtx.runObserver?.onOutcome?.({ status: ctx.signal?.aborted ? 'cancelled' : 'failed',
        stopReason: ctx.signal?.aborted ? 'cancelled' : 'runtime_error', error: { retryable: false, code: 'RUNTIME_ERROR', message } })
      if (!ctx.signal?.aborted) yield '\n\n[Error: ' + message + ']'
    } finally {
      if (!outcome) await runCtx.runObserver?.onOutcome?.({
        status: ctx.signal?.aborted ? 'cancelled' : 'failed',
        stopReason: ctx.signal?.aborted ? 'cancelled' : 'incomplete',
      })
      // Keep full partial evidence in the child transcript; parent snapshots intentionally hold short summaries.
      if (ctx.runId && outcome && outcome.status !== 'succeeded') {
        const content = outcome.partialOutput || outcome.error?.message || outcome.stopReason || outcome.status
        try {
          await ctx.history.append({ id: 'subagent-outcome:' + ctx.runId, role: 'assistant', content,
            tokens: estimateTokens(content), createdAt: Date.now(),
            metadata: { runId: ctx.runId, status: outcome.status, stopReason: outcome.stopReason, error: outcome.error, partial: true } }, ctx)
        } catch (error) { ctx.logger.warn({ err: error, runId: ctx.runId }, 'Failed to persist partial child transcript') }
      }
    }
  }

  private async *runInternal(input: string | any[] | null, ctx: AgentContext): AsyncIterable<string> {
    const unboundedCode = this.options.unboundedCode === true || ctx.toolProfile === 'code'
    // 迭代上限决策顺序（与 agent-context/factory.ts 的 tokenBudget 规则对齐）：
    //   1. this.options.maxIterations 显式传入 → 原样使用（NaN = 调用方声明"不限"）
    //      （调用方已经推导过了，例如 subagent-tool 的 maxSteps；不应再被
    //       superpower 倍率干预，否则会把子代理步数悄悄放大 4×）
    //   2. 未显式传入 → 读 env MAX_ITERATIONS
    //   3. env 未配置 → 不限步数（原先写死 50，经 balanced 倍率 2 得到 100，
    //      会在长任务中途硬截断；真正收口交给 token 预算，不设人为天花板）
    const hasExplicitIterations = typeof this.options.maxIterations === 'number'
    const configuredIterations = parseInt(process.env.MAX_ITERATIONS ?? '', 10)
    const envDefaultIterations = Number.isFinite(configuredIterations) && configuredIterations > 0
      ? configuredIterations
      : undefined
    const maxIterations = hasExplicitIterations
      ? (this.options.maxIterations as number)
      : unboundedCode || envDefaultIterations === undefined
        ? Number.POSITIVE_INFINITY
        : applyOSMMultiplier('maxIterations', envDefaultIterations)

    const maxAskUserCount = unboundedCode ? Number.POSITIVE_INFINITY : this.options.maxAskUserCount ?? 5
    const conversationId = ctx.turnId ?? this.options.conversationId ?? ctx.conversationId
    ctx.conversationId = conversationId

    // Add user message to history only if input is provided
    // 优先使用 displayContent（原始前端格式，含 workspace_image）存入 DB，用于 UI 展示
    // LLM 收到的是处理后的 input（文本化的 prompt），两者分离
    const historyContent = (this.options.displayContent ?? input) as string | any[]
    if (input !== null && input !== '') {
      const userMessage: Message & { conversationId?: string } = {
        id: ctx.userMessageId ?? uuidv4(),
        role: 'user',
        content: historyContent,
        ...(input !== historyContent ? { modelInputContent: input } : {}),
        createdAt: Date.now(),
        tokens: estimateTokens(input),
        ...(conversationId ? { conversationId } : {}),
        metadata: { ...this.options.metadata, rootRunId: ctx.rootRunId, turnId: ctx.turnId },
      }
      const savedUserMsgId = await ctx.history.append(userMessage, ctx) ?? userMessage.id
      // ★ 把后端 message_id 回传给前端，前端用它做删除/重发的准确定位
      yield `\x00__user_msg_id__${savedUserMsgId}`
      // ★ 别名帧（新版协议，第三方项目 等下游消费 camelCase 命名；不影响旧消费者）
      yield `\x00__userMsgId__${savedUserMsgId}`
    }

    // Persisted snapshots make every replay/compaction use the same actual
    // attachment content, including after a restart or approval continuation.
    let outputContinuation: { messageId: string; suffix: string } | undefined
    const continuedResponseFingerprints = new Set<string>()
    let emittedOutput = ''
    const readModelHistory = async (): Promise<Message[]> => {
      const messages = await requestHistory(ctx)
      if (!outputContinuation) return messages
      // The full segment is durable and searchable. If compaction covered it,
      // its short suffix also anchors the precise point where generation stopped.
      if (!messages.some(message => message.id === outputContinuation!.messageId)) {
        messages.push({ role: 'assistant', content: outputContinuation.suffix })
      }
      messages.push({ role: 'user', content: OUTPUT_CONTINUATION_PROMPT })
      return messages
    }

    // ★ 会话待办初始帧：每轮开始时推送现有清单，客户端据此恢复任务托盘
    yield* yieldTodoFrame(ctx)

    if (ctx.resumeToolCall) {
      const resume = ctx.resumeToolCall
      const item: RegisteredToolCall = { call: resume.toolCall, messageId: resume.messageId ?? uuidv4() }
      const result = resume.decision === 'approved'
        ? await executeRegisteredTool(item, { ...ctx, approvedToolCallId: resume.toolCall.id })
        : resume.decision === 'answered'
          ? { success: true, status: 'succeeded' as const, output: resume.output ?? '', durationMs: 0 }
          : { success: false, status: 'interrupted' as const, output: '用户拒绝此操作，未执行', durationMs: 0 }
      // A claimed approval cannot become a second pending approval for this ID.
      const settled = yield* this.settleTool(item, result.needsConfirmation
        ? { ...result, needsConfirmation: false, status: 'failed', success: false, output: '审批后策略仍未允许执行：' + result.output }
        : result, ctx)
      if (settled.failedToPersist) throw new Error('Approved tool result could not be persisted; execution will not be repeated automatically')
      if (ctx.signal?.aborted) return
    }

    // Build tool list from registry
    const toolList = ctx.tools.list()

    /** Names of tools actually called in the last iteration */
    let lastUsedToolNames: Set<string> = new Set()
    // ── Token 跨轮次累加（用于匹配 DeepSeek 官网统计） ────────────────────────
    let cumulativePromptTokens = 0
    let cumulativeCompletionTokens = 0
    let cumulativeCacheHitTokens: number | undefined = undefined
    let cumulativeCacheMissTokens: number | undefined = undefined
    let cumulativeReasoningTokens: number | undefined = undefined
    let cumulativeSystemPromptTokens = 0
    let cumulativeSystemToolsTokens = 0
    let cumulativeSkillTokens = 0
    let cumulativeRagTokens = 0
    let cumulativeBuiltinToolsTokens = 0
    let cumulativeMcpToolsTokens = 0
    let cumulativeUserInputTokens = 0
    let cumulativeMessagesTokens = 0
    let cumulativeToolResultsTokensTotal = 0

    let askUserCount = 0
    try {
      const messages = pairToolHistory(await ctx.history.getHistory(ctx))
      let lastUserIndex = -1
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') {
          lastUserIndex = i
          break
        }
      }
      const recentMessages = lastUserIndex >= 0 ? messages.slice(lastUserIndex) : messages
      askUserCount = recentMessages.filter((m: Message) => m.role === 'tool' && m.toolName === 'ask_user').length
    } catch (err) {
      ctx.logger.warn({ err }, 'Failed to count ask_user occurrences')
    }

    const toolProgress = new ToolProgressTracker()

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      // ── 每轮迭代开始时检查 abort signal，确保用户中止能及时生效 ──────────────
      // 之前只在 LLM 调用时检查，导致工具执行/历史压缩等阶段无法被中断。
      if (ctx.signal?.aborted) {
        ctx.logger.info({ iteration }, 'Agent loop aborted at iteration boundary')
        await ctx.runObserver?.onOutcome?.({ status: 'cancelled', stopReason: 'cancelled', partialOutput: emittedOutput || undefined })
        return
      }

      // 1. 先检查是否需要压缩（用 raw token count，不受 window 限制）
      // 阈值对齐 Claude Code auto-compact：有效窗口的 ~92% 触发（COMPRESS_THRESHOLD_RATIO=0.92）。
      // 有效窗口取 min(tokenBudget, 模型真实 contextWindow)：tokenBudget 经 OSM 倍率放大后
      // 可能远超模型实际上限，若直接用它做阈值，模型都拒答了压缩还没触发。
      let messages = await readModelHistory()
      let effectiveTools = toolList.filter(tool => tool.name !== 'ask_user' || askUserCount < maxAskUserCount)
      const configuredCompressRatio = getOSMCompressRatio(
        parseFloat(process.env.COMPRESS_THRESHOLD_RATIO ?? '0.92'))
      // A malformed or >100% runtime setting must not disable pre-request
      // compaction and allow the hard model window to be reached first.
      const compressRatio = Number.isFinite(configuredCompressRatio) && configuredCompressRatio > 0
        ? Math.min(configuredCompressRatio, 0.95) : 0.92
      // 有效上限 = 已知预算与模型窗口中的较小者；两者都未知才不设上限。
      // 窗口这一侧必须保留：装不下的请求要在本地拒发（而不是静默丢掉存储的强制
      // 约束，或明知会被服务端拒还硬发一次）。真正要消除的是**被人为推导出来的
      // 预算**压低下限 —— 历史上 env 缺省 60000 经 balanced 倍率 2 得到 120000，
      // 比模型 128k 窗口还小 8k，于是引擎比模型更早拒答
      // （"Request input (112210) plus output reservation (8192) exceeds context window
      // (120000)"）。该默认值已在 agent-context/factory.ts 移除，这里不再引入新的推导预算。
      const effectiveBudget = unboundedCode
        ? (ctx.modelCaps?.contextWindow ?? Number.POSITIVE_INFINITY)
        : Math.min(
          typeof ctx.tokenBudget === 'number' ? ctx.tokenBudget : Number.POSITIVE_INFINITY,
          ctx.modelCaps?.contextWindow ?? Number.POSITIVE_INFINITY)
      // Code mode derives its dispatch cap from the remaining context later,
      // instead of stopping at the old fixed 8192-token output cap.
      let maxOutputTokens = unboundedCode
        ? undefined
        : this.options.maxOutputTokens ?? Math.min(8192, Math.max(256, Math.floor(effectiveBudget / 4)))
      // Admission headroom triggers compaction early; the actual Code output
      // allowance is all context capacity left after the admitted input.
      const outputReservation = maxOutputTokens ?? (Number.isFinite(effectiveBudget)
        ? Math.min(8192, Math.max(256, Math.floor(effectiveBudget * 0.05))) : 0)
      const fixedInputTokens = estimateRequestInput(messages.filter(message => message.role === 'system'
        && !(ctx.history.retainsArchive && message.metadata?.isCompactSummary)), this.options.systemPrompt, effectiveTools)
      if ((!unboundedCode && (!Number.isFinite(maxOutputTokens) || maxOutputTokens! <= 0))
        || (Number.isFinite(effectiveBudget) && fixedInputTokens + outputReservation > effectiveBudget)) {
        await ctx.runObserver?.onOutcome?.({ status: 'failed', stopReason: 'context_limit',
          partialOutput: emittedOutput || undefined,
          error: { code: 'CONTEXT_LIMIT', message: 'System instructions, tools and output reservation exceed the context window', retryable: false } })
        yield '\n\n[Response truncated: token budget exceeded]'
        return
      }
      // 压缩基准与有效上限同源（预算与窗口的较小者）；两者都没有时不触发压缩
      // （既无窗口也无预算时无从判断何时该压缩，交给服务端错误反馈）。
      const compressThreshold = Math.floor(effectiveBudget * compressRatio)
      let rawTokens = estimateRequestInput(messages, this.options.systemPrompt, effectiveTools) + outputReservation
      if (rawTokens > compressThreshold && typeof ctx.history.microCompactToolResults === 'function') {
        // 先做 micro-compact：清理旧工具结果（不调 LLM），省下的空间可能足以
        // 避免全量压缩——对齐 Claude Code「先轻量清理再考虑总结」的分级策略。
        try {
          const microOutputLimit = ctx.toolProfile === 'code' ? getCodeToolOutputMaxChars() : getToolOutputMaxChars()
          const micro = await ctx.history.microCompactToolResults(ctx, { keepRecent: 10, maxChars: microOutputLimit })
          if (micro.cleared > 0) {
            messages = await readModelHistory()
            rawTokens = estimateRequestInput(messages, this.options.systemPrompt, effectiveTools) + outputReservation
            ctx.logger.info({ ...micro, rawTokens }, 'Micro-compact done')
          }
        } catch (err: any) {
          ctx.logger.warn({ err: err?.message }, 'Micro-compact failed, continuing')
        }
      }
      for (let compressionPass = 0; compressionPass < 4 && rawTokens > compressThreshold
        && typeof ctx.history.compress === 'function'
        && (!ctx.requestBudget || ctx.requestBudget.canAfford(rawTokens * 3 + 16_384)); compressionPass++) {
        ctx.logger.info({ rawTokens, threshold: compressThreshold }, 'Compressing conversation history')
        const { buildCompactSummarizeFn } = await import('./compact-prompt.js')
        // 专职模型路由：配置了 LLM_SUMMARIZE_MODEL 时用轻量模型做总结，
        // 否则退回主模型（压缩发生在循环内，失败不可阻断对话）
        let summarizeLlm: LLMAdapter = this.llm
        if (process.env.LLM_SUMMARIZE_MODEL) {
          try {
            const { createLLMAdapterWithDbConfig } = await import('../llm-adapter/index.js')
            summarizeLlm = await createLLMAdapterWithDbConfig({ model: process.env.LLM_SUMMARIZE_MODEL })
          } catch (err: any) {
            ctx.logger.warn({ err: err?.message }, 'Summarize model unavailable, falling back to main model')
          }
        }
        try {
          const summarizeWindow = resolveCapabilities({ model: summarizeLlm.model, provider: summarizeLlm.provider }).contextWindow
          const summarize = buildCompactSummarizeFn(summarizeLlm, { signal: ctx.signal, onRequestAttempt: ctx.onRequestAttempt,
            contextWindow: Math.min(effectiveBudget, summarizeWindow ?? Infinity), maxOutputTokens: unboundedCode ? undefined : Math.min(4096, maxOutputTokens!),
            archiveAvailable: ctx.history.retainsArchive === true })
          const beforeCompression = rawTokens
          // Retained exchanges must fit alongside system/tool overhead and the
          // summary itself. Reduce retention on a second pass if the first
          // reduction still leaves an inadmissible request.
          const keepRecentTokens = Math.floor(Math.min(effectiveBudget * 0.2,
            Math.max(0, compressThreshold - fixedInputTokens - outputReservation - 8192)) / 2 ** compressionPass)
          const stats = await ctx.history.compress(
            ctx,
            summarize,
            { keepRecentTokens, force: true },
          )
          const compressedMessages = await readModelHistory()
          const compressedRequestTokens = estimateRequestInput(compressedMessages, this.options.systemPrompt, effectiveTools) + outputReservation
          ctx.logger.info({ preTokens: stats.preTokens, postTokens: stats.postTokens,
            preRequestTokens: rawTokens, postRequestTokens: compressedRequestTokens, compressionPass }, 'Compression done')
          rawTokens = compressedRequestTokens
          if (rawTokens >= beforeCompression) break
        } catch (err: any) {
          ctx.logger.error({ err: err?.message, rawTokens }, 'Compression failed; checking the complete request before dispatch')
          break
        }
      }

      // Read again after compaction without silently windowing away constraints.
      messages = await readModelHistory()

      // 3. 计算 windowed token count，检查是否超 budget。
      // 使用 1.1 的系数作为安全余量，防止本地估算与 API 实际计量的偏差。
      const historyTokens = messages.reduce((sum, m) => sum + (m.tokens ?? estimateTokens(m.content)), 0)
      const conservativeHistoryTokens = Math.ceil(historyTokens * 1.1)

      if (!unboundedCode && typeof ctx.tokenBudget === 'number' && conservativeHistoryTokens >= ctx.tokenBudget) {
        ctx.logger.warn({ historyTokens, conservativeHistoryTokens, tokenBudget: ctx.tokenBudget }, 'Token budget exhausted')
        await ctx.runObserver?.onOutcome?.({ status: 'failed', stopReason: 'context_limit', partialOutput: emittedOutput || undefined,
          error: { retryable: false, code: 'CONTEXT_LIMIT', message: 'Context window exceeded' } })
        yield '\n\n[Response truncated: token budget exceeded]'
        return
      }

      let finalizationReason: 'budget' | 'max_steps' | undefined
      let systemPrompt = this.options.systemPrompt
      let requestInputTokenEstimate = estimateRequestInput(messages, systemPrompt, effectiveTools)
      // One more exploration request must leave enough for a summary, including likely tool-result growth.
      const summaryReserve = unboundedCode ? 0 : estimateRequestInput(messages, systemPrompt, []) + 4096 + 8192
      ctx.finalizationReserveTokens = unboundedCode ? 0 : summaryReserve + 8192
      if (!unboundedCode && ctx.requestBudget && !ctx.requestBudget.canAfford(requestInputTokenEstimate + maxOutputTokens! + summaryReserve)) {
        finalizationReason = 'budget'
      } else if (this.options.finalizeOnLimit && iteration > 0 && iteration === maxIterations - 1) {
        finalizationReason = 'max_steps'
      }
      const finalizationNotice = finalizationReason === 'budget'
        ? '已接近本次任务的引擎本地累计用量上限，停止探索并交回已有证据；尚未完成全部核实。'
        : '已达到本次子任务的探索步数上限，停止探索并交回已有证据；尚未完成全部核实。'
      const recordedEvidence = finalizationReason ? partialEvidence(messages) : ''
      if (finalizationReason) {
        effectiveTools = []
        systemPrompt = [systemPrompt, FINALIZATION_PROMPT].filter(Boolean).join('\n\n')
        if (!unboundedCode) maxOutputTokens = Math.min(maxOutputTokens!, 4096)
        requestInputTokenEstimate = estimateRequestInput(messages, systemPrompt, [])
        if (!unboundedCode && ctx.requestBudget && !ctx.requestBudget.canAfford(requestInputTokenEstimate + maxOutputTokens!)) {
          messages = [...messages.filter(message => message.role === 'system'), ...finalizationMessages(messages)]
          requestInputTokenEstimate = estimateRequestInput(messages, systemPrompt, [])
        }
        if (!unboundedCode && ctx.requestBudget && !ctx.requestBudget.canAfford(requestInputTokenEstimate + maxOutputTokens!)) {
          const evidence = emittedOutput || recordedEvidence
          await ctx.runObserver?.onOutcome?.({ status: 'failed', stopReason: 'budget', partialOutput: evidence,
            error: { code: 'TOKEN_BUDGET_EXCEEDED', message: finalizationNotice, retryable: false } })
          yield '\n\n' + finalizationNotice + '\n\n' + (emittedOutput ? '' : evidence)
          return
        }
        yield '\n\n' + finalizationNotice + '\n\n'
      }

      const finalOutputReservation = unboundedCode ? outputReservation : (maxOutputTokens ?? 0)
      const exceedsContext = Number.isFinite(effectiveBudget)
        && requestInputTokenEstimate + finalOutputReservation > effectiveBudget
      if (exceedsContext) {
        await ctx.runObserver?.onOutcome?.({ status: 'failed', stopReason: 'context_limit',
          partialOutput: emittedOutput || undefined,
          error: { code: 'CONTEXT_LIMIT', message: `Request input (${requestInputTokenEstimate}) plus output reservation (${finalOutputReservation}) exceeds context window (${effectiveBudget})`, retryable: false } })
        yield '\n\n[Response truncated: token budget exceeded]'
        return
      }

      // A configured context window bounds input plus completion (including
      // reasoning). Code mode gets all remaining capacity instead of a fixed
      // output cap; omitting this field would let compatible gateways use
      // their 262K/393K protocol maxima despite a configured 100K window.
      const dispatchMaxOutputTokens = unboundedCode && Number.isFinite(effectiveBudget)
        ? Math.max(1, Math.floor(effectiveBudget - requestInputTokenEstimate)) : maxOutputTokens

      ctx.logger.debug({ iteration, toolCount: effectiveTools.length, finalizationReason }, 'Preparing model request')

      const llmOptions: LLMAdapterOptions = {
        model: this.llm.model,
        maxTokens: dispatchMaxOutputTokens,
        unboundedOutput: unboundedCode,
        contextWindow: Number.isFinite(effectiveBudget) ? effectiveBudget : undefined,
        requestInputTokenEstimate,
        onRequestAttempt: ctx.onRequestAttempt,
        systemPrompt,
        temperature: this.options.temperature,
        thinkingEnabled: this.options.thinkingEnabled,
        // Finalization must retain an explicit Off instead of restoring provider defaults.
        thinkingConfig: finalizationReason && !isThinkingDisabled(this.options) ? undefined : this.options.thinkingConfig,
        responseThinkingField: this.options.responseThinkingField,
        reasoningEffort: this.options.reasoningEffort,
        tools: effectiveTools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
          execute: async (_args: unknown, _ctx: AgentContext) => ({ success: true as const, output: '' }),
        })),
      }

      ctx.logger.debug({ iteration, messageCount: messages.length }, 'ReAct iteration')

      let response: any = {
        content: '',
        reasoningContent: '',
        toolCalls: [],
        promptTokens: 0,
        completionTokens: 0,
        finishReason: 'stop',
        model: this.llm.model,
        contextWindow: llmOptions.contextWindow,
      }

      let partialOutput = emittedOutput
      let partialSaved = false
      let streamCompleted = false
      let streamChunkCount = 0
      let receivedTerminalChunk = false
      let failureReason = 'incomplete'
      let promptUsageReported = false
      let completionUsageReported = false
      const toolCallsMap = new Map<number, { id?: string; name?: string; args: string; started: boolean }>()
      const invocationPromptTokens = () => promptUsageReported ? response.promptTokens : requestInputTokenEstimate
      const invocationCompletionTokens = () => completionUsageReported ? response.completionTokens
        : estimateTokens(response.content + response.reasoningContent
          + (toolCallsMap.size ? JSON.stringify([...toolCallsMap.values()].map(({ id, name, args }) => ({ id, name, args }))) : ''))
      const contextSnapshot = () => ({ currentPromptTokens: invocationPromptTokens(), contextWindow: response.contextWindow,
        modelId: response.model, contextUsageEstimated: !promptUsageReported,
        // Compatible gateways can correct message-start input/cache counters
        // at the terminal chunk. Retain the sample without claiming finality.
        contextUsageProvisional: promptUsageReported && !receivedTerminalChunk, requestInputTokenEstimate })
      let publishedContext: string | undefined
      const changedContextFrame = () => {
        const snapshot = JSON.stringify(contextSnapshot())
        if (snapshot === publishedContext) return undefined
        publishedContext = snapshot
        return '\x00__usage__' + snapshot
      }
      const persistPartial = async (status: 'failed' | 'cancelled', stopReason: string,
        responseDiagnostics?: Record<string, string | number | boolean>) => {
        if (partialSaved || (!response.content && !response.reasoningContent && !responseDiagnostics
          && !promptUsageReported && !completionUsageReported && !toolCallsMap.size)) return
        const messageId = ctx.assistantMessageId ?? uuidv4()
        const promptTokens = invocationPromptTokens()
        const completionTokens = invocationCompletionTokens()
        await ctx.history.append({ id: messageId, role: 'assistant', content: response.content,
          reasoningContent: response.reasoningContent, modelId: response.model, createdAt: Date.now(),
          tokens: completionTokens, conversationId,
          usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens,
            currentPromptTokens: promptTokens, ...(response.contextWindow ? { contextWindow: response.contextWindow } : {}),
            ...(response.cacheHitTokens != null ? { cacheHitTokens: response.cacheHitTokens } : {}),
            ...(response.cacheMissTokens != null ? { cacheMissTokens: response.cacheMissTokens } : {}),
            ...(response.reasoningTokens != null ? { reasoningTokens: response.reasoningTokens } : {}) },
          metadata: { rootRunId: ctx.rootRunId, turnId: ctx.turnId, partial: true, status, stopReason,
            ...(responseDiagnostics ? { responseDiagnostics } : {}),
            contextUsageEstimated: !promptUsageReported,
            contextUsageProvisional: promptUsageReported && !receivedTerminalChunk, requestInputTokenEstimate,
            usageEstimated: !promptUsageReported || !completionUsageReported },
        } as Message, ctx)
        partialSaved = true
      }
      try {
        // Context occupancy is useful while the provider is still thinking.
        // Publish this admitted request's estimate without charging unfinished
        // input/output; provider input corrects it as soon as it is available.
        yield changedContextFrame()!
        const stream = this.llm.stream(messages, {
          ...llmOptions,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        } as LLMAdapterOptions & { signal?: AbortSignal })

        for await (const chunk of stream) {
          if (ctx.signal?.aborted) throw Object.assign(new Error('Model request cancelled'), { name: 'AbortError' })
          streamChunkCount++
          receivedTerminalChunk ||= chunk.done === true
          // Providers may report usage/model before their final chunk (or fail afterwards).
          for (const key of ['promptTokens', 'completionTokens', 'cacheHitTokens', 'cacheMissTokens', 'reasoningTokens'] as const) {
            const value = chunk[key]
            if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
              response[key] = value
              if (key === 'promptTokens') promptUsageReported = true
              if (key === 'completionTokens') completionUsageReported = true
            }
          }
          if (chunk.model && chunk.model !== response.reportedModel) {
            response.model = response.reportedModel = chunk.model
          }
          if (chunk.finishReason) response.finishReason = chunk.finishReason
          if (typeof chunk.contextWindow === 'number' && Number.isFinite(chunk.contextWindow) && chunk.contextWindow > 0) response.contextWindow = chunk.contextWindow
          const contextFrame = changedContextFrame()
          if (contextFrame) yield contextFrame
          if (chunk.content) {
            response.content += chunk.content
            emittedOutput += chunk.content
            partialOutput = emittedOutput
            yield chunk.content
            await ctx.runObserver?.onOutput?.(emittedOutput)
          }
          if (chunk.reasoningContent) {
            response.reasoningContent += chunk.reasoningContent
            yield `\x00__thinking__${chunk.reasoningContent}`
          }
          if (chunk.toolCalls) {
            for (const tc of chunk.toolCalls) {
              const idx = (tc as any).index ?? 0
              let existing = toolCallsMap.get(idx)
              if (!existing) {
                existing = { args: '', started: false }
                toolCallsMap.set(idx, existing)
              }
              if (tc.id) existing.id = tc.id
              if (tc.name) existing.name = tc.name
              if (tc.args) existing.args += tc.args
              
              if (!finalizationReason && !existing.started && existing.id && existing.name) {
                existing.started = true
                yield `\x00__tool_start__${JSON.stringify({ name: existing.name, toolCallId: existing.id })}`
              }
              
              if (!finalizationReason && tc.args && existing.id) {
                yield `\x00__tool_args__${JSON.stringify({ toolCallId: existing.id, args: tc.args })}`
              }
            }
          }
        }
        if (ctx.signal?.aborted) throw Object.assign(new Error('Model request cancelled'), { name: 'AbortError' })

        // Convert toolCallsMap back to response.toolCalls
         response.toolCalls = Array.from(toolCallsMap.values()).map((tc: any) => {
           let parsedArgs = {}
           let parseError: string | undefined
           try {
             parsedArgs = JSON.parse(repairJson(tc.args || '{}'))
           } catch (e) {
             ctx.logger.error({ err: e, args: tc.args }, 'Failed to parse tool arguments')
             parseError = e instanceof Error ? e.message : String(e)
           }
           return {
             id: tc.id || `call_${uuidv4()}`,
             name: tc.name || '',
             args: parsedArgs,
             _rawArgs: tc.args,
             _parseError: parseError,
           }
         })
        
        if (response.toolCalls.length > 0 && response.finishReason !== 'length' && response.finishReason !== 'error') {
          response.finishReason = 'tool_calls'
        }
        streamCompleted = true
      } catch (err: any) {
        failureReason = err.name === 'AbortError' || ctx.signal?.aborted ? 'cancelled'
          : err?.code === 'TOKEN_BUDGET_EXCEEDED' ? 'budget' : 'provider_error'
        await persistPartial(failureReason === 'cancelled' ? 'cancelled' : 'failed', failureReason)
        if (partialSaved) yield `\x00__usage__${JSON.stringify({
          promptTokens: cumulativePromptTokens + invocationPromptTokens(),
          completionTokens: cumulativeCompletionTokens + invocationCompletionTokens(),
          totalTokens: cumulativePromptTokens + cumulativeCompletionTokens + invocationPromptTokens() + invocationCompletionTokens(),
          // The interrupted call is already durable. Keep every reported
          // billing detail at that same watermark, rather than retaining the
          // preceding call's cache/reasoning counters in the live projection.
          ...(cumulativeCacheHitTokens !== undefined || response.cacheHitTokens !== undefined
            ? { cacheHitTokens: (cumulativeCacheHitTokens ?? 0) + (response.cacheHitTokens ?? 0) } : {}),
          ...(cumulativeCacheMissTokens !== undefined || response.cacheMissTokens !== undefined
            ? { cacheMissTokens: (cumulativeCacheMissTokens ?? 0) + (response.cacheMissTokens ?? 0) } : {}),
          ...(cumulativeReasoningTokens !== undefined || response.reasoningTokens !== undefined
            ? { reasoningTokens: (cumulativeReasoningTokens ?? 0) + (response.reasoningTokens ?? 0) } : {}),
          ...contextSnapshot() })}`
        const announced = [...toolCallsMap.values()].filter(call => call.started && call.id && call.name)
          .map(call => ({ id: call.id!, name: call.name!, args: {}, _rawArgs: call.args }))
        yield* this.settleUnstarted(announced, ctx, 'Model request ended before this tool could execute')
        if (err.name === 'AbortError' || ctx.signal?.aborted) {
          ctx.logger.info('LLM call aborted')
          await ctx.runObserver?.onOutcome?.({ status: 'cancelled', stopReason: 'cancelled', partialOutput })
          return
        }
        if (err?.code === 'TOKEN_BUDGET_EXCEEDED') {
          const evidence = partialOutput || recordedEvidence || partialEvidence(messages)
          const message = err instanceof Error ? err.message : '本次任务的引擎本地累计用量额度不足。'
          await ctx.runObserver?.onOutcome?.({ status: 'failed', stopReason: 'budget', partialOutput: evidence,
            error: { code: 'TOKEN_BUDGET_EXCEEDED', message, retryable: false } })
          yield '\n\n' + message + (partialOutput ? '' : '\n\n' + evidence)
          return
        }
        ctx.logger.error({ err }, 'LLM call failed')
        await ctx.runObserver?.onOutcome?.({ status: 'failed', stopReason: err?.code === 'TOKEN_BUDGET_EXCEEDED' ? 'budget' : 'provider_error', partialOutput,
          error: { retryable: false, code: err?.code === 'TOKEN_BUDGET_EXCEEDED' ? 'TOKEN_BUDGET_EXCEEDED' : 'PROVIDER_ERROR', message: err instanceof Error ? err.message : String(err) } })
        yield `\n\n[Error: LLM call failed - ${err instanceof Error ? err.message : 'unknown error'}]`
        return
      } finally {
        // Generator cancellation can happen at any yielded delta, before the provider completes.
        if (!streamCompleted) await persistPartial(ctx.signal?.aborted ? 'cancelled' : 'failed', ctx.signal?.aborted ? 'cancelled' : failureReason)
      }

    // A provider may ignore the empty tool list. Never execute new work during the reserved summary.
    if (finalizationReason && response.toolCalls.length > 0) {
      const evidence = emittedOutput || recordedEvidence || partialEvidence(messages)
      await persistPartial('failed', finalizationReason)
      await ctx.runObserver?.onOutcome?.({ status: 'failed', stopReason: finalizationReason, partialOutput: evidence,
        error: { code: finalizationReason === 'budget' ? 'TOKEN_BUDGET_EXCEEDED' : 'MAX_STEPS', message: finalizationNotice, retryable: false } })
      if (!response.content && !emittedOutput) yield evidence
      return
    }

    // Context capacity is stable; physical request spend is enforced by onRequestAttempt.
    await ctx.runObserver?.onUsage?.({ invocationId: uuidv4(), promptTokens: invocationPromptTokens(),
      completionTokens: invocationCompletionTokens(), cacheHitTokens: response.cacheHitTokens,
      cacheMissTokens: response.cacheMissTokens, estimated: !promptUsageReported || !completionUsageReported })

    const bd = this.options.promptBreakdown ?? { systemPromptTokens: 0, systemToolsTokens: 0, skillTokens: 0, ragTokens: 0, builtinToolsTokens: 0, mcpToolsTokens: 0 }
    const completionTokens = invocationCompletionTokens()
    const usageEstimated = !promptUsageReported || !completionUsageReported

    // ── 真实 Token 统计 ──────────────────────────────────────────────
    // 优先使用 LLM API 返回的 promptTokens（真实计费值）。
    // 本地估算的 systemPromptTokens / systemToolsTokens / skillTokens 仅用于分项展示参考。
    // 实际发送给 LLM 的工具数 = effectiveTools.length，不是全量 registry。
    const effectiveToolDefsTokens = estimateTokens(
      effectiveTools.map(t => `${t.name}: ${t.description} ${JSON.stringify(t.parameters ?? {})}`).join('\n')
    )
    const builtinToolsTokensRaw = (bd as any).builtinToolsTokens ?? 0
    const mcpToolsTokensRaw = (bd as any).mcpToolsTokens ?? 0
    const configuredToolDefsTokens = builtinToolsTokensRaw + mcpToolsTokensRaw
    // Only definitions still sent in this invocation occupy its context.
    const effectiveBuiltin = configuredToolDefsTokens > 0
      ? Math.round(effectiveToolDefsTokens * builtinToolsTokensRaw / configuredToolDefsTokens) : effectiveToolDefsTokens
    const effectiveMcp = effectiveToolDefsTokens - effectiveBuiltin
    const currentToolResultsTokens = messages.filter(message => message.role === 'tool')
      .reduce((total, message) => total + estimateModelMessageTokens(message), 0)
    const requestMessagesTokens = estimateModelHistoryTokens(messages)
    // History already includes tool results. Never add earlier, archived results
    // a second time, especially after compaction has removed them from input.
    const localEstimate = bd.systemPromptTokens + effectiveBuiltin + effectiveMcp + bd.skillTokens
      + ((bd as any).ragTokens ?? 0) + requestMessagesTokens
    const promptTokens = invocationPromptTokens()

    const lastUserMsg = [...messages].reverse().find(message => message.role === 'user')
    const userInputTokens = lastUserMsg ? estimateModelMessageTokens(lastUserMsg) : 0
    const rawMessagesTokens = Math.max(0, requestMessagesTokens - userInputTokens - currentToolResultsTokens)

    // ── 基于真实 Token 消耗推算倍率 ──────────────────────────────
    let finalSystemPromptTokens = bd.systemPromptTokens
    let finalSystemToolsTokens = effectiveBuiltin + effectiveMcp
    let finalSkillTokens = bd.skillTokens
    let finalRagTokens = (bd as any).ragTokens ?? 0
    let finalBuiltinToolsTokens = effectiveBuiltin
    let finalMcpToolsTokens = effectiveMcp
    let finalToolResultsTokens = currentToolResultsTokens
    let finalUserInputTokens = userInputTokens
    let finalMessagesTokens = rawMessagesTokens

    if (localEstimate > 0) {
      // Cached input still occupies context. Scale disjoint request components
      // against the full provider count (or the dispatch estimate if absent).
      const ratio = promptTokens / localEstimate
      finalSystemPromptTokens = Math.floor(bd.systemPromptTokens * ratio)
      
      // 如果工具消耗为 0，避免出现 0 / 0 = NaN 的情况
      if (effectiveBuiltin + effectiveMcp > 0) {
        finalSystemToolsTokens = Math.floor((effectiveBuiltin + effectiveMcp) * ratio)
        const builtinRatio = effectiveBuiltin / (effectiveBuiltin + effectiveMcp)
        finalBuiltinToolsTokens = Math.round(finalSystemToolsTokens * builtinRatio)
        finalMcpToolsTokens = finalSystemToolsTokens - finalBuiltinToolsTokens
      } else {
        finalSystemToolsTokens = 0
        finalBuiltinToolsTokens = 0
        finalMcpToolsTokens = 0
      }

      finalSkillTokens = Math.floor(bd.skillTokens * ratio)
      finalRagTokens = Math.floor(((bd as any).ragTokens ?? 0) * ratio)
      
      finalToolResultsTokens = Math.floor(currentToolResultsTokens * ratio)
      finalUserInputTokens = Math.floor(userInputTokens * ratio)
      
      // Floor each component, then put the rounding remainder in history so
      // even very small counts add up exactly to the request's prompt tokens.
      finalMessagesTokens = Math.max(0, promptTokens - finalSystemPromptTokens - finalSystemToolsTokens - finalSkillTokens - finalRagTokens - finalToolResultsTokens - finalUserInputTokens)
    } else if (promptTokens) {
      // 极端情况：localEstimate 为 0 但有 apiPromptTokens，全算作历史消息
      finalMessagesTokens = promptTokens
    }

    const currentUsage: TokenUsage = {
      currentPromptTokens: promptTokens,
      contextWindow: response.contextWindow,
      systemPromptTokens: finalSystemPromptTokens,
      systemToolsTokens: finalSystemToolsTokens,
      skillTokens: finalSkillTokens,
      messagesTokens: finalMessagesTokens,
      userInputTokens: finalUserInputTokens,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      ragTokens: finalRagTokens,
      builtinToolsTokens: finalBuiltinToolsTokens,
      mcpToolsTokens: finalMcpToolsTokens,
      toolResultsTokens: finalToolResultsTokens,
      // ── DeepSeek 专有：本轮增量值 ─────────────────────────────────
      ...(response.cacheHitTokens != null ? { cacheHitTokens: response.cacheHitTokens } : {}),
      ...(response.cacheMissTokens != null ? { cacheMissTokens: response.cacheMissTokens } : {}),
      ...(response.reasoningTokens != null ? { reasoningTokens: response.reasoningTokens } : {}),
    }

    // ── 跨轮次累加统计（用于实时 __usage__ 帧，向用户展示当前请求的总消耗） ──────────
    // 注意：为了与模型供应商的计费（Billing）保持一致，我们将每一轮迭代的输入和输出 Token 进行累加。
    // 虽然每一轮的 promptTokens 都包含了前几轮的历史，但供应商是对每一次 API 调用单独计费的。
    cumulativePromptTokens += promptTokens
    cumulativeCompletionTokens += completionTokens
    
    // 累加各项基数（基于本轮推算的分项值）
    // 每一轮的 promptTokens 包含了系统提示词、工具定义、历史消息、当前提问以及本轮之前所有的工具结果。
    // 我们将每一轮的这些分项“计费值”累加起来，最终的总和将严格等于 cumulativePromptTokens。
    cumulativeSystemPromptTokens += finalSystemPromptTokens
    cumulativeSystemToolsTokens += finalSystemToolsTokens
    cumulativeSkillTokens += finalSkillTokens
    cumulativeRagTokens += finalRagTokens
    cumulativeBuiltinToolsTokens += finalBuiltinToolsTokens
    cumulativeMcpToolsTokens += finalMcpToolsTokens
    cumulativeUserInputTokens += finalUserInputTokens
    cumulativeMessagesTokens += finalMessagesTokens
    cumulativeToolResultsTokensTotal += finalToolResultsTokens

    // ── DeepSeek 专有：KV Cache 命中 / 推理 token 跨轮次累加 ─────────────
    // 在多轮迭代中，如果某次 API 调用返回了 cacheHitTokens 等字段，我们需要更新累积值。
    // 与 promptTokens 类似，这些字段也是按轮次计费的，因此使用 += 累加。
    
    if (response.cacheHitTokens != null) {
      cumulativeCacheHitTokens = (cumulativeCacheHitTokens ?? 0) + response.cacheHitTokens
    }
    
    if (response.cacheMissTokens != null) {
      cumulativeCacheMissTokens = (cumulativeCacheMissTokens ?? 0) + response.cacheMissTokens
    }
    
    // reasoningTokens 是模型“思考”过程输出的 Token，属于真实的生成增量。
    // 只要当前响应有值，就必须用 += 累加到总和里。
    if (response.reasoningTokens != null) {
      cumulativeReasoningTokens = (cumulativeReasoningTokens ?? 0) + response.reasoningTokens
    }

    const cumulativeUsage: TokenUsage = {
      systemPromptTokens: cumulativeSystemPromptTokens,
      systemToolsTokens: cumulativeSystemToolsTokens,
      skillTokens: cumulativeSkillTokens,
      messagesTokens: cumulativeMessagesTokens,
      userInputTokens: cumulativeUserInputTokens,
      promptTokens: cumulativePromptTokens, // UI 展示多轮累加的输入消耗
      completionTokens: cumulativeCompletionTokens,
      totalTokens: cumulativePromptTokens + cumulativeCompletionTokens,
      ragTokens: cumulativeRagTokens,
      builtinToolsTokens: cumulativeBuiltinToolsTokens,
      mcpToolsTokens: cumulativeMcpToolsTokens,
      toolResultsTokens: cumulativeToolResultsTokensTotal,
      ...(cumulativeCacheHitTokens != null ? { cacheHitTokens: cumulativeCacheHitTokens } : {}),
      ...(cumulativeCacheMissTokens != null ? { cacheMissTokens: cumulativeCacheMissTokens } : {}),
      ...(cumulativeReasoningTokens != null ? { reasoningTokens: cumulativeReasoningTokens } : {}),
    }

      if (response.finishReason === 'length' && response.toolCalls.length === 0
        && !finalizationReason && iteration + 1 < maxIterations && String(response.content).trim()) {
        const fingerprint = createHash('sha256').update(String(response.content).trim().replace(/\s+/g, ' ')).digest('hex')
        if (!continuedResponseFingerprints.has(fingerprint)) {
          continuedResponseFingerprints.add(fingerprint)
          const messageId = uuidv4()
          await ctx.history.append({ id: messageId, role: 'assistant', content: response.content,
            reasoningContent: response.reasoningContent, createdAt: Date.now(), tokens: completionTokens,
            usage: currentUsage as unknown as Record<string, number>, modelId: response.model, conversationId,
            metadata: { rootRunId: ctx.rootRunId, turnId: ctx.turnId, outputContinuation: true,
              usageEstimated, contextUsageEstimated: !promptUsageReported,
              contextUsageProvisional: promptUsageReported && !receivedTerminalChunk, requestInputTokenEstimate,
              continuationIndex: continuedResponseFingerprints.size, stopReason: 'output_limit' },
          } as Message, ctx)
          outputContinuation = { messageId, suffix: String(response.content).slice(-2048) }
          yield `\x00__usage__${JSON.stringify({ ...cumulativeUsage, ...contextSnapshot() })}`
          ctx.logger.info({ iteration, messageId, continuationIndex: continuedResponseFingerprints.size }, 'Continuing model response after output limit')
          // Every continuation goes through normal admission, compaction,
          // physical request accounting and cancellation on the next iteration.
          continue
        }
        ctx.logger.warn({ iteration }, 'Output continuation repeated an unchanged segment')
      }
      if (response.finishReason === 'length' || response.finishReason === 'error') {
        await persistPartial('failed', response.finishReason === 'length' ? 'output_limit' : 'provider_error')
        yield `\x00__usage__${JSON.stringify({ ...cumulativeUsage, ...contextSnapshot() })}`
        yield* this.settleUnstarted(response.toolCalls ?? [], ctx, 'Model response ended before this tool could execute')
        await ctx.runObserver?.onOutcome?.({ status: 'failed', stopReason: response.finishReason === 'length' ? 'output_limit' : 'provider_error',
          partialOutput: emittedOutput, error: { code: response.finishReason === 'length' ? 'OUTPUT_LIMIT' : 'INCOMPLETE_RESPONSE', message: 'Model response ended before completion', retryable: false } })
        return
      }
      outputContinuation = undefined
      continuedResponseFingerprints.clear()
      // Register the complete batch before any invocation can start.
      if (response.toolCalls && response.toolCalls.length > 0) {
        const calls = response.toolCalls as ParsedToolCall[]
        lastUsedToolNames = new Set(calls.map(call => call.name))
        const registered: RegisteredToolCall[] = []
        try {
        for (let index = 0; index < calls.length; index++) {
          const call = calls[index]
          const messageId = uuidv4()
          registered.push({ call, messageId })
          await ctx.history.append({
            id: messageId, role: 'assistant', content: index === 0 ? response.content || '' : '',
            reasoningContent: index === 0 ? response.reasoningContent : undefined,
            toolCall: call, toolCallId: call.id, createdAt: Date.now(),
            tokens: index === 0 ? completionTokens : 0,
            usage: index === 0 ? currentUsage as unknown as Record<string, number> : undefined,
            modelId: response.model, conversationId,
            metadata: { rootRunId: ctx.rootRunId, turnId: ctx.turnId,
              ...(index === 0 ? { usageEstimated, contextUsageEstimated: !promptUsageReported,
                contextUsageProvisional: promptUsageReported && !receivedTerminalChunk, requestInputTokenEstimate } : {}) },
          } as Message, ctx)
          if (index === 0) yield `\x00__usage__${JSON.stringify({ ...cumulativeUsage,
            ...contextSnapshot(), conversationId: messageId })}`
          const frame = { name: call.name, toolName: call.name, args: call.args,
            toolCallId: call.id, messageId, rootRunId: ctx.rootRunId, turnId: ctx.turnId }
          yield `\x00__tool_start__${JSON.stringify(frame)}`
          yield `\x00__tool_call__${JSON.stringify(frame)}`
        }
        } catch (error) {
          for (const item of registered) yield* this.settleTool(item, {
            success: false, status: 'interrupted', output: '工具批次登记失败，未执行', durationMs: 0,
          }, ctx)
          yield* this.settleUnstarted(calls.slice(registered.length), ctx, '工具批次登记失败，未执行')
          throw error
        }

        const batch = await executeToolBatch(registered, ctx)
        let failedToPersist = false
        if (batch.pending) {
          try {
            // Persist before emitting a request users can answer.
            await ctx.onPending?.(batch.pending)
          } catch (error) {
            const index = registered.findIndex(item => item.call.id === batch.pending!.toolCallId)
            batch.results[index] = { success: false, status: 'failed', output: `等待请求保存失败: ${error instanceof Error ? error.message : String(error)}`,
              error: 'PENDING_PERSIST_FAILED', durationMs: 0 }
            batch.pending = undefined
            failedToPersist = true
          }
        }
        let blocked = false
        const settledFrames: string[] = []
        for (let index = 0; index < registered.length; index++) {
          const result = batch.results[index]
          const settlement = this.settleTool(registered[index], result, ctx)
          let step = await settlement.next()
          while (!step.done) {
            settledFrames.push(step.value)
            step = await settlement.next()
          }
          const settled = step.value
          failedToPersist ||= settled.failedToPersist
          blocked ||= Boolean(result.metadata?.blocked)
        }
        const globalConsecutiveFailures = toolProgress.observe(calls, batch.results)
        // The consumer may disconnect/return after any frame. All started tool
        // results must already be durable before yielding the first terminal card.
        for (const frame of settledFrames) yield frame
        if (failedToPersist) throw new Error('One or more tool results could not be persisted; all started tools have settled')
        if (ctx.signal?.aborted) {
          await ctx.runObserver?.onOutcome?.({ status: 'cancelled', stopReason: 'cancelled', partialOutput: emittedOutput || undefined })
          return
        }
        if (batch.pending) {
          const pending = batch.pending
          yield `\x00__ask_user__${JSON.stringify({ ...pending.args, question: pending.question,
            options: pending.options, toolCallId: pending.toolCallId, requestId: pending.requestId })}`
          yield `\x00__permission_request__${JSON.stringify({ ...pending, sessionId: ctx.sessionId,
            description: pending.question, rootRunId: ctx.rootRunId, turnId: ctx.turnId })}`
          await ctx.runObserver?.onOutcome?.({ status: 'blocked', stopReason: pending.kind === 'ask' ? 'needs_user' : 'permission',
            error: { retryable: false, code: pending.kind === 'ask' ? 'NEEDS_USER' : 'PERMISSION_REQUIRED', message: pending.question ?? 'User input required' } })
          return
        }
        if (ctx.runId && blocked) {
          await ctx.runObserver?.onOutcome?.({ status: 'blocked', stopReason: 'permission',
            error: { code: 'TOOL_NOT_ALLOWED', message: 'Tool execution was blocked', retryable: false } })
          return
        }
        if (globalConsecutiveFailures >= toolFailureLimit()) {
          await ctx.runObserver?.onOutcome?.({ status: 'failed', stopReason: 'repeated_failure',
            error: { retryable: false, code: 'REPEATED_FAILURE', message: 'Tool failure or repetition limit exceeded' } })
          yield '\n\n[Loop detected or tools failed repeatedly. Stopping to prevent token waste.]'
          return
        }
        continue
      }
      if (!String(response.content ?? '').trim()) {
        // Keep shape/usage evidence even for an entirely empty response. Raw provider
        // payloads can contain credentials or user content and must not enter diagnostics.
        const responseDiagnostics = {
          provider: this.llm.provider, modelId: String(response.model), finishReason: String(response.finishReason),
          chunkCount: streamChunkCount, terminalChunkReceived: receivedTerminalChunk,
          contentCharacters: String(response.content ?? '').length,
          reasoningCharacters: String(response.reasoningContent ?? '').length,
          promptTokens: Number(response.promptTokens), completionTokens: Number(response.completionTokens),
        }
        ctx.logger.warn({ rootRunId: ctx.rootRunId, sessionId: ctx.sessionId, ...responseDiagnostics }, 'Model response had no final answer')
        await persistPartial('failed', 'empty_output', responseDiagnostics)
        yield `\x00__usage__${JSON.stringify({ ...cumulativeUsage, ...contextSnapshot() })}`
        const message = response.reasoningContent?.trim()
          ? '模型仅返回了思考内容，未收到最终回答（EMPTY_OUTPUT）。请检查模型服务后重试。'
          : '未收到模型的最终回答或工具调用（EMPTY_OUTPUT）。模型服务可能返回了空内容，或响应未被正确解析；请检查模型服务后重试。'
        await ctx.runObserver?.onOutcome?.({ status: 'failed', stopReason: 'empty_output', partialOutput: emittedOutput || undefined,
          error: { code: 'EMPTY_OUTPUT', message, retryable: false } })
        return
      }
      // ── 最终回答 ──
      // 注意：response.content 和 response.reasoningContent 已经在上面的流式循环中通过 yield 输出过了
      // 此处只需持久化最终结果并发送 usage 帧即可。

      // Yield token usage breakdown as a special __usage__ frame (includes conversationId)
      const messageId = ctx.assistantMessageId ?? uuidv4()
      const finalMsg: Message & { conversationId?: string } = {
        id: messageId,
        role: 'assistant',
        content: finalizationReason ? finalizationNotice + '\n\n' + response.content : response.content || '',
        metadata: { rootRunId: ctx.rootRunId, turnId: ctx.turnId, usageEstimated, contextUsageEstimated: !promptUsageReported,
          contextUsageProvisional: promptUsageReported && !receivedTerminalChunk, requestInputTokenEstimate,
          ...(finalizationReason ? { partial: true, stopReason: finalizationReason } : {}) },
        reasoningContent: response.reasoningContent,
        createdAt: Date.now(),
        tokens: completionTokens, // 使用本轮增量生成数
        usage: currentUsage as unknown as Record<string, number>, // 存储本轮增量 Usage，防止 DB 统计累加
        modelId: response.model,
        ...(conversationId ? { conversationId } : {}),
      }
      await ctx.history.append(finalMsg, ctx)
      yield `\x00__assistant_msg_id__${messageId}`
      await ctx.runObserver?.onOutcome?.(ctx.signal?.aborted ? { status: 'cancelled', stopReason: 'cancelled' }
        : finalizationReason ? { status: 'failed', stopReason: finalizationReason, partialOutput: emittedOutput,
          error: { code: finalizationReason === 'budget' ? 'TOKEN_BUDGET_EXCEEDED' : 'MAX_STEPS', message: finalizationNotice, retryable: false } }
        : { status: 'succeeded', output: emittedOutput, stopReason: 'completed' })

      yield `\x00__usage__${JSON.stringify({
        ...cumulativeUsage,
        ...contextSnapshot(),
        conversationId: messageId,
      })}`
      return
    }

    // Max iterations exceeded
    ctx.logger.warn({ maxIterations }, 'Max iterations exceeded')
    await ctx.runObserver?.onOutcome?.({ status: 'failed', stopReason: 'max_steps', partialOutput: emittedOutput || undefined,
      error: { retryable: false, code: 'MAX_STEPS', message: 'Maximum iterations exceeded' } })
    yield `\n\n[Max iterations (${maxIterations}) exceeded. The task may be too complex.]`
  }
}
