import { applyThinkingPreference } from './thinking.js'
import { observeRequest, observeStreamRequest, anthropicUsage } from './request-attempt.js'
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
 * Anthropic-compatible gateways may expose a larger context window than the
 * provider's output parameter accepts. DeepSeek V4's Anthropic endpoint, for
 * example, rejects max_tokens above 393216. This is a wire-protocol ceiling,
 * not an engine-side Code-mode budget.
 */
const MAX_ANTHROPIC_OUTPUT_TOKENS = 393_216

function normalizeOutputTokenLimit(value: number | undefined, fallback: number): number {
  const candidate = Number.isFinite(value) ? Math.floor(value!) : fallback
  return Math.max(1, Math.min(MAX_ANTHROPIC_OUTPUT_TOKENS, candidate))
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
        } else if (parsed.dataUrlStripped) {
          toolContent = parsed.hasDataUrl === false
            ? `图片文件 ${parsed.filename || 'image'} 已读取，但图像内容未写入上下文。需要像素级检查时请改用 OCR 或较小图片。`
            : `图片文件 ${parsed.filename || 'image'} 已读取，图像内容已通过视觉通道提供。`
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

  // Anthropic has no system role inside messages. Compacted history belongs
  // in the conversation, without replacing the request's system prompt.
  if (msg.role === 'system') {
    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
    return { role: 'user', content: `[Historical context]\n${content}` }
  }

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

  constructor(readonly model: string = 'claude-3-5-sonnet-20241022', apiKey?: string, baseURL?: string, defaultHeaders?: Record<string, string>) {
    const hasTokenAuth = defaultHeaders && 'X-Access-Token' in defaultHeaders
    this.client = new Anthropic({
      apiKey: apiKey || process.env.ANTHROPIC_API_KEY,
      maxRetries: 0,
      baseURL: baseURL || process.env.ANTHROPIC_BASE_URL,
      // X-Access-Token 鉴权：通过自定义 fetch 移除 SDK 自动生成的 X-API-Key 头，
      // 并手动注入全部自定义头，避免上游报 "duplicated valid auth method"。
      ...(hasTokenAuth ? {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fetch: (async (url: any, init?: any) => {
          const headers = new Headers(init?.headers)
          headers.delete('X-API-Key')
          for (const [k, v] of Object.entries(defaultHeaders!)) {
            headers.set(k, v)
          }
          return globalThis.fetch(url as RequestInfo | URL, { ...init, headers })
        }) as any
      } : (defaultHeaders && Object.keys(defaultHeaders).length ? { defaultHeaders } : {}))
    })
  }

  async complete(messages: Message[], options?: LLMAdapterOptions): Promise<LLMResponse> {
    options = applyThinkingPreference(options, this.provider, options?.model ?? this.model)
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

    const requestedMaxTokens = options?.maxTokens
      ?? (options?.unboundedOutput
        // Anthropic-compatible DeepSeek V4 gateways require a positive
        // max_tokens field. Keep this at the wire maximum instead of using
        // the estimated remaining context, which can silently become 400
        // near a full context window. Context admission/compaction belongs to
        // the agent loop; this is only the provider protocol ceiling.
        ? MAX_ANTHROPIC_OUTPUT_TOKENS
        : 4096)
    const maxTokens = normalizeOutputTokenLimit(requestedMaxTokens, MAX_ANTHROPIC_OUTPUT_TOKENS)
    const params: Record<string, unknown> = {
      model: options?.model ?? this.model,
      max_tokens: maxTokens,
      messages: anthropicMessages,
      system: options?.systemPrompt,
    }

    if (options?.thinkingConfig) {
      Object.assign(params, options.thinkingConfig)
    }

    if (options?.tools && options.tools.length > 0) {
      params['tools'] = options.tools.map(toolToAnthropic)
    }

    type CreateFn = (p: Record<string, unknown>, requestOptions: { signal?: AbortSignal }) => Promise<{
      content: Array<{
        type: string
        text?: string
        thinking?: string
        reasoning?: string
        reasoning_content?: string
        id?: string
        name?: string
        input?: unknown
        [key: string]: unknown
      }>
      usage: { 
        input_tokens: number; 
        output_tokens: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
      }
      stop_reason: string | null
    }>
    const response = await observeRequest(() => (this.client.messages.create as unknown as CreateFn)(params, { signal: options?.signal }), { ...options, model: String(params.model), requestInputTokenEstimate: Math.max(options?.requestInputTokenEstimate ?? 0, estimateTokens(JSON.stringify({ messages: params.messages, tools: params.tools, system: params.system }))) }, this.provider, String(params.model), value => anthropicUsage(value.usage))

    let content = ''
    let reasoningContent = ''
    const toolCalls: LLMResponse['toolCalls'] = []

    for (const block of response.content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        content += block.text
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id ?? '',
          name: block.name ?? '',
          args: block.input as Record<string, unknown>,
        })
      } else if (
        block.type === 'thinking'
        || block.type === 'redacted_thinking'
        || block.type === 'reasoning'
        || block.type === 'reasoning_content'
        || (options?.responseThinkingField && block.type === options.responseThinkingField)
      ) {
        // Different Anthropic-compatible gateways use different names for the
        // hidden block. Keep it diagnostic-only; utility callers must never
        // expose reasoning as the generated visible text.
        const field = options?.responseThinkingField && block.type === options.responseThinkingField
          ? options.responseThinkingField
          : block.type === 'reasoning_content'
            ? 'reasoning_content'
            : block.type === 'reasoning'
              ? 'reasoning'
              : 'thinking'
        const hidden = block[field]
        if (typeof hidden === 'string') reasoningContent += hidden
      }
    }

    const cacheHitTokens = response.usage.cache_read_input_tokens
    const cacheMissTokens = response.usage.cache_creation_input_tokens

    return {
      content,
      reasoningContent: reasoningContent || undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      promptTokens: anthropicUsage(response.usage)!.promptTokens,
      completionTokens: response.usage.output_tokens,
      finishReason: response.stop_reason === 'tool_use' ? 'tool_calls' :
                    response.stop_reason === 'max_tokens' ? 'length' : 'stop',
      model: (response as any).model,
      ...(cacheHitTokens != null ? { cacheHitTokens } : {}),
      ...(cacheMissTokens != null ? { cacheMissTokens } : {}),
    }
  }

  async *stream(messages: Message[], options?: LLMAdapterOptions): AsyncIterable<LLMStreamChunk> {
    options = applyThinkingPreference(options, this.provider, options?.model ?? this.model)
    // Two-pass orphan filtering (same as complete())
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

    const requestedStreamMaxTokens = options?.maxTokens
      ?? (options?.unboundedOutput
        ? MAX_ANTHROPIC_OUTPUT_TOKENS
        : 4096)
    const streamMaxTokens = normalizeOutputTokenLimit(requestedStreamMaxTokens, MAX_ANTHROPIC_OUTPUT_TOKENS)
    const streamParams: Record<string, unknown> = {
      model: options?.model ?? this.model,
      max_tokens: streamMaxTokens,
      messages: anthropicMessages,
      system: options?.systemPrompt,
    }

    if (options?.thinkingConfig) {
      Object.assign(streamParams, options.thinkingConfig)
    }

    if (options?.tools && options.tools.length > 0) {
      streamParams['tools'] = options.tools.map(toolToAnthropic)
    }

    // 流式 tool_use 组装：content_block_start 带 id/name，
    // 后续 input_json_delta 追加参数，content_block_stop 时上报
    const pendingTools = new Map<
      number,
      { id: string; name: string; args: string }
    >()

    // Use the messages.stream() helper available in v0.20
    let stream: ReturnType<(typeof createStream)>
    const createStream = () => (this.client.messages as unknown as {
      stream: (params: Record<string, unknown>, requestOptions: { signal?: AbortSignal }) => {
        abort(): void
        [Symbol.asyncIterator](): AsyncIterator<{
          type: string
          delta?: { type: string; text?: string }
        }>
        finalMessage(): Promise<{
          usage: { 
            input_tokens: number; 
            output_tokens: number;
            cache_creation_input_tokens?: number;
            cache_read_input_tokens?: number;
          }
          model: string
          stop_reason: string | null
        }>
      }
    }).stream(streamParams, { signal: options?.signal })

    const observed = await observeStreamRequest(async () => {
      stream = createStream()
      return stream
    }, { ...options, model: String(streamParams.model), requestInputTokenEstimate: Math.max(options?.requestInputTokenEstimate ?? 0, estimateTokens(JSON.stringify({ messages: streamParams.messages, tools: streamParams.tools, system: streamParams.system }))) }, this.provider, String(streamParams.model), (event, previous) => {
      const frame = event as {type: string; message?: {usage?: unknown}; usage?: unknown}
      return anthropicUsage(frame.type === 'message_start' ? frame.message?.usage : frame.usage, previous)
    })
    try {
    for await (const event of observed as any) {
      if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
        pendingTools.set(event.index, {
          id: event.content_block.id ?? '',
          name: event.content_block.name ?? '',
          args: ''
        })
      } else if (event.type === 'content_block_delta') {
        if (event.delta?.type === 'text_delta' && event.delta.text) {
          yield { content: event.delta.text, done: false }
        } else if ((event.delta?.type === 'thinking_delta' || event.delta?.type === options?.responseThinkingField) && (event.delta.thinking || event.delta[options?.responseThinkingField || 'thinking'])) {
          yield { reasoningContent: event.delta.thinking || event.delta[options?.responseThinkingField || 'thinking'], done: false }
        } else if (event.delta?.type === 'input_json_delta') {
          const tool = pendingTools.get(event.index)
          if (tool && event.delta.partial_json) tool.args += event.delta.partial_json
        }
      } else if (event.type === 'content_block_stop' && pendingTools.has(event.index)) {
        const tool = pendingTools.get(event.index)!
        pendingTools.delete(event.index)
        if (tool.id && tool.name) {
          yield {
            content: '',
            done: false,
            toolCalls: [
              {
                id: tool.id,
                name: tool.name,
                args: tool.args || '{}',
                index: event.index
              }
            ]
          }
        }
      }
    }

    const finalMessage = await stream!.finalMessage()
    const cacheHitTokens = finalMessage.usage.cache_read_input_tokens
    const cacheMissTokens = finalMessage.usage.cache_creation_input_tokens

    yield {
      done: true,
      finishReason: finalMessage.stop_reason === 'max_tokens' ? 'length' : finalMessage.stop_reason === 'tool_use' ? 'tool_calls' : 'stop',
      promptTokens: anthropicUsage(finalMessage.usage)!.promptTokens,
      completionTokens: finalMessage.usage.output_tokens,
      model: finalMessage.model,
      ...(cacheHitTokens != null ? { cacheHitTokens } : {}),
      ...(cacheMissTokens != null ? { cacheMissTokens } : {}),
    }
    } finally { stream!.abort() }
  }

  countTokens(content: string | any[]): number {
    return estimateTokens(content)
  }
}
