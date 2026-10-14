import { createHash } from 'node:crypto'
import type { Client, Transaction, Row } from '@libsql/client'
import type { Message } from '../agent-context/types.js'
import { estimateTokens } from '../utils/tokens.js'
import { CollaborationError, type CollaborationBinding, type CollaborationProducer } from './types.js'
import type { CollaborationStore } from './store.js'
import type { SQLiteDeliveryBatch, SQLiteDeliveryReceipt } from './sqlite-delivery.js'
import { ensureHistoryMaintenanceSchema, type HistoryMaintenanceLease } from './history-maintenance.js'
import type { ExecutionOwner } from './execution-owner.js'
import { assertDeliveryExecution, assertDeliveryProducer } from './delivery-execution.js'
import { authenticatedJSONLHistory, canonicalJSONLMessage, jsonlHistoryEpoch,
  type JSONLHistoryOrigin, type JSONLPhysicalSnapshot, type JSONLAppendPlan } from '../../storage/conversation/jsonl-origin.js'

declare const consumerBrand: unique symbol
export type JSONLDeliveryConsumer = Readonly<{ [consumerBrand]: true }>
interface Fence { producer: CollaborationProducer; binding: CollaborationBinding; origin: JSONLHistoryOrigin;
  executionOwner?: ExecutionOwner; epoch: number; anchorId: string; anchor: string }
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const scope = (b: CollaborationBinding) => [b.tenantId, b.rootRunId, b.rootAttemptId]
const fail = (code: ConstructorParameters<typeof CollaborationError>[0], message: string): never => { throw new CollaborationError(code, message) }
const publicReceipt = (row: Row): SQLiteDeliveryReceipt => ({ messageId: String(row.message_id), historyMessageId: String(row.history_message_id),
  invocationRunId: String(row.recipient_invocation_run_id), state: row.state as SQLiteDeliveryReceipt['state'], ...(row.reason == null ? {} : { reason: String(row.reason) }) })
function anchor(snapshot: JSONLPhysicalSnapshot, id: string): string {
  const rows = snapshot.rows.filter(row => row.id === id), active = snapshot.active.filter(message => message.id === id)
  if (rows.length !== 1 || active.length !== 1 || active[0].role !== 'user') fail('conflict', 'JSONL delivery needs one exact physical input anchor')
  return JSON.stringify([snapshot.fileIdentity, rows[0].offset, rows[0].bytes, rows[0].hash, canonicalJSONLMessage(active[0])])
}

/** The file sync and SQL receipt are separate durable steps with exact pending reconciliation. */
export class JSONLCollaborationDelivery {
  private readonly consumers = new WeakMap<JSONLDeliveryConsumer, Fence>()
  private readonly byProducer = new WeakMap<CollaborationProducer, { consumer: JSONLDeliveryConsumer; fence: Fence }>()
  constructor(private readonly store: CollaborationStore, private readonly resolveProducer: (producer: CollaborationProducer) => CollaborationBinding) {}

  private async sql<T>(action: (tx: Transaction) => Promise<T>): Promise<T> {
    const tx = await this.store.db.transaction('write')
    try { const value = await action(tx); await tx.commit(); return value }
    catch (error) { if (!tx.closed) await tx.rollback().catch(() => undefined); throw error }
    finally { tx.close() }
  }

