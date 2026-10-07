import { EventEmitter } from 'events'
import { randomUUID } from 'node:crypto'
import { CurrentTurnProjection, decodeStreamChunk, type StreamEnvelope } from './stream-projection.js'

export interface SseEventPayload { id: string; chunk: string }
export interface StreamBusOptions {
  maxReplayEvents?: number
  maxReplayBytes?: number
  maxSubscriberEvents?: number
  /** Maximum bytes queued for one subscriber before it must reload a snapshot. */
  maxSubscriberBytes?: number
  initialProjection?: StreamEnvelope[]
  /** Keep the producer alive when an SSE viewer disconnects (the client can replay later). */
  retainOnDisconnect?: boolean
}
export interface StreamSnapshot {
  schemaVersion: 1
  streamId: string
  eventId: string
  finished: boolean
  error?: string
  /** Older frames remain available from the persisted history snapshot. */
  projectionTruncated?: boolean
  projection: StreamEnvelope[]
}

export class SnapshotRequiredError extends Error {
  readonly statusCode = 409
  readonly code = 'snapshot_required'
  constructor(message = 'Replay cursor is unavailable; load the current snapshot') { super(message); this.name = 'SnapshotRequiredError' }
}

export class StreamBus {
  public readonly events: SseEventPayload[] = []
  public readonly emitter = new EventEmitter()
  public readonly streamId = randomUUID()
  public finished = false
  public errorObj: unknown = null
  public disconnectTimeout: NodeJS.Timeout | null = null
  public readonly maxSubscriberEvents: number
  public readonly maxSubscriberBytes: number
  public readonly retainOnDisconnect: boolean
  private sequence = 0
  private replayBytes = 0
  private readonly maxReplayEvents: number
  private readonly maxReplayBytes: number
  private projection: CurrentTurnProjection

  constructor(public abortController: AbortController, options: StreamBusOptions = {}) {
    this.emitter.setMaxListeners(20)
    this.maxReplayEvents = Math.max(1, options.maxReplayEvents ?? 2048)
    this.maxReplayBytes = Math.max(1, options.maxReplayBytes ?? 8 * 1024 * 1024)
    this.maxSubscriberEvents = Math.max(1, options.maxSubscriberEvents ?? 2048)
    this.maxSubscriberBytes = Math.max(1, options.maxSubscriberBytes ?? 8 * 1024 * 1024)
    this.retainOnDisconnect = options.retainOnDisconnect === true
    this.projection = new CurrentTurnProjection(structuredClone(options.initialProjection ?? []))
  }

  get lastEventId(): string { return `${this.streamId}:${this.sequence}` }

  /** Resume attempts can inherit their turn projection before publishing new events. */
  seedProjection(payloads: StreamEnvelope[]): void {
    if (this.sequence || this.finished) throw new Error('Projection must be seeded before the first event')
    this.projection = new CurrentTurnProjection(structuredClone(payloads))
  }

  push(chunk: string): SseEventPayload | undefined {
    if (this.finished) return undefined
    return this.append(chunk)
  }

  /** Durable cancellation may update an already-ended waiting stream. */
  publishRunState(run: { runId: string; version: number }): SseEventPayload | undefined {
    const current = this.projection.currentRun()
    if (!current || current.runId !== run.runId || typeof current.version !== 'number'
      || !Number.isSafeInteger(run.version) || run.version <= current.version) return undefined
    return this.append('\x00__run__' + JSON.stringify(run))
  }

  private append(chunk: string): SseEventPayload {
    const envelope = decodeStreamChunk(chunk)
    if (envelope) this.projection.apply(envelope)
    const payload = { id: `${this.streamId}:${++this.sequence}`, chunk }
    this.events.push(payload)
    this.replayBytes += Buffer.byteLength(chunk, 'utf8')
    while (this.events.length && (this.events.length > this.maxReplayEvents || this.replayBytes > this.maxReplayBytes)) {
      this.replayBytes -= Buffer.byteLength(this.events.shift()!.chunk, 'utf8')
    }
    // Projection and cursor have already advanced together before listeners can inspect them.
    this.emitter.emit('data', payload)
    return payload
  }

  snapshot(): StreamSnapshot {
    return { schemaVersion: 1, streamId: this.streamId, eventId: this.lastEventId,
      finished: this.finished, ...(this.errorObj ? { error: this.errorObj instanceof Error ? this.errorObj.message : String(this.errorObj) } : {}),
      ...(this.projection.truncated ? { projectionTruncated: true } : {}),
      projection: this.projection.snapshot() }
  }

