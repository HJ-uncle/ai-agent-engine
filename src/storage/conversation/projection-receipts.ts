import type { Client } from '@libsql/client'
import type { ConversationToolCallAnchor, Message } from '../../core/agent-context/types.js'
import { up } from '../sqlite/migrations/030_conversation_projection_receipts.js'

export type ProjectionContext = { tenantId: string; sessionId: string }
export type ProjectionExecutor = Pick<Client, 'execute'>
export interface ProjectionReceipt {
  backend: 'sqlite' | 'jsonl'
  disposition: 'pending' | 'appended' | 'suppressed'
  epoch: number
  anchorSequence: number | null
}
const ready = new WeakMap<Client, Promise<void>>()
export function ensureProjectionReceipts(db: Client): Promise<void> {
  let pending = ready.get(db)
  if (!pending) {
    pending = up(db).catch(error => { ready.delete(db); throw error })
    ready.set(db, pending)
  }
  return pending
}

export function validateProjection(message: Message, anchor: ConversationToolCallAnchor): string {
  const conversation = (message as Message & { conversationId?: string }).conversationId ?? ''
  const notification = message.metadata?.subagentNotification as { runId?: unknown; parentToolCallId?: unknown } | undefined
  const validNotification = message.role === 'assistant' && !message.toolCallId && !message.toolCall && !message.toolName
    && typeof notification?.runId === 'string' && !!notification.runId && message.id === 'subagent-result:' + notification.runId
    && notification.parentToolCallId === anchor.toolCallId
  if (!message.id || !anchor.messageId || !anchor.toolCallId || typeof anchor.conversationId !== 'string'
    || !(message.role === 'tool' && message.toolCallId === anchor.toolCallId || validNotification) || conversation !== anchor.conversationId)
    throw new Error('Conditional history result does not match its stable dispatch identity')
  return message.id
}

export async function readProjectionReceipt(db: ProjectionExecutor, ctx: ProjectionContext, id: string,
  anchor: ConversationToolCallAnchor): Promise<ProjectionReceipt | null> {
  const row = (await db.execute({ sql: `SELECT anchor_message_id, anchor_tool_call_id, anchor_conversation_id,
    backend, disposition, reservation_epoch, anchor_sequence FROM conversation_projection_receipts
    WHERE tenant_id=? AND session_id=? AND message_id=?`, args: [ctx.tenantId, ctx.sessionId, id] })).rows[0]
  if (!row) return null
  if (row.anchor_message_id !== anchor.messageId || row.anchor_tool_call_id !== anchor.toolCallId
    || row.anchor_conversation_id !== anchor.conversationId) throw new Error('History projection receipt identity collision')
  return { backend: row.backend as ProjectionReceipt['backend'], disposition: row.disposition as ProjectionReceipt['disposition'],
    epoch: Number(row.reservation_epoch), anchorSequence: row.anchor_sequence == null ? null : Number(row.anchor_sequence) }
}

export async function projectionEpoch(db: ProjectionExecutor, ctx: ProjectionContext): Promise<number> {
  const row = (await db.execute({ sql: 'SELECT epoch FROM conversation_projection_epochs WHERE tenant_id=? AND session_id=?',
    args: [ctx.tenantId, ctx.sessionId] })).rows[0]
  return Number(row?.epoch ?? 0)
}

/** This executor can be the owning write transaction, never an awaited outer read. */
export async function findActiveToolCallAnchor(db: ProjectionExecutor, ctx: ProjectionContext,
  key: ConversationToolCallAnchor): Promise<ConversationToolCallAnchor | null> {
  if (!key.messageId || !key.toolCallId || typeof key.conversationId !== 'string') return null
  const row = (await db.execute({ sql: `SELECT c.message_id, c.tool_call_id, c.conversation_id FROM conversations c
    WHERE c.tenant_id=? AND c.session_id=? AND c.message_id=? AND c.tool_call_id=?
      AND COALESCE(c.conversation_id,'')=? AND c.tool_call_name IS NOT NULL AND c.tool_call_name<>''
      AND c.tool_args IS NOT NULL AND json_valid(c.tool_args)
      AND (c.role='system' OR NOT EXISTS (
        SELECT 1 FROM conversations u WHERE u.tenant_id=c.tenant_id AND u.session_id=c.session_id AND u.role='user'
      ) OR EXISTS (
        SELECT 1 FROM conversations u WHERE u.tenant_id=c.tenant_id AND u.session_id=c.session_id AND u.role='user'
          AND (u.created_at<c.created_at OR (u.created_at=c.created_at AND u.id<=c.id))
      )) LIMIT 1`, args: [ctx.tenantId, ctx.sessionId, key.messageId, key.toolCallId, key.conversationId] })).rows[0]
  return row ? { messageId: String(row.message_id), toolCallId: String(row.tool_call_id), conversationId: String(row.conversation_id ?? '') } : null
}

export async function writeProjectionReceipt(db: ProjectionExecutor, ctx: ProjectionContext, id: string,
  anchor: ConversationToolCallAnchor, receipt: ProjectionReceipt): Promise<void> {
  await db.execute({ sql: `INSERT INTO conversation_projection_receipts
    (tenant_id, session_id, message_id, anchor_message_id, anchor_tool_call_id, anchor_conversation_id, backend, disposition, reservation_epoch, anchor_sequence)
    VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,session_id,message_id) DO UPDATE SET disposition=excluded.disposition
    WHERE conversation_projection_receipts.anchor_message_id=excluded.anchor_message_id
      AND conversation_projection_receipts.anchor_tool_call_id=excluded.anchor_tool_call_id
      AND conversation_projection_receipts.anchor_conversation_id=excluded.anchor_conversation_id
      AND conversation_projection_receipts.disposition='pending'`,
    args: [ctx.tenantId, ctx.sessionId, id, anchor.messageId, anchor.toolCallId, anchor.conversationId,
      receipt.backend, receipt.disposition, receipt.epoch, receipt.anchorSequence] })
  const persisted = await readProjectionReceipt(db, ctx, id, anchor)
  if (!persisted || persisted.disposition !== receipt.disposition)
    throw new Error('History projection disposition was not durably recorded')
}

/** JSONL reserve/complete are short commits; never hold SQL ownership across filesystem I/O. */
export async function commitProjectionReceipt(db: Client, ctx: ProjectionContext, id: string,
  anchor: ConversationToolCallAnchor, receipt: ProjectionReceipt): Promise<void> {
  const tx = await db.transaction('write')
  try { await writeProjectionReceipt(tx, ctx, id, anchor, receipt); await tx.commit() }
  catch (error) {
    if (!tx.closed) {
      try { await tx.rollback() }
      catch (rollbackError) { throw new AggregateError([error, rollbackError], 'History projection receipt failed and rollback did not complete') }
    }
    throw error
  }
  finally { tx.close() }
}

export async function advanceProjectionEpoch(db: Client, ctx: ProjectionContext): Promise<void> {
  await ensureProjectionReceipts(db)
  await db.execute({ sql: `INSERT INTO conversation_projection_epochs(tenant_id,session_id,epoch) VALUES(?,?,1)
    ON CONFLICT(tenant_id,session_id) DO UPDATE SET epoch=epoch+1`, args: [ctx.tenantId, ctx.sessionId] })
}
