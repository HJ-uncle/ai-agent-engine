import { createHash } from 'node:crypto'
import { AnthropicError } from '@anthropic-ai/sdk'

const MAX_EVENT_BYTES = 8192
const knownTypes = {
  overloaded_error: 'transient', rate_limit_error: 'transient', api_error: 'transient',
  internal_error: 'transient', internal_server_error: 'transient', timeout_error: 'transient',
  service_unavailable_error: 'transient', invalid_request_error: 'request', bad_request_error: 'request',
  validation_error: 'request', request_too_large: 'request', not_found_error: 'request',
  authentication_error: 'authentication', permission_error: 'authentication',
  quota_exceeded_error: 'quota', billing_error: 'quota',
} as const
type Classification = typeof knownTypes[keyof typeof knownTypes] | 'unknown'
const safeMessages = new Set([
  'overloaded', 'overloaded error', 'too many requests', 'rate limit exceeded', 'internal server error',
  'service unavailable', 'request timed out', 'invalid request', 'authentication failed',
  'permission denied', 'not found', 'request too large', 'quota exceeded',
])
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const knownCodes = {
  rate_limit_exceeded: 'transient', too_many_requests: 'transient', server_error: 'transient',
  insufficient_quota: 'quota', invalid_api_key: 'authentication', context_length_exceeded: 'request',
} as const
const safeId = (value: unknown): string | undefined => typeof value === 'string' &&
  (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    || /^(?:req|request|msg|resp)_[A-Za-z0-9]{8,64}$/.test(value)) ? value : undefined
const safeStatus = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= 400 && value <= 599 ? value : undefined
interface ResponseDiagnostics { responseStatus?: number; providerRequestId?: string; providerResponseId?: string }

/** SDK 0.20 discards an SSE error's object payload and mislabels it a connection error. */
export class AnthropicStreamError extends AnthropicError {
  readonly code = 'PROVIDER_STREAM_ERROR'
  readonly source = 'anthropic_sse_error'
  // RetryingAdapter still forbids replay after any delivered stream chunk.
  readonly retryable: boolean
  readonly providerErrorType: string
  readonly providerErrorCode?: string
  readonly classification: Classification
  readonly providerStatus?: number
  readonly responseStatus?: number
  readonly providerRequestId?: string
  readonly providerResponseId?: string
  readonly providerMessage: string
  readonly providerMessageSha256?: string
  readonly providerMessageLength?: number
  readonly malformed: boolean

  constructor(data: string, truncated: boolean, response: ResponseDiagnostics = {}) {
    let payload: Record<string, unknown> | undefined
    try { if (!truncated) payload = object(JSON.parse(data)) } catch { /* Untrusted payload stays out of the error. */ }
    const detail = object(payload?.error) ?? payload
    const rawType = detail?.type
    const recognized = typeof rawType === 'string' && Object.prototype.hasOwnProperty.call(knownTypes, rawType)
    const providerErrorType = recognized ? rawType : 'unrecognized_error'
    const rawCode = detail?.code
    const codeType = typeof rawCode === 'string' && Object.prototype.hasOwnProperty.call(knownTypes, rawCode)
    const codeKnown = typeof rawCode === 'string' && Object.prototype.hasOwnProperty.call(knownCodes, rawCode)
    const providerErrorCode = codeType || codeKnown ? rawCode as string : undefined
    // A known request/auth/quota type remains authoritative even if a gateway
    // supplies a conflicting code. Unknown messages never drive classification.
    const classification = recognized ? knownTypes[rawType as keyof typeof knownTypes]
      : codeType ? knownTypes[rawCode as keyof typeof knownTypes]
        : codeKnown ? knownCodes[rawCode as keyof typeof knownCodes] : 'unknown'
    const rawMessage = typeof detail?.message === 'string' ? detail.message : undefined
    // Gateways can quote credentials, prompts, paths or request bodies in message.
    // Keep only a fixed vocabulary; its digest and size permit correlation safely.
    const normalized = rawMessage?.trim().toLowerCase().replace(/[.!]$/, '')
    const providerMessage = normalized && safeMessages.has(normalized) ? normalized : '[provider message redacted]'
    super(`Anthropic gateway stream error: ${providerErrorType} (${classification}); ${providerMessage}`)
    this.name = 'AnthropicStreamError'
    this.providerErrorType = providerErrorType
    this.providerErrorCode = providerErrorCode
    this.classification = classification
    this.retryable = classification === 'transient'
    this.providerStatus = safeStatus(detail?.status) ?? safeStatus(detail?.status_code) ?? safeStatus(payload?.status)
    this.responseStatus = response.responseStatus
    this.providerRequestId = safeId(payload?.request_id) ?? safeId(detail?.request_id) ?? safeId(response.providerRequestId)
    this.providerResponseId = safeId(payload?.response_id) ?? safeId(response.providerResponseId)
    this.providerMessage = providerMessage
    this.malformed = truncated || !detail
    if (rawMessage !== undefined) {
      this.providerMessageSha256 = createHash('sha256').update(rawMessage).digest('hex')
      this.providerMessageLength = rawMessage.length
    }
  }
}