  assertReplayCursor(cursor?: string): number {
    const prefix = `${this.streamId}:`
    const raw = cursor === undefined ? '0' : cursor.startsWith(prefix) ? cursor.slice(prefix.length) : ''
    if (!/^(0|[1-9]\d*)$/.test(raw)) throw new SnapshotRequiredError()
    const sequence = Number(raw)
    const earliest = this.events.length ? Number(this.events[0].id.slice(prefix.length)) - 1 : this.sequence
    if (!Number.isSafeInteger(sequence) || sequence < earliest || sequence > this.sequence) throw new SnapshotRequiredError()
    return sequence
  }

  end(): void {
    if (this.finished) return
    this.finished = true
    this.emitter.emit('end')
  }

  error(err: unknown): void {
    if (this.finished) return
    this.finished = true
    this.errorObj = err instanceof Error ? err : new Error(String(err))
    // EventEmitter treats an unobserved 'error' as a process-level throw.
    if (this.emitter.listenerCount('error')) this.emitter.emit('error', this.errorObj)
  }
}

export const activeStreams = new Map<string, StreamBus>()

/** Subscribe and capture replay synchronously, before SSE headers or the first next(). */
export function busToIterable(bus: StreamBus, lastEventId?: string): AsyncIterableIterator<SseEventPayload> {
  const cursor = bus.assertReplayCursor(lastEventId)
  const prefixLength = bus.streamId.length + 1
  const queue = bus.events.filter(event => Number(event.id.slice(prefixLength)) > cursor)
  let queuedBytes = queue.reduce((total, event) => total + Buffer.byteLength(event.chunk, 'utf8'), 0)
  let closed = false
  let failure: unknown = queue.length > bus.maxSubscriberEvents || queuedBytes > bus.maxSubscriberBytes
    ? new SnapshotRequiredError('Subscriber replay exceeds its queue budget; load the current snapshot')
    : undefined
  let waiting: { resolve: (value: IteratorResult<SseEventPayload>) => void; reject: (error: unknown) => void } | undefined
  const cleanup = () => {
    bus.emitter.off('data', onData)
    bus.emitter.off('end', onEnd)
    bus.emitter.off('error', onError)
  }
  const finish = () => { closed = true; cleanup(); queue.length = 0; queuedBytes = 0 }
  const settle = () => {
    if (!waiting) return
    const waiter = waiting
    if (failure) { waiting = undefined; finish(); waiter.reject(failure) }
    else if (queue.length) {
      waiting = undefined
      const value = queue.shift()!
      queuedBytes -= Buffer.byteLength(value.chunk, 'utf8')
      waiter.resolve({ done: false, value })
    }
    else if (closed || bus.finished) {
      waiting = undefined
      finish()
      if (bus.errorObj) waiter.reject(bus.errorObj)
      else waiter.resolve({ done: true, value: undefined })
    }
  }
  const onData = (payload: SseEventPayload) => {
    if (closed) return
    queue.push(payload)
    queuedBytes += Buffer.byteLength(payload.chunk, 'utf8')
    if (queue.length > bus.maxSubscriberEvents || queuedBytes > bus.maxSubscriberBytes) {
      failure = new SnapshotRequiredError('Subscriber fell behind; load the current snapshot')
      cleanup()
      queue.length = 0
      queuedBytes = 0
    }
    settle()
  }
  const onEnd = () => settle()
  const onError = () => settle()
  bus.emitter.on('data', onData)
  bus.emitter.on('end', onEnd)
  bus.emitter.on('error', onError)

  return {
    [Symbol.asyncIterator]() { return this },
    next() {
      if (closed) return Promise.resolve({ done: true as const, value: undefined })
      if (waiting) return Promise.reject(new Error('Concurrent reads on one stream subscription are not supported'))
      return new Promise<IteratorResult<SseEventPayload>>((resolve, reject) => { waiting = { resolve, reject }; settle() })
    },
    return() {
      finish()
      if (waiting) { const waiter = waiting; waiting = undefined; waiter.resolve({ done: true, value: undefined }) }
      return Promise.resolve({ done: true as const, value: undefined })
    },
    throw(error: unknown) {
      finish()
      if (waiting) { const waiter = waiting; waiting = undefined; waiter.reject(error) }
      return Promise.reject(error)
    },
  }
}
