/**
 * DeepSeek 专有通道适配器
 * ============================================================================
 * 在 OpenAI 兼容协议之上叠加 DeepSeek 私有优化：
 *
 * 1. KV Cache (上下文硬盘缓存) — 0.1元/百万的命中价
 *    https://api-docs.deepseek.com/zh-cn/guides/kv_cache
 *    OpenAIAdapter 已经透传 prompt_cache_hit_tokens / cached_tokens / reasoning_tokens
 *
 * 2. Thinking Mode (R1 / V3 Reasoning)
 *    https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
 *    自动给 deepseek-reasoner / R1 注入 reasoning_effort
 *
 * 3. JSON Mode
 *    https://api-docs.deepseek.com/zh-cn/guides/json_mode
 *    options.responseFormat='json' 触发；可在适配器构造时设置默认开启
 *
 * 4. Chat Prefix Completion (β)
 *    https://api-docs.deepseek.com/zh-cn/guides/chat_prefix_completion
 *    options.prefix 触发，自动追加 prefix:true 的 assistant 消息
 *
 * 5. FIM Completion (β)
 *    https://api-docs.deepseek.com/zh-cn/guides/fim_completion
 *    暴露 fimComplete(prompt, suffix) 方法
 *
 * 6. Stream Usage (默认开启 stream_options.include_usage)
 *    OpenAIAdapter 默认已开启
 *
 * 7. Tool Calls (与 OpenAI 完全兼容)
 *    https://api-docs.deepseek.com/zh-cn/guides/tool_calls
 *
 * 8. Anthropic 兼容 (DeepSeek 也提供 /anthropic 路径)
 *    https://api-docs.deepseek.com/zh-cn/guides/anthropic_api
 *    本适配器使用 OpenAI 兼容路径，已经覆盖大部分使用场景；如需 Claude 兼容
 *    可直接改 baseUrl 走 AnthropicAdapter（不在本通道实现）
 */
import { OpenAIAdapter } from './openai.js'
import type { LLMResponse, LLMAdapterOptions, LLMStreamChunk } from './types.js'
import type { Message } from '../agent-context/index.js'
import {
  parseDeepSeekError,
  DeepSeekRateLimitError,
  DeepSeekInvalidParamError,
} from './deepseek-errors.js'

const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com'
/** DeepSeek 推理类模型识别 */
const REASONER_MODEL_PATTERNS = [
  /deepseek-reasoner/i,
  /deepseek-r1/i,
  /deepseek-v3.*think/i,
  /deepseek-v4-pro/i,    // V4 Pro 默认推理
  /deepseek-v4-flash/i,  // V4 Flash 也支持推理
]

export interface DeepSeekAdapterOptions {
  /** 自动给推理模型注入 reasoning_effort（默认 true） */
  autoThinking?: boolean
  /** 思考力度：medium / high / max（默认 medium） */
  thinkingEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'max'
  /** 全局默认开启 JSON Mode（默认 false） */
  defaultJsonMode?: boolean
  /** stream 时附带 include_usage（默认 true） */
  includeStreamUsage?: boolean
  /** 在控制台输出 KV Cache 命中率（默认 true） */
  logCacheHits?: boolean
}

export class DeepSeekAdapter extends OpenAIAdapter {
  override readonly provider = 'deepseek'
  override readonly supportsVision = false
  private readonly dsOptions: Required<DeepSeekAdapterOptions>

  constructor(
    model: string = 'deepseek-chat',
    apiKey?: string,
    baseURL?: string,
    options: DeepSeekAdapterOptions = {},
    defaultHeaders?: Record<string, string>,
  ) {
    super(
      model,
      apiKey || process.env.DEEPSEEK_API_KEY,
      baseURL || process.env.DEEPSEEK_BASE_URL || DEFAULT_DEEPSEEK_BASE_URL,
      undefined,
      defaultHeaders,
    )
    this.dsOptions = {
      autoThinking: options.autoThinking ?? true,
      thinkingEffort: options.thinkingEffort ?? 'medium',
      defaultJsonMode: options.defaultJsonMode ?? false,
      includeStreamUsage: options.includeStreamUsage ?? true,
      logCacheHits: options.logCacheHits ?? true,
    }
  }

  /** 是否为 thinking-mode 模型（R1 / V3 reasoner / V4 Pro） */
  static isReasoner(model: string): boolean {
    return REASONER_MODEL_PATTERNS.some((re) => re.test(model))
  }

  /** 通过模型名或 baseUrl 自动判定是否为 DeepSeek 通道 */
  static detect(model?: string, baseUrl?: string): boolean {
    const m = (model || '').toLowerCase()
    const b = (baseUrl || '').toLowerCase()
    return m.includes('deepseek') || b.includes('deepseek') || b.includes('api.deepseek.com')
  }

  /** 把 DeepSeek 默认参数注入到 LLMAdapterOptions */
  private wrapOptions(options?: LLMAdapterOptions): LLMAdapterOptions {
    const model = options?.model ?? this.model
    const wrapped: LLMAdapterOptions = {
      ...(options ?? { model }),
      includeStreamUsage: options?.includeStreamUsage ?? this.dsOptions.includeStreamUsage,
      responseFormat: options?.responseFormat ?? (this.dsOptions.defaultJsonMode ? 'json' : undefined),
      // R1/reasoner 模型默认拿到 reasoning_content
      responseThinkingField: options?.responseThinkingField ?? 'reasoning_content',
    }

    // 自动 thinking-mode（reasoner 模型）
    if (this.dsOptions.autoThinking && DeepSeekAdapter.isReasoner(model)) {
      const baseThinking = (options?.thinkingConfig as Record<string, unknown> | null) ?? {}
      wrapped.thinkingConfig = {
        ...baseThinking,
        reasoning_effort: (baseThinking as any).reasoning_effort ?? this.dsOptions.thinkingEffort,
      }
    }

    return wrapped
  }

