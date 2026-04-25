import type { LoopStrategy } from './strategy.js'
import type { AgentContext } from '../agent-context/index.js'
import type { LLMAdapter, LLMAdapterOptions } from '../llm-adapter/index.js'
import type { Message } from '../agent-context/index.js'
import { v4 as uuidv4 } from 'uuid'

export interface TokenUsage {
  /** Tokens in the system prompt (including RAG context) */
  systemPromptTokens: number
  /** Tokens used by tool definitions */
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
}

export interface ReActOptions {
  maxIterations?: number
  maxAskUserCount?: number
  systemPrompt?: string
  temperature?: number
  /** Unique ID for this conversation round (one chat request = one conversationId) */
  conversationId?: string
  /** Pre-computed token counts for the injected prompts (optional) */
  promptBreakdown?: Pick<TokenUsage, 'systemPromptTokens' | 'systemToolsTokens' | 'skillTokens'>
  thinkingConfig?: Record<string, unknown> | null
  responseThinkingField?: string | null
}

export class ReActStrategy implements LoopStrategy {
  constructor(
    private readonly llm: LLMAdapter,
    private readonly options: ReActOptions = {},
  ) {}

  async *run(input: string | null, ctx: AgentContext): AsyncIterable<string> {
    const maxIterations = this.options.maxIterations ??
      parseInt(process.env.MAX_ITERATIONS ?? '50', 10)

    const maxAskUserCount = this.options.maxAskUserCount ?? 5
    const conversationId = this.options.conversationId

    // Add user message to history only if input is provided
    if (input !== null && input !== '') {
      const userMessage: Message & { conversationId?: string } = {
        role: 'user',
        content: input,
        createdAt: Date.now(),
        tokens: this.llm.countTokens(input),
        ...(conversationId ? { conversationId } : {}),
      }
      await ctx.history.append(userMessage, ctx)
    }

    // Build tool list from registry
    const toolList = ctx.tools.list()

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
      // Get windowed messages first
      const messages = await ctx.history.getHistory(ctx)

      // Compute token count from the WINDOWED messages (not raw DB total) — fixes budget check bug
      const estimateTokens = (m: Message) => m.tokens ?? Math.ceil(m.content.length / 4)
      const historyTokens = messages.reduce((sum, m) => sum + estimateTokens(m), 0)

      // Auto-compress when the raw (unwindowed) history crosses 75% of the token budget.
      // This keeps the DB lean and avoids the sliding window silently discarding context.
      const compressThreshold = Math.floor(ctx.tokenBudget * 0.75)
      const rawTokens = await ctx.history.getRawTokenCount(ctx)
      if (rawTokens > compressThreshold) {
        ctx.logger.info({ rawTokens, threshold: compressThreshold }, 'Compressing conversation history')
        await ctx.history.compress(ctx, async (msgs) => {
          const content = msgs
            .map((m) => `${m.role}: ${m.content.slice(0, 200)}`)
            .join('\n')
          const resp = await this.llm.complete(
            [
              {
                role: 'user',
                content: `Summarize this conversation concisely (max 300 words), preserving key context, decisions and facts:\n\n${content}`,
                createdAt: Date.now(),
              },
            ],
            { model: this.llm.model, temperature: 0.3 },
          )
          return resp.content
        })
      }

      // Guard: windowed tokens must not exceed the budget
      if (historyTokens >= ctx.tokenBudget) {
        ctx.logger.warn({ historyTokens, tokenBudget: ctx.tokenBudget }, 'Token budget exhausted')
        yield '\n\n[Response truncated: token budget exceeded]'
        return
      }

      const llmOptions: LLMAdapterOptions = {
        model: this.llm.model,
        systemPrompt: this.options.systemPrompt,
        temperature: this.options.temperature,
        thinkingConfig: this.options.thinkingConfig,
        responseThinkingField: this.options.responseThinkingField,
        // Pass tools as the registry list (adapter will convert)
        tools: toolList
          .filter((t) => {
            // If ask_user has been called too many times, remove it from the available tools
            if (t.name === 'ask_user' && askUserCount >= maxAskUserCount) {
              ctx.logger.info({ maxAskUserCount, askUserCount }, 'Filtering out ask_user tool due to limit reached')
              return false
            }
            return true
          })
          .map((t) => ({
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

    const bd = this.options.promptBreakdown ?? { systemPromptTokens: 0, systemToolsTokens: 0, skillTokens: 0 }
    const promptTokens = response.promptTokens || (bd.systemPromptTokens + bd.systemToolsTokens + bd.skillTokens + historyTokens)
    const completionTokens = response.completionTokens
    const currentUsage: TokenUsage = {
      systemPromptTokens: bd.systemPromptTokens,
      systemToolsTokens: bd.systemToolsTokens,
      skillTokens: bd.skillTokens,
      messagesTokens: Math.max(0, promptTokens - bd.systemPromptTokens - bd.systemToolsTokens - bd.skillTokens),
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
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
          reasoningContent: i === 0 ? response.reasoningContent : undefined,
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
          toolResult = await ctx.tools.execute(toolCall.name, toolCall.args, ctx)
        } catch (err) {
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
          outputPreview: String(toolResult.output).slice(0, 500),
        })}`

        if (!toolResult.success) {
          consecutiveFailures++
          ctx.logger.warn({ toolName: toolCall.name, failures: consecutiveFailures }, 'Tool call failed')
        } else {
          consecutiveFailures = 0
        }

        // Add tool result to history
        const toolMsg: Message & { conversationId?: string } = {
          role: 'tool',
          content: toolResult.output,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          createdAt: Date.now(),
          tokens: this.llm.countTokens(String(toolResult.output)),
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
      const finalCompletionTokens = response.completionTokens
      const finalPromptTokens = response.promptTokens || (bd.systemPromptTokens + bd.systemToolsTokens + bd.skillTokens + historyTokens)
      const finalUsage: TokenUsage = {
        systemPromptTokens: bd.systemPromptTokens,
        systemToolsTokens: bd.systemToolsTokens,
        messagesTokens: Math.max(0, finalPromptTokens - bd.systemPromptTokens - bd.systemToolsTokens - bd.skillTokens),
        skillTokens: bd.skillTokens,
        promptTokens: finalPromptTokens,
        completionTokens: finalCompletionTokens,
        totalTokens: finalPromptTokens + finalCompletionTokens,
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
