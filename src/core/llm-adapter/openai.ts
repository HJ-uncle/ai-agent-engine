import OpenAI from 'openai'
import type { LLMAdapter, LLMResponse, LLMAdapterOptions, LLMStreamChunk, EmbedOptions } from './types.js'
import type { Message, Tool } from '../agent-context/index.js'
import { estimateTokens } from '../utils/tokens.js'
import { repairJson } from '../utils/json.js'

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
/**
 * thinking-mode 占位文本：部分网关（如网易 AIGW deepseek-v4-pro）要求带 tool_calls
 * 的 assistant 消息在回传时必须包含【非空】reasoning_content，否则返回
 * 400 "The reasoning_content in the thinking mode must be passed back to the API."
 * 历史消息缺失 / 空值时用此占位补齐，保证多轮工具调用不被网关拒绝。
 */
const THINKING_PLACEHOLDER = '(reasoning omitted)'

/**
 * @description 计算 assistant 消息回传时应使用的 reasoning_content。
 *   仅在 thinking mode（ensureReasoning=true）下兜底为非空占位。
 * @param raw 原始 reasoningContent（可能为 undefined / 空串）
 * @param ensureReasoning 是否强制保证非空（thinking mode 开启时为 true）
 * @returns 需要回传的字段对象（不需要回传时为空对象）
 */
function buildReasoningField(
  raw: unknown,
  ensureReasoning: boolean,
): { reasoning_content?: string } {
  const text = typeof raw === 'string' ? raw : raw != null ? String(raw) : ''
  if (text.trim()) return { reasoning_content: text }
  if (ensureReasoning) return { reasoning_content: THINKING_PLACEHOLDER }
  return {}
}

/**
 * @description 判断当前请求是否启用了 thinking mode。
 *   依据 thinkingConfig 或 responseThinkingField 是否存在。
 */
function isThinkingMode(options?: LLMAdapterOptions): boolean {
  return !!(options?.thinkingConfig || options?.responseThinkingField)
}

/**
 * @description 判断指定模型是否【不支持】自定义 temperature 参数。
 *   OpenAI 推理系（o1 / o3 / o4 / gpt-5 及其变体）只接受默认 temperature，
 *   显式传入会返回 400 "Unsupported parameter: 'temperature' is not supported with this model."
 *   命中时调用方应从请求体中省略 temperature。
 * @param model 实际请求的模型 ID
 */
function modelRejectsTemperature(model?: string): boolean {
  if (!model) return false
  return /^(o1|o3|o4|gpt-5)([.\-]|$)/i.test(model) || /(^|[\/-])(o1|o3|o4|gpt-5)([.\-]|$)/i.test(model)
}

/**
 * @description 判断指定模型是否使用 max_completion_tokens 取代 max_tokens。
 *   与 modelRejectsTemperature 同源（OpenAI 推理系），二者约束一致。
 * @param model 实际请求的模型 ID
 */
function modelUsesMaxCompletionTokens(model?: string): boolean {
  return modelRejectsTemperature(model)
}

/**
 * @description 按模型能力组装通用采样参数（temperature / max_tokens）。
 *   推理系模型省略 temperature，并将 max_tokens 改写为 max_completion_tokens。
 * @param model 实际请求的模型 ID
 * @param temperature 调用方期望的 temperature（可能为 undefined）
 * @param maxTokens 调用方期望的 max_tokens（可能为 undefined）
 */
function buildSamplingParams(
  model: string | undefined,
  temperature: number | undefined,
  maxTokens: number | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!modelRejectsTemperature(model) && temperature != null) {
    out.temperature = temperature
  }
  if (maxTokens != null) {
    if (modelUsesMaxCompletionTokens(model)) out.max_completion_tokens = maxTokens
    else out.max_tokens = maxTokens
  }
  return out
}

/**
 * @description 从供应商 400 错误信息中识别「不支持的参数名」，用于自动剔除后重试。
 *   兼容多种网关措辞：
 *     - "Unsupported parameter: 'temperature' is not supported with this model."
 *     - "'top_p' is not supported with this model"
 *     - "Unknown parameter: 'frequency_penalty'."
 *   仅当能定位到 params 中真实存在的字段时才返回，避免误删。
 * @param message 供应商返回的错误文本
 * @param params 当前请求参数（用于校验字段确实存在）
 * @returns 可剔除的参数名；无法识别时返回 null
 */
