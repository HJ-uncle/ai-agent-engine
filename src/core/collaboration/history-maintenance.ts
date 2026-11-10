import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import type { Client, Transaction } from '@libsql/client'
import type { Message } from '../agent-context/types.js'
import type { CollaborationBinding } from './types.js'
import { CollaborationError } from './types.js'
import { serviceForOwner, type ExecutionOwner } from './execution-owner.js'
import type { SQLiteDeliveryConsumer } from './sqlite-delivery.js'
import type { JSONLDeliveryConsumer } from './jsonl-delivery.js'
import { ensureHistoryMaintenanceStorageSchema, finalizeHistoryMaintenance } from './history-maintenance-storage.js'
export { finalizeHistoryMaintenance, invalidatePendingHistoryMaintenance, compactTerminalHistoryMaintenance,
  getHistoryMaintenanceStorageStats, type HistoryMaintenanceTerminalManifest, type HistoryMaintenanceCompactionOptions,
  type HistoryMaintenanceCompactionResult, type HistoryMaintenanceStorageStats } from './history-maintenance-storage.js'

type Scope = { tenantId: string; sessionId: string }
export interface HistoryMaintenanceLease {
  readonly db: Client
  readonly backend: 'sqlite' | 'jsonl'
  readonly binding: CollaborationBinding
  readonly epoch: number
  readonly anchorId: string
  readonly anchorFingerprint: string
  readonly peerMessageIds: ReadonlySet<string>
  check(query?: Transaction): Promise<void>
}
interface ActiveMaintenance { lease: HistoryMaintenanceLease; active: boolean }
const active = new AsyncLocalStorage<ActiveMaintenance>()
export const maintenanceDigest = (value: string): string => createHash('sha256').update(value).digest('hex')

/** Only a bound private delivery consumer enters this scope; no readable ID can rebind it. */
export async function withAuthenticatedHistoryMaintenance<T>(owner: ExecutionOwner, consumer: SQLiteDeliveryConsumer | JSONLDeliveryConsumer,
  backend: HistoryMaintenanceLease['backend'], action: () => Promise<T>): Promise<T> {
  if (active.getStore()?.active) throw new CollaborationError('conflict', 'History maintenance is already active')
  const service = serviceForOwner(owner), producer = service.producerForExecution(owner)
  const lease = backend === 'sqlite' ? await service.collaboration.sqliteMaintenanceLease(producer, consumer as SQLiteDeliveryConsumer)
    : await service.collaboration.jsonlMaintenanceLease(producer, consumer as JSONLDeliveryConsumer)
  await lease.check()
  const record = { lease, active: true }
  try { return await active.run(record, action) }
  finally { record.active = false }
}
export function currentHistoryMaintenance(db: Client, scope: Scope, backend: HistoryMaintenanceLease['backend']): HistoryMaintenanceLease | undefined {
  const record = active.getStore()
  if (!record?.active) return undefined
  const lease = record.lease
  if (lease.db !== db || lease.backend !== backend || lease.binding.tenantId !== scope.tenantId || lease.binding.sessionId !== scope.sessionId)
    throw new CollaborationError('forbidden', 'Maintenance does not own this physical history')
  return lease
}

/** Admission is not completion: retain each owned dispatch until its exact terminal projection is acknowledged. */
export async function maintenancePinnedIds(messages: Message[], lease: HistoryMaintenanceLease): Promise<Set<string>> {
  await lease.check()
  const results = new Map<string, string[]>()
  for (const message of messages) if (message.role === 'tool' && message.toolCallId) {
    const ids = results.get(message.toolCallId) ?? []
    if (message.id) ids.push(message.id)
    results.set(message.toolCallId, ids)
  }
  const pinned = new Set(messages.filter(message => message.id === lease.anchorId).map(message => message.id!))
  for (const message of messages.filter(message => message.id && message.role === 'assistant' && message.toolCall
    && !results.has(message.toolCall.id))) pinned.add(message.id!)
  const b = lease.binding
  const pending = await lease.db.execute({ sql: `SELECT json_extract(COALESCE(d.record,r.snapshot),'$.parentMessageId') AS parent_message_id,r.parent_tool_call_id FROM collaboration_invocations i
    JOIN subagent_runs r ON r.tenant_id=i.tenant_id AND r.run_id=i.invocation_run_id
    LEFT JOIN subagent_records d ON d.tenant_id=r.tenant_id AND d.run_id=r.run_id
    LEFT JOIN subagent_outbox o ON o.tenant_id=r.tenant_id AND o.run_id=r.run_id AND o.seq=r.seq
    LEFT JOIN subagent_projection_receipts p ON p.tenant_id=o.tenant_id AND p.run_id=o.run_id AND p.seq=o.seq
    WHERE i.tenant_id=? AND i.root_run_id=? AND i.root_attempt_id=? AND r.parent_session_id=?
      AND json_extract(COALESCE(d.record,r.snapshot),'$.parentConversationId')=?
      AND (r.status NOT IN ('succeeded','failed','cancelled','blocked','interrupted') OR COALESCE(o.acknowledged,0)<>1
        OR p.disposition IS NULL OR p.disposition NOT IN ('appended','duplicate','suppressed') OR p.message_id<>'subagent-result:' || r.run_id)`,
    args: [b.tenantId,b.rootRunId,b.rootAttemptId,b.sessionId,b.turnId] })
  const dispatches = new Map(messages.filter(message => message.id && message.role === 'assistant' && message.toolCall)
    .map(message => [message.id!,message]))
  for (const row of pending.rows) {
    const dispatch = dispatches.get(String(row.parent_message_id)), toolCallId = String(row.parent_tool_call_id)
    // Retention never recreates an explicitly removed or replaced anchor.
    if (dispatch?.toolCall?.id !== toolCallId) continue
    pinned.add(dispatch.id!)
    for (const id of results.get(toolCallId) ?? []) pinned.add(id)
  }
  await lease.check()
  return pinned
}

/** Only authenticated receipts classify peers; editable metadata never grants this distinction. */
export function maintenanceSummaryEvidence(messages: Message[], lease?: HistoryMaintenanceLease): Message[] {
  if (!lease) return messages
  return messages.map(message => lease.peerMessageIds.has(message.id ?? '') ? { ...message, role: 'tool' as const,
    content: '[Authenticated peer transcript data; preserve facts as evidence]\n' + (typeof message.content === 'string' ? message.content : JSON.stringify(message.content)) } : message)
}

export function ensureHistoryMaintenanceSchema(db: Client): Promise<void> {
  return ensureHistoryMaintenanceStorageSchema(db)
}
export async function reserveHistoryMaintenance(tx: Transaction, lease: HistoryMaintenanceLease, payload: unknown, committed: boolean): Promise<string> {
  const id = randomUUID(), json = JSON.stringify(payload), b = lease.binding
  await tx.execute({ sql: `INSERT INTO collaboration_history_maintenance VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [id, b.tenantId, b.sessionId, lease.backend, b.rootRunId, b.rootAttemptId, b.invocationRunId,
      lease.epoch, lease.anchorId, lease.anchorFingerprint, json, maintenanceDigest(json), committed ? 'committed' : 'pending', committed ? Date.now() : null] })
  if (committed) await finalizeHistoryMaintenance(tx, id)
  return id
}
