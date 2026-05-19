import OpenAI from 'openai'
import type { LLMAdapter, LLMResponse, LLMAdapterOptions, LLMStreamChunk } from './types.js'
import type { Message, Tool } from '../agent-context/index.js'
import { estimateTokens } from '../utils/tokens.js'

/**
 * Normalize a base URL for use with the OpenAI SDK.
 * The OpenAI SDK appends `/chat/completions` to the baseURL, so the URL
 * must end with `/v1` (or a versioned path). This function:
 *   1. Strips trailing slashes
 *   2. Strips known SDK-appended suffixes like `/chat/completions`,
 *      `/embeddings`, `/completions`, `/models` etc. so users can paste
 *      a full endpoint URL and it still works.
 *   3. Appends `/v1` if no version segment is present.
 *
 * Examples:
 *   https://api.example.com                          → https://api.example.com/v1
 *   https://api.example.com/                         → https://api.example.com/v1
 *   https://api.example.com/v1                       → https://api.example.com/v1  (unchanged)
 *   https://api.example.com/v1/                      → https://api.example.com/v1  (trailing slash removed)
 *   https://api.example.com/v1/chat/completions      → https://api.example.com/v1  (suffix stripped)
 *   https://api.example.com/v1/chat/completions/     → https://api.example.com/v1  (suffix stripped)
 *   https://api.example.com/v2                       → https://api.example.com/v2  (unchanged)
 *   https://api.example.com/api/v1                   → https://api.example.com/api/v1 (unchanged)
 *   https://api.example.com/v1/embeddings            → https://api.example.com/v1  (suffix stripped)
 */
function normalizeBaseURL(url: string | undefined): string | undefined {
  if (!url) return url
  // Remove trailing slash
  let trimmed = url.replace(/\/+$/, '')
  // Strip known OpenAI SDK endpoint suffixes that users may accidentally include.
  // Order matters: check longest patterns first.
  const sdkSuffixes = [
    '/chat/completions',
    '/completions',
    '/embeddings',
    '/models',
    '/images/generations',
    '/audio/transcriptions',
    '/audio/translations',
  ]
  for (const suffix of sdkSuffixes) {
    if (trimmed.endsWith(suffix)) {
      trimmed = trimmed.slice(0, -suffix.length)
      break
    }
  }
  // Remove any trailing slash left after stripping
  trimmed = trimmed.replace(/\/+$/, '')
  // If already ends with a version segment like /v1, /v2, /v3 … leave it as-is
  if (/\/v\d+$/.test(trimmed)) return trimmed
  // Otherwise append /v1
  return `${trimmed}/v1`
}

/**
 * Convert Message[] to OpenAI format with orphan-filtering:
 * - Collect all valid tool_call IDs emitted by assistant messages
 * - Drop any tool-result messages whose tool_call_id has no matching assistant tool_call
 * This prevents "unexpected tool_use_id" errors from Claude-via-OpenAI-proxy adapters.
 */
