import { createHash } from 'node:crypto'

export interface CacheStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ttlSeconds: number): Promise<void>
  delete(key: string): Promise<void>
}

export function generateCacheKey(provider: string, model: string, prompt: string): string {
  const content = `${provider}:${model}:${prompt}`
  return createHash('sha256').update(content).digest('hex')
}
