import type { Message, Tool } from '../agent-context/index.js'

export interface LLMResponse {
  content: string
  toolCalls?: Array<{
    id: string
    name: string
    args: Record<string, unknown>
  }>
  promptTokens: number
  completionTokens: number
  finishReason: 'stop' | 'tool_calls' | 'length' | 'error'
}

export interface LLMStreamChunk {
  content?: string
  toolCalls?: Array<{
    id: string
    name: string
    args: Record<string, unknown>
  }>
  done: boolean
  promptTokens?: number
  completionTokens?: number
}

export interface LLMAdapterOptions {
  model: string
  maxTokens?: number
  temperature?: number
  systemPrompt?: string
  tools?: Tool[]
}

export interface LLMAdapter {
  readonly provider: string
  readonly model: string
  complete(messages: Message[], options?: LLMAdapterOptions): Promise<LLMResponse>
  stream(messages: Message[], options?: LLMAdapterOptions): AsyncIterable<LLMStreamChunk>
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
