import { randomUUID } from 'node:crypto'
import { getDb } from '../../storage/sqlite/db.js'
import { SubagentStore, getSubagentStore } from '../subagent/store.js'
import type { CreateSubagentRun, SubagentMutation } from '../subagent/types.js'
import { admissionFingerprint, CollaborationStore, rootInvocationId } from './store.js'
import { CollaborationError, type CollaborationBinding, type CollaborationProducer, type CollaborationReceipt } from './types.js'
import { SQLiteCollaborationDelivery, type SQLiteDeliveryConsumer, type SQLiteDeliveryBatch, type SQLiteDeliveryReceipt } from './sqlite-delivery.js'
import type { Client, Row } from '@libsql/client'
import { JSONLCollaborationDelivery, type JSONLDeliveryConsumer } from './jsonl-delivery.js'
import type { JSONLHistoryOrigin } from '../../storage/conversation/jsonl-origin.js'
import type { Message } from '../agent-context/types.js'
import type { HistoryMaintenanceLease } from './history-maintenance.js'
import type { ExecutionOwner } from './execution-owner.js'

/** Server services retain these capabilities; model/HTTP args can only supply targets. */
export class CollaborationRuntime {
  private readonly generation = randomUUID()
  private readonly principals = new WeakMap<CollaborationProducer, CollaborationBinding>()
  private readonly roots = new Map<string, CollaborationProducer>()
  private readonly children = new Map<string, CollaborationProducer>()
  private operation: Promise<unknown> = Promise.resolve()
  private readonly sqliteDelivery: SQLiteCollaborationDelivery
  private readonly jsonlDelivery: JSONLCollaborationDelivery
  constructor(readonly store: CollaborationStore, private readonly subagents: SubagentStore) {
    this.sqliteDelivery = new SQLiteCollaborationDelivery(store, producer => this.binding(producer))
    this.jsonlDelivery = new JSONLCollaborationDelivery(store, producer => this.binding(producer))
  }

  bindJSONLDelivery(producer: CollaborationProducer, history: { origin: JSONLHistoryOrigin; tenantId: string; sessionId: string; anchorId: string; anchorContent?: string; executionOwner?: ExecutionOwner }): Promise<JSONLDeliveryConsumer> {
    this.binding(producer)
    return this.serialize(() => this.jsonlDelivery.bind(producer, history))
  }
  consumeJSONLDelivery(consumer: JSONLDeliveryConsumer, budget?: { maxRows?: number; maxBytes?: number }): Promise<SQLiteDeliveryBatch> {
    return this.serialize(() => this.jsonlDelivery.consume(consumer, budget))
  }
  jsonlDeliverySnapshot(consumer: JSONLDeliveryConsumer, inheritContext: boolean): Promise<Message[]> {
    return this.jsonlDelivery.snapshot(consumer, inheritContext)
  }
  jsonlMaintenanceLease(producer: CollaborationProducer, consumer: JSONLDeliveryConsumer): Promise<HistoryMaintenanceLease> {
    this.binding(producer)
    return this.jsonlDelivery.maintenanceLease(producer, consumer)
  }
  jsonlDeliveryReceipt(producer: CollaborationProducer, messageId: string): Promise<SQLiteDeliveryReceipt | null> {
    this.binding(producer)
    return this.serialize(() => this.jsonlDelivery.receipt(producer, messageId))
  }

