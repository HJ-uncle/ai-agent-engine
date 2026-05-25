import type { MemoryNodeType } from '../../storage/memory/types.js'

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
  messages: Array<{ role: string; content: string }>
}

export interface LLMCredentials {
  model?: string
  apiKey?: string
  baseUrl?: string
  provider?: string
}
