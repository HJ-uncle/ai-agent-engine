import { randomUUID } from 'node:crypto'
import type { LLMAdapterOptions, RequestAttemptUsage } from './types.js'
import { isAbortError, throwIfAborted } from '../utils/abort.js'
import { estimateProviderRequestInput } from '../utils/multimodal-context.js'

/** Use the same final wire estimate for admission, output capacity and observation. */
export function prepareRequestContext(options: LLMAdapterOptions | undefined,
  request: { model?: unknown; messages?: unknown; tools?: unknown; system?: unknown }, wireMaxTokens?: number): LLMAdapterOptions {
  const requestInputTokenEstimate = Math.max(options?.requestInputTokenEstimate ?? 0, estimateProviderRequestInput(request))
  const contextWindow = options?.contextWindow
  const result = { ...options, model: String(request.model ?? options?.model ?? ''), requestInputTokenEstimate }
  if (typeof contextWindow === 'number' && Number.isFinite(contextWindow) && contextWindow > 0) {
    const remaining = Math.floor(contextWindow - requestInputTokenEstimate)
    if (remaining < 1) throw Object.assign(new Error('Provider request input exceeds its configured context window'),
      { code: 'CONTEXT_WINDOW_EXCEEDED', retryable: false, contextWindow, requestInputTokenEstimate })
    result.maxTokens = Math.min(Number.isFinite(wireMaxTokens) && wireMaxTokens! > 0 ? Math.floor(wireMaxTokens!) : remaining, remaining)
  }
  return result
}

type Outcome = 'succeeded' | 'failed' | 'cancelled'
async function begin(options: LLMAdapterOptions | undefined, provider: string, model: string) {
  throwIfAborted(options?.signal)
  const identity = { requestAttemptId: randomUUID(), provider, model }
  await options?.onRequestAttempt?.({ type: 'start', ...identity, estimatedInputTokens: options?.requestInputTokenEstimate, maxOutputTokens: options?.maxTokens })
  return async (outcome: Outcome, usage?: RequestAttemptUsage) => {
    await options?.onRequestAttempt?.({ type: 'finish', ...identity, outcome, ...(usage ? { usage } : {}) })
  }
}

export async function observeRequest<T>(
  request: () => Promise<T>, options: LLMAdapterOptions | undefined, provider: string, model: string,
  getUsage: (value: T) => RequestAttemptUsage | undefined,
): Promise<T> {
  const finish = await begin(options, provider, model)
  let outcome: Outcome = 'failed'
  let usage: RequestAttemptUsage | undefined
  try {
    throwIfAborted(options?.signal)
    const result = await request()
    usage = getUsage(result)
    throwIfAborted(options?.signal)
    outcome = 'succeeded'
    return result
  } catch (error) {
    if (isAbortError(error, options?.signal)) outcome = 'cancelled'
    throw error
  } finally { await finish(outcome, usage) }
}

export async function observeStreamRequest<T>(
  request: () => Promise<AsyncIterable<T>>, options: LLMAdapterOptions | undefined, provider: string, model: string,
  getUsage: (value: T, previous?: RequestAttemptUsage) => RequestAttemptUsage | undefined,
  isTerminal?: (value: T) => boolean,
): Promise<AsyncIterable<T>> {
  const finish = await begin(options, provider, model)
  let stream: AsyncIterable<T>
  try { throwIfAborted(options?.signal); stream = await request() }
  catch (error) { await finish(isAbortError(error, options?.signal) ? 'cancelled' : 'failed'); throw error }
  return (async function* () {
    let outcome: Outcome = 'cancelled'
    let usage: RequestAttemptUsage | undefined
    let completed = !isTerminal
    try {
      for await (const value of stream) {
        usage = getUsage(value, usage) ?? usage
        completed ||= isTerminal?.(value) === true
        throwIfAborted(options?.signal)
        yield value
      }
      throwIfAborted(options?.signal)
      if (!completed) throw Object.assign(new Error('Upstream stream ended before a terminal completion marker'), {
        code: 'INCOMPLETE_STREAM', retryable: true,
      })
      outcome = 'succeeded'
    } catch (error) { outcome = isAbortError(error, options?.signal) ? 'cancelled' : 'failed'; throw error }
    finally { await finish(outcome, usage) }
  })()
}

export function openAIUsage(value: unknown): RequestAttemptUsage | undefined {
  if (!value || typeof value !== 'object') return undefined
  const usage = value as Record<string, unknown>
  const number = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : undefined
  const promptTokens = number(usage.prompt_tokens) ?? number(usage.input_tokens)
  const completionTokens = number(usage.completion_tokens) ?? number(usage.output_tokens)
  if (promptTokens === undefined && completionTokens === undefined) return undefined
  const details = usage.prompt_tokens_details as Record<string, unknown> | undefined
  const completionDetails = usage.completion_tokens_details as Record<string, unknown> | undefined
  const cacheHitTokens = number(usage.prompt_cache_hit_tokens) ?? number(usage.cache_hit_tokens) ?? number(details?.cached_tokens)
  const cacheMissTokens = number(usage.prompt_cache_miss_tokens) ?? (cacheHitTokens !== undefined ? Math.max(0, (promptTokens ?? 0) - cacheHitTokens) : undefined)
  const reasoningTokens = number(completionDetails?.reasoning_tokens) ?? number(usage.reasoning_tokens)
  return { promptTokens: promptTokens ?? 0, completionTokens: completionTokens ?? 0, ...(cacheHitTokens !== undefined ? {cacheHitTokens} : {}), ...(cacheMissTokens !== undefined ? {cacheMissTokens} : {}), ...(reasoningTokens !== undefined ? {reasoningTokens} : {}) }
}

export function anthropicUsage(value: unknown, previous?: RequestAttemptUsage): RequestAttemptUsage | undefined {
  if (!value || typeof value !== 'object') return previous
  const u = value as Record<string, unknown>
  const n = (x: unknown) => typeof x === 'number' && Number.isFinite(x) ? x : undefined
  const input = n(u.input_tokens)
  const cacheHitTokens = n(u.cache_read_input_tokens) ?? previous?.cacheHitTokens
  const cacheMissTokens = n(u.cache_creation_input_tokens) ?? previous?.cacheMissTokens
  return {
    // Anthropic input_tokens excludes its cache read/creation tokens, unlike OpenAI prompt_tokens.
    promptTokens: input !== undefined ? input + (cacheHitTokens ?? 0) + (cacheMissTokens ?? 0) : previous?.promptTokens ?? 0,
    completionTokens: n(u.output_tokens) ?? previous?.completionTokens ?? 0,
    ...(cacheHitTokens !== undefined ? {cacheHitTokens} : {}), ...(cacheMissTokens !== undefined ? {cacheMissTokens, cacheWriteTokens: cacheMissTokens} : {}),
  }
}
