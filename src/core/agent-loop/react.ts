import type { LoopStrategy } from './strategy.js'
import type { AgentContext } from '../agent-context/index.js'
import type { LLMAdapter, LLMAdapterOptions } from '../llm-adapter/index.js'
import type { Message } from '../agent-context/index.js'
import { estimateTokens } from '../utils/tokens.js'
import { v4 as uuidv4 } from 'uuid'

/**
 * 截断过大的工具输出，避免历史消息膨胀。
 * 保留开头和结尾各 maxChars/2 的内容，中间用省略标记替代。
 * 对于 24/7 长期运行的 Agent 至关重要。
 */
const TOOL_OUTPUT_MAX_CHARS = parseInt(process.env.TOOL_OUTPUT_MAX_CHARS ?? '4000', 10)

function truncateToolOutput(output: string, maxChars: number = TOOL_OUTPUT_MAX_CHARS): string {
  if (output.length <= maxChars) return output
  const half = Math.floor(maxChars / 2)
  const head = output.slice(0, half)
  const tail = output.slice(-half)
  const truncatedChars = output.length - maxChars
  return `${head}\n\n... [truncated ${truncatedChars} chars] ...\n\n${tail}`
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
  /**
   * 原始用户消息内容（含 workspace_image 等前端格式），用于存入历史 DB（UI 展示用）。
   * 与 input（LLM prompt）分离：LLM 看到文本化的 prompt，DB/UI 保留原始格式。
   */
  displayContent?: string | any[] | null
}

export class ReActStrategy implements LoopStrategy {
  constructor(
    private readonly llm: LLMAdapter,
    private readonly options: ReActOptions = {},
  ) {}

