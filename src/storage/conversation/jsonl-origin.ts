import type { Client } from '@libsql/client'
import type { ConversationHistory, Message } from '../../core/agent-context/types.js'
import { CollaborationError } from '../../core/collaboration/types.js'
import { ensureJSONLDeliverySchema } from '../../core/collaboration/jsonl-delivery-schema.js'
import { getDb, getDbEpoch } from '../sqlite/db.js'
import { forwardSQLiteHistory } from './sqlite-origin.js'

export type JSONLScope = { tenantId: string; sessionId: string }
export interface JSONLPhysicalRow {
  id: string
  offset: number
  bytes: number
  hash: string
  sequence: number
  message: Message
}
export interface JSONLPhysicalSnapshot {
  fileIdentity: string
  revision: string
  size: number
  contentHash: string
  nextSequence: number
  lastId: string | null
  rows: JSONLPhysicalRow[]
  active: Message[]
}
export interface JSONLAppendPlan {
  fileIdentity: string
  offset: number
  bytes: number
  hash: string
  encoded: string
  prefixHash?: string
}
export interface JSONLHistoryOrigin {
  db(): Client
  withLease<T>(scope: JSONLScope, action: () => Promise<T>): Promise<T>
  inspect(scope: JSONLScope): Promise<JSONLPhysicalSnapshot>
  assertRevision(scope: JSONLScope, snapshot: JSONLPhysicalSnapshot): Promise<void>
  plan(scope: JSONLScope, snapshot: JSONLPhysicalSnapshot, message: Message): JSONLAppendPlan
  persist(scope: JSONLScope, plan: JSONLAppendPlan): Promise<void>
}
interface Identity { origin: JSONLHistoryOrigin; db?: Client; epoch?: number }
const identities = new WeakMap<ConversationHistory, Identity>()
const conflict = (message: string): never => { throw new CollaborationError('conflict', message) }
export function registerJSONLHistory(history: ConversationHistory, origin: JSONLHistoryOrigin): void { identities.set(history, { origin }) }
export function forwardJSONLHistory(source: ConversationHistory, wrapper: ConversationHistory): ConversationHistory {
  const found = identities.get(source)
  if (found) identities.set(wrapper, found)
  return wrapper
}
export function forwardConversationOrigin(source: ConversationHistory, wrapper: ConversationHistory): ConversationHistory {
  return forwardJSONLHistory(source, forwardSQLiteHistory(source, wrapper))
}
export function jsonlHistoryIdentity(history: ConversationHistory): JSONLHistoryOrigin | undefined {
  const found = identities.get(history)
  if (!found) return undefined
  const db = found.origin.db(), epoch = getDbEpoch(db)
  if (found.db && (found.db !== db || found.epoch !== epoch) || db.closed || getDb() !== db || epoch === undefined)
    conflict('JSONL receipt datasource changed')
  found.db ??= db; found.epoch ??= epoch
  return found.origin
}
export async function jsonlHistoryEpoch(db: Pick<Client, 'execute'>, scope: JSONLScope, required = false): Promise<number> {
  const result = (await db.execute({ sql: `SELECT epoch,typeof(epoch) AS epoch_type FROM collaboration_jsonl_epochs
    WHERE tenant_id=? AND session_id=?`, args: [scope.tenantId, scope.sessionId] })).rows
  if (!result.length) { if (required) conflict('JSONL durable history epoch is absent'); return 0 }
  const value = Number(result[0].epoch)
  if (result.length !== 1 || result[0].epoch_type !== 'integer' || !Number.isSafeInteger(value) || value < 0)
    conflict('JSONL durable history epoch is invalid')
  return value
}