function messagesToOpenAI(
  messages: Message[],
  supportsVision: boolean = true,
): OpenAI.Chat.ChatCompletionMessageParam[] {
  // First pass: collect all valid tool_call IDs (with non-empty id & name)
  // AND collect all tool result IDs from tool messages
  const validToolCallIds = new Set<string>()
  const validToolResultIds = new Set<string>()

  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.toolCall) {
      const id = msg.toolCall.id || ''
      const name = msg.toolCall.name || ''
      if (id && name) {
        validToolCallIds.add(id)
      }
    }
    if (msg.role === 'tool' && msg.toolCallId) {
      validToolResultIds.add(msg.toolCallId)
    }
  }

  // Second pass: convert, dropping orphaned tool results AND orphaned tool calls
  const result: OpenAI.Chat.ChatCompletionMessageParam[] = []
  // 将消息内容转换为纯文本（不支持多模态的模型）
  function contentToString(content: any): string {
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      const texts: string[] = []
      for (const part of content) {
        if (part.type === 'text') texts.push(part.text ?? '')
        else if (part.type === 'image_url') texts.push('[Image]')
        // workspace_image/workspace_file 已在消息入口处自动处理，此处仅作为历史消息兼容
      }
      return texts.filter(Boolean).join('\n')
    }
    return String(content ?? '')
  }

  // 将消息内容转换为 OpenAI 多模态数组（支持 image_url）
  function contentToMultimodal(content: any, supportsVision: boolean = true): string | OpenAI.Chat.ChatCompletionContentPart[] {
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return String(content ?? '')
    const parts: OpenAI.Chat.ChatCompletionContentPart[] = []

    for (const part of content) {
      if (part.type === 'text') {
        parts.push({ type: 'text', text: part.text ?? '' })
      } else if (part.type === 'image_url') {
        // 只有支持视觉的模型才保留 image_url，否则转换为文本描述
        if (supportsVision) {
          parts.push({ type: 'image_url', image_url: { url: part.image_url?.url ?? '' } })
        } else {
          parts.push({ type: 'text', text: '[Image]' })
        }
      }
      // workspace_image/workspace_file 已在消息入口处自动处理
      // 'file' type (legacy with full content): skip，避免 base64/大文本污染上下文
    }

    if (parts.length === 0) return ''
    return parts.length === 1 && parts[0].type === 'text'
      ? (parts[0] as OpenAI.Chat.ChatCompletionContentPartText).text
      : parts
  }
  
  for (const msg of messages) {
    if (msg.role === 'tool') {
      const tcId = msg.toolCallId ?? ''
      // Drop orphaned tool results (no matching assistant tool_call)
      if (tcId && !validToolCallIds.has(tcId)) {
        continue
      }

      // 特殊处理 smart_read / read_image 工具结果：提取 dataUrl，以 image_url 形式注入 user 消息
      // （OpenAI 不支持在 tool message 里直接传图片，需要用 user 消息包装）
      const rawToolContent = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
      let imageInjected = false
      try {
        const parsed = JSON.parse(rawToolContent)
        console.log(`[openai.ts] read_image tool result parse attempt:`, {
          hasDataUrl: !!parsed?.dataUrl,
          dataUrlPrefix: parsed?.dataUrl ? String(parsed.dataUrl).slice(0, 30) : null,
          filename: parsed?.filename,
          mimeType: parsed?.mimeType,
          size: parsed?.size,
          rawLength: rawToolContent.length,
        })
        if (parsed?.dataUrl && typeof parsed.dataUrl === 'string' && parsed.dataUrl.startsWith('data:image/')) {
          // 先正常返回 tool result（不含 base64，太大）
          result.push({
            role: 'tool',
            tool_call_id: tcId,
            content: `Image "${parsed.filename ?? 'image'}" (${parsed.mimeType ?? ''}, ${parsed.size ?? 0} bytes) loaded successfully.`,
          })
          // 再注入 user 消息让 AI 真正看到图片（视觉理解）
          // 明确标注文件名，避免多图场景下 LLM 混淆
          // 只有支持视觉的模型才注入 image_url，否则用纯文本描述
          if (supportsVision) {
            const injectedMsg = {
              role: 'user' as const,
              content: [
                { type: 'text', text: `Here is the image file "${parsed.filename ?? 'image'}" you just read:` },
                { type: 'image_url', image_url: { url: parsed.dataUrl } },
              ] as OpenAI.Chat.ChatCompletionContentPart[],
            }
            result.push(injectedMsg)
            console.log(`[openai.ts] ✅ Image injected as user message for "${parsed.filename}", dataUrl length: ${parsed.dataUrl.length}, parts: ${injectedMsg.content.length}`)
          } else {
            console.log(`[openai.ts] ⚠️ Model does not support vision, skipping image_url injection`)
          }
          imageInjected = true
        } else {
          console.log(`[openai.ts] ⚠️ tool result is NOT a read_image dataUrl, treating as plain text. keys:`, Object.keys(parsed ?? {}))
        }
      } catch (e) {
        console.log(`[openai.ts] ⚠️ tool result JSON parse failed:`, (e as Error).message, 'raw prefix:', rawToolContent.slice(0, 100))
      }
      if (!imageInjected) {
        result.push({
          role: 'tool',
          tool_call_id: tcId,
          content: contentToString(msg.content),
        })
      }
      continue
    }
    if (msg.role === 'assistant' && msg.toolCall) {
      const id = msg.toolCall.id || ''
      const name = msg.toolCall.name || ''
      
      // If the tool call is broken OR it has no matching tool result,
      // emit it as plain assistant text to avoid OpenAI 400 error.
      if (!id || !name || !validToolResultIds.has(id)) {
        let fallbackContent = contentToString(msg.content || '')
        // Optionally append the tool call intent to content so context isn't fully lost
        if (name && !fallbackContent.includes(name)) {
           const argsStr = JSON.stringify(msg.toolCall.args || {})
           fallbackContent += `\n[Intended to call tool: ${name} with args: ${argsStr}, but was interrupted]`
        }
        result.push({
          role: 'assistant',
          content: fallbackContent || '(no content)',
          ...((msg as any).reasoningContent != null ? { reasoning_content: (msg as any).reasoningContent } : {})
        })
        continue
      }
      result.push({
        role: 'assistant',
        content: contentToString(msg.content ?? null),
        ...((msg as any).reasoningContent != null ? { reasoning_content: (msg as any).reasoningContent } : {}),
        tool_calls: [{
          id,
          type: 'function',
          function: {
            name,
            arguments: JSON.stringify(msg.toolCall.args),
          },
        }],
      })
      continue
    }

    // user/assistant/system 消息：支持多模态数组（image_url / workspace_image）
    const finalContent = contentToMultimodal(msg.content, supportsVision)
    if (msg.role === 'assistant') {
      result.push({
        role: 'assistant' as const,
        content: finalContent as any,
        ...((msg as any).reasoningContent != null ? { reasoning_content: (msg as any).reasoningContent } : {})
      })
    } else if (msg.role === 'user') {
      result.push({
        role: 'user' as const,
        content: finalContent as string | OpenAI.Chat.ChatCompletionContentPart[],
      })
    } else {
      result.push({
        role: 'system' as const,
        content: finalContent as string,
      })
    }
  }
  // 最终消息列表摘要日志
  const msgSummary = result.map((m, i) => {
    const role = m.role
    const content = m.content
    if (Array.isArray(content)) {
      const types = content.map((p: any) => p.type).join('+')
      const hasImage = content.some((p: any) => p.type === 'image_url')
      return `[${i}] ${role}: [${types}]${hasImage ? ' ← IMAGE ✅' : ''}`
    }
    const preview = typeof content === 'string' ? content.slice(0, 60).replace(/\n/g, '\\n') : String(content).slice(0, 60)
    return `[${i}] ${role}: "${preview}"`
  })
  console.log(`[openai.ts] messagesToOpenAI result (${result.length} messages):\n` + msgSummary.join('\n'))

  return result
}

