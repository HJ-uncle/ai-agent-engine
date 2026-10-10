import type { MemoryNodeType, MemoryScope } from '../../storage/memory/types.js'

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
  /** Effective request/model capability override, shared with the chat request. */
  contextWindow?: number
}
