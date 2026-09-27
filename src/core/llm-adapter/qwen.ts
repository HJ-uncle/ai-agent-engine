/**
 * Qwen (通义千问 / 百炼) 专有通道适配器
 * ============================================================================
 * 基于阿里云百炼 OpenAI 兼容接口，在 OpenAIAdapter 基础上叠加 Qwen 私有特性：
 *
 * 1. Stream Usage
 *    stream_options: { include_usage: true }
 *    流式 usage 字段为 input_tokens / output_tokens（与 OpenAI 的 prompt_tokens 不同）
 *    openai.ts 已在 Fix 中兼容：finalUsage?.prompt_tokens ?? finalUsage?.input_tokens
 *
 * 2. Thinking Mode（思考模式）
 *    enable_thinking: true，推理内容在 reasoning_content 字段返回
 *    仅支持 qwen3 系列 / QwQ 系列思考模型
 *    https://help.aliyun.com/zh/model-studio/qwen-thinking-mode
 *
 * 3. Vision（图像 / 视频理解）
 *    大多数 Qwen 模型（qwen-plus / qwen-max / qwen-turbo / qwen3 / qwen-vl-* 等）
 *    均支持 image_url 多模态输入；仅 qwen-long / qwen-math / qwen-audio 等专用模型例外。
 *    https://help.aliyun.com/zh/model-studio/qwen-vl
 *
 * 4. Function Calling（工具调用）
 *    与 OpenAI 协议完全兼容，直接透传 tools / tool_choice
 *    https://help.aliyun.com/zh/model-studio/qwen-function-calling
 *
 * 5. 网络搜索（enable_search）
 *    传入 enable_search: true 即可开启内置 Web 搜索增强
 *    https://help.aliyun.com/zh/model-studio/qwen-search
 *
 * 6. 自动凭据解析
 *    优先使用 DASHSCOPE_API_KEY / QWEN_API_KEY 环境变量
 *    默认 baseURL: https://dashscope.aliyuncs.com/compatible-mode/v1
 */
import { OpenAIAdapter } from './openai.js'
import type { LLMResponse, LLMAdapterOptions, LLMStreamChunk } from './types.js'
import type { Message } from '../agent-context/index.js'

const DEFAULT_QWEN_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1'

/** Qwen 思考模型识别：qwen3 系列 / QwQ 系列 */
const THINKING_MODEL_PATTERNS = [
  /qwen3/i,
  /qwq/i,
]

/**
 * 明确不支持视觉的 Qwen 纯文本专用模型
 * 其余 Qwen 模型（qwen-plus / qwen-max / qwen-turbo / qwen3-* / qwen-vl-* 等）
 * 均支持 image_url 多模态输入
 */
const TEXT_ONLY_MODEL_PATTERNS = [
  /qwen-long/i,
  /qwen-math/i,
  /qwen-audio/i,
  /qwen-code/i,
]

export interface QwenAdapterOptions {
  /** 思考模型自动注入 enable_thinking（默认 true） */
  autoThinking?: boolean
  /** 默认开启网络搜索（默认 false） */
  enableSearch?: boolean
  /** stream 时附带 include_usage（默认 true） */
  includeStreamUsage?: boolean
  /** 在控制台输出 token 统计日志（默认 false） */
  logUsage?: boolean
}

export class QwenAdapter extends OpenAIAdapter {
  override readonly provider = 'qwen'
  private readonly qwenOptions: Required<QwenAdapterOptions>

  constructor(
    model: string = 'qwen-plus',
    apiKey?: string,
    baseURL?: string,
    options: QwenAdapterOptions = {},
    defaultHeaders?: Record<string, string>,
  ) {
    super(
      model,
      apiKey
        || process.env.DASHSCOPE_API_KEY
        || process.env.QWEN_API_KEY,
      baseURL || process.env.QWEN_BASE_URL || DEFAULT_QWEN_BASE_URL,
      undefined,
      defaultHeaders,
    )
    // 大多数 Qwen 模型支持视觉；只有明确的纯文本专用型号才关闭
    // openai.ts 的 detectVisionSupport 遇到 qwen URL 会返回 false，此处强制覆盖
    const isTextOnly = TEXT_ONLY_MODEL_PATTERNS.some((re) => re.test(model))
    ;(this as any).supportsVision = !isTextOnly

    this.qwenOptions = {
      autoThinking:       options.autoThinking      ?? true,
      enableSearch:       options.enableSearch       ?? false,
      includeStreamUsage: options.includeStreamUsage ?? true,
      logUsage:           options.logUsage           ?? false,
    }
  }

  /** 判断是否为 Qwen 思考模型 */
  static isThinkingModel(model: string): boolean {
    return THINKING_MODEL_PATTERNS.some((re) => re.test(model))
  }

  /** 通过模型名或 baseUrl 自动判定是否为 Qwen 通道 */
  static detect(model?: string, baseUrl?: string): boolean {
    const m = (model || '').toLowerCase()
    const b = (baseUrl || '').toLowerCase()
    return (
      m.includes('qwen') ||
      m.includes('qwq') ||
      b.includes('qwen') ||
      b.includes('dashscope') ||
      b.includes('aliyuncs.com')
    )
  }

  /** 把 Qwen 默认参数注入到 LLMAdapterOptions */
  private wrapOptions(options?: LLMAdapterOptions): LLMAdapterOptions {
    const model = options?.model ?? this.model
    const wrapped: LLMAdapterOptions = {
      ...(options ?? { model }),
      includeStreamUsage: options?.includeStreamUsage ?? this.qwenOptions.includeStreamUsage,
      // Qwen 推理内容字段与 DeepSeek 相同
      responseThinkingField: options?.responseThinkingField ?? 'reasoning_content',
    }

    // 自动思考模式：qwen3 / QwQ + autoThinking=true 时注入 enable_thinking
    if (
      this.qwenOptions.autoThinking &&
      QwenAdapter.isThinkingModel(model) &&
      !options?.thinkingConfig
    ) {
      wrapped.thinkingConfig = { enable_thinking: true }
    }

    // 外部显式传了 thinkingConfig 则直接透传（不覆盖）
    if (options?.thinkingConfig) {
      wrapped.thinkingConfig = options.thinkingConfig
    }

    return wrapped
  }

  override async complete(messages: Message[], options?: LLMAdapterOptions): Promise<LLMResponse> {
    const wrapped = this.wrapOptions(options)
    const resp = await super.complete(messages, wrapped)
    this._logUsage(resp.promptTokens, resp.completionTokens)
    return resp
  }

  override async *stream(messages: Message[], options?: LLMAdapterOptions): AsyncIterable<LLMStreamChunk> {
    const wrapped = this.wrapOptions(options)

    // 注入 enable_search 到请求体（非标准 LLMAdapterOptions 字段，走 extraParams 透传）
    if (this.qwenOptions.enableSearch || (options as any)?.enableSearch) {
      ;(wrapped as any).extraParams = {
        ...((wrapped as any).extraParams ?? {}),
        enable_search: true,
      }
    }

    for await (const chunk of super.stream(messages, wrapped)) {
      if (chunk.done) {
        this._logUsage(chunk.promptTokens, chunk.completionTokens)
      }
      yield chunk
    }
  }

  /** 打印 token 用量日志 */
  private _logUsage(prompt?: number, completion?: number) {
    if (this.qwenOptions.logUsage && (prompt || completion)) {
      console.log(`[Qwen] 用量：prompt=${prompt ?? 0} completion=${completion ?? 0} total=${(prompt ?? 0) + (completion ?? 0)}`)
    }
  }
}
