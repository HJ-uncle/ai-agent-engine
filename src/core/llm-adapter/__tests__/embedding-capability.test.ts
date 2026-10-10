import { describe, expect, it, vi } from 'vitest'
import { FallbackAdapter, RetryingAdapter } from '../retry.js'
import type { LLMAdapter } from '../types.js'

const adapter = (embed?: LLMAdapter['embed']): LLMAdapter => ({ provider: 'anthropic', model: 'chat-model',
  complete: vi.fn(), stream: vi.fn(), countTokens: () => 0, ...(embed ? { embed } : {}) })

describe('embedding capability through chat wrappers', () => {
  it('does not advertise embed when the underlying Anthropic chat adapter has no embedding method', () => {
    expect(new RetryingAdapter(adapter()).embed).toBeUndefined()
    expect(new FallbackAdapter({ primary: new RetryingAdapter(adapter()), fallbacks: [adapter()] }).embed).toBeUndefined()
  })

  it('preserves the method and its binding only for adapters that support embeddings', async () => {
    const inner = adapter(vi.fn(async () => [[1, 0]]))
    const retry = new RetryingAdapter(inner)
    expect(await retry.embed?.('one')).toEqual([[1, 0]])
    expect(inner.embed).toHaveBeenCalledWith('one', undefined)
    const fallback = new FallbackAdapter({ primary: adapter(), fallbacks: [retry] })
    expect(await fallback.embed?.('two')).toEqual([[1, 0]])
  })
})
