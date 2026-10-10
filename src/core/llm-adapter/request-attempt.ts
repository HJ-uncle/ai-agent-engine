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

/** A sparse wire snapshot cannot accept a ledger whose missing fields were defaulted. */
export type OpenAIUsageSnapshot = Partial<Omit<RequestAttemptUsage, 'unknown'>> & { unknown?: never }

/** Preserve absent fields for streaming consumers; absence is not an explicit zero. */
export function openAIUsageSnapshot(value: unknown, previous?: OpenAIUsageSnapshot): OpenAIUsageSnapshot | undefined {
  if (!value || typeof value !== 'object') return previous
  const usage = value as Record<string, unknown>
  const number = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined
  const input = number(usage.prompt_tokens) ?? number(usage.input_tokens)
  const output = number(usage.completion_tokens) ?? number(usage.output_tokens)
  if (input === undefined && output === undefined && !previous) return undefined
  // Stream usage is a cumulative snapshot. Some compatible endpoints patch
  // only one field, so missing fields retain their prior value; explicit zero
  // remains zero. Never add snapshots together or add cache hits to input.
  const promptTokens = input ?? previous?.promptTokens
  const completionTokens = output ?? previous?.completionTokens
  const details = usage.prompt_tokens_details as Record<string, unknown> | undefined
  const completionDetails = usage.completion_tokens_details as Record<string, unknown> | undefined
  const reportedCacheHit = number(usage.prompt_cache_hit_tokens) ?? number(usage.cache_hit_tokens)
    ?? number(details?.cached_tokens)
  const cacheHitTokens = reportedCacheHit ?? previous?.cacheHitTokens
  const cacheMissTokens = number(usage.prompt_cache_miss_tokens)
    ?? (input === undefined && reportedCacheHit === undefined ? previous?.cacheMissTokens : undefined)
    ?? (cacheHitTokens !== undefined && promptTokens !== undefined ? Math.max(0, promptTokens - cacheHitTokens) : previous?.cacheMissTokens)
  const reasoningTokens = number(completionDetails?.reasoning_tokens) ?? number(usage.reasoning_tokens) ?? previous?.reasoningTokens
  return { ...(promptTokens !== undefined ? {promptTokens} : {}), ...(completionTokens !== undefined ? {completionTokens} : {}),
    ...(cacheHitTokens !== undefined ? {cacheHitTokens} : {}), ...(cacheMissTokens !== undefined ? {cacheMissTokens} : {}),
    ...(reasoningTokens !== undefined ? {reasoningTokens} : {}) }
}

/** Convert only after accumulating sparse wire snapshots, never before. */
export function openAIUsageFromSnapshot(snapshot: OpenAIUsageSnapshot | undefined): RequestAttemptUsage | undefined {
  return snapshot ? { ...snapshot, promptTokens: snapshot.promptTokens ?? 0, completionTokens: snapshot.completionTokens ?? 0,
    ...(snapshot.promptTokens === undefined || snapshot.completionTokens === undefined ? { unknown: true } : {}) } : undefined
}

/** Parse a single non-streaming provider usage object. */
export function openAIUsage(value: unknown): RequestAttemptUsage | undefined {
  return openAIUsageFromSnapshot(openAIUsageSnapshot(value))
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

/** Keep raw counters sparse: compatible gateways can correct input/cache at message_delta. */
export type AnthropicUsageSnapshot = Partial<{
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}>

export function anthropicUsageSnapshot(value: unknown, previous?: AnthropicUsageSnapshot): AnthropicUsageSnapshot | undefined {
  if (!value || typeof value !== 'object') return previous
  const raw = value as Record<string, unknown>
  const snapshot = { ...previous }
  let reported = false
  for (const field of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const) {
    const counter = raw[field]
    if (typeof counter === 'number' && Number.isFinite(counter) && counter >= 0) {
      snapshot[field] = counter
      reported = true
    }
  }
  return reported ? snapshot : previous
}

export function anthropicUsageFromSnapshot(snapshot: AnthropicUsageSnapshot | undefined): RequestAttemptUsage | undefined {
  if (!snapshot) return undefined
  const cacheHitTokens = snapshot.cache_read_input_tokens
  const cacheMissTokens = snapshot.cache_creation_input_tokens
  return {
    promptTokens: (snapshot.input_tokens ?? 0) + (cacheHitTokens ?? 0) + (cacheMissTokens ?? 0),
    completionTokens: snapshot.output_tokens ?? 0,
    ...(cacheHitTokens !== undefined ? { cacheHitTokens } : {}),
    ...(cacheMissTokens !== undefined ? { cacheMissTokens, cacheWriteTokens: cacheMissTokens } : {}),
    ...(snapshot.input_tokens === undefined || snapshot.output_tokens === undefined ? { unknown: true } : {}) }
}
