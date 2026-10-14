import { EventEmitter } from 'events'
import { randomUUID } from 'node:crypto'
import { CurrentTurnProjection, decodeStreamChunk, type StreamEnvelope, type SubagentWatermark, type ChildSequenceSource } from './stream-projection.js'
import { BoundedPublicationQueue, PublicationUnavailableError, type PublicationQueueStats } from './publication-queue.js'

export interface SseEventPayload { id: string; chunk: string }

/** Listener lifecycle events are observations too. In particular, EventEmitter's
 * once wrapper removes itself before invoking the reader; a throwing meta-listener
 * must not prevent that reader from observing the terminal event. */
class StreamObserverEmitter extends EventEmitter {
  constructor(private readonly onFailure: (event: string | symbol) => void) { super() }
  override emit(event: string | symbol, ...args: unknown[]): boolean {
    const listeners = this.rawListeners(event)
    const fail = (listener: (...values: unknown[]) => unknown): void => {
      // Off invokes removeListener observers. Even a replaced/hostile method must
      // not make our async rejection handler itself reject.
      try { this.off(event, listener) } catch { /* Reader isolation includes lifecycle removal. */ }
      try { this.onFailure(event) } catch { /* Diagnostics must not own execution. */ }
    }
    for (const raw of listeners) {
      const listener = raw as (...values: unknown[]) => unknown
      try {
        const result: unknown = Reflect.apply(listener, this, args)
        if (result !== undefined) void Promise.resolve(result).catch(() => fail(listener))
      } catch { fail(listener) }
    }
    return listeners.length > 0
  }
}
export interface StreamBusOptions {
  /** Modern publishers must commit exact child evidence before projection/broadcast.
   * All frames share this ordering barrier; legacy synchronous producers remain separate. */
  publication?: {
    beforeAppend(sequence: number, chunk: string, streamId: string): Promise<void>
    beforeTerminal(sequence: number, streamId: string): Promise<void>
    /** The lazy projection is still inside producer order and not yet visible.
     * Ordinary frames need not clone or write a checkpoint unless selected. */
    beforeVisible?(snapshot: () => StreamSnapshot, chunk: string, sequence: number): Promise<void>
    beforeClose?(snapshot: StreamSnapshot): Promise<void>
    maxEvents?: number
    maxBytes?: number
  }
  maxReplayEvents?: number
  maxReplayBytes?: number
  maxSubscriberEvents?: number
  /** Maximum bytes queued for one subscriber before it must reload a snapshot. */
  maxSubscriberBytes?: number
  /** Explicit server-owned SQL recovery protocol; publication hooks alone do not select it. */
  childSequenceSource?: ChildSequenceSource
  initialProjection?: StreamEnvelope[]
  initialSubagentWatermarks?: SubagentWatermark[]
  initialProjectionTruncated?: boolean
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
  subagentWatermarks?: SubagentWatermark[]
  publicationRecovery?: { reason: string; lastConfirmedEventId: string }
  /** Viewer callbacks cannot change execution or evidence authority. Counts are bounded diagnostics only. */
  observerFailures?: { data: number; end: number; error: number; lifecycle: number }
}

export class SnapshotRequiredError extends Error {
  readonly statusCode = 409
  readonly code = 'snapshot_required'
  constructor(message = 'Replay cursor is unavailable; load the current snapshot') { super(message); this.name = 'SnapshotRequiredError' }
}

export class StreamBus {
  public readonly events: SseEventPayload[] = []
  public readonly emitter = new StreamObserverEmitter(event => {
    const key = event === 'data' || event === 'end' || event === 'error' ? event : 'lifecycle'
    this.observerFailures[key] = Math.min(Number.MAX_SAFE_INTEGER, this.observerFailures[key] + 1)
  })
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
  readonly childSequenceSource: ChildSequenceSource
  private readonly publication?: StreamBusOptions['publication']
  private readonly publications: BoundedPublicationQueue
  private publicationClosing = false
  private terminalPublication?: Promise<void>
  private publicationRecovery?: StreamSnapshot['publicationRecovery']
  private lastConfirmedPublication?: string
  private readonly observerFailures = { data: 0, end: 0, error: 0, lifecycle: 0 }

