import { createHash } from 'node:crypto'
import OpenAI from 'openai'
import { systemConfigStore } from '../sqlite/system-config.js'
import type { MemoryContext } from './types.js'
import { SQLiteMemoryManager } from './memory-manager.js'

export interface MemoryEmbeddingConfig {
  baseUrl: string
  model: string
  apiKey?: string
  /** Required space dimension; changing it invalidates previously stored vectors. */
  dimensions: number
  /** Send dimensions only to services explicitly configured to support that field. */
  sendDimensions?: boolean
}

export interface MemoryEmbeddingService {
  readonly spaceId: string
  readonly model: string
  readonly dimensions: number
  embed(text: string | string[], signal?: AbortSignal): Promise<number[][]>
}

function normalizeEmbeddingBaseUrl(value: string): string {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('EMBEDDING_BASE_URL must be an HTTP(S) service URL without credentials, query or fragment')
  }
  url.pathname = url.pathname.replace(/\/embeddings\/?$/, '').replace(/\/$/, '')
  return url.toString().replace(/\/$/, '')
}

/** Chat protocol/model changes never select a different embedding space. */
export class OpenAIMemoryEmbeddingService implements MemoryEmbeddingService {
  readonly spaceId: string
  readonly model: string
  readonly dimensions: number
  private readonly client: OpenAI
  private readonly sendDimensions: boolean

  constructor(config: MemoryEmbeddingConfig) {
    const baseUrl = normalizeEmbeddingBaseUrl(config.baseUrl)
    if (!config.model.trim()) throw new Error('EMBEDDING_MODEL must be non-empty')
    if (!Number.isSafeInteger(config.dimensions) || config.dimensions < 1) throw new Error('EMBEDDING_DIMENSIONS must be a positive integer')
    this.model = config.model.trim()
    this.dimensions = config.dimensions
    this.sendDimensions = config.sendDimensions === true
    this.spaceId = `sha256:${createHash('sha256').update(JSON.stringify({ protocol: 'openai-embeddings', baseUrl, model: this.model, dimensions: this.dimensions })).digest('hex')}`
    const host = new URL(baseUrl).hostname
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(host)
    if (!config.apiKey && !local) throw new Error('EMBEDDING_API_KEY is required for a remote embedding service')
    this.client = new OpenAI({ baseURL: baseUrl, apiKey: config.apiKey || 'local-embedding-service', timeout: 30_000, maxRetries: 1 })
  }

  async embed(text: string | string[], signal?: AbortSignal): Promise<number[][]> {
    const inputs = typeof text === 'string' ? [text] : text
    if (!inputs.length) return []
    if (inputs.some(input => typeof input !== 'string' || !input.trim())) throw new Error('Embedding input must contain non-empty text')
    const response = await this.client.embeddings.create({ model: this.model, input: inputs, encoding_format: 'float',
      ...(this.sendDimensions ? { dimensions: this.dimensions } : {}) }, { signal })
    if (response.model && response.model !== this.model) throw new Error('Embedding service returned a different model; vectors were not stored')
    if (response.data.length !== inputs.length) throw new Error('Embedding service returned an incomplete batch; vectors were not stored')
    const ordered = [...response.data].sort((a, b) => a.index - b.index)
    if (ordered.some((item, index) => item.index !== index || item.embedding.length !== this.dimensions
      || item.embedding.some(value => !Number.isFinite(value)))) {
      throw new Error('Embedding service returned invalid indices, dimensions or values; vectors were not stored')
    }
    return ordered.map(item => item.embedding)
  }
}

/** Explicit, independently configurable endpoint; never reuses Anthropic chat credentials. */
export async function createMemoryEmbeddingService(): Promise<MemoryEmbeddingService | undefined> {
  const keys = ['EMBEDDING_BASE_URL', 'EMBEDDING_MODEL', 'EMBEDDING_API_KEY', 'EMBEDDING_DIMENSIONS', 'EMBEDDING_SEND_DIMENSIONS']
  const values = await Promise.all(keys.map(key => systemConfigStore.get(key)))
  const config = Object.fromEntries(keys.map((key, index) => [key, (values[index] ?? process.env[key])?.trim() || undefined]))
  if (!config.EMBEDDING_BASE_URL && !config.EMBEDDING_MODEL && !config.EMBEDDING_API_KEY) return undefined
  if (!config.EMBEDDING_BASE_URL || !config.EMBEDDING_MODEL) throw new Error('Independent memory embeddings require EMBEDDING_BASE_URL and EMBEDDING_MODEL')
  return new OpenAIMemoryEmbeddingService({ baseUrl: config.EMBEDDING_BASE_URL, model: config.EMBEDDING_MODEL,
    apiKey: config.EMBEDDING_API_KEY, dimensions: Number(config.EMBEDDING_DIMENSIONS ?? 1536),
    sendDimensions: config.EMBEDDING_SEND_DIMENSIONS === 'true' })
}

export interface EmbeddingBackfillResult { attempted: number; stored: number; changed: number; errors: string[] }
const inFlightBackfills = new Map<string, Promise<EmbeddingBackfillResult>>()

/**
 * Incremental and restartable: successful rows carry their space identity;
 * failed/unprocessed rows remain candidates on the next call. A text CAS
 * prevents an in-flight request from attaching a stale vector after editing.
 */
export function backfillMemoryEmbeddings(manager: SQLiteMemoryManager, context: MemoryContext,
  service: MemoryEmbeddingService, options: { limit?: number; signal?: AbortSignal } = {}): Promise<EmbeddingBackfillResult> {
  const key = JSON.stringify([process.env.DATA_DIR, context.tenantId, context.scope ?? 'global', context.scope === 'session' ? context.sessionId : '', service.spaceId])
  const pending = inFlightBackfills.get(key)
  if (pending) return pending
  const work = (async () => {
    const result: EmbeddingBackfillResult = { attempted: 0, stored: 0, changed: 0, errors: [] }
    const candidates = await manager.getEmbeddingBackfillCandidates(service.spaceId, options.limit ?? 20, context)
    result.attempted = candidates.length
    if (!candidates.length) return result
    try {
      const vectors = await service.embed(candidates.map(node => node.summary), options.signal)
      for (let index = 0; index < candidates.length; index++) {
        const node = candidates[index]
        if (await manager.updateEmbeddingIfUnchanged(node.id, node.summary, node.detail, vectors[index], service.spaceId, context)) result.stored++
        else result.changed++
      }
    } catch (error) {
      if (options.signal?.aborted) throw error
      // Report a stable diagnostic without SDK request headers or credentials.
      result.errors.push('Memory embedding backfill failed; unprocessed rows remain retryable')
    }
    return result
  })()
  inFlightBackfills.set(key, work)
  void work.finally(() => { if (inFlightBackfills.get(key) === work) inFlightBackfills.delete(key) }).catch(() => {})
  return work
}
