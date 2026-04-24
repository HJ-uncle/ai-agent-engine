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
  systemPrompt?: string
  temperature?: number
  /** Unique ID for this conversation round (one chat request = one conversationId) */
  conversationId?: string
  /** Pre-computed token counts for the injected prompts (optional) */
  promptBreakdown?: Pick<TokenUsage, 'systemPromptTokens' | 'systemToolsTokens' | 'skillTokens'>
}

export class ReActStrategy implements LoopStrategy {
  constructor(
    private readonly llm: LLMAdapter,
    private readonly options: ReActOptions = {},
  ) {}

  async *run(input: string | null, ctx: AgentContext): AsyncIterable<string> {
    const maxIterations = this.options.maxIterations ??
      parseInt(process.env.MAX_ITERATIONS ?? '10', 10)

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
        // Pass tools as the registry list (adapter will convert)
        tools: toolList.map((t) => ({
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
      response = await this.llm.complete(messages, llmOptions)
      console.log('--- llm.complete finished ---', response.content?.slice(0, 50))
    } catch (err) {
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
      if (response.content?.trim()) {
        yield `\x00__thinking__${response.content}`
      }

      // Add assistant message with tool calls
      const assistantMsgId = uuidv4()
      const assistantMsg: Message & { conversationId?: string } = {
        id: assistantMsgId,
        role: 'assistant',
        content: response.content,
        toolCall: response.toolCalls[0],
        toolCallId: response.toolCalls[0].id,
        createdAt: Date.now(),
        tokens: response.completionTokens,
        usage: currentUsage as unknown as Record<string, number>,
        ...(conversationId ? { conversationId } : {}),
      }
      await ctx.history.append(assistantMsg, ctx)
      yield `\x00__usage__${JSON.stringify({ ...currentUsage, conversationId: assistantMsgId })}`

      // Execute each tool call
      let consecutiveFailures = 0
      for (const toolCall of response.toolCalls) {
        ctx.logger.info({ toolName: toolCall.name, args: toolCall.args }, 'Executing tool')

        // ── 思考过程：通知前端正在调用哪个工具 ──────────────────────────
        yield `\x00__tool_start__${JSON.stringify({ name: toolCall.name, args: toolCall.args })}`

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
          success: toolResult.success,
          outputPreview: String(toolResult.output).slice(0, 200),
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

      // ── 最终回答：改用 stream() 实现字符级流式输出 ────────────────────────
      let streamContent = ''
      let streamPromptTokens = 0
      let streamCompletionTokens = 0

      try {
        for await (const chunk of this.llm.stream(messages, llmOptions)) {
          if (chunk.content) {
            streamContent += chunk.content
            yield chunk.content    // ← 每个字符实时推送给前端
          }
          if (chunk.done) {
            streamPromptTokens    = chunk.promptTokens    ?? 0
            streamCompletionTokens = chunk.completionTokens ?? 0
          }
        }
      } catch (streamErr) {
        ctx.logger.error({ streamErr }, 'Stream failed, falling back to complete()')
        // stream 失败时降级到已有的 response.content
        streamContent = response.content
        streamCompletionTokens = response.completionTokens
        yield response.content
      }

      // Yield token usage breakdown as a special __usage__ frame (includes conversationId)
      const finalCompletionTokens = streamCompletionTokens || response.completionTokens
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
        content: streamContent || response.content,
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
