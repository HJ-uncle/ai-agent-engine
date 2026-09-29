import type { LLMAdapter, LLMResponse, LLMAdapterOptions, LLMStreamChunk, RetryOptions, FallbackConfig } from './types.js'
import type { Message } from '../agent-context/index.js'

import { abortableDelay, isAbortError, throwIfAborted } from '../utils/abort.js'

export function isRetryable(error: unknown): boolean {
  if (isAbortError(error)) return false
  if (!error || typeof error !== 'object') return false
  const value = error as { status?: number; statusCode?: number; httpStatus?: number; retryable?: boolean; code?: string; message?: string }
  if (value.retryable === false) return false
  const status = value.status ?? value.statusCode ?? value.httpStatus
  if (status !== undefined) return status === 408 || status === 429 || status >= 500 && status <= 599
  return value.retryable === true || /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE)$/.test(value.code ?? '') || /timeout|network|fetch failed|socket hang up|terminated|rate limit|overload/i.test(value.message ?? '')
}

function getDelay(attempt: number, options: RetryOptions): number {
  const delay = options.baseDelayMs * Math.pow(2, attempt)
  return Math.min(delay, options.maxDelayMs)
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000 },
  signal?: AbortSignal,
): Promise<T> {
  let lastError: unknown

  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    throwIfAborted(signal)
    try {
      return await fn()
    } catch (err) {
      lastError = err
      if (signal?.aborted || attempt === options.maxRetries || !isRetryable(err)) {
        throw err
      }
      await abortableDelay(getDelay(attempt, options), signal)
    }
  }

  throw lastError
}

export class RetryingAdapter implements LLMAdapter {
  constructor(
    private readonly inner: LLMAdapter,
    private readonly retryOptions: RetryOptions = {
      maxRetries: 3,
      baseDelayMs: 1000,
      maxDelayMs: 30000,
    },
  ) {}

  get provider(): string { return this.inner.provider }
  get model(): string { return this.inner.model }

  async complete(messages: Message[], options?: LLMAdapterOptions): Promise<LLMResponse> {
    return withRetry(() => this.inner.complete(messages, options), this.retryOptions, options?.signal)
  }

  async *stream(messages: Message[], options?: LLMAdapterOptions): AsyncIterable<LLMStreamChunk> {
    for (let attempt = 0; attempt <= this.retryOptions.maxRetries; attempt++) {
      throwIfAborted(options?.signal)
      let emitted = false
      try {
        for await (const chunk of this.inner.stream(messages, options)) {
          // Once a consumer has seen any progress, replay could duplicate content or tool work.
          emitted = true
          yield chunk
        }
        return
      } catch (error) {
        if (emitted || options?.signal?.aborted || attempt === this.retryOptions.maxRetries || !isRetryable(error)) throw error
        await abortableDelay(getDelay(attempt, this.retryOptions), options?.signal)
      }
    }
  }

  countTokens(text: string): number {
    return this.inner.countTokens(text)
  }

  async embed(text: string | string[], options?: any): Promise<number[][]> {
    if (this.inner.embed) {
      return withRetry(() => this.inner.embed!(text, options), this.retryOptions)
    }
    throw new Error('Embed not supported by underlying adapter')
  }
}

export class FallbackAdapter implements LLMAdapter {
  private adapters: LLMAdapter[]

  constructor(config: FallbackConfig) {
    this.adapters = [config.primary, ...config.fallbacks]
  }

  get provider(): string { return this.adapters[0].provider }
  get model(): string { return this.adapters[0].model }

  async complete(messages: Message[], options?: LLMAdapterOptions): Promise<LLMResponse> {
    let lastError: unknown

    for (const adapter of this.adapters) {
      throwIfAborted(options?.signal)
      try {
        return await adapter.complete(messages, options)
      } catch (err) {
        if (isAbortError(err, options?.signal)) throw err
        const status = (err as {status?: number})?.status
        if (typeof status === 'number' && status >= 400 && status < 500 && !isRetryable(err)) throw err
        lastError = err
        console.warn(`LLM adapter ${adapter.provider}/${adapter.model} failed, trying fallback...`)
      }
    }

    throw lastError
  }

  async *stream(messages: Message[], options?: LLMAdapterOptions): AsyncIterable<LLMStreamChunk> {
    yield* this.adapters[0].stream(messages, options)
  }

  countTokens(text: string): number {
    return this.adapters[0].countTokens(text)
  }

  async embed(text: string | string[], options?: any): Promise<number[][]> {
    let lastError: unknown
    for (const adapter of this.adapters) {
      if (adapter.embed) {
        try {
          return await adapter.embed(text, options)
        } catch (err) {
          lastError = err
          console.warn(`LLM embed adapter ${adapter.provider}/${adapter.model} failed, trying fallback...`)
        }
      }
    }
    throw lastError || new Error('Embed not supported by any fallback adapter')
  }
}