  constructor(public abortController: AbortController, options: StreamBusOptions = {}) {
    this.emitter.setMaxListeners(20)
    this.maxReplayEvents = Math.max(1, options.maxReplayEvents ?? 2048)
    this.maxReplayBytes = Math.max(1, options.maxReplayBytes ?? 8 * 1024 * 1024)
    this.maxSubscriberEvents = Math.max(1, options.maxSubscriberEvents ?? 2048)
    this.maxSubscriberBytes = Math.max(1, options.maxSubscriberBytes ?? 8 * 1024 * 1024)
    this.retainOnDisconnect = options.retainOnDisconnect === true
    this.publication = options.publication
    this.childSequenceSource = options.childSequenceSource ?? 'legacy-memory'
    if (this.childSequenceSource === 'published-store' && !this.publication) throw new Error('SQL child sequences require ordered publication')
    this.publications = new BoundedPublicationQueue(options.publication?.maxEvents, options.publication?.maxBytes)
    this.projection = new CurrentTurnProjection(structuredClone(options.initialProjection ?? []), options.initialSubagentWatermarks, options.initialProjectionTruncated, this.childSequenceSource)
    if (this.publication && this.projection.hasChildEvidence) throw new Error('A new published stream cannot seed unadmitted child evidence')
  }

  get lastEventId(): string { return `${this.streamId}:${this.sequence}` }

  /** Status probes need identity only; never clone transcript/image payloads or expose mutable run state. */
  get currentRunId(): string | undefined {
    const runId = this.projection.currentRun()?.runId
    return typeof runId === 'string' ? runId : undefined
  }

  /** Resume attempts can inherit their turn projection before publishing new events. */
  seedProjection(payloads: StreamEnvelope[], subagentWatermarks?: SubagentWatermark[], projectionTruncated = false): void {
    if (this.sequence || this.finished || this.publicationClosing || this.publications.stats.pendingEvents) throw new Error('Projection must be seeded before the first event')
    const projection = new CurrentTurnProjection(structuredClone(payloads), subagentWatermarks, projectionTruncated, this.childSequenceSource)
    if (this.publication && projection.hasChildEvidence) throw new Error('A new published stream cannot seed unadmitted child evidence')
    this.projection = projection
  }

  /** Trusted publication authority calls this only after its atomic imported-R
   * proof. The ordinary seed API still rejects unadmitted child watermarks. */
  seedAdmittedProjection(seed: { streamId: string; checkpointId: string; digest: string; projection: StreamEnvelope[];
    watermarks: SubagentWatermark[]; projectionTruncated: boolean }): void {
    if (!this.publication || seed.streamId !== this.streamId || !seed.checkpointId || !/^[a-f0-9]{64}$/.test(seed.digest))
      throw new Error('Invalid admitted projection owner')
    if (this.sequence || this.finished || this.publicationClosing || this.publications.stats.pendingEvents)
      throw new Error('Projection must be seeded before the first event')
    this.projection = new CurrentTurnProjection(structuredClone(seed.projection), seed.watermarks, seed.projectionTruncated, this.childSequenceSource)
  }

  push(chunk: string): SseEventPayload | undefined {
    this.assertSynchronousPublication()
    if (this.finished) return undefined
    return this.append(chunk)
  }

  /** Durable cancellation may update an already-ended waiting stream. */
  publishRunState(run: { runId: string; version: number }): SseEventPayload | undefined {
    this.assertSynchronousPublication()
    const current = this.projection.currentRun()
    if (!current || current.runId !== run.runId || typeof current.version !== 'number'
      || !Number.isSafeInteger(run.version) || run.version <= current.version) return undefined
    return this.append('\x00__run__' + JSON.stringify(run))
  }

