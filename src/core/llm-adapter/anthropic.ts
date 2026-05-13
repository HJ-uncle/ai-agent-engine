import Anthropic from '@anthropic-ai/sdk'
import type { LLMAdapter, LLMResponse, LLMAdapterOptions, LLMStreamChunk } from './types.js'
import type { Message, Tool } from '../agent-context/index.js'
import { estimateTokens } from '../utils/tokens.js'

// Anthropic SDK v0.20 does not expose Tool types directly; we use a minimal inline type.
interface AnthropicTool {
  name: string
  description?: string
  input_schema: {
    type: 'object'
    properties?: Record<string, unknown>
    required?: string[]
    [key: string]: unknown
  }
}

// Content block types not exported by v0.20 but present at runtime
interface ToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string
}

interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
}

type AnthropicContentBlock =
  | Anthropic.TextBlockParam
  | Anthropic.ImageBlockParam
  | ToolResultBlock
  | ToolUseBlock

interface AnthropicMessageParam {
  role: 'user' | 'assistant'
  content: string | AnthropicContentBlock[]
}

/**
 * Convert a single Message to Anthropic format.
 *
 * Returns null when the message must be dropped:
 *  - tool_result blocks whose tool_use_id is not in validToolUseIds
 *  - assistant tool_use blocks with missing id or name (legacy history)
 */
function messageToAnthropic(
  msg: Message,
  validToolUseIds?: Set<string>,
  validToolResultIds?: Set<string>
): AnthropicMessageParam | null {
  // ── tool result → Anthropic user/tool_result ─────────────────────────────
  if (msg.role === 'tool') {
    // Drop orphaned tool_result blocks (no matching tool_use was emitted)
    if (validToolUseIds && msg.toolCallId && !validToolUseIds.has(msg.toolCallId)) {
      return null
    }
    
    let toolContent: any
    if (Array.isArray(msg.content)) {
      // 如果已经是多模态数组，直接使用
      toolContent = msg.content
    } else {
      // 尝试解析 JSON 查看是否是图片数据
      let parsed: any = null
      try {
        parsed = JSON.parse(String(msg.content))
        if (parsed.dataUrl) {
          // 如果是 smart_read 的图片 JSON 结果，转换成多模态格式
          toolContent = [
            { type: 'text', text: `图片文件 ${parsed.filename} 已读取：` },
            { 
              type: 'image', 
              source: { 
                type: 'base64', 
                media_type: parsed.mimeType || 'image/png', 
                data: parsed.dataUrl.replace(/^data:.*;base64,/, '') 
              } 
            }
          ]
        } else {
          toolContent = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
        }
      } catch {
        // 不是 JSON，直接使用原内容
        toolContent = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
      }
    }
    
    // 如果是多模态数组，需要把它包装在 tool_result 中
    let finalContent: AnthropicContentBlock[]
    if (Array.isArray(toolContent)) {
      // 对于多模态内容，Anthropic 的 tool_result 接受数组
      finalContent = [{
        type: 'tool_result',
        tool_use_id: msg.toolCallId ?? '',
        content: toolContent as any,
      }]
    } else {
      finalContent = [{
        type: 'tool_result',
        tool_use_id: msg.toolCallId ?? '',
        content: toolContent,
      }]
    }
    
    return {
      role: 'user',
      content: finalContent,
    }
  }

  // ── assistant with tool_call → Anthropic assistant/tool_use ──────────────
  if (msg.role === 'assistant' && msg.toolCall) {
    const id   = msg.toolCall.id
    const name = msg.toolCall.name

    const blocks: AnthropicContentBlock[] = []
    let fallbackContent = msg.content || ''

    // Guard: skip tool_use block if id or name is missing (old DB records)
    // Also skip if it has no corresponding tool_result (orphaned tool_call)
    if (id && name && validToolResultIds && validToolResultIds.has(id)) {
      if (msg.content) {
        blocks.push({ type: 'text', text: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) })
      }
      blocks.push({ type: 'tool_use', id, name, input: msg.toolCall.args })
      // Register this id so downstream tool_result blocks are not dropped
      validToolUseIds?.add(id)
    } else {
      // If orphaned, append the intended tool call to the content so context isn't lost
      if (name && !fallbackContent.includes(name)) {
        const argsStr = JSON.stringify(msg.toolCall.args || {})
        fallbackContent += `\n[Intended to call tool: ${name} with args: ${argsStr}, but was interrupted]`
      }
      if (fallbackContent) {
        blocks.push({ type: 'text', text: typeof fallbackContent === 'string' ? fallbackContent : JSON.stringify(fallbackContent) })
      }
    }

    // If no blocks at all, return a plain text assistant message
    if (blocks.length === 0) {
      return { role: 'assistant', content: '(no content)' }
    }
    return { role: 'assistant', content: blocks }
  }

  // ── system filtered out at call site ─────────────────────────────────────
  if (msg.role === 'system') return null

  return {
    role: msg.role as 'user' | 'assistant',
    content: msg.content,
  }
}

