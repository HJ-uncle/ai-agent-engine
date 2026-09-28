import type { LoopStrategy } from './strategy.js'
import type { AgentContext } from '../agent-context/index.js'
import type { LLMAdapter, LLMAdapterOptions } from '../llm-adapter/index.js'
import type { Message, ToolResult } from '../agent-context/index.js'
import { estimateTokens } from '../utils/tokens.js'
import { v4 as uuidv4 } from 'uuid'
import { applyOSMMultiplier, getOSMCompressRatio } from '../osm.js'
import { repairJson } from '../utils/json.js'
import { TodoStore } from '../../storage/todo/index.js'

/**
 * 截断过大的工具输出，避免历史消息膨胀。
 * 保留开头和结尾各 maxChars/2 的内容，中间用省略标记替代。
 * 对于 24/7 长期运行的 Agent 至关重要。
 *
 * ⚠️ 注意：以前这里用模块顶层 const 缓存 env，导致 process.env 或 superpower
 * 开关运行时变更无法生效。现改为每次调用时动态读取，保证 PUT /settings 热更新
 * 能立即生效（与 maxIterations / compressRatio 的动态读取策略对齐）。
 */
function getToolOutputMaxChars(): number {
  const base = parseInt(process.env.TOOL_OUTPUT_MAX_CHARS ?? '4000', 10)
  return applyOSMMultiplier('toolOutputMaxChars', base)
}

/**
 * 连续失败 / 重复调用的止损阈值。
 *
 * 旧值写死 20：意味着「同一个工具连续失败或重复调 20 轮」才刹车，
 * 中间 19 轮全在白白烧 token（转录里同一假设反复推演 4-5 遍就是这种浪费）。
 * 现改为可配（默认 8），并可用 MAX_CONSECUTIVE_FAILURES 热更新。
 */
function getMaxConsecutiveFailures(): number {
  const raw = parseInt(process.env.MAX_CONSECUTIVE_FAILURES ?? '', 10)
  if (Number.isFinite(raw) && raw > 0) return raw
  return 8
}

/**
 * 语义级重复检测：判断两次工具调用是否「实质相同」。
 *
 * 旧实现用 `name + JSON.stringify(args)` 全等比较，过于严格 —— 模型只要把
 * 参数换个写法（键顺序、空格）就绕过了检测。
 * 这里做归一化后再比：
 *   - 键排序后序列化，消除键顺序差异；
 *   - 字符串值仅保留前 200 字符，避免长文本（如整段代码）的微小差异
 *     把「实质相同的重复调用」判成不同。
 * 只比较工具名 + 归一化参数，不涉及语义模型，零额外成本。
 */
function fingerprintToolCall(tc: { name?: string; args?: unknown }): string {
  const args = tc?.args ?? {}
  let normalized: string
  try {
    const sortKeys = (val: unknown): unknown => {
      if (Array.isArray(val)) return val.map(sortKeys)
      if (val && typeof val === 'object') {
        const out: Record<string, unknown> = {}
        for (const k of Object.keys(val as Record<string, unknown>).sort()) {
          out[k] = sortKeys((val as Record<string, unknown>)[k])
        }
        return out
      }
      return val
    }
    normalized = JSON.stringify(sortKeys(args), (_k, v) =>
      typeof v === 'string' && v.length > 200 ? v.slice(0, 200) : v,
    )
  } catch {
    normalized = String(args)
  }
  return `${tc?.name ?? ''}:${normalized}`
}


/**
 * Truncate tool output that is too long.
 *
 * Special case: if the output is a JSON object that contains a `dataUrl` field
 * (smart_read / read_image image result), do NOT truncate at all.  Truncating
 * JSON mid-string corrupts the structure, causing JSON.parse to fail in the
 * LLM adapter — which then passes garbled base64 as plain text to the model,
 * leading to hallucination.  The base64 data is necessary for the adapter to
 * inject an image_url message part so the vision model can actually see the image.
 */
function truncateToolOutput(output: string, maxChars: number = getToolOutputMaxChars()): string {
  // Never truncate image JSON results — the adapter needs the full dataUrl intact.
  if (output.includes('"dataUrl"') || output.includes('"hasDataUrl"')) {
    try {
      const parsed = JSON.parse(output)
      if (parsed && typeof parsed === 'object' && (parsed.dataUrl || parsed.hasDataUrl)) {
        return output  // pass through unchanged
      }
    } catch {
      // Could not parse — fall through to normal truncation
    }
  }
  if (output.length <= maxChars) return output
  const half = Math.floor(maxChars / 2)
  const head = output.slice(0, half)
  const tail = output.slice(-half)
  const truncatedChars = output.length - maxChars
  return `${head}\n\n... [truncated ${truncatedChars} chars] ...\n\n${tail}`
}