/** Pending/suppressed IDs remain origins even when their file rows are absent. */
export async function authenticatedJSONLHistory(origin: JSONLHistoryOrigin, scope: JSONLScope,
  snapshot: JSONLPhysicalSnapshot, inheritContext = true, requiredAnchorId?: string): Promise<Message[]> {
  const db = origin.db()
  await ensureJSONLDeliverySchema(db)
  const tx = await db.transaction('read')
  let epoch: number, receipts: Awaited<ReturnType<Client['execute']>>['rows']
  try {
    receipts = (await tx.execute({ sql: `SELECT history_message_id,state,history_epoch,typeof(history_epoch) AS epoch_type,
      file_identity,row_offset,row_bytes,row_hash FROM collaboration_jsonl_deliveries WHERE tenant_id=? AND history_session_id=?`,
      args: [scope.tenantId, scope.sessionId] })).rows
    epoch = await jsonlHistoryEpoch(tx, scope, receipts.some(receipt => receipt.state === 'integrated'))
    await tx.commit()
  } catch (error) { if (!tx.closed) await tx.rollback().catch(() => undefined); throw error }
  finally { tx.close() }
  await origin.assertRevision(scope, snapshot)
  const byId = new Map<string, typeof receipts[number]>(), physical = new Map<string, JSONLPhysicalRow[]>(), activeCounts = new Map<string, number>(), activeById = new Map<string, Message>()
  for (const row of snapshot.rows) { const items = physical.get(row.id) ?? []; items.push(row); physical.set(row.id, items) }
  for (const message of snapshot.active) if (message.id) { activeCounts.set(message.id, (activeCounts.get(message.id) ?? 0) + 1); activeById.set(message.id, message) }
  for (const receipt of receipts) {
    const id = String(receipt.history_message_id)
    if (byId.has(id)) conflict('JSONL peer receipt identity is ambiguous')
    byId.set(id, receipt)
    if (receipt.state !== 'integrated') continue
    const rows = physical.get(id), row = rows?.[0]
    if (!row || rows!.length !== 1 || activeCounts.get(id) !== 1 || receipt.epoch_type !== 'integer'
      || !Number.isSafeInteger(Number(receipt.history_epoch)) || Number(receipt.history_epoch) !== epoch
      || receipt.file_identity !== snapshot.fileIdentity || Number(receipt.row_offset) !== row.offset
      || Number(receipt.row_bytes) !== row.bytes || receipt.row_hash !== row.hash || row.message.role !== 'user'
      || canonicalJSONLMessage(row.message) !== canonicalJSONLMessage(activeById.get(id)!))
      conflict('JSONL peer receipt lost its exact physical history row')
  }
  const selected = snapshot.active.filter(message => !byId.has(message.id ?? '') || byId.get(message.id!)!.state === 'integrated')
  const human = selected.filter(message => message.role === 'user' && !byId.has(message.id ?? '')).at(-1)
  if (requiredAnchorId !== undefined && human?.id !== requiredAnchorId) conflict('JSONL admitted input changed')
  if (inheritContext) return selected
  const anchor = requiredAnchorId ?? human?.id
  if (!anchor) return selected
  const index = selected.findIndex(message => message.id === anchor)
  if (index < 0) conflict('JSONL current input anchor is absent')
  const inputSequence = (selected[index] as Message & { dbId?: number }).dbId
  // A pinned original task can precede the summarized same-turn exchanges in
  // physical sequence while the summary is displayed first in model history.
  return selected.filter((message, position) => position >= index || message.metadata?.isCompactSummary
    && typeof inputSequence === 'number' && Number(message.metadata.compactionLeafSeq) >= inputSequence)
}
export function canonicalJSONLMessage(message: Message): string {
  const ordered = (value: unknown): unknown => Array.isArray(value) ? value.map(ordered)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, ordered(item)])) : value
  return JSON.stringify(ordered(message))
}
export async function readAuthenticatedJSONLHistory(history: ConversationHistory, scope: JSONLScope & { inheritContext?: boolean }): Promise<Message[] | undefined> {
  const origin = jsonlHistoryIdentity(history)
  if (!origin) return undefined
  return origin.withLease(scope, async () => {
    const snapshot = await origin.inspect(scope)
    const result = await authenticatedJSONLHistory(origin, scope, snapshot, scope.inheritContext !== false)
    jsonlHistoryIdentity(history)
    return result
  })
}
