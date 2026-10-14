import { createHash } from 'node:crypto'
import type { Client, Transaction, Row } from '@libsql/client'
import { estimateTokens } from '../utils/tokens.js'
import { ensureSQLiteDeliverySchema } from './delivery-schema.js'
import { CollaborationError, type CollaborationBinding, type CollaborationProducer } from './types.js'
import type { CollaborationStore } from './store.js'
import { authenticatedSQLiteRows } from '../../storage/conversation/sqlite-origin.js'
import { ensureHistoryMaintenanceSchema, type HistoryMaintenanceLease } from './history-maintenance.js'
import type { ExecutionOwner } from './execution-owner.js'
import { assertDeliveryExecution, assertDeliveryProducer } from './delivery-execution.js'

declare const consumerBrand: unique symbol
export type SQLiteDeliveryConsumer = Readonly<{ [consumerBrand]: true }>
export interface SQLiteDeliveryReceipt {
  messageId: string
  historyMessageId: string
  invocationRunId: string
  state: 'integrated' | 'suppressed'
  reason?: string
}
export interface SQLiteDeliveryBatch {
  receipts: SQLiteDeliveryReceipt[]
  bytes: number
  hasMore: boolean
}
interface Fence {
  producer: CollaborationProducer
  executionOwner?: ExecutionOwner
  binding: CollaborationBinding
  epoch: number
  anchorId: string
  anchor: string
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const scope = (b: CollaborationBinding) => [b.tenantId, b.rootRunId, b.rootAttemptId]
const fail = (code: ConstructorParameters<typeof CollaborationError>[0], message: string): never => {
  throw new CollaborationError(code, message)
}
const stableAnchor = (row: Row): string => JSON.stringify([row.id, row.message_id, row.role, row.content,
  row.conversation_id, row.metadata, row.model_id])
const publicReceipt = (row: Row): SQLiteDeliveryReceipt => ({ messageId: String(row.message_id),
  historyMessageId: String(row.history_message_id), invocationRunId: String(row.recipient_invocation_run_id),
  state: row.state as SQLiteDeliveryReceipt['state'], ...(row.reason == null ? {} : { reason: String(row.reason) }) })
async function latestHumanId(tx: Transaction, binding: CollaborationBinding): Promise<string | undefined> {
  const row = (await tx.execute({ sql: `SELECT c.message_id FROM conversations c
    WHERE c.tenant_id=? AND c.session_id=? AND c.role='user' AND NOT EXISTS (
      SELECT 1 FROM collaboration_deliveries d WHERE d.tenant_id=c.tenant_id
        AND d.history_session_id=c.session_id AND d.history_message_id=c.message_id
        )
    ORDER BY c.created_at DESC,c.id DESC LIMIT 1`, args: [binding.tenantId, binding.sessionId] })).rows[0]
  return row ? String(row.message_id) : undefined
}

/** Internal SQLite delivery only; acceptance and provider dispatch remain different facts. */
export class SQLiteCollaborationDelivery {
  private readonly consumers = new WeakMap<SQLiteDeliveryConsumer, Fence>()
  private readonly producerConsumers = new WeakMap<CollaborationProducer, { consumer: SQLiteDeliveryConsumer; fence: Fence }>()
  private tail: Promise<unknown> = Promise.resolve()
  constructor(private readonly store: CollaborationStore,
    private readonly resolveProducer: (producer: CollaborationProducer) => CollaborationBinding) {}

  private write<T>(operation: (tx: Transaction) => Promise<T>): Promise<T> {
    const pending = this.tail.catch(() => undefined).then(async () => {
      await this.store.prepare()
      await ensureSQLiteDeliverySchema(this.store.db)
      const tx = await this.store.db.transaction('write')
      try { const result = await operation(tx); await tx.commit(); return result }
      catch (error) { if (!tx.closed) await tx.rollback().catch(() => undefined); throw error }
      finally { tx.close() }
    })
    this.tail = pending.catch(() => undefined)
    return pending
  }