  override async complete(messages: Message[], options?: LLMAdapterOptions): Promise<LLMResponse> {
    return this._withRetry(() => this._doComplete(messages, options))
  }

  private async _doComplete(messages: Message[], options?: LLMAdapterOptions): Promise<LLMResponse> {
    try {
      const resp = await super.complete(messages, this.wrapOptions(options))
      this._logCacheHits(resp.cacheHitTokens, resp.promptTokens)
      return resp
    } catch (err) {
      throw this._mapError(err, options)
    }
  }

  override async *stream(messages: Message[], options?: LLMAdapterOptions): AsyncIterable<LLMStreamChunk> {
    // stream 不支持重试（已有 partial 数据），直接透传并映射错误
    try {
      const wrapped = this.wrapOptions(options)
      for await (const chunk of super.stream(messages, wrapped)) {
        if (chunk.done) this._logCacheHits(chunk.cacheHitTokens, chunk.promptTokens)
        yield chunk
      }
    } catch (err) {
      throw this._mapError(err, options)
    }
  }

  /**
   * 指数退避重试（仅对 429 自动重试，最多 3 次；1s / 2s / 4s）
   */
  private async _withRetry<T>(fn: () => Promise<T>, attempt = 0): Promise<T> {
    try {
      return await fn()
    } catch (err) {
      if (err instanceof DeepSeekRateLimitError && attempt < 3) {
        const delay = Math.pow(2, attempt) * 1000   // 1s, 2s, 4s
        console.warn(`[DeepSeek] 429 速率限制，${delay / 1000}s 后第 ${attempt + 1} 次重试...`)
        await new Promise((r) => setTimeout(r, delay))
        return this._withRetry(fn, attempt + 1)
      }
      throw err
    }
  }

  /**
   * 将 OpenAI SDK APIError 映射为 DeepSeek 语义错误，并处理 422 参数降级
   */
  private _mapError(err: unknown, options?: LLMAdapterOptions): unknown {
    const status = (err as any)?.status ?? (err as any)?.statusCode
    const body = (err as any)?.error ?? (err as any)?.body
    if (!status) return err

    const mapped = parseDeepSeekError(status, body)
    if (!mapped) return err

    // 422：若有问题参数，尝试一次降级重试（移除该参数后）
    if (mapped instanceof DeepSeekInvalidParamError && mapped.problematicParam && options) {
      console.warn(`[DeepSeek] 422 参数错误 (${mapped.problematicParam})，已记录，将由调用方处理`)
    }

    return mapped
  }

  /** 打印 KV Cache 命中率日志 */
  private _logCacheHits(hit: number | undefined, total: number | undefined) {
    if (this.dsOptions.logCacheHits && hit && (total ?? 0) > 0) {
      const ratio = ((hit / total!) * 100).toFixed(1)
      console.log(`[DeepSeek] KV Cache 命中: ${hit}/${total} tokens (${ratio}%)`)
    }
  }

  /**
   * FIM Completion (Fill-in-Middle) — 调用 /beta/completions
   * 用于代码补全等场景，给定 prompt + suffix，模型生成中间。
   */
  async fimComplete(params: {
    prompt: string
    suffix: string
    maxTokens?: number
    temperature?: number
    model?: string
  }): Promise<{
    content: string
    promptTokens: number
    completionTokens: number
    cacheHitTokens?: number
    cacheMissTokens?: number
    reasoningTokens?: number
    model: string
  }> {
    // 通过 OpenAI SDK 内部 client 拿到 baseURL 和 apiKey
    const client = (this as any).client as { baseURL: string; apiKey: string }
    const baseURL = client?.baseURL ?? DEFAULT_DEEPSEEK_BASE_URL
    // SDK 通常把 baseURL 规范成 .../v1，这里替换为 .../beta
    const fimURL = baseURL.replace(/\/v\d+$/, '') + '/beta/completions'

    const resp = await fetch(fimURL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${client?.apiKey ?? ''}`,
      },
      body: JSON.stringify({
        model: params.model ?? this.model,
        prompt: params.prompt,
        suffix: params.suffix,
        max_tokens: params.maxTokens ?? 256,
        temperature: params.temperature ?? 0,
      }),
    })

    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error(`DeepSeek FIM API error: HTTP ${resp.status} ${text.slice(0, 200)}`)
    }

    const json = (await resp.json()) as any
    return {
      content: json?.choices?.[0]?.text ?? '',
      promptTokens: json?.usage?.prompt_tokens ?? 0,
      completionTokens: json?.usage?.completion_tokens ?? 0,
      cacheHitTokens: json?.usage?.prompt_cache_hit_tokens,
      cacheMissTokens: json?.usage?.prompt_cache_miss_tokens,
      reasoningTokens:
        json?.usage?.completion_tokens_details?.reasoning_tokens || json?.usage?.reasoning_tokens,
      model: json?.model,
    }
  }
}