class ErrorEventScanner {
  private line: number[] = []
  private lineTruncated = false
  private skipLf = false
  private event = ''
  private data = ''
  private dataTruncated = false
  private decoder = new TextDecoder()
  constructor(private readonly response: ResponseDiagnostics) {}

  private finishLine(): AnthropicStreamError | undefined {
    const bytes = Uint8Array.from(this.line)
    this.line = []
    const line = this.decoder.decode(bytes)
    const truncated = this.lineTruncated
    this.lineTruncated = false
    if (!line && !truncated) {
      if (this.event === 'message_start' && !this.dataTruncated) {
        try { this.response.providerResponseId = safeId(object(object(JSON.parse(this.data))?.message)?.id) } catch { /* No raw data retained. */ }
      }
      const error = this.event === 'error' ? new AnthropicStreamError(this.data, this.dataTruncated, this.response) : undefined
      this.event = ''; this.data = ''; this.dataTruncated = false
      return error
    }
    if (line.startsWith('event:')) this.event = line.slice(6).replace(/^ /, '').slice(0, 64)
    if (line.startsWith('data:')) {
      const value = line.slice(5).replace(/^ /, '')
      const available = Math.max(0, MAX_EVENT_BYTES - this.data.length)
      this.data += (this.data ? '\n' : '') + value.slice(0, available)
      this.dataTruncated ||= truncated || value.length > available || this.data.length > MAX_EVENT_BYTES
      this.data = this.data.slice(0, MAX_EVENT_BYTES)
    }
    return undefined
  }

  accept(bytes: Uint8Array): { error: AnthropicStreamError; boundary: number } | undefined {
    for (let index = 0; index < bytes.length; index++) {
      const value = bytes[index]
      if (this.skipLf) { this.skipLf = false; if (value === 10) continue }
      if (value === 10 || value === 13) {
        this.skipLf = value === 13
        const error = this.finishLine()
        // Withhold the error frame's final delimiter so SDK never performs its
        // lossy conversion. Earlier frames in the same network chunk still pass.
        if (error) return { error, boundary: index }
      } else if (this.line.length < MAX_EVENT_BYTES) this.line.push(value)
      else this.lineTruncated = true
    }
    return undefined
  }
}

/** Per-response state is bounded and isolated; successful bytes are never rewritten. */
export function preserveAnthropicStreamErrors(response: Response, signal?: AbortSignal | null): Response {
  if (!response.ok || !response.body || !/^text\/event-stream(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) return response
  const reader = response.body.getReader()
  const scanner = new ErrorEventScanner({ responseStatus: response.status,
    providerRequestId: safeId(response.headers.get('request-id')) ?? safeId(response.headers.get('x-request-id')) })
  let pendingError: AnthropicStreamError | undefined
  let cleanupPromise: Promise<void> | undefined
  let finished = false
  let cancelled = false
  let abortListener: (() => void) | undefined
  const cleanup = (cancelReader: boolean, reason?: unknown): Promise<void> => {
    // Cancellation settles reads but does not release their lock. One owner
    // handles EOF, errors and consumer return, including overlapping teardown.
    cleanupPromise ??= (async () => {
      try { if (cancelReader) await reader.cancel(reason) }
      finally {
        if (abortListener) signal?.removeEventListener('abort', abortListener)
        reader.releaseLock()
      }
    })()
    return cleanupPromise
  }
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      abortListener = () => {
        if (finished) return
        finished = true
        const error = new DOMException('Anthropic request aborted', 'AbortError')
        const reject = () => { if (!cancelled) controller.error(error) }
        void cleanup(true, error).then(reject, reject)
      }
      if (signal?.aborted) abortListener()
      else signal?.addEventListener('abort', abortListener, { once: true })
    },
    async pull(controller) {
      if (finished) return
      if (pendingError) {
        finished = true
        try { await cleanup(true, pendingError) } catch { /* Original error is authoritative. */ }
        if (!cancelled) controller.error(pendingError)
        return
      }
      try {
        const next = await reader.read()
        if (finished) return
        if (next.done) {
          finished = true
          await cleanup(false)
          if (!cancelled) controller.close()
          return
        }
        const failure = scanner.accept(next.value)
        if (!failure) { controller.enqueue(next.value); return }
        pendingError = failure.error
        if (failure.boundary > 0) controller.enqueue(next.value.subarray(0, failure.boundary))
        else {
          finished = true
          try { await cleanup(true, pendingError) } catch { /* Original error is authoritative. */ }
          if (!cancelled) controller.error(pendingError)
        }
      } catch (error) {
        finished = true
        try { await cleanup(false) } catch { /* Original error is authoritative. */ }
        if (!cancelled) controller.error(error)
      }
    },
    async cancel(reason) {
      cancelled = true
      finished = true
      await cleanup(true, reason)
    },
  }, { highWaterMark: 0 })
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
}