function toolToOpenAI(tool: Tool): OpenAI.Chat.ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as Record<string, unknown>,
    },
  }
}

// ─── Qwen/vLLM fallback: parse <tool_call> XML from text content ─────────────
// Some OpenAI-compatible endpoints (Qwen, vLLM) emit tool calls as text blocks
// instead of structured tool_calls JSON. This parser handles that case.
interface ParsedToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

// Parameter-key → tool-name heuristics for when the model emits <function=> with empty name
const PARAM_TO_TOOL_HEURISTICS: Array<{ keys: string[]; tool: string }> = [
  { keys: ['command'],              tool: 'run_skill_script' },
  { keys: ['key', 'value'],         tool: 'remember' },
  { keys: ['key'],                  tool: 'recall' },
  { keys: ['path', 'content'],      tool: 'write_file' },
  { keys: ['path'],                 tool: 'smart_read' },
  { keys: ['query'],                tool: 'search_memory' },
  { keys: ['name'],                 tool: 'get_skill' },
]

function inferToolName(args: Record<string, unknown>): string {
  const paramKeys = Object.keys(args)
  for (const { keys, tool } of PARAM_TO_TOOL_HEURISTICS) {
    if (keys.every((k) => paramKeys.includes(k))) return tool
  }
  // No params → list_skills
  if (paramKeys.length === 0) return 'list_skills'
  return ''
}

