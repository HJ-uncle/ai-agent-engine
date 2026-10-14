import type { Client, Transaction } from '@libsql/client'
import { StreamBus, type StreamBusOptions, type StreamSnapshot } from '../stream-pipeline/stream-bus.js'
import { decodeStreamChunk } from '../stream-pipeline/stream-projection.js'
import { ensureChildRecoverySchema } from './child-recovery-schema.js'
import { requireChildRecovery } from './child-usage-authority.js'
import { admitPublishedChild, advancePublicationBoundary, ensurePublicationOwner, type PublicationScope } from './published-store.js'
import { PublishedRecoveryLeases, type PublishedRecoveryEnvelope } from './recovery-leases.js'
import { childReceiptGroup } from './child-receipt-shapes.js'
import { PublishedTurnBootstraps, type TurnBootstrap } from './turn-bootstrap.js'
import { SubagentStore } from './store.js'

type ParentScope = Omit<PublicationScope, 'streamId'>
export interface DurablePublicationOptions { enabled: boolean; childSequenceSource?: 'published-store'; checkpointIntervalMs?: number; checkpointEveryEvents?: number; now?: () => number }
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

/** The trusted producer supplies root/turn/attempt; a viewer never creates an owner.
 * This owner is for a new stream. Resume/persisted bootstraps have distinct contracts. */
