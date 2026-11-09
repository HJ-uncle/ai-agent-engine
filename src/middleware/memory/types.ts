import type { MemoryNodeType, MemoryScope } from '../../storage/memory/types.js'
import type { ApiFormat } from '../../core/llm-adapter/protocol.js'
import type { LLMRequestAttemptEvent } from '../../core/llm-adapter/types.js'

export type MemoryRequestStage = 'memory_recall' | 'memory_extraction'
export type MemoryRequestAttemptEvent = LLMRequestAttemptEvent & { stage: MemoryRequestStage }

export interface MemoryExtractorOptions {
  enabled: boolean
  minImportance?: number
  memoryTypes?: MemoryNodeType[]
}

export interface ExtractedMemory {
  type: MemoryNodeType
  content: string
  importance: number
  emotion: number
  tags: string[]
  relatedTo?: string
}

export interface MemoryExtractContext {
  sessionId: string
  tenantId: string
  scope?: MemoryScope
  messages: Array<{ role: string; content: string }>
}

export interface LLMCredentials {
  model?: string
  apiKey?: string
  baseUrl?: string
  provider?: string
  apiFormat?: ApiFormat
  /** Effective request/model capability override, shared with the chat request. */
  contextWindow?: number
  signal?: AbortSignal
  /** Includes utility usage without changing the provider's original counters. */
  onRequestAttempt?: (event: MemoryRequestAttemptEvent) => void | Promise<void>
}