  async bind(producer: CollaborationProducer, history: { origin: JSONLHistoryOrigin; tenantId: string; sessionId: string; anchorId: string; anchorContent?: string; executionOwner?: ExecutionOwner }): Promise<JSONLDeliveryConsumer> {
    const binding = this.resolveProducer(producer), origin = history.origin
    if (origin.db() !== this.store.db || history.tenantId !== binding.tenantId || history.sessionId !== binding.sessionId)
      fail('forbidden', 'JSONL delivery must use the admitted producer and same actual receipt Client')
    await this.store.prepare()
    return origin.withLease(binding, async () => {
      await assertDeliveryProducer(this.store, this.store.db, producer, binding, history.executionOwner)
      await this.store.db.execute({ sql: 'INSERT OR IGNORE INTO collaboration_jsonl_epochs VALUES(?,?,0)', args: [binding.tenantId, binding.sessionId] })
      const epoch = await jsonlHistoryEpoch(this.store.db, binding, true), snapshot = await origin.inspect(binding)
      const active = await authenticatedJSONLHistory(origin, binding, snapshot, true, history.anchorId)
      const input = active.find(message => message.id === history.anchorId)
      if (!input || (input as Message & { conversationId?: string }).conversationId !== binding.turnId
        || history.anchorContent !== undefined && (typeof input.content === 'string' ? input.content : JSON.stringify(input.content)) !== history.anchorContent)
        fail('conflict', 'JSONL persisted input differs from its immutable admitted task')
      const peer = await this.store.db.execute({ sql: `SELECT 1 FROM collaboration_jsonl_deliveries WHERE tenant_id=? AND history_session_id=? AND history_message_id=?`,
        args: [binding.tenantId, binding.sessionId, history.anchorId] })
      if (peer.rows.length) fail('forbidden', 'A JSONL peer delivery cannot become human input')
      const fingerprint = anchor(snapshot, history.anchorId), existing = this.byProducer.get(producer)
      if (existing) {
        if (existing.fence.binding !== binding || existing.fence.executionOwner !== history.executionOwner || existing.fence.origin !== origin || existing.fence.epoch !== epoch
          || existing.fence.anchorId !== history.anchorId || existing.fence.anchor !== fingerprint)
          fail('conflict', 'JSONL invocation cannot rebind its original history fence')
        assertDeliveryExecution(this.store, producer, binding, history.executionOwner)
        return existing.consumer
      }
      await origin.assertRevision(binding, snapshot)
      await assertDeliveryProducer(this.store, this.store.db, producer, binding, history.executionOwner)
      if (this.resolveProducer(producer) !== binding) fail('forbidden', 'JSONL producer authority changed')
      const consumer = Object.freeze({}) as JSONLDeliveryConsumer, fence = { producer, executionOwner: history.executionOwner, binding, origin, epoch, anchorId: history.anchorId, anchor: fingerprint }
      this.consumers.set(consumer, fence); this.byProducer.set(producer, { consumer, fence })
      return consumer
    })
  }

  private get(consumer: JSONLDeliveryConsumer): Fence {
    const found = this.consumers.get(consumer)
    if (!found) fail('forbidden', 'A live private JSONL delivery consumer is required')
    if (this.resolveProducer(found!.producer) !== found!.binding || found!.origin.db() !== this.store.db)
      fail('forbidden', 'JSONL producer or datasource authority changed')
    assertDeliveryExecution(this.store, found!.producer, found!.binding, found!.executionOwner)
    return found!
  }
  async maintenanceLease(producer: CollaborationProducer, consumer: JSONLDeliveryConsumer): Promise<HistoryMaintenanceLease> {
    const fence = this.get(consumer)
    if (fence.producer !== producer) fail('forbidden', 'Maintenance consumer belongs to another execution')
    await ensureHistoryMaintenanceSchema(this.store.db)
    await this.snapshot(consumer, true)
    const peerMessageIds = new Set((await this.store.db.execute({ sql: `SELECT history_message_id FROM collaboration_jsonl_deliveries
      WHERE tenant_id=? AND history_session_id=? AND state='integrated'`, args: [fence.binding.tenantId, fence.binding.sessionId] })).rows.map(row => String(row.history_message_id)))
    return { db: this.store.db, backend: 'jsonl', binding: fence.binding,
      epoch: fence.epoch, anchorId: fence.anchorId, anchorFingerprint: fence.anchor, peerMessageIds,
      // Storage invokes this again inside its own file lease. Re-entering the
      // file queue here would wait on itself; inspect authenticates that lease.
      check: async () => { await this.inspect(fence) } }
  }
  private async inspect(fence: Fence): Promise<JSONLPhysicalSnapshot> {
    this.get(this.byProducer.get(fence.producer)!.consumer)
    await assertDeliveryProducer(this.store, this.store.db, fence.producer, fence.binding, fence.executionOwner)
    if (await jsonlHistoryEpoch(this.store.db, fence.binding, true) !== fence.epoch) fail('conflict', 'JSONL consumer epoch was invalidated')
    const snapshot = await fence.origin.inspect(fence.binding)
    if (anchor(snapshot, fence.anchorId) !== fence.anchor) fail('conflict', 'JSONL physical admitted input changed')
    await authenticatedJSONLHistory(fence.origin, fence.binding, snapshot, true, fence.anchorId)
    return snapshot
  }
  async snapshot(consumer: JSONLDeliveryConsumer, inheritContext: boolean): Promise<Message[]> {
    const fence = this.get(consumer)
    return fence.origin.withLease(fence.binding, async () => {
      const snapshot = await this.inspect(fence)
      const result = await authenticatedJSONLHistory(fence.origin, fence.binding, snapshot, inheritContext, fence.anchorId)
      await assertDeliveryProducer(this.store, this.store.db, fence.producer, fence.binding, fence.executionOwner)
      this.get(consumer)
      return result
    })
  }

