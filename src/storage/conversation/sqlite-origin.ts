import { assertControllerDeliveryOrigins } from '../../core/collaboration/controller-origin.js'
import type { Client, Row, Transaction } from '@libsql/client'
import type { ConversationHistory, Message } from '../../core/agent-context/types.js'
import { CollaborationError } from '../../core/collaboration/types.js'
import { ensureSQLiteDeliverySchema } from '../../core/collaboration/delivery-schema.js'
import { getDb, getDbEpoch } from '../sqlite/db.js'

type Scope = { tenantId: string; sessionId: string }
interface Identity { db: Client; epoch: number | undefined; decode(row: Row): Message }
const identities = new WeakMap<ConversationHistory, Identity>()
const conflict = (message: string): never => { throw new CollaborationError('conflict', message) }

/** Backend identity follows only server-created history wrappers, never copied shapes. */
export function registerSQLiteHistory(history: ConversationHistory, db: Client, decode: Identity['decode']): void {
  identities.set(history, { db, epoch: getDbEpoch(db), decode })
}
export function forwardSQLiteHistory(source: ConversationHistory, wrapper: ConversationHistory): ConversationHistory {
  const identity = identities.get(source)
  if (identity) identities.set(wrapper, identity)
  return wrapper
}
export function sqliteHistoryIdentity(history: ConversationHistory): Identity | undefined {
  const identity = identities.get(history)
  if (identity && (identity.db.closed || identity.epoch === undefined || getDb() !== identity.db
    || getDbEpoch(identity.db) !== identity.epoch)) conflict('SQLite history datasource changed')
  return identity
}

/** Readable metadata and peer-prefixed IDs cannot authenticate a message's origin. */
export async function authenticatedSQLiteRows(query: Pick<Transaction, 'execute'>, scope: Scope,
  inheritContext = true, requiredAnchorId?: string): Promise<Row[]> {
  await assertControllerDeliveryOrigins(query, scope, 'sqlite')
  // Compare receipt bodies inside SQLite against the exact physical primary key.
  // Retired mail contributes only its ID/state, never its historical large body.
  const deliveries = (await query.execute({ sql: `SELECT d.history_message_id,d.state,
    CASE WHEN d.state='integrated' THEN (
      d.history_identity_version=1 AND d.history_row_id IS NOT NULL AND
      e.epoch IS NOT NULL AND typeof(e.epoch)='integer' AND e.epoch>=0 AND e.epoch<=9007199254740991 AND
      typeof(d.history_epoch)='integer' AND d.history_epoch=e.epoch AND c.id IS d.history_row_id AND
      c.tenant_id IS d.tenant_id AND c.session_id IS d.history_session_id AND
      c.message_id IS d.history_message_id AND c.role='user' AND
      c.conversation_id IS d.history_conversation_id AND c.model_id IS d.history_model_id AND
      c.content IS d.history_content AND c.metadata IS d.history_metadata
    ) ELSE 1 END AS physical_identity_matches
    FROM collaboration_deliveries d
    LEFT JOIN conversations c ON c.id=d.history_row_id
    LEFT JOIN collaboration_history_epochs e ON e.tenant_id=d.tenant_id AND e.session_id=d.history_session_id
    WHERE d.tenant_id=? AND d.history_session_id=?`, args: [scope.tenantId, scope.sessionId] })).rows
  const receiptById = new Map<string, Row>()
  for (const receipt of deliveries) {
    const id = String(receipt.history_message_id)
    if (receiptById.has(id)) conflict('Peer history identity is ambiguous')
    receiptById.set(id, receipt)
    if (receipt.state === 'integrated' && Number(receipt.physical_identity_matches) !== 1)
      conflict('Peer receipt lost its exact physical history row')
  }
  // A suppressed receipt still excludes its readable ID from human admission.
  // Exclude it in SQL so retained stale content also stays off the native wire.
  const selected = (await query.execute({ sql: `SELECT c.* FROM conversations c WHERE c.tenant_id=? AND c.session_id=?
    AND NOT EXISTS (SELECT 1 FROM collaboration_deliveries d WHERE d.tenant_id=c.tenant_id
      AND d.history_session_id=c.session_id AND d.history_message_id=c.message_id AND d.state='suppressed')
    ORDER BY c.created_at ASC,c.id ASC`, args: [scope.tenantId, scope.sessionId] })).rows
  const countById = new Map<string, number>()
  let human: Row | undefined
  for (const row of selected) {
    const id = String(row.message_id)
    countById.set(id, (countById.get(id) ?? 0) + 1)
    if (row.role === 'user' && !receiptById.has(id)) human = row
  }
  // A second physical row with the same readable ID must still fail closed.
  for (const receipt of deliveries) {
    if (receipt.state === 'integrated' && countById.get(String(receipt.history_message_id)) !== 1)
      conflict('Peer receipt lost its history fence')
  }
  if (requiredAnchorId !== undefined && human?.message_id !== requiredAnchorId)
    conflict('The current human or delegated invocation anchor changed')
  if (inheritContext) return selected
  const anchorId = requiredAnchorId ?? human?.message_id
  if (anchorId === undefined) return selected
  const index = selected.findIndex(row => row.message_id === anchorId)
  if (index < 0) conflict('The current input anchor is absent')
  return selected.slice(index)
}

/** JSONL stays on its own projection; SQLite reads one authenticated physical snapshot. */
export async function readAuthenticatedSQLiteHistory(history: ConversationHistory,
  scope: Scope & { inheritContext?: boolean }): Promise<Message[] | undefined> {
  const identity = sqliteHistoryIdentity(history)
  if (!identity) return undefined
  await ensureSQLiteDeliverySchema(identity.db)
  const tx = await identity.db.transaction('read')
  try {
    const rows = await authenticatedSQLiteRows(tx, scope, scope.inheritContext !== false)
    sqliteHistoryIdentity(history)
    await tx.commit()
    return rows.map(identity.decode)
  } catch (error) { if (!tx.closed) await tx.rollback().catch(() => undefined); throw error }
  finally { tx.close() }
}
