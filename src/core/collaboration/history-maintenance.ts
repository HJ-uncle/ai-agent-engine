import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import type { Client, Transaction } from '@libsql/client'
import type { Message } from '../agent-context/types.js'
import type { CollaborationBinding } from './types.js'
import { CollaborationError } from './types.js'
import { serviceForOwner, type ExecutionOwner } from './execution-owner.js'
import type { SQLiteDeliveryConsumer } from './sqlite-delivery.js'
import type { JSONLDeliveryConsumer } from './jsonl-delivery.js'

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
const prepared = new WeakMap<Client, Promise<void>>()
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

/** An unfinished dispatch must remain available for its exact terminal projection. */
export function maintenancePinnedIds(messages: Message[], anchorId: string): Set<string> {
  const results = new Set(messages.filter(message => message.role === 'tool').map(message => message.toolCallId))
  return new Set([anchorId, ...messages.filter(message => message.id && message.role === 'assistant' && message.toolCall
    && !results.has(message.toolCall.id)).map(message => message.id!)])
}

/** Only authenticated receipts classify peers; editable metadata never grants this distinction. */
export function maintenanceSummaryEvidence(messages: Message[], lease?: HistoryMaintenanceLease): Message[] {
  if (!lease) return messages
  return messages.map(message => lease.peerMessageIds.has(message.id ?? '') ? { ...message, role: 'tool' as const,
    content: '[Authenticated peer transcript data; preserve facts as evidence]\n' + (typeof message.content === 'string' ? message.content : JSON.stringify(message.content)) } : message)
}

export function ensureHistoryMaintenanceSchema(db: Client): Promise<void> {
  let promise = prepared.get(db)
  if (!promise) {
    promise = db.execute(`CREATE TABLE IF NOT EXISTS collaboration_history_maintenance (
      maintenance_id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,session_id TEXT NOT NULL,backend TEXT NOT NULL,
      root_run_id TEXT NOT NULL,root_attempt_id TEXT NOT NULL,invocation_run_id TEXT NOT NULL,
      history_epoch INTEGER NOT NULL,anchor_id TEXT NOT NULL,anchor_fingerprint TEXT NOT NULL,
      payload_json TEXT NOT NULL,payload_hash TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('pending','committed','invalidated')),
      committed_at INTEGER)`).then(async () => {
        await db.execute(`CREATE INDEX IF NOT EXISTS collaboration_history_maintenance_pending
          ON collaboration_history_maintenance(tenant_id,session_id,backend,state)`)
      }).catch(error => { prepared.delete(db); throw error })
    prepared.set(db, promise)
  }
  return promise
}
export async function reserveHistoryMaintenance(tx: Transaction, lease: HistoryMaintenanceLease, payload: unknown, committed: boolean): Promise<string> {
  const id = randomUUID(), json = JSON.stringify(payload), b = lease.binding
  await tx.execute({ sql: `INSERT INTO collaboration_history_maintenance VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [id, b.tenantId, b.sessionId, lease.backend, b.rootRunId, b.rootAttemptId, b.invocationRunId,
      lease.epoch, lease.anchorId, lease.anchorFingerprint, json, maintenanceDigest(json), committed ? 'committed' : 'pending', committed ? Date.now() : null] })
  return id
}
