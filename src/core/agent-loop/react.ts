import type { LoopStrategy } from './strategy.js'
import type { AgentContext } from '../agent-context/index.js'
import type { LLMAdapter, LLMAdapterOptions } from '../llm-adapter/index.js'
import type { Message } from '../agent-context/index.js'

export interface ReActOptions {
  maxIterations?: number
  systemPrompt?: string
  temperature?: number
}

export class ReActStrategy implements LoopStrategy {
  constructor(
    private readonly llm: LLMAdapter,
    private readonly options: ReActOptions = {},
  ) {}

  async *run(input: string, ctx: AgentContext): AsyncIterable<string> {
    const maxIterations = this.options.maxIterations ??
      parseInt(process.env.MAX_ITERATIONS ?? '10', 10)

    // Add user message to history
    const userMessage: Message = {
      role: 'user',
      content: input,
      createdAt: Date.now(),
    }
    await ctx.history.append(userMessage, ctx)

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
      response = await this.llm.complete(messages, llmOptions)
    } catch (err) {
      ctx.logger.error({ err }, 'LLM call failed')
      yield `\n\n[Error: LLM call failed - ${err instanceof Error ? err.message : 'unknown error'}]`
      return
    }

    // Update token budget — only subtract completion tokens to avoid double-counting
    // prompt tokens across iterations (history is already tracked via getTokenCount)
    ctx.tokenBudget -= response.completionTokens

    // Handle tool calls
    if (response.toolCalls && response.toolCalls.length > 0) {
      // Add assistant message with tool calls
      const assistantMsg: Message = {
        role: 'assistant',
        content: response.content,
        toolCall: response.toolCalls[0], // store first tool call reference
        toolCallId: response.toolCalls[0].id, // ← also store id in toolCallId for DB persistence
        createdAt: Date.now(),
        tokens: response.completionTokens,
      }
      await ctx.history.append(assistantMsg, ctx)

      // Execute each tool call
      let consecutiveFailures = 0
      for (const toolCall of response.toolCalls) {
        ctx.logger.info({ toolName: toolCall.name, args: toolCall.args }, 'Executing tool')

        let toolResult
        try {
          toolResult = await ctx.tools.execute(toolCall.name, toolCall.args, ctx)
        } catch (err) {
          toolResult = {
            success: false,
            output: `Tool error: ${err instanceof Error ? err.message : 'unknown error'}`,
          }
        }

        if (!toolResult.success) {
          consecutiveFailures++
          ctx.logger.warn({ toolName: toolCall.name, failures: consecutiveFailures }, 'Tool call failed')
        } else {
          consecutiveFailures = 0
        }

        // Add tool result to history
        const toolMsg: Message = {
          role: 'tool',
          content: toolResult.output,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          createdAt: Date.now(),
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

      // Final answer (no tool calls)
      const finalMsg: Message = {
        role: 'assistant',
        content: response.content,
        createdAt: Date.now(),
        tokens: response.completionTokens,
      }
      await ctx.history.append(finalMsg, ctx)

      // Yield the response content
      yield response.content
      return
    }

    // Max iterations exceeded
    ctx.logger.warn({ maxIterations }, 'Max iterations exceeded')
    yield `\n\n[Max iterations (${maxIterations}) exceeded. The task may be too complex.]`
  }
}
