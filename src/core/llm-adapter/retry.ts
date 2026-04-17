import type { LLMAdapter, LLMResponse, LLMAdapterOptions, LLMStreamChunk, RetryOptions, FallbackConfig } from './types.js'
import type { Message } from '../agent-context/index.js'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isRetryable(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase()
    return msg.includes('5') || msg.includes('timeout') || msg.includes('network') ||
           msg.includes('rate') || msg.includes('overload')
  }
  return false
}

function getDelay(attempt: number, options: RetryOptions): number {
  const delay = options.baseDelayMs * Math.pow(2, attempt)
  return Math.min(delay, options.maxDelayMs)
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000 },
): Promise<T> {
  let lastError: unknown

  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      if (attempt === options.maxRetries || !isRetryable(err)) {
        throw err
      }
      await sleep(getDelay(attempt, options))
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
    return withRetry(() => this.inner.complete(messages, options), this.retryOptions)
  }

  async *stream(messages: Message[], options?: LLMAdapterOptions): AsyncIterable<LLMStreamChunk> {
    // For streaming, retry on initial connection error only
    yield* this.inner.stream(messages, options)
  }

  countTokens(text: string): number {
    return this.inner.countTokens(text)
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
      try {
        return await adapter.complete(messages, options)
      } catch (err) {
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
}