  bindSQLiteDelivery(producer: CollaborationProducer, history: { db: Client; tenantId: string; sessionId: string; anchorId: string; anchorContent?: string; executionOwner?: ExecutionOwner }): Promise<SQLiteDeliveryConsumer> {
    this.binding(producer)
    return this.serialize(() => this.sqliteDelivery.bind(producer, history))
  }
  consumeSQLiteDelivery(consumer: SQLiteDeliveryConsumer, budget?: { maxRows?: number; maxBytes?: number }): Promise<SQLiteDeliveryBatch> {
    return this.serialize(() => this.sqliteDelivery.consume(consumer, budget))
  }
  sqliteDeliverySnapshot(consumer: SQLiteDeliveryConsumer, inheritContext: boolean): Promise<Row[]> {
    // A read snapshot authenticates its own durable revision; it must not hold
    // the runtime's global mutation queue while another root accepts a send.
    return this.sqliteDelivery.snapshot(consumer, inheritContext)
  }
  sqliteMaintenanceLease(producer: CollaborationProducer, consumer: SQLiteDeliveryConsumer): Promise<HistoryMaintenanceLease> {
    this.binding(producer)
    return this.sqliteDelivery.maintenanceLease(producer, consumer)
  }
  sqliteDeliveryReceipt(producer: CollaborationProducer, messageId: string): Promise<SQLiteDeliveryReceipt | null> {
    this.binding(producer)
    return this.serialize(() => this.sqliteDelivery.receipt(producer, messageId))
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.operation.catch(() => undefined).then(operation)
    this.operation = pending.catch(() => undefined)
    return pending
  }
  private issue(binding: CollaborationBinding): CollaborationProducer {
    const capability = Object.freeze({}) as CollaborationProducer
    this.principals.set(capability, Object.freeze({ ...binding }))
    return capability
  }
  private binding(producer: CollaborationProducer): CollaborationBinding {
    const binding = this.principals.get(producer)
    if (!binding) throw new CollaborationError('forbidden', 'A live server producer capability is required')
    return binding
  }
  executionBinding(producer: CollaborationProducer): CollaborationBinding { return this.binding(producer) }

  /** Root admission supplies this private attempt; it is not an exposed route. */
  admitRoot(input: { tenantId: string; rootRunId: string; rootAttemptId: string }): Promise<CollaborationProducer> {
    return this.serialize(async () => {
      await this.subagents.initialize()
      const identity = await this.store.resolveRootAdmission(input.tenantId, input.rootRunId, input.rootAttemptId)
      const binding: CollaborationBinding = { ...input, ...identity, generation: this.generation, participantId: `root:${input.rootRunId}`,
        sessionId: identity.rootSessionId, invocationRunId: rootInvocationId(input.rootRunId, input.rootAttemptId), kind: 'root' }
      await this.store.openRoot(binding)
      const key = JSON.stringify([input.tenantId, input.rootRunId, input.rootAttemptId])
      let producer = this.roots.get(key)
      if (!producer) { producer = this.issue(binding); this.roots.set(key, producer) }
      return producer
    })
  }
  lookupRootAdmissionReceipt(input: { tenantId: string; rootRunId: string; rootAttemptId: string }): Promise<CollaborationProducer | null> {
    return this.serialize(async () => {
      const identity = await this.store.resolveRootAdmission(input.tenantId, input.rootRunId, input.rootAttemptId)
      const binding: CollaborationBinding = { ...input, ...identity, generation: this.generation, participantId: `root:${input.rootRunId}`,
        sessionId: identity.rootSessionId, invocationRunId: rootInvocationId(input.rootRunId, input.rootAttemptId), kind: 'root' }
      if (!await this.store.lookupRootAdmissionReceipt(binding)) return null
      const id = JSON.stringify([input.tenantId, input.rootRunId, input.rootAttemptId])
      let producer = this.roots.get(id)
      if (!producer) { producer = this.issue(binding); this.roots.set(id, producer) }
      return producer
    })
  }

  admitChild(producer: CollaborationProducer, input: CreateSubagentRun): Promise<{ producer: CollaborationProducer; mutation: SubagentMutation }> {
    // Resolve object ownership before asynchronous work so a copied shape can
    // never acquire a capability merely by matching readable identity fields.
    const parent = this.binding(producer)
    if (parent.kind !== 'root') throw new CollaborationError('forbidden', 'Nested child admission has not been authorized')
    if (input.childSessionId !== undefined) throw new CollaborationError('invalid', 'Child session identity is generated by admission or frozen continuation')
    return this.serialize(async () => {
      await this.store.prepare()
      let admitted: CollaborationBinding | undefined
      const mutation = await this.subagents.createRunDelta(input, async (tx, header, admission) => {
        admitted = await this.store.admitChild(tx, parent, header, admission, admissionFingerprint(input))
      })
      if (!admitted) throw new Error('Child admission did not produce a binding')
      const key = JSON.stringify([admitted.tenantId, admitted.invocationRunId])
      let child = this.children.get(key)
      if (!child) { child = this.issue(admitted); this.children.set(key, child) }
      return { producer: child, mutation }
    })
  }