  private async read<T>(operation: (tx: Transaction) => Promise<T>): Promise<T> {
    await this.store.prepare()
    await ensureSQLiteDeliverySchema(this.store.db)
    const tx = await this.store.db.transaction('read')
    try { const result = await operation(tx); await tx.commit(); return result }
    catch (error) { if (!tx.closed) await tx.rollback().catch(() => undefined); throw error }
    finally { tx.close() }
  }

  async maintenanceLease(producer: CollaborationProducer, consumer: SQLiteDeliveryConsumer): Promise<HistoryMaintenanceLease> {
    const fence = this.consumers.get(consumer)
    if (!fence || fence.producer !== producer) fail('forbidden', 'A live private consumer is required for maintenance')
    await ensureHistoryMaintenanceSchema(this.store.db)
    await this.snapshot(consumer, true)
    const peerMessageIds = new Set((await this.store.db.execute({ sql: `SELECT history_message_id FROM collaboration_deliveries
      WHERE tenant_id=? AND history_session_id=? AND state='integrated'`, args: [fence!.binding.tenantId, fence!.binding.sessionId] })).rows.map(row => String(row.history_message_id)))
    const check = async (tx?: Transaction): Promise<void> => {
      if (!tx) { await this.snapshot(consumer, true); return }
      const b = this.resolveProducer(fence!.producer)
      if (b !== fence!.binding) fail('forbidden', 'Maintenance producer authority changed')
      await assertDeliveryProducer(this.store, tx, fence!.producer, b, fence!.executionOwner)
      const epoch = (await tx.execute({ sql: 'SELECT epoch FROM collaboration_history_epochs WHERE tenant_id=? AND session_id=?', args: [b.tenantId, b.sessionId] })).rows[0]
      const anchors = (await tx.execute({ sql: 'SELECT id,message_id,role,content,conversation_id,metadata,model_id FROM conversations WHERE tenant_id=? AND session_id=? AND message_id=?', args: [b.tenantId, b.sessionId, fence!.anchorId] })).rows
      if (!epoch || Number(epoch.epoch) !== fence!.epoch || anchors.length !== 1 || stableAnchor(anchors[0]) !== fence!.anchor)
        fail('conflict', 'Maintenance lost its exact admitted input')
      await authenticatedSQLiteRows(tx, b, true, fence!.anchorId)
    }
    return { db: this.store.db, backend: 'sqlite', binding: fence!.binding,
      epoch: fence!.epoch, anchorId: fence!.anchorId, anchorFingerprint: fence!.anchor, peerMessageIds, check }
  }

  bind(producer: CollaborationProducer, history: { db: Client; tenantId: string; sessionId: string; anchorId: string; anchorContent?: string; executionOwner?: ExecutionOwner }): Promise<SQLiteDeliveryConsumer> {
    const binding = this.resolveProducer(producer)
    if (history.db !== this.store.db || history.tenantId !== binding.tenantId || history.sessionId !== binding.sessionId)
      fail('forbidden', 'Delivery must use the admitted producer and the same physical history Client')
    return this.write(async tx => {
      await assertDeliveryProducer(this.store, tx, producer, binding, history.executionOwner)
      const anchor = (await tx.execute({ sql: `SELECT id,message_id,role,content,conversation_id,metadata,model_id
        FROM conversations WHERE tenant_id=? AND session_id=? AND message_id=?`,
        args: [binding.tenantId, binding.sessionId, history.anchorId] })).rows
      if (anchor.length !== 1 || anchor[0].role !== 'user' || anchor[0].conversation_id !== binding.turnId)
        fail('conflict', 'Delivery needs the actual current human input anchor')
      if (history.anchorContent !== undefined && anchor[0].content !== history.anchorContent)
        fail('conflict', 'Persisted input differs from its admitted human or delegated task')
      const peer = await tx.execute({ sql: `SELECT 1 FROM collaboration_deliveries
        WHERE tenant_id=? AND history_session_id=? AND history_message_id=? LIMIT 1`,
        args: [binding.tenantId, binding.sessionId, history.anchorId] })
      if (peer.rows.length) fail('forbidden', 'A peer delivery cannot become a human input anchor')
      if (await latestHumanId(tx, binding) !== history.anchorId) fail('conflict', 'The selected human input anchor is no longer current')
      await tx.execute({ sql: 'INSERT OR IGNORE INTO collaboration_history_epochs VALUES (?,?,0)', args: [binding.tenantId, binding.sessionId] })
      const epoch = Number((await tx.execute({ sql: 'SELECT epoch FROM collaboration_history_epochs WHERE tenant_id=? AND session_id=?',
        args: [binding.tenantId, binding.sessionId] })).rows[0].epoch)
      const existing = this.producerConsumers.get(producer)
      if (existing) {
        if (existing.fence.binding !== binding || existing.fence.executionOwner !== history.executionOwner || existing.fence.epoch !== epoch
          || existing.fence.anchorId !== history.anchorId || existing.fence.anchor !== stableAnchor(anchor[0]))
          fail('conflict', 'This invocation cannot rebind after its original history fence changed')
        assertDeliveryExecution(this.store, producer, binding, history.executionOwner)
        return existing.consumer
      }
      const consumer = Object.freeze({}) as SQLiteDeliveryConsumer
      assertDeliveryExecution(this.store, producer, binding, history.executionOwner)
      const fence = { producer, executionOwner: history.executionOwner, binding, epoch, anchorId: history.anchorId, anchor: stableAnchor(anchor[0]) }
      this.consumers.set(consumer, fence)
      this.producerConsumers.set(producer, { consumer, fence })
      return consumer
    })
  }

