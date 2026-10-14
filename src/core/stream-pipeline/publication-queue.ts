export class PublicationUnavailableError extends Error {
  readonly statusCode = 409
  readonly code = 'publication_recovery_required'
  constructor(readonly reason: 'queue_full' | 'oversized_frame' | 'closed' | 'evidence_unavailable', options?: ErrorOptions) {
    super('Parent stream publication requires recovery: ' + reason, options)
    this.name = 'PublicationUnavailableError'
  }
}

interface Operation { bytes: number; action: () => Promise<unknown>; failQueueOnError: boolean; resolve: (value: unknown) => void; reject: (error: unknown) => void }
export interface PublicationQueueStats {
  pendingEvents: number; pendingBytes: number; highWaterEvents: number; highWaterBytes: number
  maxInFlight: number; closed: boolean; failed: boolean
}

/** A queue slot includes its active operation until the real promise settles.
 * A timeout/observer disconnect cannot release an evidence write's ownership. */
export class BoundedPublicationQueue {
  private pending: Operation[] = []
  private active?: Operation
  private bytes = 0
  private events = 0
  private highEvents = 0
  private highBytes = 0
  private running = false
  private closed = false
  private failure?: PublicationUnavailableError
  private idle: Array<() => void> = []
  constructor(readonly maxEvents = 256, readonly maxBytes = 1024 * 1024) {
    if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > 4096 ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 8 * 1024 * 1024) throw new RangeError('Invalid publication budget')
  }
  get stats(): PublicationQueueStats {
    return { pendingEvents: this.events, pendingBytes: this.bytes, highWaterEvents: this.highEvents,
      highWaterBytes: this.highBytes, maxInFlight: this.highEvents ? 1 : 0, closed: this.closed, failed: this.failure !== undefined }
  }
  run<T>(bytes: number, action: () => Promise<T>, failQueueOnError = true): Promise<T> {
    if (!Number.isSafeInteger(bytes) || bytes < 0) return Promise.reject(new RangeError('Invalid publication byte count'))
    if (this.failure || this.closed) return Promise.reject(this.failure ?? new PublicationUnavailableError('closed'))
    if (bytes > this.maxBytes) return Promise.reject(new PublicationUnavailableError('oversized_frame'))
    if (this.events >= this.maxEvents || this.bytes + bytes > this.maxBytes) return Promise.reject(new PublicationUnavailableError('queue_full'))
    this.bytes += bytes; this.events++
    this.highEvents = Math.max(this.highEvents, this.events); this.highBytes = Math.max(this.highBytes, this.bytes)
    const result = new Promise<T>((resolve, reject) => {
      this.pending.push({ bytes, action, failQueueOnError, resolve: value => resolve(value as T), reject })
    })
    if (!this.running) { this.running = true; void this.pump() }
    return result
  }
  /** Prevent new work; already admitted work still owns its resources. */
  seal(): void { this.closed = true }
  fail(cause: unknown): PublicationUnavailableError {
    if (!this.failure) this.failure = cause instanceof PublicationUnavailableError ? cause
      : new PublicationUnavailableError('evidence_unavailable', { cause })
    this.closed = true
    for (const operation of this.pending.splice(0)) {
      this.events--; this.bytes -= operation.bytes; operation.reject(this.failure)
    }
    this.notifyIdle()
    return this.failure
  }
  async join(): Promise<void> {
    if (this.running || this.events) await new Promise<void>(resolve => this.idle.push(resolve))
  }
  assertHealthy(): void { if (this.failure) throw this.failure }
  private notifyIdle(): void { if (!this.running && !this.events) for (const resolve of this.idle.splice(0)) resolve() }
  private async pump(): Promise<void> {
    try {
      while (this.pending.length) {
        const operation = this.pending.shift()!; this.active = operation
        try {
          const value = await operation.action()
          this.assertHealthy()
          operation.resolve(value)
        } catch (error) { operation.reject(operation.failQueueOnError ? this.fail(error) : error) }
        finally { this.active = undefined; this.events--; this.bytes -= operation.bytes }
      }
    } finally { this.running = false; this.notifyIdle() }
  }
}