  get publicationStats(): PublicationQueueStats { return this.publications.stats }
  private assertSynchronousPublication(): void {
    if (this.publication || this.publications.stats.pendingEvents) throw new Error('Use awaited ordered publication methods on this stream')
  }
  private notifyObservers(event: 'data' | 'end' | 'error', ...args: unknown[]): void {
    this.emitter.emit(event, ...args)
  }
  private observationFailure(cause: unknown, lastConfirmedEventId: string): PublicationUnavailableError {
    const error = this.publications.fail(cause)
    this.publicationRecovery ??= { reason: error.reason, lastConfirmedEventId }
    this.publicationClosing = true
    // Failure of an observation channel does not abort the executor or its peers.
    // Join an in-flight evidence commit before notifying readers that it ended.
    void this.publications.join().then(() => this.finishError(error))
    return error
  }
  /** A failed durable seed is an observer failure just like a failed append.
   * Mark it explicitly before an executor continues with its real history. */
  failPublication(cause: unknown): void {
    this.observationFailure(cause,this.lastConfirmedPublication ?? `${this.streamId}:0`)
  }
  private ordered<T>(bytes: number, action: () => Promise<T>): Promise<T> {
    return this.publications.run(bytes, action).catch(error => {
      throw this.observationFailure(error, this.lastConfirmedPublication ?? `${this.streamId}:0`)
    })
  }
  private async appendPublished(chunk: string): Promise<SseEventPayload> {
    await this.publication?.beforeAppend(this.sequence + 1, chunk, this.streamId)
    this.publications.assertHealthy()
    let prepared: StreamSnapshot | undefined
    await this.publication?.beforeVisible?.(() => {
      if (!prepared) {
        const projection = this.projection.fork()
        const envelope = decodeStreamChunk(chunk)
        if (envelope) projection.apply(envelope)
        prepared = this.snapshotOf(projection, this.sequence + 1)
      }
      return prepared
    }, chunk, this.sequence + 1)
    this.publications.assertHealthy()
    const payload = this.append(chunk)
    this.lastConfirmedPublication = payload.id
    return payload
  }
  async publish(chunk: string): Promise<SseEventPayload | undefined> {
    if (this.publicationRecovery) throw new PublicationUnavailableError('evidence_unavailable')
    if (this.finished || this.publicationClosing) return undefined
    return this.ordered(Buffer.byteLength(chunk, 'utf8'), () => this.appendPublished(chunk))
  }
  /** A cancelled durable waiting run may update its ended projection, in order. */
  async publishRunStateOrdered(run: { runId: string; version: number }): Promise<SseEventPayload | undefined> {
    const chunk = '\x00__run__' + JSON.stringify(run)
    return this.ordered(Buffer.byteLength(chunk, 'utf8'), async () => {
      const current = this.projection.currentRun()
      if (!current || current.runId !== run.runId || typeof current.version !== 'number' ||
        !Number.isSafeInteger(run.version) || run.version <= current.version) return undefined
      return this.appendPublished(chunk)
    })
  }
  /** Lease issuance runs inside the same queue as child and ordinary frames.
   * Merely awaiting an idle promise would allow a later publication to overtake it. */
  atPublicationFence<T>(reader: (snapshot: StreamSnapshot) => Promise<T>): Promise<T> {
    return this.publications.run(0, async () => {
      try { await this.publication?.beforeTerminal(this.sequence, this.streamId) }
      catch (error) { throw this.observationFailure(error, this.lastConfirmedPublication ?? `${this.streamId}:0`) }
      this.publications.assertHealthy()
      return reader(this.snapshot())
    }, false)
  }
  private orderedTerminal(error?: unknown): Promise<void> {
    if (this.terminalPublication) return this.terminalPublication
    if (this.finished) return Promise.resolve()
    this.publicationClosing = true
    this.terminalPublication = this.ordered(0, async () => {
      await this.publication?.beforeTerminal(this.sequence, this.streamId)
      this.publications.assertHealthy()
      await this.publication?.beforeClose?.({ ...this.snapshot(), finished: true,
        ...(error === undefined ? {} : { error: error instanceof Error ? error.message : String(error) }) })
      this.publications.assertHealthy()
      if (error === undefined) this.finishEnd(); else this.finishError(error)
    })
    return this.terminalPublication
  }
  endOrdered(): Promise<void> { return this.orderedTerminal() }
  errorOrdered(error: unknown): Promise<void> { return this.orderedTerminal(error) }

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
    this.notifyObservers('data', payload)
    return payload
  }

  private snapshotOf(projection: CurrentTurnProjection, sequence: number): StreamSnapshot {
    const subagentWatermarks = projection.subagentWatermarks()
    return { schemaVersion: 1, streamId: this.streamId, eventId: `${this.streamId}:${sequence}`,
      finished: this.finished, ...(this.errorObj ? { error: this.errorObj instanceof Error ? this.errorObj.message : String(this.errorObj) } : {}),
      ...(projection.truncated ? { projectionTruncated: true } : {}),
      projection: projection.snapshot(), ...(subagentWatermarks.length ? { subagentWatermarks } : {}),
      ...(this.publicationRecovery ? { publicationRecovery: { ...this.publicationRecovery } } : {}),
      ...(Object.values(this.observerFailures).some(count => count > 0) ? { observerFailures: { ...this.observerFailures } } : {}) }
  }
  snapshot(): StreamSnapshot { return this.snapshotOf(this.projection, this.sequence) }

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
    this.assertSynchronousPublication()
    this.finishEnd()
  }
  private finishEnd(): void {
    if (this.finished) return
    this.finished = true
    this.notifyObservers('end')
  }

  error(err: unknown): void {
    this.assertSynchronousPublication()
    this.finishError(err)
  }
  private finishError(err: unknown): void {
    if (this.finished) return
    this.finished = true
    this.errorObj = err instanceof Error ? err : new Error(String(err))
    this.notifyObservers('error', this.errorObj)
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