  async *run(input: string | any[] | null, ctx: AgentContext): AsyncIterable<string> {
    const maxIterations = this.options.maxIterations ??
      parseInt(process.env.MAX_ITERATIONS ?? '50', 10)

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
      }
      await ctx.history.append(userMessage, ctx)
    }

    // Build tool list from registry
    const toolList = ctx.tools.list()

    /** Names of tools actually called in the last iteration */
    let lastUsedToolNames: Set<string> = new Set()
    /** 记录迭代 0 的工具定义 token 数，后续迭代的 usage 展示统一使用此值 */
    let iter0ToolDefsTokens: number | null = null
    /** Cumulative token count of tool-call result messages across all iterations */
    let cumulativeToolResultsTokens = 0

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

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      // ── 每轮迭代开始时检查 abort signal，确保用户中止能及时生效 ──────────────
      // 之前只在 LLM 调用时检查，导致工具执行/历史压缩等阶段无法被中断。
      if (ctx.signal?.aborted) {
        ctx.logger.info({ iteration }, 'Agent loop aborted at iteration boundary')
        return
      }

      // 1. 先检查是否需要压缩（用 raw token count，不受 window 限制）
      // 对 24/7 Agent，使用更激进的阈值（0.5）以尽早触发压缩
      const compressRatio = parseFloat(process.env.COMPRESS_THRESHOLD_RATIO ?? '0.5')
      const compressThreshold = Math.floor(ctx.tokenBudget * compressRatio)
      const rawTokens = await ctx.history.getRawTokenCount(ctx)
      if (rawTokens > compressThreshold) {
        ctx.logger.info({ rawTokens, threshold: compressThreshold }, 'Compressing conversation history')
        await ctx.history.compress(ctx, async (msgs) => {
          // 超大消息（base64 图片等）压缩时只取前 200 字符作为摘要输入
          const content = msgs
            .map((m) => {
              const tokens = m.tokens ?? estimateTokens(m.content)
              const text = typeof m.content === 'string'
                ? (tokens > 1000 ? m.content.slice(0, 200) + `...[truncated, ~${tokens} tokens]` : m.content)
                : '[Multimodal content]'
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

      // 2. 压缩后重新取 windowed messages（applyTokenWindow 会截断超大消息）
      const messages = await ctx.history.getHistory(ctx)

      // 3. 计算 windowed token count，检查是否超 budget
      const historyTokens = messages.reduce((sum, m) => sum + (m.tokens ?? estimateTokens(m.content)), 0)

      if (historyTokens >= ctx.tokenBudget) {
        ctx.logger.warn({ historyTokens, tokenBudget: ctx.tokenBudget }, 'Token budget exhausted')
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
        tools: effectiveTools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
          execute: async (_args: unknown, _ctx: AgentContext) => ({ success: true as const, output: '' }),
        })),
      }

      ctx.logger.debug({ iteration, messageCount: messages.length }, 'ReAct iteration')

      let response
      try {
        console.log('--- llm.complete started ---')
        response = await this.llm.complete(messages, {
          ...llmOptions,
          // 传递 signal 给适配器以便支持中断
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        } as LLMAdapterOptions & { signal?: AbortSignal })
        console.log('--- llm.complete finished ---', response.content?.slice(0, 50))
      } catch (err: any) {
        if (err.name === 'AbortError') {
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
    const completionTokens = response.completionTokens

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
    const localEstimate = bd.systemPromptTokens + displayToolDefsTokens + bd.skillTokens + historyTokens
    const promptTokens = apiPromptTokens || localEstimate
    // 用 API 真实 prompt 减去本地可确定的部分，得到更准确的 messagesTokens
    const realMessagesTokens = apiPromptTokens
      ? Math.max(0, apiPromptTokens - bd.systemPromptTokens - displayToolDefsTokens - bd.skillTokens)
      : historyTokens

    const currentUsage: TokenUsage = {
      systemPromptTokens: bd.systemPromptTokens,
      systemToolsTokens: displayToolDefsTokens,
      skillTokens: bd.skillTokens,
      messagesTokens: realMessagesTokens,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      ragTokens: (bd as any).ragTokens ?? 0,
      builtinToolsTokens: (bd as any).builtinToolsTokens ?? 0,
      mcpToolsTokens: (bd as any).mcpToolsTokens ?? 0,
      toolResultsTokens: cumulativeToolResultsTokens ?? 0,
    }

      // Handle tool calls
    if (response.toolCalls && response.toolCalls.length > 0) {
      // ── 思考过程：如果 AI 有思考文本，先流出 ─────────────────────────
      // 对于 Deepseek R1，优先使用 reasoningContent 作为思考过程，如果没有则退回使用 content
      const thinkingText = response.reasoningContent?.trim()
      const fallbackThinking = response.content?.trim()
      
      if (thinkingText) {
        yield `\x00__thinking__${thinkingText}`
      } else if (fallbackThinking && response.toolCalls && response.toolCalls.length > 0) {
        // 如果没有 reasoningContent 但有工具调用，旧模型通常把思考过程写在 content 里
        yield `\x00__thinking__${fallbackThinking}`
      }

      // Record which tools were used in this iteration (for next-iteration pruning)
      lastUsedToolNames = new Set(response.toolCalls.map((tc) => tc.name))

      // Execute each tool call sequentially
      let consecutiveFailures = 0
      for (let i = 0; i < response.toolCalls.length; i++) {
        const toolCall = response.toolCalls[i]

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
          ...(conversationId ? { conversationId } : {}),
        }
        await ctx.history.append(assistantMsg, ctx)
        
        // Only yield usage for the first message (to avoid duplicating tokens in the frontend)
        if (i === 0) {
          yield `\x00__usage__${JSON.stringify({ ...currentUsage, conversationId: assistantMsgId })}`
        }

        ctx.logger.info({ toolName: toolCall.name, args: toolCall.args }, 'Executing tool')

        // ── 思考过程：通知前端正在调用哪个工具 ──────────────────────────
        yield `\x00__tool_start__${JSON.stringify({ name: toolCall.name, args: toolCall.args, toolCallId: toolCall.id })}`

        // SPECIAL CASE: ask_user tool pauses the agent loop
        if (toolCall.name === 'ask_user') {
          // Output the interactive card
          yield `\x00__ask_user__${JSON.stringify({ ...toolCall.args, toolCallId: toolCall.id })}`

          // DO NOT APPEND A TOOL MSG HERE! Wait for the user to submit it.
          // Otherwise, OpenAI throws 400 because there is no tool_result matching tool_calls

          // Break the whole loop to end the generation (wait for frontend submit)
          return
        }

        let toolResult
        try {
          // 工具执行前再次检查 abort，避免长时间运行的工具浪费资源
          if (ctx.signal?.aborted) {
            ctx.logger.info({ toolName: toolCall.name }, 'Aborted before tool execution')
            return
          }
          toolResult = await ctx.tools.execute(toolCall.name, toolCall.args, ctx)
        } catch (err) {
          // 区分主动 abort 与真正的工具错误
          if ((err as any)?.name === 'AbortError' || ctx.signal?.aborted) {
            ctx.logger.info({ toolName: toolCall.name }, 'Tool execution aborted')
            return
          }
          toolResult = {
            success: false,
            output: `Tool error: ${err instanceof Error ? err.message : 'unknown error'}`,
          }
        }

        // ── 思考过程：通知前端工具执行完毕 ──────────────────────────────
        yield `\x00__tool_end__${JSON.stringify({
          name: toolCall.name,
          toolCallId: toolCall.id,
          success: toolResult.success,
          outputPreview: String(toolResult.output),
        })}`

        if (!toolResult.success) {
          consecutiveFailures++
          ctx.logger.warn({ toolName: toolCall.name, failures: consecutiveFailures }, 'Tool call failed')
        } else {
          consecutiveFailures = 0
        }

        // Add tool result to history (truncate oversized output to save tokens)
        const truncatedOutput = truncateToolOutput(String(toolResult.output))
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

        // Bail out if the same tool fails 3 times in a row (prevents infinite loops)
        if (consecutiveFailures >= 3) {
          ctx.logger.error({ toolName: toolCall.name }, 'Tool failed 3 consecutive times, stopping')
          yield `\n\n[Tool \`${toolCall.name}\` failed repeatedly. Last error: ${toolResult.output}]`
          return
        }
      }

      // Continue to next iteration
      continue
    }

      // ── 最终回答：直接返回 complete() 的结果，避免重复调用 API 导致 Token 翻倍计算 ──
      // 如果有 reasoningContent，先流出思考过程
      if (response.reasoningContent?.trim()) {
        yield `\x00__thinking__${response.reasoningContent.trim()}`
      }

      // 将 response.content 切片模拟流式输出效果
      if (response.content) {
        const chunkSize = 10
        for (let i = 0; i < response.content.length; i += chunkSize) {
          yield response.content.slice(i, i + chunkSize)
          // 可选：添加微小延迟模拟真实流式
          await new Promise(resolve => setTimeout(resolve, 5))
        }
      }

      // Yield token usage breakdown as a special __usage__ frame (includes conversationId)
      // 使用 displayToolDefsTokens（迭代 0 的值）而非当前迭代的 effectiveToolDefsTokens
      // 确保最终回答的 usage 与工具调用阶段一致（Bug fix: 避免裁剪后数值异常偏低）
      const finalCompletionTokens = response.completionTokens
      const finalApiPrompt = response.promptTokens
      const finalLocalEstimate = bd.systemPromptTokens + displayToolDefsTokens + bd.skillTokens + historyTokens
      const finalPromptTokens = finalApiPrompt || finalLocalEstimate
      const finalRealMessages = finalApiPrompt
        ? Math.max(0, finalApiPrompt - bd.systemPromptTokens - displayToolDefsTokens - bd.skillTokens)
        : historyTokens
      const finalUsage: TokenUsage = {
        systemPromptTokens: bd.systemPromptTokens,
        systemToolsTokens: displayToolDefsTokens,
        messagesTokens: finalRealMessages,
        skillTokens: bd.skillTokens,
        promptTokens: finalPromptTokens,
        completionTokens: finalCompletionTokens,
        totalTokens: finalPromptTokens + finalCompletionTokens,
        ragTokens: (bd as any).ragTokens ?? 0,
        builtinToolsTokens: (bd as any).builtinToolsTokens ?? 0,
        mcpToolsTokens: (bd as any).mcpToolsTokens ?? 0,
        toolResultsTokens: cumulativeToolResultsTokens,
      }

      const messageId = uuidv4()
      const finalMsg: Message & { conversationId?: string } = {
        id: messageId,
        role: 'assistant',
        content: response.content || '',
        reasoningContent: response.reasoningContent,
        createdAt: Date.now(),
        tokens: finalCompletionTokens,
        usage: finalUsage as unknown as Record<string, number>, // Attach usage to the final message so it gets saved in the DB
        ...(conversationId ? { conversationId } : {}),
      }
      await ctx.history.append(finalMsg, ctx)

      yield `\x00__usage__${JSON.stringify({ ...finalUsage, conversationId: messageId })}`
      return
    }

    // Max iterations exceeded
    ctx.logger.warn({ maxIterations }, 'Max iterations exceeded')
    yield `\n\n[Max iterations (${maxIterations}) exceeded. The task may be too complex.]`
  }
}
