import type { Message, Tool } from '../agent-context/index.js'

export interface LLMResponse {
  content: string
  reasoningContent?: string
  toolCalls?: Array<{
    id: string
    name: string
    args: Record<string, unknown>
  }>
  promptTokens: number
  completionTokens: number
  finishReason: 'stop' | 'tool_calls' | 'length' | 'error'
  // ── DeepSeek 专有：上下文硬盘缓存 (KV Cache) 与推理模式 ─────────────
  /** DeepSeek 命中上下文缓存的 token 数（计费 0.1元/百万，原价 1/10） */
  cacheHitTokens?: number
  /** DeepSeek 未命中缓存的 token 数（按正常输入价计费） */
  cacheMissTokens?: number
  /** R1/V3 thinking 模式下 reasoning_content 实际产生的推理 token 数 */
  reasoningTokens?: number
  /** 实际使用的模型 ID */
  model?: string
}

export interface LLMStreamChunk {
  content?: string
  reasoningContent?: string
  toolCalls?: Array<{
    id?: string
    name?: string
    args?: string
    index?: number
  }>
  done: boolean
  finishReason?: 'stop' | 'tool_calls' | 'length' | 'error'
  promptTokens?: number
  completionTokens?: number
  cacheHitTokens?: number
  cacheMissTokens?: number
  reasoningTokens?: number
  model?: string
}

export interface RequestAttemptUsage {
  cacheWriteTokens?: number
  promptTokens: number
  completionTokens: number
  cacheHitTokens?: number
  cacheMissTokens?: number
  reasoningTokens?: number
}

export type LLMRequestAttemptEvent = {
  type: 'start'
  estimatedInputTokens?: number
  maxOutputTokens?: number
  requestAttemptId: string
  provider: string
  model: string
} | {
  type: 'finish'
  requestAttemptId: string
  provider: string
  model: string
  outcome: 'succeeded' | 'failed' | 'cancelled'
  /** Missing means the upstream did not report usage; it must not be billed as zero. */
  usage?: RequestAttemptUsage
}

export interface LLMAdapterOptions {
  model: string
  maxTokens?: number
  temperature?: number
  systemPrompt?: string
  tools?: Tool[]
  thinkingConfig?: Record<string, unknown> | null
  responseThinkingField?: string | null
  reasoningEffort?: 'low' | 'medium' | 'high'
  signal?: AbortSignal
  onRequestAttempt?: (event: LLMRequestAttemptEvent) => void | Promise<void>
  /** Internal estimate computed from the provider request, for shared budget reservations. */
  requestInputTokenEstimate?: number
  // ── DeepSeek 专有可选项 ───────────────────────────────────────────────
  /** "json" 强制模型输出严格 JSON（DeepSeek JSON Mode） */
  responseFormat?: 'json' | 'text'
  /** Chat Prefix Completion：在最后一条 assistant 消息上预填的前缀文本 */
  prefix?: string
  /** stream 时是否要求服务端在最后 chunk 中带 usage（默认 true） */
  includeStreamUsage?: boolean
}

export interface EmbedOptions {
  model?: string
}

export interface LLMAdapter {
  readonly provider: string
  readonly model: string
  complete(messages: Message[], options?: LLMAdapterOptions): Promise<LLMResponse>
  stream(messages: Message[], options?: LLMAdapterOptions): AsyncIterable<LLMStreamChunk>
  embed?(text: string | string[], options?: EmbedOptions): Promise<number[][]>
  countTokens(text: string): number
}

export interface RetryOptions {
  maxRetries: number
  baseDelayMs: number
  maxDelayMs: number
}

export interface FallbackConfig {
  primary: LLMAdapter
  fallbacks: LLMAdapter[]
}