/**
 * Merge adjacent same-role messages to satisfy Anthropic's strict
 * user/assistant alternation requirement.
 */
function mergeAdjacentRoles(msgs: AnthropicMessageParam[]): AnthropicMessageParam[] {
  const merged: AnthropicMessageParam[] = []
  for (const msg of msgs) {
    const prev = merged[merged.length - 1]
    if (prev && prev.role === msg.role) {
      // Combine content
      const prevBlocks = Array.isArray(prev.content)
        ? prev.content
        : [{ type: 'text' as const, text: prev.content as string }]
      const currBlocks = Array.isArray(msg.content)
        ? msg.content
        : [{ type: 'text' as const, text: msg.content as string }]
      prev.content = [...prevBlocks, ...currBlocks]
    } else {
      merged.push({ ...msg, content: msg.content })
    }
  }
  return merged
}

function toolToAnthropic(tool: Tool): AnthropicTool {
  const { type: _ignored, ...restParams } = tool.parameters
  return {
    name: tool.name,
    description: tool.description,
    input_schema: {
      ...restParams,
      type: 'object',
    },
  }
}

export class AnthropicAdapter implements LLMAdapter {
  readonly provider = 'anthropic'
  private client: Anthropic

  constructor(readonly model: string = 'claude-3-5-sonnet-20241022', apiKey?: string, baseURL?: string) {
    this.client = new Anthropic({
      apiKey: apiKey || process.env.ANTHROPIC_API_KEY,
      baseURL: baseURL || process.env.ANTHROPIC_BASE_URL,
    })
  }