/** 子代理输出末尾的执行元数据标记（subagent 工具附带，客户端专用，不进 LLM 历史） */
const SUBAGENT_META_MARKER = '__SUBAGENT_META__'

function stripSubagentMeta(output: string): string {
  const idx = output.lastIndexOf(SUBAGENT_META_MARKER)
  return idx === -1 ? output : output.slice(0, idx).trimEnd()
}

export interface TokenUsage {
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
  maxIterations?: number
  maxAskUserCount?: number
  systemPrompt?: string
  temperature?: number
  /** Unique ID for this conversation round (one chat request = one conversationId) */
  conversationId?: string
  /** Pre-computed token counts for the injected prompts (optional) */
  promptBreakdown?: Pick<TokenUsage, 'systemPromptTokens' | 'systemToolsTokens' | 'skillTokens' | 'ragTokens' | 'builtinToolsTokens' | 'mcpToolsTokens'>
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

export class ReActStrategy implements LoopStrategy {
  constructor(
    private readonly llm: LLMAdapter,
    private readonly options: ReActOptions = {},
  ) {}

  async *run(input: string | any[] | null, ctx: AgentContext): AsyncIterable<string> {
    // maxIterations 决策顺序（与 agent-context/factory.ts 的 tokenBudget 规则对齐）：
    //   1. this.options.maxIterations 显式传入 → 原样使用
    //      （调用方已经推导过了，例如 subagent-tool 的 maxSteps；不应再被
    //       superpower 倍率干预，否则会把子代理步数悄悄放大 4×）
    //   2. 未显式传入 → 读 env 默认值（50），再按 superpower 模式放大
    const hasExplicitIterations = typeof this.options.maxIterations === 'number'
    const baseMaxIterations = this.options.maxIterations ??
      parseInt(process.env.MAX_ITERATIONS ?? '50', 10)
    const maxIterations = hasExplicitIterations
      ? baseMaxIterations
      : applyOSMMultiplier('maxIterations', baseMaxIterations)

    const maxAskUserCount = this.options.maxAskUserCount ?? 5
    const conversationId = this.options.conversationId

    // Add user message to history only if input is provided
    // 优先使用 displayContent（原始前端格式，含 workspace_image）存入 DB，用于 UI 展示
    // LLM 收到的是处理后的 input（文本化的 prompt），两者分离
    const historyContent = (this.options.displayContent ?? input) as string | any[]
    if (input !== null && input !== '') {
      const userMessage: Message & { conversationId?: string } = {
        role: 'user',
        content: historyContent,
        createdAt: Date.now(),
        tokens: estimateTokens(historyContent),
        ...(conversationId ? { conversationId } : {}),
        metadata: this.options.metadata,
      }
      const savedUserMsgId = await ctx.history.append(userMessage, ctx)
      // ★ 把后端 message_id 回传给前端，前端用它做删除/重发的准确定位
      yield `\x00__user_msg_id__${savedUserMsgId}`
      // ★ 别名帧（新版协议，第三方项目 等下游消费 camelCase 命名；不影响旧消费者）
      yield `\x00__userMsgId__${savedUserMsgId}`
    }

    // ★ 会话待办初始帧：每轮开始时推送现有清单，客户端据此恢复任务托盘
    yield* yieldTodoFrame(ctx)

    // Build tool list from registry
    const toolList = ctx.tools.list()

    /** Names of tools actually called in the last iteration */
    let lastUsedToolNames: Set<string> = new Set()
    /** 记录迭代 0 的工具定义 token 数，后续迭代的 usage 展示统一使用此值 */
    let iter0ToolDefsTokens: number | null = null
    /** Cumulative token count of tool-call result messages across all iterations */
    let cumulativeToolResultsTokens = 0
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
      const messages = await ctx.history.getHistory(ctx)
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

    /** 记录连续失败次数，防止进入死循环。包含全局失败计数和重复调用检测。 */
    let globalConsecutiveFailures = 0
    /** 记录工具调用的指纹（name + args），用于检测重复调用 */
    let lastToolFingerprints: string[] = []

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      // ── 每轮迭代开始时检查 abort signal，确保用户中止能及时生效 ──────────────
      // 之前只在 LLM 调用时检查，导致工具执行/历史压缩等阶段无法被中断。
      if (ctx.signal?.aborted) {
        ctx.logger.info({ iteration }, 'Agent loop aborted at iteration boundary')
        return
      }

      // 1. 先检查是否需要压缩（用 raw token count，不受 window 限制）
      // 对 24/7 Agent，使用更激进的阈值（0.5）以尽早触发压缩
      // superpower 模式下阈值放宽到 0.7，留更多上下文空间
      const compressRatio = getOSMCompressRatio(
        parseFloat(process.env.COMPRESS_THRESHOLD_RATIO ?? '0.5'))
      const compressThreshold = Math.floor(ctx.tokenBudget * compressRatio)
      const rawTokens = await ctx.history.getRawTokenCount(ctx)
      if (rawTokens > compressThreshold) {
        ctx.logger.info({ rawTokens, threshold: compressThreshold }, 'Compressing conversation history')
        await ctx.history.compress(ctx, async (msgs) => {
          // 压缩历史记录时，只提取文本内容作为摘要输入，忽略图片等二进制数据
          const content = msgs
            .map((m) => {
              const tokens = m.tokens ?? estimateTokens(m.content)
              let text = ''
              if (typeof m.content === 'string') {
                // 如果是普通文本，超过 1000 tokens 则截断以节省摘要提示词空间
                text = tokens > 1000 ? m.content.slice(0, 500) + `... [truncated]` : m.content
              } else if (Array.isArray(m.content)) {
                // 如果是多模态数组，只提取文本部分进行摘要
                text = m.content
                  .filter((part: any) => part.type === 'text' && part.text)
                  .map((part: any) => part.text)
                  .join(' ')
                if (text.length > 500) text = text.slice(0, 500) + '... [truncated]'
              } else {
                text = '[Non-text content]'
              }
              return `${m.role}: ${text}`
            })
            .join('\n')
          const resp = await this.llm.complete(
            [
              {
                role: 'user',
                content: `Summarize this conversation concisely (max 500 words), preserving key context, decisions and facts:\n\n${content}`,
                createdAt: Date.now(),
              },
            ],
            { model: this.llm.model, temperature: 0.3 },
          )
          return resp.content
        })
      }

      // 2. 压缩后重新取 windowed messages（applyTokenWindow 加截断超大消息）
      let messages = await ctx.history.getHistory(ctx)

      // ★ 修复：当设置了 displayContent（前端原始格式）时，历史存的是 displayContent，
      //   但 LLM 需要看到处理后的 input（含 OCR/图片/文件内容）。
      //   此处在每一轮迭代中都将本轮 user 消息的 content 替换为真正的 LLM prompt，
      //   确保多轮工具调用后 LLM 依然能看到处理后的多模态/长文本内容。
      if (this.options.displayContent !== undefined && this.options.displayContent !== null && input) {
        const processedInput = input as string | any[]
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === 'user') {
            messages[i] = { ...messages[i], content: processedInput ?? messages[i].content }
            break
          }
        }
      }