function detectUnsupportedParam(message: string, params: Record<string, unknown>): string | null {
  if (!message) return null
  const patterns = [
    /unsupported parameter:\s*['"`]?([a-z0-9_.]+)['"`]?/i,
    /unknown parameter:\s*['"`]?([a-z0-9_.]+)['"`]?/i,
    /['"`]([a-z0-9_.]+)['"`]\s+is not supported/i,
    /parameter\s+['"`]?([a-z0-9_.]+)['"`]?\s+is not supported/i
  ]
  for (const re of patterns) {
    const m = message.match(re)
    const name = m?.[1]
    if (name && Object.prototype.hasOwnProperty.call(params, name)) {
      return name
    }
  }
  return null
}

/**
 * @description 包裹 chat.completions.create 调用，遇到「不支持的参数」类 400 时
 *   自动剔除该参数并重试，直至无可剔除参数或成功。不依赖模型名硬编码，
 *   覆盖各网关对 temperature / top_p / penalty 等参数的差异化限制。
 *   注意：reasoning_content 缺失类 400（"must be passed back"）无法靠删参解决，
 *   detectUnsupportedParam 不会命中，会原样抛出由上层处理。
 * @param client OpenAI SDK 实例
 * @param params 请求参数（会按需克隆删字段）
 * @param requestOptions create 的第二参（signal 等）
 */
async function createWithParamFallback<T>(
  client: OpenAI,
  params: Record<string, unknown>,
  requestOptions: { signal?: AbortSignal },
): Promise<T> {
  let current = { ...params }
  const dropped = new Set<string>()
  // 最多重试参数个数次，防御性上限避免死循环
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      return (await client.chat.completions.create(current as any, requestOptions)) as T
    } catch (error: any) {
      const status = error?.status ?? error?.response?.status
      if (status !== 400) throw error
      const msg: string =
        error?.error?.message ?? error?.response?.data?.error?.message ?? error?.message ?? ''
      const bad = detectUnsupportedParam(msg, current)
      if (!bad || dropped.has(bad)) throw error
      dropped.add(bad)
      const next = { ...current }
      delete next[bad]
      current = next
    }
  }
  // 兜底：再尝试一次（理论不可达）
  return (await client.chat.completions.create(current as any, requestOptions)) as T
}

/**
 * @description createWithParamFallback 的流式版本：建立 SSE 连接阶段遇到
 *   「不支持的参数」类 400 时，自动剔除该参数重试。错误在 await create 阶段抛出，
 *   不影响后续 chunk 迭代。
 * @param client OpenAI SDK 实例
 * @param params 请求参数（含 stream:true，会按需克隆删字段）
 * @param requestOptions create 的第二参（signal 等）
 */
async function streamWithParamFallback(
  client: OpenAI,
  params: Record<string, unknown>,
  requestOptions: { signal?: AbortSignal },
): Promise<AsyncIterable<OpenAI.Chat.ChatCompletionChunk>> {
  let current = { ...params }
  const dropped = new Set<string>()
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      return await client.chat.completions.create(
        current as unknown as OpenAI.Chat.ChatCompletionCreateParamsStreaming,
        requestOptions,
      )
    } catch (error: any) {
      const status = error?.status ?? error?.response?.status
      if (status !== 400) throw error
      const msg: string =
        error?.error?.message ?? error?.response?.data?.error?.message ?? error?.message ?? ''
      const bad = detectUnsupportedParam(msg, current)
      if (!bad || dropped.has(bad)) throw error
      dropped.add(bad)
      const next = { ...current }
      delete next[bad]
      current = next
    }
  }
  return await client.chat.completions.create(
    current as unknown as OpenAI.Chat.ChatCompletionCreateParamsStreaming,
    requestOptions,
  )
}

