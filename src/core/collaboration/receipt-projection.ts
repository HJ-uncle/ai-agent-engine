import type { Client, Row, Transaction } from '@libsql/client'
import { CollaborationError, type CollaborationDelivery, type CollaborationReceipt, type CollaborationRootScope } from './types.js'
import { controllerDigest } from './controller-origin.js'

type Query = Pick<Client, 'execute'> | Pick<Transaction, 'execute'>
const conflict = (message: string): never => { throw new CollaborationError('conflict', message) }

export function collaborationReceipt(row: Row, delivery: CollaborationDelivery = { state: 'pending' }): CollaborationReceipt {
  return { messageId: String(row.message_id), rootRunId: String(row.root_run_id), rootAttemptId: String(row.root_attempt_id),
    senderParticipantId: String(row.sender_participant_id), senderInvocationRunId: String(row.sender_invocation_run_id),
    recipientParticipantId: String(row.recipient_participant_id), requestKey: String(row.request_key), payloadHash: String(row.payload_hash),
    payloadBytes: Number(row.payload_bytes), acceptedSeq: Number(row.seq), acceptedAt: Number(row.accepted_at),
    state: row.state as CollaborationReceipt['state'], ...(row.reason == null ? {} : { reason: String(row.reason) }), delivery }
}

/** Project durable receipt rows in one bounded query, without loading message
 * bodies or inventing a model-consumption ACK. Caller owns the read transaction. */
export async function projectCollaborationReceipts(q: Query, b: CollaborationRootScope, rows: Row[]): Promise<CollaborationReceipt[]> {
  if (!rows.length) return []
  const ids = rows.map(row => String(row.message_id)), placeholders = ids.map(() => '?').join(',')
  const args = [b.tenantId, b.rootRunId, b.rootAttemptId, ...ids]
  const selection = `tenant_id=? AND root_run_id=? AND root_attempt_id=? AND message_id IN (${placeholders})`
  const columns = 'tenant_id,root_run_id,root_attempt_id,message_id,recipient_participant_id,recipient_invocation_run_id,history_session_id,history_message_id,state,reason,integrated_at'
  const deliveries = (await q.execute({ sql: `SELECT d.*,o.recipient_invocation_id AS controller_invocation_id,o.root_session_id AS controller_root_session_id,
    p.session_id AS recipient_session_id
    FROM (SELECT ${columns} FROM collaboration_deliveries WHERE ${selection}
      UNION ALL SELECT ${columns} FROM collaboration_jsonl_deliveries WHERE ${selection}) d
    LEFT JOIN collaboration_controller_origins o ON o.tenant_id=d.tenant_id AND o.root_run_id=d.root_run_id
      AND o.root_attempt_id=d.root_attempt_id AND o.message_id=d.message_id
    LEFT JOIN collaboration_participants p ON p.tenant_id=d.tenant_id AND p.root_run_id=d.root_run_id
      AND p.root_attempt_id=d.root_attempt_id AND p.participant_id=d.recipient_participant_id`, args: [...args, ...args] })).rows
  const byId = new Map<string, Row>()
  for (const delivery of deliveries) {
    const id = String(delivery.message_id)
    if (byId.has(id)) conflict('Message has conflicting history delivery receipts')
    byId.set(id, delivery)
  }
  return rows.map(row => {
    const receipt = collaborationReceipt(row), delivery = byId.get(receipt.messageId)
    if (!delivery) return receipt
    const isController = receipt.senderParticipantId.startsWith('controller:')
    const expectedHistoryId = (isController ? 'controller:' : 'peer:') + controllerDigest(JSON.stringify([b.tenantId, b.rootRunId, b.rootAttemptId, receipt.messageId]))
    if (delivery.recipient_participant_id !== receipt.recipientParticipantId || delivery.history_message_id !== expectedHistoryId
      || delivery.history_session_id !== delivery.recipient_session_id
      || isController && (delivery.controller_invocation_id !== delivery.recipient_invocation_run_id
        || delivery.controller_root_session_id !== b.rootSessionId))
      conflict('History delivery does not match its accepted recipient')
    if (delivery.state === 'pending') return receipt
    if (delivery.state !== 'integrated' && delivery.state !== 'suppressed') conflict('Invalid history delivery state')
    const integratedAt = delivery.integrated_at == null ? undefined : Number(delivery.integrated_at)
    if (integratedAt !== undefined && (!Number.isSafeInteger(integratedAt) || integratedAt < 0)
      || delivery.state === 'integrated' && integratedAt === undefined) conflict('Invalid history integration time')
    return { ...receipt, delivery: delivery.state === 'integrated'
      ? { state: 'integrated', historyMessageId: String(delivery.history_message_id), integratedAt: integratedAt! }
      : { state: 'suppressed', historyMessageId: String(delivery.history_message_id), ...(integratedAt === undefined ? {} : { integratedAt }),
        ...(delivery.reason == null ? {} : { reason: String(delivery.reason) }) } }
  })
}