export class ParentPublicationAuthority {
  private readonly parent: ParentScope
  private stream?: string
  private readyPromise?: Promise<void>
  private checkpointSequence = 0
  private checkpointAt = 0
  readonly leases: PublishedRecoveryLeases
  constructor(readonly db: Client, scope: ParentScope, private readonly durable?: DurablePublicationOptions) {
    this.parent = Object.freeze({ ...scope })
    this.leases = new PublishedRecoveryLeases(db)
  }
  private scope(streamId: string): PublicationScope {
    if (typeof streamId !== 'string' || !streamId || this.stream && this.stream !== streamId) requireChildRecovery('scope_mismatch')
    this.stream ??= streamId
    return { ...this.parent, streamId }
  }
  private async transaction<T>(action: (tx: Transaction) => Promise<T>): Promise<T> {
    const tx = await this.db.transaction('write')
    try { const value = await action(tx); await tx.commit(); return value }
    catch (error) { if (!tx.closed) await tx.rollback(); throw error }
    finally { tx.close() }
  }
  private ready(streamId: string): Promise<void> {
    const scope = this.scope(streamId)
    return this.readyPromise ??= (async () => {
      // A first run may publish before any child exists. Its durable usage proof
      // still queries checkpoint tables and must initialize that schema first.
      await new SubagentStore(this.db).initialize()
      await ensureChildRecoverySchema(this.db)
      await this.transaction(tx => ensurePublicationOwner(tx, scope))
    })().catch(error => { this.readyPromise = undefined; throw error })
  }
  private child(chunk: string): { runId: string; seq: number } | undefined {
    const envelope = decodeStreamChunk(chunk)
    if (!envelope && chunk.startsWith('\x00__subagent_event__')) requireChildRecovery('invalid_identity')
    if (!envelope) return undefined
    const event = record(envelope.subagentEvent)
    if (envelope.subagentEvent !== undefined && !event) requireChildRecovery('invalid_identity')
    const tool = record(envelope.toolEnd ?? envelope.toolResult)
    const receipts = tool && childReceiptGroup(tool)
    const child = event ?? receipts?.identities[0]
    if (!child) return undefined
    const identity = event?.schemaVersion === 1 ? record(event.snapshot)
      : record(event?.identity ?? event?.view) ?? child
    if (event && event.schemaVersion !== 1 && event.schemaVersion !== 2) requireChildRecovery('invalid_identity')
    const identities: Array<[string, string]> = [['tenantId', this.parent.tenantId], ['rootSessionId', this.parent.rootSessionId],
      ['parentSessionId', this.parent.parentSessionId], ['parentConversationId', this.parent.parentTurnId]]
    for (const candidate of event ? [identity] : receipts?.identities ?? []) for (const [field, expected] of identities) if (candidate && candidate[field] !== undefined && candidate[field] !== expected) requireChildRecovery('foreign_checkpoint')
    const runId = child.runId, seq = event ? event.seq : receipts?.seq
    if (typeof runId !== 'string' || !runId || typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1) requireChildRecovery('invalid_identity')
    if (identity?.runId !== undefined && identity.runId !== runId || identity?.lastSeq !== undefined && identity.lastSeq !== seq) requireChildRecovery('invalid_identity')
    return { runId, seq }
  }
  private get projectionOptions(): { childSequenceSource: 'published-store' } | undefined {
    return this.durable?.childSequenceSource === 'published-store' ? { childSequenceSource: 'published-store' } : undefined
  }
  readonly hooks: NonNullable<StreamBusOptions['publication']> = {
    beforeAppend: async (sequence, chunk, streamId) => {
      const child = this.child(chunk)
      await this.ready(streamId)
      // Ordinary text shares queue order, with no SQLite write per token.
      if (child) await this.transaction(tx => admitPublishedChild(tx, this.scope(streamId), sequence, child.runId, child.seq))
    },
    beforeTerminal: async (sequence, streamId) => {
      await this.ready(streamId)
      await this.transaction(tx => advancePublicationBoundary(tx, this.scope(streamId), sequence))
    },
    beforeVisible: async (prepare, chunk, sequence) => {
      if (!this.durable?.enabled) return
      const now = this.durable.now?.() ?? Date.now()
      const control = decodeStreamChunk(chunk)
      const important = Boolean(control && ['run','subagentEvent','toolEnd','toolResult','usage','ask_user','permissionRequest'].some(key => control[key] !== undefined))
      const due = now - this.checkpointAt >= (this.durable.checkpointIntervalMs ?? 1000) || sequence - this.checkpointSequence >= (this.durable.checkpointEveryEvents ?? 64)
      // The initial user frame precedes root publication. It is included in the
      // first run checkpoint rather than falsely inventing a root at that point.
      if (!important && (control?.userMessage || !this.checkpointSequence || !due)) return
      const snapshot = prepare()
      await this.ready(snapshot.streamId)
      await this.transaction(tx => advancePublicationBoundary(tx, this.scope(snapshot.streamId), sequence))
      await new PublishedTurnBootstraps(this.db).capture(this.scope(snapshot.streamId), snapshot, this.projectionOptions)
      this.checkpointSequence = sequence; this.checkpointAt = now
    },
    beforeClose: async snapshot => {
      if (!this.durable?.enabled) return
      const { error, ...header } = snapshot, store = new PublishedTurnBootstraps(this.db)
      // End notification is a distinct observation from the immutable data E.
      // Its closure receipt cannot rewrite bytes already admitted at that E.
      const checkpoint = await store.capture(this.scope(snapshot.streamId), { ...header, finished: false }, this.projectionOptions)
      await store.closeCheckpoint(this.scope(snapshot.streamId), checkpoint.checkpointId, error)
      this.checkpointSequence = Number(snapshot.eventId.slice(snapshot.streamId.length + 1)); this.checkpointAt = this.durable.now?.() ?? Date.now()
    },
  }
  /** Queue order holds while the lease captures E/R/U in its physical transaction. */
  capture(bus: StreamBus, limit = 64): Promise<PublishedRecoveryEnvelope> {
    return this.captureSnapshot(bus, limit).then(result => result.recovery)
  }
  captureSnapshot(bus: StreamBus, limit = 64): Promise<{ snapshot: StreamSnapshot; recovery: PublishedRecoveryEnvelope }> {
    if (this.stream && this.stream !== bus.streamId) return Promise.reject(new Error('Wrong parent publication owner'))
    return bus.atPublicationFence(async snapshot => {
      const sequence = Number(snapshot.eventId.slice(snapshot.streamId.length + 1))
      const recovery = await this.leases.issue(this.scope(snapshot.streamId), limit, sequence)
      return { snapshot, recovery }
    })
  }
  /** Explicit producer checkpoint. It makes no older bus/history authoritative
   * and does not enable the unavailable persisted/approval HTTP routes. */
  captureBootstrap(bus: StreamBus): Promise<TurnBootstrap> {
    if (this.stream && this.stream !== bus.streamId) return Promise.reject(new Error('Wrong parent publication owner'))
    return bus.atPublicationFence(async snapshot => {
      const store = new PublishedTurnBootstraps(this.db)
      const { error, ...body } = snapshot
      const checkpoint = await store.capture(this.scope(snapshot.streamId), { ...body, finished: false }, this.projectionOptions)
      if (snapshot.finished) await store.closeCheckpoint(this.scope(snapshot.streamId), checkpoint.checkpointId, error)
      return checkpoint
    })
  }
  async resumeBootstrap(bus: StreamBus, predecessor: TurnBootstrap): Promise<void> {
    try {
      const store = new PublishedTurnBootstraps(this.db)
      await store.resume(predecessor.checkpointId, predecessor.fence, this.scope(bus.streamId))
      const seed = await store.projectionSeed(predecessor.fence, predecessor.checkpointId)
      bus.seedAdmittedProjection({ ...seed,streamId: bus.streamId })
    } catch (error) {
      bus.failPublication(error)
      throw error
    }
  }
}