  async complete(messages: Message[], options?: LLMAdapterOptions): Promise<LLMResponse> {
    // Two-pass orphan filtering:
    // Pass 1 — collect all valid tool_use ids from assistant messages
    // and collect all valid tool_result ids from tool messages
    const validToolUseIds = new Set<string>()
    const validToolResultIds = new Set<string>()
    for (const msg of messages) {
      if (msg.role === 'assistant' && msg.toolCall?.id && msg.toolCall?.name) {
        // We defer adding to validToolUseIds to messageToAnthropic
      }
      if (msg.role === 'tool' && msg.toolCallId) {
        validToolResultIds.add(msg.toolCallId)
      }
    }

    const anthropicMessages = mergeAdjacentRoles(
      messages
        .map((m) => messageToAnthropic(m, validToolUseIds, validToolResultIds))
        .filter((m): m is AnthropicMessageParam => m !== null),
    )

    // Debug: log what we're sending to Anthropic
    if (process.env.DEBUG_ANTHROPIC === '1') {
      console.log('[anthropic] messages sent:', JSON.stringify(anthropicMessages, null, 2))
    }

    const params: Record<string, unknown> = {
      model: options?.model ?? this.model,
      max_tokens: options?.maxTokens ?? 4096,
      messages: anthropicMessages,
      system: options?.systemPrompt,
    }

    if (options?.thinkingConfig) {
      Object.assign(params, options.thinkingConfig)
    }

    if (options?.tools && options.tools.length > 0) {
      params['tools'] = options.tools.map(toolToAnthropic)
    }

    type CreateFn = (p: Record<string, unknown>) => Promise<{
      content: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>
      usage: { input_tokens: number; output_tokens: number }
      stop_reason: string | null
    }>
    const response = await (this.client.messages.create as unknown as CreateFn)(params)

    let content = ''
    let reasoningContent = ''
    const toolCalls: LLMResponse['toolCalls'] = []

    for (const block of response.content) {
      if (block.type === 'text' && block.text !== undefined) {
        content += block.text
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id ?? '',
          name: block.name ?? '',
          args: block.input as Record<string, unknown>,
        })
      } else if (block.type === 'thinking' || (options?.responseThinkingField && block.type === options.responseThinkingField)) {
        reasoningContent += (block as any)[options?.responseThinkingField || 'thinking']
      }
    }

    return {
      content,
      reasoningContent: reasoningContent || undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      promptTokens: response.usage.input_tokens,
      completionTokens: response.usage.output_tokens,
      finishReason: response.stop_reason === 'tool_use' ? 'tool_calls' :
                    response.stop_reason === 'max_tokens' ? 'length' : 'stop',
      model: (response as any).model,
    }
  }

  async *stream(messages: Message[], options?: LLMAdapterOptions): AsyncIterable<LLMStreamChunk> {
    // Two-pass orphan filtering (same as complete())
    const validToolUseIds = new Set<string>()
    for (const msg of messages) {
      if (msg.role === 'assistant' && msg.toolCall?.id && msg.toolCall?.name) {
        validToolUseIds.add(msg.toolCall.id)
      }
    }
    const anthropicMessages = mergeAdjacentRoles(
      messages
        .map((m) => messageToAnthropic(m, validToolUseIds))
        .filter((m): m is AnthropicMessageParam => m !== null),
    )

    const streamParams: Record<string, unknown> = {
      model: options?.model ?? this.model,
      max_tokens: options?.maxTokens ?? 4096,
      messages: anthropicMessages,
      system: options?.systemPrompt,
    }

    if (options?.thinkingConfig) {
      Object.assign(streamParams, options.thinkingConfig)
    }

    if (options?.tools && options.tools.length > 0) {
      streamParams['tools'] = options.tools.map(toolToAnthropic)
    }

    // Use the messages.stream() helper available in v0.20
    const stream = (this.client.messages as unknown as {
      stream: (params: Record<string, unknown>) => {
        [Symbol.asyncIterator](): AsyncIterator<{
          type: string
          delta?: { type: string; text?: string }
        }>
        finalMessage(): Promise<{
          usage: { input_tokens: number; output_tokens: number }
          model: string
        }>
      }
    }).stream(streamParams)

    for await (const event of stream as any) {
      if (event.type === 'content_block_delta') {
        if (event.delta?.type === 'text_delta' && event.delta.text) {
          yield { content: event.delta.text, done: false }
        } else if ((event.delta?.type === 'thinking_delta' || event.delta?.type === options?.responseThinkingField) && (event.delta.thinking || event.delta[options?.responseThinkingField || 'thinking'])) {
          yield { reasoningContent: event.delta.thinking || event.delta[options?.responseThinkingField || 'thinking'], done: false }
        }
      }
    }

    const finalMessage = await stream.finalMessage()
    yield {
      done: true,
      promptTokens: finalMessage.usage.input_tokens,
      completionTokens: finalMessage.usage.output_tokens,
      model: finalMessage.model,
    }
  }

  countTokens(content: string | any[]): number {
    return estimateTokens(content)
  }
}