  consume(consumer: SQLiteDeliveryConsumer, budget: { maxRows?: number; maxBytes?: number } = {}): Promise<SQLiteDeliveryBatch> {
    const fence = this.consumers.get(consumer)
    if (!fence) fail('forbidden', 'A live internal delivery consumer is required')
    const maxRows = budget.maxRows ?? 32, maxBytes = budget.maxBytes ?? 128 * 1024
    if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 32
      || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 128 * 1024) fail('invalid', 'Invalid delivery batch budget')
    return this.write(async tx => {
      const b = this.resolveProducer(fence!.producer)
      if (b !== fence!.binding) fail('forbidden', 'Delivery producer authority changed')
      await assertDeliveryProducer(this.store, tx, fence!.producer, b, fence!.executionOwner)
      const epoch = (await tx.execute({ sql: 'SELECT epoch FROM collaboration_history_epochs WHERE tenant_id=? AND session_id=?',
        args: [b.tenantId, b.sessionId] })).rows[0]
      const anchor = (await tx.execute({ sql: `SELECT id,message_id,role,content,conversation_id,metadata,model_id
        FROM conversations WHERE tenant_id=? AND session_id=? AND message_id=?`, args: [b.tenantId, b.sessionId, fence!.anchorId] })).rows
      if (!epoch || Number(epoch.epoch) !== fence!.epoch || anchor.length !== 1 || stableAnchor(anchor[0]) !== fence!.anchor
        || await latestHumanId(tx, b) !== fence!.anchorId)
        fail('conflict', 'History changed; this invocation cannot integrate messages')
      // A second WAL writer can edit history without the public mutation API.
      // Do not append more mail behind a receipt whose physical row changed.
      const changedDelivery = await tx.execute({ sql: `SELECT 1 FROM collaboration_deliveries d
        WHERE d.tenant_id=? AND d.root_run_id=? AND d.root_attempt_id=? AND d.recipient_participant_id=?
          AND d.history_session_id=? AND d.state='integrated' AND (
            d.history_identity_version<>1 OR d.history_row_id IS NULL OR
            (SELECT count(*) FROM conversations c WHERE c.tenant_id=d.tenant_id
              AND c.session_id=d.history_session_id AND c.message_id=d.history_message_id)<>1 OR
            NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id IS d.history_row_id
              AND c.tenant_id=d.tenant_id AND c.session_id=d.history_session_id AND c.message_id=d.history_message_id
              AND c.conversation_id IS d.history_conversation_id AND c.model_id IS d.history_model_id
              AND c.role='user' AND c.content=d.history_content AND c.metadata=d.history_metadata)) LIMIT 1`,
        args: [...scope(b), b.participantId, b.sessionId] })
      if (changedDelivery.rows.length) fail('conflict', 'An integrated delivery has lost its authenticated physical history row')
      const selected = await tx.execute({ sql: `SELECT m.* FROM collaboration_messages m
        WHERE m.tenant_id=? AND m.root_run_id=? AND m.root_attempt_id=? AND m.recipient_participant_id=? AND m.state='queued'
        AND NOT EXISTS (SELECT 1 FROM collaboration_deliveries d WHERE d.tenant_id=m.tenant_id
          AND d.root_run_id=m.root_run_id AND d.root_attempt_id=m.root_attempt_id AND d.message_id=m.message_id)
        ORDER BY m.seq LIMIT ?`, args: [...scope(b), b.participantId, maxRows + 1] })
      const receipts: SQLiteDeliveryReceipt[] = []
      let bytes = 0, hasMore = selected.rows.length > maxRows
      for (const row of selected.rows.slice(0, maxRows)) {
        if (digest(String(row.body)) !== row.payload_hash || Buffer.byteLength(String(row.body), 'utf8') !== Number(row.payload_bytes))
          fail('conflict', 'Durable message payload does not match its acceptance receipt')
        const historyMessageId = 'peer:' + digest(JSON.stringify([...scope(b), row.message_id]))
        // The header describes authenticated peer data; it never grants system/tool permissions.
        const content = '[对等 Agent 消息]\n' + JSON.stringify({ sender: String(row.sender_participant_id),
          invocation: String(row.sender_invocation_run_id), messageId: String(row.message_id) }) + '\n\n' + String(row.body)
        const metadata = JSON.stringify({ collaborationDelivery: { version: 1, messageId: String(row.message_id),
          rootRunId: b.rootRunId, recipientInvocationRunId: b.invocationRunId } })
        const receipt: SQLiteDeliveryReceipt = { messageId: String(row.message_id), historyMessageId,
          invocationRunId: b.invocationRunId, state: 'integrated' }
        const itemBytes = Buffer.byteLength(JSON.stringify({ content, metadata, receipt }), 'utf8')
        if (itemBytes > maxBytes && !receipts.length) fail('too_large', 'A complete peer message exceeds this delivery batch budget')
        if (bytes + itemBytes > maxBytes) { hasMore = true; break }
        const collision = await tx.execute({ sql: 'SELECT 1 FROM conversations WHERE tenant_id=? AND session_id=? AND message_id=? LIMIT 1',
          args: [b.tenantId, b.sessionId, historyMessageId] })
        if (collision.rows.length) fail('conflict', 'Peer history identity exists without its delivery receipt')
        const inserted = await tx.execute({ sql: `INSERT INTO conversations
          (tenant_id,session_id,conversation_id,message_id,role,content,tokens,metadata)
          VALUES (?,?,?,?,?,?,?,?)`, args: [b.tenantId, b.sessionId, b.turnId, historyMessageId, 'user', content, estimateTokens(content), metadata] })
        const actual = (await tx.execute({ sql: `SELECT CAST(id AS TEXT) AS row_id,conversation_id,model_id,role,content,metadata
          FROM conversations WHERE tenant_id=? AND session_id=? AND message_id=? AND id=?`,
          args: [b.tenantId, b.sessionId, historyMessageId, inserted.lastInsertRowid ?? null] })).rows
        if (actual.length !== 1 || actual[0].conversation_id !== b.turnId || actual[0].model_id !== null
          || actual[0].role !== 'user' || actual[0].content !== content || actual[0].metadata !== metadata)
          fail('conflict', 'Inserted peer history does not match the intended delivery')
        await tx.execute({ sql: `INSERT INTO collaboration_deliveries
          (tenant_id,root_run_id,root_attempt_id,message_id,recipient_participant_id,recipient_invocation_run_id,
            history_session_id,history_message_id,history_epoch,history_row_id,history_conversation_id,history_model_id,
            history_identity_version,payload_hash,history_content,history_metadata,state,integrated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, args: [...scope(b), row.message_id, b.participantId, b.invocationRunId,
            b.sessionId, historyMessageId, fence!.epoch, actual[0].row_id, b.turnId, null, 1,
            row.payload_hash, content, metadata, 'integrated', Date.now()] })
        bytes += itemBytes; receipts.push(receipt)
      }
      assertDeliveryExecution(this.store, fence!.producer, b, fence!.executionOwner)
      return { receipts, bytes, hasMore }
    })
  }

  /** The provider projection shares the exact consumer fence and physical read revision. */
  snapshot(consumer: SQLiteDeliveryConsumer, inheritContext: boolean): Promise<Row[]> {
    const fence = this.consumers.get(consumer)
    if (!fence) fail('forbidden', 'A live internal delivery consumer is required')
    // All authority, anchor, epoch and receipt checks share one WAL read revision.
    // Projection never reserves the writer or queues behind another root's send.
    return this.read(async tx => {
      const b = this.resolveProducer(fence!.producer)
      if (b !== fence!.binding) fail('forbidden', 'Delivery producer authority changed')
      await assertDeliveryProducer(this.store, tx, fence!.producer, b, fence!.executionOwner)
      const epoch = (await tx.execute({ sql: 'SELECT epoch FROM collaboration_history_epochs WHERE tenant_id=? AND session_id=?',
        args: [b.tenantId, b.sessionId] })).rows[0]
      const anchor = (await tx.execute({ sql: 'SELECT id,message_id,role,content,conversation_id,metadata,model_id FROM conversations WHERE tenant_id=? AND session_id=? AND message_id=?',
        args: [b.tenantId, b.sessionId, fence!.anchorId] })).rows
      if (!epoch || Number(epoch.epoch) !== fence!.epoch || anchor.length !== 1 || stableAnchor(anchor[0]) !== fence!.anchor)
        fail('conflict', 'History changed; this invocation cannot project a provider request')
      const rows = await authenticatedSQLiteRows(tx, b, inheritContext, fence!.anchorId)
      if (this.resolveProducer(fence!.producer) !== b) fail('forbidden', 'Delivery producer authority changed')
      assertDeliveryExecution(this.store, fence!.producer, b, fence!.executionOwner)
      return rows
    }).then(rows => {
      if (this.resolveProducer(fence!.producer) !== fence!.binding) fail('forbidden', 'Delivery producer authority changed')
      assertDeliveryExecution(this.store, fence!.producer, fence!.binding, fence!.executionOwner)
      return rows
    })
  }

  /** Read-only reconciliation never dispatches a provider or re-appends a deleted row. */
  async receipt(producer: CollaborationProducer, messageId: string): Promise<SQLiteDeliveryReceipt | null> {
    const b = this.resolveProducer(producer)
    await this.store.prepare(); await ensureSQLiteDeliverySchema(this.store.db)
    // Explicit columns retain their positions if another connection migrates
    // the table between native prepare/metadata and the first SQLite step.
    const rows = (await this.store.db.execute({ sql: `SELECT d.message_id,d.history_message_id,d.recipient_invocation_run_id,
      d.state,d.reason,d.history_row_id,d.history_identity_version,d.history_content,d.history_metadata,c.role,c.content,c.metadata,
      (c.id IS d.history_row_id AND c.conversation_id IS d.history_conversation_id
        AND c.model_id IS d.history_model_id) AS physical_identity_matches FROM collaboration_deliveries d
      LEFT JOIN conversations c ON c.tenant_id=d.tenant_id AND c.session_id=d.history_session_id AND c.message_id=d.history_message_id
      WHERE d.tenant_id=? AND d.root_run_id=? AND d.root_attempt_id=? AND d.message_id=? AND d.recipient_participant_id=?`,
      args: [...scope(b), messageId, b.participantId] })).rows
    if (!rows[0]) return null
    if (rows.length !== 1) fail('conflict', 'Delivery history identity is ambiguous')
    const row = rows[0]
    if (row.state === 'integrated' && (Number(row.history_identity_version) !== 1 || row.history_row_id == null
      || Number(row.physical_identity_matches) !== 1 || row.role !== 'user'
      || row.content !== row.history_content || row.metadata !== row.history_metadata))
      fail('conflict', 'Integrated delivery has lost or changed its exact history row')
    return publicReceipt(row)
  }
}
