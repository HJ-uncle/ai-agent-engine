import type { LLMAdapter, LLMResponse, LLMAdapterOptions, LLMStreamChunk, RetryOptions, FallbackConfig } from './types.js'
import type { Message } from '../agent-context/index.js'

import { abortableDelay, isAbortError, throwIfAborted } from '../utils/abort.js'
import { estimateRequestInput } from '../agent-loop/finalization.js'

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

  get embed(): LLMAdapter['embed'] {
    // Optional capabilities must remain optional through wrappers. Anthropic
    // chat adapters have no embedding endpoint.
    if (!this.inner.embed) return undefined
    return (text, options) => withRetry(() => this.inner.embed!(text, options), this.retryOptions)
  }
}

export class FallbackAdapter implements LLMAdapter {
  private adapters: LLMAdapter[]
  private readonly modelContextWindows: Record<string, number>

  constructor(config: FallbackConfig) {
    this.adapters = [config.primary, ...config.fallbacks]
    this.modelContextWindows = config.modelContextWindows ?? {}
  }

  get provider(): string { return this.adapters[0].provider }
  get model(): string { return this.adapters[0].model }

  private selectedOptions(adapter: LLMAdapter, messages: Message[], options?: LLMAdapterOptions): LLMAdapterOptions {
    const contextWindow = this.modelContextWindows[adapter.model]
    if (Number.isFinite(contextWindow) && contextWindow > 0) {
      const input = Math.max(options?.requestInputTokenEstimate ?? 0,
        estimateRequestInput(messages, options?.systemPrompt, options?.tools ?? []))
      const requested = input + (options?.maxTokens ?? (options?.unboundedOutput ? 0 : 4096))
      if (requested > contextWindow) throw Object.assign(new Error(
        `Model ${adapter.model} context window ${contextWindow} cannot fit estimated input and output reserve ${requested}`,
      ), { code: 'CONTEXT_WINDOW_EXCEEDED', retryable: false, model: adapter.model, contextWindow, requested })
    }
    return { ...options, model: adapter.model }
  }

  async complete(messages: Message[], options?: LLMAdapterOptions): Promise<LLMResponse> {
    let lastError: unknown

    for (const adapter of this.adapters) {
      throwIfAborted(options?.signal)
      try {
        const response = await adapter.complete(messages, this.selectedOptions(adapter, messages, options))
        return { ...response, model: response.model ?? adapter.model }
      } catch (err) {
        if (isAbortError(err, options?.signal) || !isRetryable(err)) throw err
        lastError = err
      }
    }

    throw lastError
  }

  async *stream(messages: Message[], options?: LLMAdapterOptions): AsyncIterable<LLMStreamChunk> {
    let lastError: unknown
    for (const adapter of this.adapters) {
      throwIfAborted(options?.signal)
      let delivered = false
      try {
        for await (const chunk of adapter.stream(messages, this.selectedOptions(adapter, messages, options))) {
          // A yielded chunk is already visible to the consumer, including thinking,
          // tool arguments, usage and terminal state. Never replay after that boundary.
          delivered = true
          yield { ...chunk, model: chunk.model ?? adapter.model }
        }
        return
      } catch (error) {
        if (delivered || isAbortError(error, options?.signal) || !isRetryable(error)) throw error
        lastError = error
      }
    }
    throw lastError
  }

  countTokens(text: string): number {
    return this.adapters[0].countTokens(text)
  }

  get embed(): LLMAdapter['embed'] {
    if (!this.adapters.some(adapter => adapter.embed)) return undefined
    return (text, options) => this.embedWithFallback(text, options)
  }

  private async embedWithFallback(text: string | string[], options?: any): Promise<number[][]> {
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