function parseXmlToolCalls(content: string): ParsedToolCall[] {
  const results: ParsedToolCall[] = []
  const blockRe = /<tool_call>([\s\S]*?)<\/tool_call>/g
  let blockMatch: RegExpExecArray | null

  while ((blockMatch = blockRe.exec(content)) !== null) {
    const block = blockMatch[1]

    // ① Try JSON format: {"name":"...","arguments":{...}}
    try {
      const json = JSON.parse(block.trim()) as { name?: string; arguments?: Record<string, unknown> }
      if (json.name) {
        results.push({
          id: `call_${Date.now()}_${results.length}`,
          name: json.name,
          args: json.arguments ?? {},
        })
        continue
      }
    } catch { /* not JSON */ }

    // ② XML format: <function=toolName> or <function=> (empty name)
    const fnMatch = /<function=([^>]*)>([\s\S]*?)<\/function>/.exec(block)
    if (fnMatch) {
      const rawName = fnMatch[1].trim()
      const body = fnMatch[2]
      const args: Record<string, unknown> = {}

      const paramRe = /<parameter=([^>]+)>([\s\S]*?)<\/parameter>/g
      let paramMatch: RegExpExecArray | null
      while ((paramMatch = paramRe.exec(body)) !== null) {
        const key = paramMatch[1].trim()
        const val = paramMatch[2].trim()
        try { args[key] = JSON.parse(val) } catch { args[key] = val }
      }

      // Use explicit name, or infer from parameters when name is empty
      const name = rawName || inferToolName(args)
      if (name) {
        results.push({ id: `call_${Date.now()}_${results.length}`, name, args })
      }
    }
  }

  return results
}

/** Strip <tool_call>...</tool_call> blocks from content */
function stripToolCallBlocks(content: string): string {
  return content.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim()
}

/** 占位符：当 apiKey 未配置时传给 SDK，避免构造函数提前抛出。真正调用 API 前会做业务校验。 */
const OPENAI_KEY_PLACEHOLDER = '__NOT_SET__'

export class OpenAIAdapter implements LLMAdapter {
  readonly provider: string = 'openai'
  readonly supportsVision: boolean
  private client: OpenAI
  /** 真实有效的 apiKey（不含占位符），用于调用前校验 */
  private readonly resolvedApiKey: string | undefined

  constructor(readonly model: string = 'gpt-4o-mini', apiKey?: string, baseURL?: string) {
    const rawBaseURL = baseURL || process.env.OPENAI_BASE_URL
    this.resolvedApiKey = apiKey || process.env.OPENAI_API_KEY || undefined
    this.client = new OpenAI({
      // 当 key 未设置时传占位符，绕过 SDK 构造函数的非空校验。
      // 真正发起请求前会在 complete()/stream() 里做业务检查，给出更友好的错误。
      apiKey: this.resolvedApiKey ?? OPENAI_KEY_PLACEHOLDER,
      baseURL: normalizeBaseURL(rawBaseURL), // supports custom OpenAI-compatible endpoints
    })
    this.supportsVision = this.detectVisionSupport(rawBaseURL)
  }

  /** 在调用 LLM API 之前检查 apiKey 是否已配置，未配置则抛出可读错误 */
  private assertApiKey(): void {
    if (!this.resolvedApiKey) {
      throw new Error(
        'OpenAI API Key 未配置。请在设置页面填写 API Key，或联系管理员在 system_config 中设置 OPENAI_API_KEY。'
      )
    }
  }