      // 3. 计算 windowed token count，检查是否超 budget。
      // 使用 1.1 的系数作为安全余量，防止本地估算与 API 实际计量的偏差。
      const historyTokens = messages.reduce((sum, m) => sum + (m.tokens ?? estimateTokens(m.content)), 0)
      const conservativeHistoryTokens = Math.ceil(historyTokens * 1.1)

      if (conservativeHistoryTokens >= ctx.tokenBudget) {
        ctx.logger.warn({ historyTokens, conservativeHistoryTokens, tokenBudget: ctx.tokenBudget }, 'Token budget exhausted')
        yield '\n\n[Response truncated: token budget exceeded]'
        return
      }

      // ── 全量工具：每次都把所有已注册工具发给 LLM，不做截断 ─────────────────
      const effectiveTools = toolList.filter((t) => {
        if (t.name === 'ask_user' && askUserCount >= maxAskUserCount) return false
        return true
      })

      ctx.logger.debug({ iteration, toolCount: effectiveTools.length }, 'Sending all tools to LLM')

      const llmOptions: LLMAdapterOptions = {
        model: this.llm.model,
        systemPrompt: this.options.systemPrompt,
        temperature: this.options.temperature,
        thinkingConfig: this.options.thinkingConfig,
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
      }
      
      try {
        const stream = this.llm.stream(messages, {
          ...llmOptions,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        } as LLMAdapterOptions & { signal?: AbortSignal })

        const toolCallsMap = new Map<number, { id?: string; name?: string; args: string; started: boolean }>()

        let bufferedContent = ''
        for await (const chunk of stream) {
          if (chunk.content) {
            bufferedContent += chunk.content
            // 注意：我们暂时不 yield chunk.content，因为它可能是“思考过程”也可能是“最终回答”
            // 我们等到流结束，根据是否有 toolCalls 来决定将其作为 __thinking__ 还是普通文本。
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
              
              if (!existing.started && existing.id && existing.name) {
                existing.started = true
                yield `\x00__tool_start__${JSON.stringify({ name: existing.name, toolCallId: existing.id })}`
              }
              
              if (tc.args && existing.id) {
                yield `\x00__tool_args__${JSON.stringify({ toolCallId: existing.id, args: tc.args })}`
              }
            }
          }
          if (chunk.done) {
            response.promptTokens = chunk.promptTokens ?? response.promptTokens
            response.completionTokens = chunk.completionTokens ?? response.completionTokens
            response.cacheHitTokens = chunk.cacheHitTokens
            response.cacheMissTokens = chunk.cacheMissTokens
            response.reasoningTokens = chunk.reasoningTokens
            response.model = chunk.model
          }
        }