function messagesToOpenAI(
  messages: Message[],
  supportsVision: boolean = true,
  ensureReasoning: boolean = false,
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
        // null guard：第三方 API 返回的历史消息 content 数组可能含 null/undefined 元素
        if (part == null) continue
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
      // null guard：第三方 API 返回的历史消息 content 数组可能含 null/undefined 元素
      if (part == null) continue
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

      const rawToolContent = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)

      // Only attempt to parse JSON if it actually looks like JSON (starts with { or [)
      // This prevents thousands of fake warnings for normal plain text tool outputs like "Directory is empty"
      const trimmedRaw = rawToolContent.trim()
      let imageInjected = false

      if (trimmedRaw.startsWith('{') || trimmedRaw.startsWith('[')) {
        try {
          const parsed = JSON.parse(rawToolContent)
          console.log(`[openai.ts] read_image tool result parse attempt:`, {
            hasDataUrl: !!parsed?.dataUrl,
            dataUrlStripped: !!parsed?.dataUrlStripped,
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
            }
            imageInjected = true
          } else if (parsed?.dataUrlStripped) {
            // dataUrl was stripped before saving to history (too large); just emit a summary
            result.push({
              role: 'tool',
              tool_call_id: tcId,
              content: `Image "${parsed.filename ?? 'image'}" (${parsed.mimeType ?? ''}, ${parsed.size ?? 0} bytes) was read. The image content was delivered to the model via the vision channel in the previous turn.`,
            })
            imageInjected = true
            console.log(`[openai.ts] ℹ️ dataUrl stripped in history for "${parsed.filename}", emitting summary tool result`)
          } else {
            console.log(`[openai.ts] ⚠️ tool result is NOT a read_image dataUrl, treating as plain text. keys:`, Object.keys(parsed ?? {}))
          }
        } catch (e) {
          // JSON parse failed — likely the raw output was truncated mid-string (legacy path before
          // stripDataUrl was introduced).  Emit a neutral summary so the LLM doesn't hallucinate
          // from garbled base64 text.
          const filenameMatch = rawToolContent.match(/"filename"\s*:\s*"([^"]+)"/)
          const sizeMatch    = rawToolContent.match(/"size"\s*:\s*(\d+)/)
          const mimeMatch    = rawToolContent.match(/"mimeType"\s*:\s*"([^"]+)"/)
          const looksLikeImage = rawToolContent.includes('"dataUrl"') || rawToolContent.includes('data:image/')
          if (looksLikeImage) {
            const filename = filenameMatch?.[1] ?? 'image'
            const size     = sizeMatch?.[1] ?? '?'
            const mime     = mimeMatch?.[1] ?? 'image/?'
            result.push({
              role: 'tool',
              tool_call_id: tcId,
              content: `Image "${filename}" (${mime}, ${size} bytes) was read successfully. (Note: raw base64 payload omitted from history to save tokens.)`,
            })
            imageInjected = true
            console.log(`[openai.ts] ⚠️ JSON parse failed but detected image result — emitting summary for "${filename}"`)
          } else {
            console.log(`[openai.ts] ⚠️ tool result JSON parse failed:`, (e as Error).message, 'raw prefix:', rawToolContent.slice(0, 100))
          }
        }
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
        ...buildReasoningField((msg as any).reasoningContent, ensureReasoning),
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
      // nullish guard：content 数组中可能含 undefined 元素（第三方 API 返回异常格式）
      const types = content.map((p: any) => p?.type ?? 'unknown').join('+')
      const hasImage = content.some((p: any) => p?.type === 'image_url')
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

  constructor(readonly model: string = 'gpt-4o-mini', apiKey?: string, baseURL?: string, supportsVision?: boolean, defaultHeaders?: Record<string, string>) {
    const rawBaseURL = baseURL || process.env.OPENAI_BASE_URL
    this.resolvedApiKey = apiKey || process.env.OPENAI_API_KEY || undefined

    const hasTokenAuth = defaultHeaders && 'X-Access-Token' in defaultHeaders
    this.client = new OpenAI({
      // 当 key 未设置时传占位符，绕过 SDK 构造函数的非空校验。
      // 真正发起请求前会在 complete()/stream() 里做业务检查，给出更友好的错误。
      apiKey: this.resolvedApiKey ?? OPENAI_KEY_PLACEHOLDER,
      baseURL: normalizeBaseURL(rawBaseURL), // supports custom OpenAI-compatible endpoints
      // X-Access-Token 鉴权：通过自定义 fetch 移除 SDK 自动生成的 Authorization 头，
      // 并手动注入全部自定义头，避免上游报 "duplicated valid auth method"。
      // 其他场景：直接用 defaultHeaders 即可。
      ...(hasTokenAuth ? {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fetch: (async (url: any, init?: any) => {
          const headers = new Headers(init?.headers)
          headers.delete('Authorization')
          for (const [k, v] of Object.entries(defaultHeaders!)) {
            headers.set(k, v)
          }
          return globalThis.fetch(url as RequestInfo | URL, { ...init, headers })
        }) as any
      } : (defaultHeaders && Object.keys(defaultHeaders).length ? { defaultHeaders } : {}))
    })
    this.supportsVision = supportsVision ?? this.detectVisionSupport(rawBaseURL)
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
    // Qwen 视觉支持由 QwenAdapter 通过 TEXT_ONLY_MODEL_PATTERNS 精确控制，此处不再拦截
    
    // 如果是已知支持视觉的模型前缀，直接返回 true，无视域名黑名单
    if (modelLower.startsWith('gpt-4o') || modelLower.startsWith('gpt-4-turbo') || modelLower.includes('vision')) return true
    if (modelLower.includes('k2.5')) return true // Kimi k2.5 默认支持视觉

    if (url.includes('moonshot')) return false
    if (url.includes('zhipu')) return false
    if (url.includes('deepseek')) return false
    if (modelLower.includes('deepseek')) return false
    return true
  }

  async complete(messages: Message[], options?: LLMAdapterOptions): Promise<LLMResponse> {
    this.assertApiKey()
    const oaiMessages = messagesToOpenAI(messages, this.supportsVision, isThinkingMode(options))
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
      ...buildSamplingParams(options?.model ?? this.model, options?.temperature, options?.maxTokens),
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
    const response = await createWithParamFallback<OpenAI.Chat.ChatCompletion>(
      this.client,
      params,
      { signal: options?.signal },
    )
    const choice = response.choices[0]
    const message = choice.message

    // Primary: structured tool_calls from API
    let toolCalls = message.tool_calls?.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      args: JSON.parse(repairJson(tc.function.arguments)) as Record<string, unknown>,
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

    // ── DeepSeek / Moonshot / SiliconFlow 私有 usage 字段透传 ───────────────────
    const cacheHitTokens =
      (usage as any)?.prompt_cache_hit_tokens ??
      (usage as any)?.cache_hit_tokens ??
      (usage as any)?.prompt_tokens_details?.cached_tokens ??
      undefined
    const cacheMissTokens =
      (usage as any)?.prompt_cache_miss_tokens ??
      (cacheHitTokens != null
        ? Math.max(0, (usage?.prompt_tokens ?? 0) - (cacheHitTokens as number))
        : undefined)
    const reasoningTokens =
      (usage as any)?.completion_tokens_details?.reasoning_tokens ?? 
      (usage as any)?.reasoning_tokens ?? 
      undefined

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
    const oaiMessages = messagesToOpenAI(messages, this.supportsVision, isThinkingMode(options))
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
      ...buildSamplingParams(options?.model ?? this.model, options?.temperature, options?.maxTokens),
    }

    // stream_options.include_usage：DeepSeek/OpenAI 官方端点支持，
    // 部分第三方 GPT 兼容代理（非标准 /v1 实现）不支持此字段，传了反而返回 400/422。
    // 检测逻辑：
    //   1. 显式传 includeStreamUsage=false → 跳过
    //   2. baseURL 特征命中已知不兼容的代理模式 → 跳过
    //   3. 其余（官方 OpenAI / DeepSeek / SiliconFlow 等已验证）→ 开启
    const resolvedBaseURL = (this.client as any).baseURL as string | undefined
    const isKnownIncompatibleProxy = resolvedBaseURL
      ? /groq\.com|together\.ai|fireworks\.ai|perplexity\.ai|novita\.ai|api\.302\.ai|api-gw\.|gateway\.|proxy\./i.test(resolvedBaseURL)
      : false

    if (options?.includeStreamUsage !== false && !isKnownIncompatibleProxy) {
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
      params.tool_choice = 'auto'
    }

    // 使用原生 chat.completions.create({ stream: true }) 代替 beta.chat.completions.stream。
    // beta stream helper 内部会把 SSE chunk 解析为类型化 event 对象，第三方 GPT 兼容 API
    // 返回不标准的 chunk（缺少 object 字段或 choices 结构异常）时，SDK 内部尝试读取
    // undefined 对象的 .type 字段导致崩溃（"Cannot read properties of undefined (reading 'type')"）。
    // 原生 API 只做基础 JSON parse，由我们自己处理 delta，兼容性最佳。
    // 注意：将 params 断言为 ChatCompletionCreateParamsStreaming 以触发流式重载，
    // 返回值为 Stream<ChatCompletionChunk>，实现了 AsyncIterable<ChatCompletionChunk>。
    const stream = await streamWithParamFallback(
      this.client,
      params,
      { signal: options?.signal }
    )

    let manualUsage: any = null
    let manualModel: string | undefined = undefined
    let abortedBySignal = false

    try {
      for await (const chunk of stream) {
        // 1. 提取 usage（部分供应商在最后一个 chunk 的顶层或 usage 字段中返回）
        const usage = (chunk as any).usage
        if (usage) manualUsage = usage

        // 2. 提取 model（用于展示真实调用的模型 ID）
        if ((chunk as any).model) manualModel = (chunk as any).model

        // 3. 提取 delta 内容
        const delta = chunk.choices?.[0]?.delta
        if (!delta) continue

        // 尝试多字段提取推理内容（兼容 reasoning_content / thought / reasoning）
        const rContent = (options?.responseThinkingField ? (delta as any)[options.responseThinkingField] : null) ||
          (delta as any).reasoning_content ||
          (delta as any).thought ||
          (delta as any).reasoning

        if (delta.content || rContent || delta.tool_calls) {
          yield { 
            content: delta.content as string, 
            reasoningContent: rContent as string,
            toolCalls: delta.tool_calls?.map((tc: any) => ({
              id: tc.id,
              // 某些第三方 GPT 兼容 API 返回不完整 chunk，tc.function 可能是 undefined
              name: tc.function?.name,
              args: tc.function?.arguments, // string delta（流式增量字符串）
              index: tc.index ?? 0,
            })).filter((tc: any) => tc.name !== undefined || tc.id !== undefined || tc.args !== undefined),
            done: false 
          }
        }
      }
    } catch (err: any) {
      if (err?.name === 'AbortError' || options?.signal?.aborted) {
        // 用户主动中止：即使没拿到完整 usage，也 yield done:true 让上层能发 __usage__
        // 这样 stopSession 时 state.lastUsage 不为 null，计费信息得以保留。
        abortedBySignal = true
      } else {
        throw err
      }
    }

    // 原生 stream 没有 finalMessage()，usage 从 chunk 中累积
    const finalUsage = manualUsage
    // 兼容 Qwen dashscope：streaming usage 字段为 input_tokens 而非 prompt_tokens
    const finalPromptTokens =
      finalUsage?.prompt_tokens ??
      (finalUsage as any)?.input_tokens ??
      0

    // ── DeepSeek / Moonshot / SiliconFlow 私有 usage 字段透传 ───────────────────
    const cacheHitTokens =
      (finalUsage as any)?.prompt_cache_hit_tokens ??
      (finalUsage as any)?.cache_hit_tokens ??
      (finalUsage as any)?.prompt_tokens_details?.cached_tokens ??
      undefined
    const cacheMissTokens =
      (finalUsage as any)?.prompt_cache_miss_tokens ?? 
      (cacheHitTokens != null ? Math.max(0, (finalUsage?.prompt_tokens ?? 0) - (cacheHitTokens as number)) : undefined)
    const reasoningTokens =
      (finalUsage as any)?.completion_tokens_details?.reasoning_tokens ?? 
      (finalUsage as any)?.reasoning_tokens ?? 
      undefined

    yield {
      done: true,
      promptTokens: finalPromptTokens,
      completionTokens: finalUsage?.completion_tokens ?? 0,
      ...(cacheHitTokens != null ? { cacheHitTokens } : {}),
      ...(cacheMissTokens != null ? { cacheMissTokens } : {}),
      ...(reasoningTokens != null ? { reasoningTokens } : {}),
      model: manualModel,
    }
  }

  async embed(text: string | string[], options?: EmbedOptions): Promise<number[][]> {
    this.assertApiKey()
    const response = await this.client.embeddings.create({
      model: options?.model || 'text-embedding-3-small',
      input: text,
    })
    return response.data.map(d => d.embedding)
  }

  countTokens(text: string | any[]): number {
    return estimateTokens(text)
  }
}