  lookupChildAdmissionReceipt(producer: CollaborationProducer, input: CreateSubagentRun): Promise<CollaborationBinding | null> {
    const parent = this.binding(producer)
    if (parent.kind !== 'root') throw new CollaborationError('forbidden', 'Root producer required')
    return this.serialize(() => this.store.lookupChildAdmissionReceipt(parent, input))
  }

  /** Lost ACK recovery returns the canonical private child, after exact durable admission validation. */
  recoverChildProducer(producer: CollaborationProducer, input: CreateSubagentRun): Promise<CollaborationProducer | null> {
    const parent = this.binding(producer)
    if (parent.kind !== 'root') throw new CollaborationError('forbidden', 'Root producer required')
    return this.serialize(async () => {
      const binding = await this.store.lookupChildAdmissionReceipt(parent, input)
      if (!binding) return null
      // A ticket reserved before finish-drain still owns its committed child.
      // Dispatch remains gated by that ticket; delivery bind/consume separately
      // require open admission and therefore cannot consume mail during drain.
      await this.store.assertProducer(this.store.db, binding)
      const key = JSON.stringify([binding.tenantId, binding.invocationRunId])
      let child = this.children.get(key)
      if (!child) { child = this.issue(binding); this.children.set(key, child) }
      return child
    })
  }

  send(producer: CollaborationProducer, input: { recipientParticipantId: string; message: string; requestKey: string }): Promise<CollaborationReceipt> {
    const binding = this.binding(producer)
    return this.serialize(() => this.store.send(binding, input.recipientParticipantId, input.message, input.requestKey))
  }
  receipt(producer: CollaborationProducer, requestKey: string): Promise<CollaborationReceipt | null> {
    const binding = this.binding(producer)
    return this.serialize(() => this.store.findReceiptByKey(binding, requestKey))
  }
  beginDrain(producer: CollaborationProducer): Promise<void> {
    const binding = this.binding(producer)
    return this.serialize(() => this.store.phase(binding, 'draining'))
  }
  closeAdmission(producer: CollaborationProducer): Promise<void> {
    const binding = this.binding(producer)
    return this.serialize(() => this.store.phase(binding, 'closed'))
  }
  /** No execution was started in G3a, so this is not a child-settlement ACK. */
  revokeLocalProducer(producer: CollaborationProducer): void {
    const binding = this.binding(producer)
    this.principals.delete(producer)
    if (binding.kind === 'root') this.roots.delete(JSON.stringify([binding.tenantId, binding.rootRunId, binding.rootAttemptId]))
    else this.children.delete(JSON.stringify([binding.tenantId, binding.invocationRunId]))
  }
  /** Execution owner invokes this only after exact child drain and durable root close. */
  revokeExecutionProducers(producer: CollaborationProducer): void {
    const root = this.binding(producer)
    if (root.kind !== 'root') throw new CollaborationError('forbidden', 'Root producer required')
    for (const child of this.children.values()) {
      const binding = this.binding(child)
      if (binding.tenantId === root.tenantId && binding.rootRunId === root.rootRunId && binding.rootAttemptId === root.rootAttemptId && binding.generation === root.generation)
        this.revokeLocalProducer(child)
    }
    this.revokeLocalProducer(producer)
  }
}

let singleton: CollaborationRuntime | undefined
export function getCollaborationRuntime(): CollaborationRuntime {
  const db = getDb()
  if (!singleton || singleton.store.db !== db) singleton = new CollaborationRuntime(new CollaborationStore(db), getSubagentStore())
  return singleton
}