  async consume(consumer: JSONLDeliveryConsumer, budget: { maxRows?: number; maxBytes?: number } = {}): Promise<SQLiteDeliveryBatch> {
    const fence = this.get(consumer), b = fence.binding, maxRows = budget.maxRows ?? 32, maxBytes = budget.maxBytes ?? 128 * 1024
    if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 32 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 128 * 1024)
      fail('invalid', 'Invalid JSONL delivery batch budget')
    return fence.origin.withLease(b, async () => {
      let snapshot = await this.inspect(fence)
      const selected = (await this.store.db.execute({ sql: `SELECT m.seq,m.message_id,m.sender_participant_id,m.sender_invocation_run_id,m.body,m.payload_hash,m.payload_bytes,
        d.state AS delivery_state,d.history_message_id,d.recipient_invocation_run_id,d.file_identity,d.row_offset,d.row_bytes,d.row_hash,d.encoded_row,d.history_epoch
        FROM collaboration_messages m LEFT JOIN collaboration_jsonl_deliveries d ON d.tenant_id=m.tenant_id AND d.root_run_id=m.root_run_id
          AND d.root_attempt_id=m.root_attempt_id AND d.message_id=m.message_id
        WHERE m.tenant_id=? AND m.root_run_id=? AND m.root_attempt_id=? AND m.recipient_participant_id=? AND m.state='queued'
          AND (d.state IS NULL OR d.state='pending') ORDER BY m.seq LIMIT ?`, args: [...scope(b), b.participantId, maxRows + 1] })).rows
      const receipts: SQLiteDeliveryReceipt[] = []
      let bytes = 0, hasMore = selected.length > maxRows
      for (const row of selected.slice(0, maxRows)) {
        if (digest(String(row.body)) !== row.payload_hash || Buffer.byteLength(String(row.body)) !== Number(row.payload_bytes)) fail('conflict', 'JSONL durable message payload changed')
        const historyMessageId = 'peer:' + digest(JSON.stringify([...scope(b), row.message_id]))
        const content = '[对等 Agent 消息]\n' + JSON.stringify({ sender: String(row.sender_participant_id), invocation: String(row.sender_invocation_run_id), messageId: String(row.message_id) }) + '\n\n' + String(row.body)
        const message: Message & { conversationId: string } = { id: historyMessageId, role: 'user', content, tokens: estimateTokens(content), conversationId: b.turnId,
          metadata: { collaborationDelivery: { version: 1, messageId: String(row.message_id), rootRunId: b.rootRunId, recipientInvocationRunId: b.invocationRunId } } }
        let plan: JSONLAppendPlan
        if (row.delivery_state === 'pending') {
          if (row.history_message_id !== historyMessageId || row.recipient_invocation_run_id !== b.invocationRunId || Number(row.history_epoch) !== fence.epoch)
            fail('conflict', 'JSONL pending delivery belongs to another immutable invocation')
          plan = { fileIdentity: String(row.file_identity), offset: Number(row.row_offset), bytes: Number(row.row_bytes), hash: String(row.row_hash), encoded: String(row.encoded_row) }
          let encoded: { tenantId?: unknown; sessionId?: unknown; uuid?: unknown; type?: unknown; payload?: Message }
          try { encoded = JSON.parse(plan.encoded) } catch { fail('conflict', 'JSONL pending delivery envelope is malformed') }
          if (encoded!.tenantId !== b.tenantId || encoded!.sessionId !== b.sessionId || encoded!.uuid !== historyMessageId || encoded!.type !== 'user'
            || !encoded!.payload || canonicalJSONLMessage(encoded!.payload) !== canonicalJSONLMessage(message))
            fail('conflict', 'JSONL pending envelope no longer matches its immutable accepted payload')
        } else {
          if (snapshot.rows.some(actual => actual.id === historyMessageId)) fail('conflict', 'JSONL peer row exists without its reserved receipt')
          plan = fence.origin.plan(b, snapshot, message)
        }
        const itemBytes = plan.bytes + Buffer.byteLength(JSON.stringify({ messageId: row.message_id, historyMessageId, invocationRunId: b.invocationRunId, state: 'integrated' }))
        if (itemBytes > maxBytes && !receipts.length) fail('too_large', 'A complete JSONL peer envelope exceeds the batch budget')
        if (bytes + itemBytes > maxBytes) { hasMore = true; break }
        if (row.delivery_state !== 'pending') await this.sql(async tx => {
          await assertDeliveryProducer(this.store, tx, fence.producer, b, fence.executionOwner)
          if (await jsonlHistoryEpoch(tx, b, true) !== fence.epoch) fail('conflict', 'JSONL epoch changed before reservation')
          await tx.execute({ sql: `INSERT INTO collaboration_jsonl_deliveries
            (tenant_id,root_run_id,root_attempt_id,message_id,recipient_participant_id,recipient_invocation_run_id,history_session_id,history_message_id,history_epoch,
              file_identity,row_offset,row_bytes,row_hash,encoded_row,state) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending')`,
            args: [...scope(b), row.message_id, b.participantId, b.invocationRunId, b.sessionId, historyMessageId, fence.epoch, plan.fileIdentity, plan.offset, plan.bytes, plan.hash, plan.encoded] })
        })
        await fence.origin.persist(b, plan)
        snapshot = await fence.origin.inspect(b)
        if (anchor(snapshot, fence.anchorId) !== fence.anchor) fail('conflict', 'JSONL input changed while syncing delivery')
        const physical = snapshot.rows.filter(actual => actual.id === historyMessageId)
        if (physical.length !== 1 || snapshot.fileIdentity !== plan.fileIdentity || physical[0].offset !== plan.offset || physical[0].bytes !== plan.bytes || physical[0].hash !== plan.hash)
          fail('conflict', 'JSONL synced delivery lost exact physical identity')
        await this.sql(async tx => {
          await assertDeliveryProducer(this.store, tx, fence.producer, b, fence.executionOwner)
          if (await jsonlHistoryEpoch(tx, b, true) !== fence.epoch) fail('conflict', 'JSONL epoch changed after file sync')
          await tx.execute({ sql: `UPDATE collaboration_jsonl_deliveries SET state='integrated',integrated_at=?
            WHERE tenant_id=? AND root_run_id=? AND root_attempt_id=? AND message_id=? AND state='pending'
              AND recipient_invocation_run_id=? AND file_identity=? AND row_offset=? AND row_hash=?`,
            args: [Date.now(), ...scope(b), row.message_id, b.invocationRunId, plan.fileIdentity, plan.offset, plan.hash] })
          const committed = (await tx.execute({ sql: `SELECT state FROM collaboration_jsonl_deliveries WHERE tenant_id=? AND root_run_id=? AND root_attempt_id=? AND message_id=?`, args: [...scope(b), row.message_id] })).rows[0]
          if (committed?.state !== 'integrated') fail('conflict', 'JSONL integration receipt was not finalized')
        })
        this.get(consumer)
        bytes += itemBytes; receipts.push({ messageId: String(row.message_id), historyMessageId, invocationRunId: b.invocationRunId, state: 'integrated' })
      }
      await assertDeliveryProducer(this.store, this.store.db, fence.producer, b, fence.executionOwner)
      return { receipts, bytes, hasMore }
    })
  }
  async receipt(producer: CollaborationProducer, messageId: string): Promise<SQLiteDeliveryReceipt | null> {
    const b = this.resolveProducer(producer)
    await this.store.prepare()
    const row = (await this.store.db.execute({ sql: `SELECT message_id,history_message_id,recipient_invocation_run_id,state,reason
      FROM collaboration_jsonl_deliveries WHERE tenant_id=? AND root_run_id=? AND root_attempt_id=? AND message_id=? AND recipient_participant_id=?`,
      args: [...scope(b), messageId, b.participantId] })).rows[0]
    if (!row || row.state === 'pending') return null
    const registered = this.byProducer.get(producer)
    if (row.state === 'integrated') { if (!registered) fail('forbidden', 'JSONL receipt requires its live private history consumer'); await this.snapshot(registered!.consumer, true) }
    return publicReceipt(row)
  }
}
