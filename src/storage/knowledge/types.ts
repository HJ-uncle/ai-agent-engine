export interface KnowledgeBase {
  id: string
  tenantId: string
  name: string
  description: string
  documentCount: number
  createdAt: number
  updatedAt: number
}

export interface KBDocument {
  id: string
  tenantId: string
  knowledgeBaseId: string | null
  filename: string
  contentType: string
  chunkCount: number
  status: 'ready'
  /** False for legacy documents whose original text was never stored. */
  contentExact: boolean
  createdAt: number
  updatedAt: number
}

export interface KBDocumentDetail extends KBDocument { content: string }
export interface KBChunk {
  id: string
  documentId: string
  tenantId: string
  chunkIndex: number
  content: string
  tokenCount: number
}
export interface SearchResult {
  chunkId: string
  documentId: string
  knowledgeBaseId: string | null
  filename: string
  content: string
  score: number
  chunkIndex: number
}
export interface DocumentPatch {
  filename?: string
  content?: string
  contentType?: string
  knowledgeBaseId?: string | null
}

export const MAX_KNOWLEDGE_BODY_BYTES = 2 * 1024 * 1024
export const MAX_KNOWLEDGE_TEXT_BYTES = 1024 * 1024
export const MAX_KNOWLEDGE_SCOPES = 100
export const MAX_KNOWLEDGE_QUERY_LENGTH = 4000

export class KnowledgeError extends Error {
  constructor(message: string, public readonly code = 40001) { super(message) }
}

export function validateText(value: unknown, label: string, maxLength: number, allowEmpty = false): asserts value is string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.length > maxLength || value.includes('\0')) {
    throw new KnowledgeError(`${label} must be ${allowEmpty ? 'a' : 'a non-empty'} string of at most ${maxLength} characters`)
  }
}
export function validateContent(value: unknown): asserts value is string {
  validateText(value, 'content', MAX_KNOWLEDGE_TEXT_BYTES)
  if (Buffer.byteLength(value, 'utf8') > MAX_KNOWLEDGE_TEXT_BYTES) throw new KnowledgeError('Document content exceeds 1 MiB')
}
export function validateBaseId(value: unknown): asserts value is string | null | undefined {
  if (value !== undefined && value !== null) validateText(value, 'knowledgeBaseId', 128)
}
export function validateScopes(value: unknown): asserts value is readonly string[] | undefined {
  if (value === undefined) return
  if (!Array.isArray(value) || value.length > MAX_KNOWLEDGE_SCOPES) throw new KnowledgeError(`knowledgeBaseIds must be an array of at most ${MAX_KNOWLEDGE_SCOPES} IDs`)
  for (const id of value) validateText(id, 'knowledgeBaseIds item', 128)
}
export function validateLimit(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 100) throw new KnowledgeError('limit must be an integer between 1 and 100')
}