        response.content = bufferedContent
        
        // ── 决定 content 的归属 ──
        if (toolCallsMap.size > 0) {
          // 如果有工具调用，那么本轮产生的 content 应当视为“思考过程”
          if (response.content) {
            yield `\x00__thinking__${response.content}`
          }
        } else {
          // 如果没有工具调用，这就是最终回答，模拟流式输出以保持 UX
          if (response.content) {
            const chunkSize = 20
            for (let i = 0; i < response.content.length; i += chunkSize) {
              yield response.content.slice(i, i + chunkSize)
              await new Promise(resolve => setTimeout(resolve, 5))
            }
          }
        }

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
        
        if (response.toolCalls.length > 0) {
          response.finishReason = 'tool_calls'
        }
      } catch (err: any) {
        if (err.name === 'AbortError' || ctx.signal?.aborted) {
          ctx.logger.info('LLM call aborted')
          return
        }
        ctx.logger.error({ err }, 'LLM call failed')
        yield `\n\n[Error: LLM call failed - ${err instanceof Error ? err.message : 'unknown error'}]`
        return
      }

    // Update token budget — only subtract completion tokens to avoid double-counting
    // prompt tokens across iterations (history is already tracked via getTokenCount)
    ctx.tokenBudget -= response.completionTokens

    const bd = this.options.promptBreakdown ?? { systemPromptTokens: 0, systemToolsTokens: 0, skillTokens: 0, ragTokens: 0, builtinToolsTokens: 0, mcpToolsTokens: 0 }
    const completionTokens = response.completionTokens || estimateTokens(response.content || '')

    // ── 真实 Token 统计 ──────────────────────────────────────────────
    // 优先使用 LLM API 返回的 promptTokens（真实计费值）。
    // 本地估算的 systemPromptTokens / systemToolsTokens / skillTokens 仅用于分项展示参考。
    // 实际发送给 LLM 的工具数 = effectiveTools.length，不是全量 registry。
    const effectiveToolDefsTokens = estimateTokens(
      effectiveTools.map(t => `${t.name}: ${t.description} ${JSON.stringify(t.parameters ?? {})}`).join('\n')
    )
    // 记录迭代 0 的工具定义 token 数，后续迭代展示时统一使用此值
    // 避免工具裁剪导致最终回答的 systemToolsTokens 异常偏低（Bug fix）
    if (iter0ToolDefsTokens === null) {
      iter0ToolDefsTokens = effectiveToolDefsTokens
    }
    // 展示用的工具 token 数：始终使用迭代 0 的值，保证前端显示一致
    const displayToolDefsTokens = iter0ToolDefsTokens

    const apiPromptTokens = response.promptTokens  // LLM 返回的真实值（0 则降级用本地估算）
    // localEstimate 需要包含 toolResults / rag，保证降级路径与 API 路径分项一致
    const builtinToolsTokensRaw = (bd as any).builtinToolsTokens ?? 0
    const mcpToolsTokensRaw = (bd as any).mcpToolsTokens ?? 0
    
    // 如果上游没传细分或者细分和不等于总数，我们做个兼容兜底
    let effectiveBuiltin = builtinToolsTokensRaw
    let effectiveMcp = mcpToolsTokensRaw
    if (effectiveBuiltin + effectiveMcp === 0) {
      effectiveBuiltin = displayToolDefsTokens
      effectiveMcp = 0
    }

    const localEstimate = bd.systemPromptTokens + effectiveBuiltin + effectiveMcp + bd.skillTokens
      + ((bd as any).ragTokens ?? 0) + (cumulativeToolResultsTokens ?? 0) + historyTokens
    const promptTokens = apiPromptTokens || localEstimate

    // ── 计算当前提问 (User Message) 的 Token 数 ────────────────────────
    // 从 messages 数组中取出最后一条（即本次 User 消息）
    const lastUserMsg = messages[messages.length - 1]
    const userInputTokens = lastUserMsg?.role === 'user' ? estimateTokens(lastUserMsg.content) : 0
    // 注意：historyTokens 包含了 userInputTokens，但不包含工具调用的结果。
    // 因此，rawMessagesTokens = 历史总和 - 当前提问
    const rawMessagesTokens = Math.max(0, historyTokens - userInputTokens)

    // ── 基于真实 Token 消耗推算倍率 ──────────────────────────────
    let finalSystemPromptTokens = bd.systemPromptTokens
    let finalSystemToolsTokens = effectiveBuiltin + effectiveMcp
    let finalSkillTokens = bd.skillTokens
    let finalRagTokens = (bd as any).ragTokens ?? 0
    let finalBuiltinToolsTokens = effectiveBuiltin
    let finalMcpToolsTokens = effectiveMcp
    let finalToolResultsTokens = cumulativeToolResultsTokens ?? 0
    let finalUserInputTokens = userInputTokens
    let finalMessagesTokens = rawMessagesTokens

    if (apiPromptTokens && localEstimate > 0) {
      // 真实总数中如果包含 cacheHitTokens，我们需要把它减去，
      // 因为 cacheHitTokens 通常代表已经缓存的系统提示词或历史消息。
      // 我们基于“未命中的部分 (cacheMiss) + 命中的部分 (cacheHit)”来做整体等比放大
      // 对于计费来说，cache hit 是便宜的，但这里我们要在前端展示“它到底占了多大比例”
      const ratio = apiPromptTokens / localEstimate
      finalSystemPromptTokens = Math.round(bd.systemPromptTokens * ratio)
      
      // 如果工具消耗为 0，避免出现 0 / 0 = NaN 的情况
      if (effectiveBuiltin + effectiveMcp > 0) {
        finalSystemToolsTokens = Math.round((effectiveBuiltin + effectiveMcp) * ratio)
        const builtinRatio = effectiveBuiltin / (effectiveBuiltin + effectiveMcp)
        finalBuiltinToolsTokens = Math.round(finalSystemToolsTokens * builtinRatio)
        finalMcpToolsTokens = finalSystemToolsTokens - finalBuiltinToolsTokens
      } else {
        finalSystemToolsTokens = 0
        finalBuiltinToolsTokens = 0
        finalMcpToolsTokens = 0
      }

      finalSkillTokens = Math.round(bd.skillTokens * ratio)
      finalRagTokens = Math.round(((bd as any).ragTokens ?? 0) * ratio)
      
      const cumulativeToolResultsTokensLocal = cumulativeToolResultsTokens ?? 0
      finalToolResultsTokens = Math.round(cumulativeToolResultsTokensLocal * ratio)
      finalUserInputTokens = Math.round(userInputTokens * ratio)
      
      // 最后一个分项用减法，保证总和绝对等于 apiPromptTokens，避免 Math.round 产生的舍入误差
      finalMessagesTokens = Math.max(0, apiPromptTokens - finalSystemPromptTokens - finalSystemToolsTokens - finalSkillTokens - finalRagTokens - finalToolResultsTokens - finalUserInputTokens)
    } else if (apiPromptTokens) {
      // 极端情况：localEstimate 为 0 但有 apiPromptTokens，全算作历史消息
      finalMessagesTokens = apiPromptTokens
    }

    const currentUsage: TokenUsage = {
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

      // Handle tool calls
    if (response.toolCalls && response.toolCalls.length > 0) {
      // Record which tools were used in this iteration (for next-iteration pruning)
      lastUsedToolNames = new Set(response.toolCalls.map((tc: any) => tc.name))

      // 同一轮的多个工具调用并发执行（典型场景：一轮里派发多个 subagent）。
      // 旧实现是 for + await 逐个串行执行，子代理只能排队跑 —— 用户感知为
      // 「子代理无法并行」。现在拆成三步：
      //   1) 登记：建 assistant 消息、推送 tool_start/tool_call 帧（不落库、不执行）
      //   2) 执行：可并发的轮次用 Promise.all；含 ask_user 的轮次保持串行
      //   3) 收尾：按原顺序落库 assistant/tool 消息并推送结束帧
      // 帧的产出顺序、历史里 assistant→tool 的配对、失败计数语义都与串行实现一致。
      const toolCalls: any[] = response.toolCalls
      const hasAskUser = toolCalls.some((tc) => tc.name === 'ask_user' && !tc._parseError)

      const currentToolFingerprints = toolCalls.map((tc: any) => fingerprintToolCall(tc))
      const isRepeating = currentToolFingerprints.length > 0 && 
        currentToolFingerprints.every((f: string) => lastToolFingerprints.includes(f))
      
      if (isRepeating) {
        globalConsecutiveFailures++
        ctx.logger.warn({ currentToolFingerprints }, 'Repeating tool calls detected')
      }
      lastToolFingerprints = currentToolFingerprints

      // ── 步骤 1：登记 + 通知前端（ask_user 在此挂起，不执行任何工具）──────
      const assistantMsgs: Array<Message & { conversationId?: string }> = []
      for (let i = 0; i < toolCalls.length; i++) {
        const toolCall = toolCalls[i]

        // 为每一个工具调用单独创建一条 assistant 消息（并附加相应的 toolCall）
        // 如果有多个工具调用，思考文本（content）和 token 消耗只挂载在第一条消息上，避免重复
        const assistantMsgId = uuidv4()
        const assistantMsg: Message & { conversationId?: string } = {
          id: assistantMsgId,
          role: 'assistant',
          content: i === 0 ? response.content || '' : '',
          reasoningContent: response.reasoningContent != null ? (i === 0 ? response.reasoningContent : '') : undefined,
          toolCall: toolCall,
          toolCallId: toolCall.id,
          createdAt: Date.now(),
          tokens: i === 0 ? response.completionTokens : 0,
          usage: i === 0 ? (currentUsage as unknown as Record<string, number>) : undefined,
          modelId: response.model, // 持久化真实模型 ID
          ...(conversationId ? { conversationId } : {}),
        }
        assistantMsgs.push(assistantMsg)
        
        // Only yield usage for the first message (to avoid duplicating tokens in the frontend)
        if (i === 0) {
          yield `\x00__usage__${JSON.stringify({ 
            ...cumulativeUsage, 
            conversationId: assistantMsgId,
            modelId: response.model // 透传模型 ID 供前端计算价格
          })}`
        }

        ctx.logger.info({ toolName: toolCall.name, args: toolCall.args }, 'Executing tool')

        // ── 思考过程：通知前端正在调用哪个工具 ──────────────────────────
        yield `\x00__tool_start__${JSON.stringify({ name: toolCall.name, args: toolCall.args, toolCallId: toolCall.id })}`
        // ★ 别名帧（新版协议，第三方项目 等下游消费规范字段；不影响旧消费者）
        yield `\x00__tool_call__${JSON.stringify({ toolName: toolCall.name, args: toolCall.args, toolCallId: toolCall.id, messageId: assistantMsgId })}`

        // SPECIAL CASE: ask_user tool pauses the agent loop
        if (toolCall.name === 'ask_user' && !toolCall._parseError) {
          // Output the interactive card
          yield `\x00__ask_user__${JSON.stringify({ ...toolCall.args, toolCallId: toolCall.id })}`
          // ★ 别名帧（新版协议）：携带 sessionId / requestId 以便外部下游做权限关联
          const askArgs = (toolCall.args ?? {}) as Record<string, unknown>
          yield `\x00__permission_request__${JSON.stringify({
            requestId: toolCall.id,
            toolName: 'ask_user',
            args: askArgs,
            sessionId: ctx.sessionId,
            messageId: assistantMsgId,
            description: typeof askArgs.question === 'string' ? askArgs.question : undefined,
          })}`

          // DO NOT APPEND A TOOL MSG HERE! Wait for the user to submit it.
          // Otherwise, OpenAI throws 400 because there is no tool_result matching tool_calls

          // 本轮排在提问之后、尚未登记的工具调用不会被受理（整轮挂起等应答）。
          // 它们的 tool_start 帧在流式阶段已经发过，必须补一个结束帧，否则前端
          // 会留下永远「执行中」的残留卡片。
          for (let j = i + 1; j < toolCalls.length; j++) {
            const skipped = toolCalls[j]
            yield `\x00__tool_end__${JSON.stringify({
              name: skipped.name,
              toolCallId: skipped.id,
              success: false,
              outputPreview: '[已跳过] 本轮因等待用户应答而挂起，该工具未执行',
            })}`
          }

          // Break the whole loop to end the generation (wait for frontend submit)
          return
        }
      }

      // ── 步骤 2：执行 ───────────────────────────────────────────────────
      const toolResults: Array<ToolResult | undefined> = new Array(toolCalls.length)

      /** 执行单个工具并把结果（或错误）写回 toolResults[i] */
      const execOne = async (i: number): Promise<void> => {
        const toolCall = toolCalls[i]
        if (toolCall._parseError) {
          toolResults[i] = {
            success: false,
            output: `Tool error: SyntaxError in arguments JSON: ${toolCall._parseError}\nPlease ensure your tool arguments are strictly valid JSON (e.g. properly escape internal quotes). Raw args: ${toolCall._rawArgs}`,
          }
          return
        }
        try {
          // 执行前把 toolCallId 挂到 ctx：subagent 等工具借此注册按调用粒度的
          // 取消句柄（/subagent/cancel 按 toolCallId 单独停止某个子代理）。
          // 并发执行时最后一个会覆盖前一个 —— 只影响按 id 停止的精确性，不影响正确性。
          ctx.currentToolCallId = toolCall.id
          toolResults[i] = await ctx.tools.execute(toolCall.name, toolCall.args, ctx)
        } catch (err) {
          // 区分主动 abort 与真正的工具错误：abort 时保持 undefined，
          // 由步骤 3 统一结束本轮（与串行实现「直接 return」的语义一致）
          if ((err as any)?.name === 'AbortError' || ctx.signal?.aborted) {
            ctx.logger.info({ toolName: toolCall.name }, 'Tool execution aborted')
            return
          }
          toolResults[i] = {
            success: false,
            output: `Tool error: ${err instanceof Error ? err.message : 'unknown error'}`,
          }
        } finally {
          if (ctx.currentToolCallId === toolCall.id) ctx.currentToolCallId = undefined
        }
      }

      if (toolCalls.length > 1 && !hasAskUser) {
        // 并发：一轮里的多个工具调用同时跑（并行派发多个 subagent 的主路径）。
        // execOne 内部已吞掉异常，Promise.all 不会因单个工具失败而中断其它工具。
        await Promise.all(toolCalls.map((_tc, i) => execOne(i)))
      } else {
        for (let i = 0; i < toolCalls.length; i++) {
          // 工具执行前再次检查 abort，避免长时间运行的工具浪费资源
          if (ctx.signal?.aborted) {
            ctx.logger.info({ toolName: toolCalls[i].name }, 'Aborted before tool execution')
            return
          }
          await execOne(i)
        }
      }

      // ── 步骤 3：按顺序落库 + 推送结束帧 ────────────────────────────────
      for (let i = 0; i < toolCalls.length; i++) {
        const toolCall = toolCalls[i]
        const toolResult = toolResults[i]

        // 结果为 undefined 只有一种可能：执行期间被 abort。
        // 此时把 assistant tool_call 与一条合成的 tool result 一起落库，
        // 保持历史配对完整——否则下一轮重建上下文时会出现孤儿 tool_call，
        // 被 llm-adapter 降级为 "[Intended to call tool: ..., but was interrupted]" 占位文本。
        if (!toolResult) {
          ctx.logger.info({ toolName: toolCall.name }, 'Agent loop aborted during tool execution')
          try {
            await ctx.history.append(assistantMsgs[i], ctx)
            const abortedMsg: Message & { conversationId?: string } = {
              role: 'tool',
              content: '[Tool execution was aborted before completion. The user may retry this operation.]',
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              createdAt: Date.now(),
              tokens: estimateTokens('[Tool execution was aborted before completion]'),
              ...(conversationId ? { conversationId } : {}),
            }
            await ctx.history.append(abortedMsg, ctx)
          } catch (appendErr) {
            ctx.logger.warn({ err: appendErr, toolName: toolCall.name }, 'Failed to persist aborted tool_call pair')
          }
          return
        }

        await ctx.history.append(assistantMsgs[i], ctx)

        // ── 如果工具返回需要确认，则暂停 Loop，抛给前端审批 ────────────────
        if (toolResult.needsConfirmation) {
          ctx.logger.info({ toolName: toolCall.name }, 'Tool execution requires user confirmation')
          
          // 构造一个供前端展示的问题描述
          const reason = toolResult.pendingAction?.reason || toolResult.output
          const question = `安全策略拦截了此操作，是否允许执行？\n原因：${reason}`
          
          yield `\x00__ask_user__${JSON.stringify({
            question,
            options: ['approved', 'rejected'],
            toolCallId: toolCall.id
          })}`

          yield `\x00__permission_request__${JSON.stringify({
            requestId: toolCall.id,
            toolName: toolCall.name,
            args: toolCall.args,
            sessionId: ctx.sessionId,
            messageId: assistantMsgs[i].id,
            description: question,
          })}`

          // 返回中断，等待前端提交 toolResponse
          return
        }

        // ── 思考过程：通知前端工具执行完毕 ──────────────────────────────
        yield `\x00__tool_end__${JSON.stringify({
          name: toolCall.name,
          toolCallId: toolCall.id,
          success: toolResult.success,
          outputPreview: String(toolResult.output),
        })}`
        // ★ 别名帧（新版协议）：完整 output（非预览）+ durationMs（如有）
        yield `\x00__tool_result__${JSON.stringify({
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          success: toolResult.success,
          output: String(toolResult.output),
          ...(typeof toolResult.durationMs === 'number' ? { durationMs: toolResult.durationMs } : {}),
        })}`

        // ── todo 工具执行后推送最新清单快照（客户端任务托盘实时刷新）──────
        if (toolCall.name.startsWith('todo_')) {
          yield* yieldTodoFrame(ctx)
        }

        // ── 文件改动帧：write_file/delete_file 成功后推送改动记录 ─────────
        // 客户端据此渲染 git 风格 diff 卡片与「改动确认/撤回」面板
        if (toolResult.success && toolResult.change) {
          try {
            yield `\x00__file_change__${JSON.stringify({ ...toolResult.change, toolCallId: toolCall.id })}`
          } catch (err) {
            ctx.logger.warn({ err }, 'Failed to emit file_change frame')
          }
        }

        if (!toolResult.success) {
          globalConsecutiveFailures++
          ctx.logger.warn({ toolName: toolCall.name, globalFailures: globalConsecutiveFailures }, 'Tool call failed')
        } else if (!isRepeating) {
          // 只有当工具执行成功且不是重复调用时，才重置连续失败计数
          globalConsecutiveFailures = 0
        }

        // Add tool result to history (truncate oversized output to save tokens).
        // Image JSON results (containing dataUrl) are exempt from truncation — see
        // truncateToolOutput for details.
        const truncatedOutput = truncateToolOutput(stripSubagentMeta(String(toolResult.output)))
        const toolResultTokenCount = estimateTokens(truncatedOutput)
        cumulativeToolResultsTokens += toolResultTokenCount
        const toolMsg: Message & { conversationId?: string } = {
          role: 'tool',
          content: truncatedOutput,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          createdAt: Date.now(),
          tokens: toolResultTokenCount,
          ...(conversationId ? { conversationId } : {}),
        }
        await ctx.history.append(toolMsg, ctx)

        // Bail out if tools fail repeatedly or repeat too many times (prevents infinite loops).
        // 阈值可配（默认 8，见 getMaxConsecutiveFailures）——旧值写死 20 容忍度过高。
        if (globalConsecutiveFailures >= getMaxConsecutiveFailures()) {
          ctx.logger.error({ toolName: toolCall.name, globalConsecutiveFailures }, 'Consecutive failures or repetitions exceeded limit, stopping')
          yield `\n\n[Loop detected or tool \`${toolCall.name}\` failed repeatedly. Stopping to prevent token waste.]`
          return
        }
      }

      // Continue to next iteration
      continue
    }

      // ── 最终回答 ──
      // 注意：response.content 和 response.reasoningContent 已经在上面的流式循环中通过 yield 输出过了
      // 此处只需持久化最终结果并发送 usage 帧即可。

      // Yield token usage breakdown as a special __usage__ frame (includes conversationId)
      const messageId = uuidv4()
      const finalMsg: Message & { conversationId?: string } = {
        id: messageId,
        role: 'assistant',
        content: response.content || '',
        reasoningContent: response.reasoningContent,
        createdAt: Date.now(),
        tokens: completionTokens, // 使用本轮增量生成数
        usage: currentUsage as unknown as Record<string, number>, // 存储本轮增量 Usage，防止 DB 统计累加
        modelId: response.model,
        ...(conversationId ? { conversationId } : {}),
      }
      await ctx.history.append(finalMsg, ctx)

      yield `\x00__usage__${JSON.stringify({ 
        ...cumulativeUsage, 
        conversationId: messageId,
        modelId: response.model // 透传模型 ID 供前端计算价格
      })}`
      return
    }

    // Max iterations exceeded
    ctx.logger.warn({ maxIterations }, 'Max iterations exceeded')
    yield `\n\n[Max iterations (${maxIterations}) exceeded. The task may be too complex.]`
  }
}