  private detectVisionSupport(baseURL?: string): boolean {
    const url = (baseURL || process.env.OPENAI_BASE_URL || '').toLowerCase()
    const modelLower = this.model.toLowerCase()
    if (url.includes('anthropic')) return false
    if (url.includes('ollama')) return false
    if (url.includes('qwen')) return false
    if (url.includes('moonshot')) return false
    if (url.includes('zhipu')) return false
    if (url.includes('deepseek')) return false
    if (modelLower.includes('deepseek')) return false
    return true
  }

  async complete(messages: Message[], options?: LLMAdapterOptions): Promise<LLMResponse> {
    this.assertApiKey()
    const oaiMessages = messagesToOpenAI(messages, this.supportsVision)
    if (options?.systemPrompt) {
      oaiMessages.unshift({ role: 'system', content: options.systemPrompt })
    }

    // ── DeepSeek Chat Prefix Completion (β) ────────────────────────────────
    // 在最后一条 assistant 上加 prefix:true，引导模型从指定文本开始续写
    if (options?.prefix) {
      oaiMessages.push({
        role: 'assistant',
        content: options.prefix,
        // @ts-expect-error DeepSeek 私有字段
        prefix: true,
      })
    }

    const params: any = {
      model: options?.model ?? this.model,
      messages: oaiMessages,
      max_tokens: options?.maxTokens,
      temperature: options?.temperature,
    }

    // ── DeepSeek JSON Mode（OpenAI 也兼容此协议） ──────────────────────────
    if (options?.responseFormat === 'json') {
      params.response_format = { type: 'json_object' }
    }

    if (options?.thinkingConfig) {
      Object.assign(params, options.thinkingConfig)
    }

    if (options?.tools && options.tools.length > 0) {
      params.tools = options.tools.map(toolToOpenAI)
      params.tool_choice = 'auto'
    }
    const response = await this.client.chat.completions.create(params, {
      signal: options?.signal,
    })
    const choice = response.choices[0]
    const message = choice.message

    // Primary: structured tool_calls from API
    let toolCalls = message.tool_calls?.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      args: JSON.parse(tc.function.arguments) as Record<string, unknown>,
    }))

    // Fallback: Qwen/vLLM may embed tool calls as <tool_call> XML in content
    const rawContent = message.content ?? ''
    if ((!toolCalls || toolCalls.length === 0) && rawContent.includes('<tool_call>')) {
      const xmlCalls = parseXmlToolCalls(rawContent)
      if (xmlCalls.length > 0) {
        toolCalls = xmlCalls
      }
    }

    // Strip <tool_call> blocks from visible content
    const cleanContent = toolCalls && toolCalls.length > 0
      ? stripToolCallBlocks(rawContent)
      : rawContent

    const reasoningContent = options?.responseThinkingField 
      ? (message as any)[options.responseThinkingField] 
      : (message as any).reasoning_content

    // 处理缓存token：在 OpenAI / DeepSeek 协议中，usage.prompt_tokens 已经是总输入 token 数
    //（包含了命中缓存的部分）。之前的代码错误地又加了一次 cached_tokens 导致重复计算。
    const usage = response.usage
    const promptTokens = usage?.prompt_tokens ?? 0

    // ── DeepSeek 专有 usage 字段（其他 provider 自动为 undefined）──────────
    // 1. KV Cache 命中：prompt_cache_hit_tokens / prompt_cache_miss_tokens (旧)
    //    或 prompt_tokens_details.cached_tokens (新, V4)
    // 2. R1/V3 thinking：completion_tokens_details.reasoning_tokens
    const cacheHitTokens =
      (usage as any)?.prompt_cache_hit_tokens ??
      (usage as any)?.prompt_tokens_details?.cached_tokens ??
      undefined
    const cacheMissTokens =
      (usage as any)?.prompt_cache_miss_tokens ??
      (cacheHitTokens != null
        ? Math.max(0, (usage?.prompt_tokens ?? 0) - (cacheHitTokens as number))
        : undefined)
    const reasoningTokens =
      (usage as any)?.completion_tokens_details?.reasoning_tokens ?? undefined

    return {
      content: cleanContent,
      reasoningContent,
      toolCalls,
      promptTokens,
      completionTokens: usage?.completion_tokens ?? 0,
      finishReason: (choice.finish_reason === 'tool_calls' || (toolCalls && toolCalls.length > 0)
        ? 'tool_calls'
        : choice.finish_reason === 'length' ? 'length' : 'stop'),
      ...(cacheHitTokens != null ? { cacheHitTokens } : {}),
      ...(cacheMissTokens != null ? { cacheMissTokens } : {}),
      ...(reasoningTokens != null ? { reasoningTokens } : {}),
      model: response.model,
    }
  }

  async *stream(messages: Message[], options?: LLMAdapterOptions): AsyncIterable<LLMStreamChunk> {
    this.assertApiKey()
    const oaiMessages = messagesToOpenAI(messages, this.supportsVision)
    if (options?.systemPrompt) {
      oaiMessages.unshift({ role: 'system', content: options.systemPrompt })
    }

    // ── DeepSeek Chat Prefix Completion (β) ────────────────────────────────
    if (options?.prefix) {
      oaiMessages.push({
        role: 'assistant',
        content: options.prefix,
        // @ts-expect-error DeepSeek 私有字段
        prefix: true,
      })
    }

    const params: any = {
      model: options?.model ?? this.model,
      messages: oaiMessages,
      stream: true,
      max_tokens: options?.maxTokens,
      temperature: options?.temperature,
    }

    // 默认开启 stream_options.include_usage（DeepSeek/OpenAI 均支持，
    // 否则流式调用拿不到 usage / cached_tokens / reasoning_tokens）
    if (options?.includeStreamUsage !== false) {
      params.stream_options = { include_usage: true }
    }

    // DeepSeek JSON Mode
    if (options?.responseFormat === 'json') {
      params.response_format = { type: 'json_object' }
    }

    if (options?.thinkingConfig) {
      Object.assign(params, options.thinkingConfig)
    }

    if (options?.tools && options.tools.length > 0) {
      params.tools = options.tools.map(toolToOpenAI)
    }

    // beta.chat.completions.stream provides the streaming helper with finalMessage()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const betaClient = this.client.beta as any
    const stream = betaClient.chat.completions.stream(params)

    for await (const chunk of stream) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const delta = (chunk as any).choices?.[0]?.delta
      if (!delta) continue

      if (delta.content || 
          (options?.responseThinkingField ? (delta as any)[options.responseThinkingField] : (delta as any).reasoning_content) ||
          delta.tool_calls) {
        yield { 
          content: delta.content as string, 
          reasoningContent: options?.responseThinkingField 
            ? (delta as any)[options.responseThinkingField] as string 
            : (delta as any).reasoning_content as string,
          toolCalls: delta.tool_calls?.map((tc: any) => ({
            id: tc.id,
            name: tc.function?.name,
            args: tc.function?.arguments, // 这里传的是 string delta
            index: tc.index,
          })),
          done: false 
        }
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const finalMessage = await (stream as any).finalMessage()
    const finalUsage = finalMessage?.usage
    const finalPromptTokens = finalUsage?.prompt_tokens ?? 0

    // ── DeepSeek 私有 usage 字段透传 ───────────────────────────────────────
    const cacheHitTokens =
      (finalUsage as any)?.prompt_cache_hit_tokens ??
      (finalUsage as any)?.prompt_tokens_details?.cached_tokens ??
      undefined
    const cacheMissTokens =
      (finalUsage as any)?.prompt_cache_miss_tokens ?? undefined
    const reasoningTokens =
      (finalUsage as any)?.completion_tokens_details?.reasoning_tokens ?? undefined

    yield {
      done: true,
      promptTokens: finalPromptTokens,
      completionTokens: finalUsage?.completion_tokens ?? 0,
      ...(cacheHitTokens != null ? { cacheHitTokens } : {}),
      ...(cacheMissTokens != null ? { cacheMissTokens } : {}),
      ...(reasoningTokens != null ? { reasoningTokens } : {}),
      model: finalMessage?.model,
    }
  }

  countTokens(text: string | any[]): number {
    return estimateTokens(text)
  }
}
