import { createHash } from 'node:crypto'
import type { Client } from '@libsql/client'
import type { ConversationHistory, Message } from '../agent-context/types.js'
import type { CollaborationBinding } from '../collaboration/types.js'
import { CollaborationError } from '../collaboration/types.js'
import { readAuthenticatedJSONLHistory, jsonlHistoryIdentity } from '../../storage/conversation/jsonl-origin.js'
import { readAuthenticatedSQLiteHistory, sqliteHistoryIdentity } from '../../storage/conversation/sqlite-origin.js'
import { SubagentStore } from './store.js'
import type { DelegatedInputAnchor, SubagentRunHeader } from './types.js'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const fail = (message: string): never => { throw new CollaborationError('conflict', message) }
const stores = new WeakMap<Client, SubagentStore>()
const storeFor = (db: Client): SubagentStore => {
  let store = stores.get(db)
  if (!store) { store = new SubagentStore(db); stores.set(db, store) }
  return store
}

/** Establish the original reference from the admitted task and actual history,
 * never a context-supplied message ID or a peer/controller receipt. */
export async function retainDelegatedInput(history: ConversationHistory, store: SubagentStore, run: SubagentRunHeader): Promise<DelegatedInputAnchor> {
  const scope = { tenantId: run.tenantId, sessionId: run.childSessionId }
  const jsonl = jsonlHistoryIdentity(history), sqlite = jsonl ? undefined : sqliteHistoryIdentity(history)
  if ((jsonl?.db() ?? sqlite?.db) !== store.db) fail('Child continuation history belongs to another datasource')
  const messages = await (jsonl ? readAuthenticatedJSONLHistory(history, scope) : readAuthenticatedSQLiteHistory(history, scope)).catch(error => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      fail('Child continuation lost its exact delegated task input; it cannot replay or invent a replacement')
    throw error
  })
  if (!messages) fail('Child continuation requires authenticated history')
  const table = jsonl ? 'collaboration_jsonl_deliveries' : 'collaboration_deliveries'
  const rows = await store.db.execute({ sql: `SELECT history_message_id FROM ${table} WHERE tenant_id=? AND history_session_id=?`, args: [scope.tenantId, scope.sessionId] })
  const peerIds = new Set(rows.rows.map(row => String(row.history_message_id)))
  const input = messages!.filter(message => message.role === 'user' && !peerIds.has(message.id ?? '')).at(-1)
  const existing = await store.delegatedInputAnchor(run.tenantId, run.runId)
  const expectedRun = existing?.inputRunId ?? run.runId, expectedTurn = existing?.turnId ?? run.parentConversationId
  if (!input?.id || input.content !== run.task || input.metadata?.subagentRunId !== expectedRun
    || (input as Message & { conversationId?: string }).conversationId !== expectedTurn
    || existing && (existing.messageId !== input.id || existing.contentHash !== hash(run.task)))
    fail('Child continuation lost its exact delegated task input; it cannot replay or invent a replacement')
  if (existing) return existing
  const anchor = { inputRunId: run.runId, messageId: input!.id!, turnId: expectedTurn, contentHash: hash(run.task) }
  await store.recordDelegatedInputAnchor(run.tenantId, run.runId, anchor)
  return anchor
}

/** The live owner chooses its immutable run; readable ctx continuation flags
 * cannot authorize rebinding to an earlier turn. */
export async function delegatedContinuationInput(db: Client, binding: CollaborationBinding): Promise<{ anchor: DelegatedInputAnchor; content: string } | undefined> {
  if (binding.kind !== 'child') return undefined
  const store = storeFor(db), run = await store.getRunHeader(binding.tenantId, binding.invocationRunId, true)
  if (!run) return fail('Child continuation admission is absent')
  if (run.continuationMode !== 'continue') return undefined
  if (run.childSessionId !== binding.sessionId || run.parentSessionId !== binding.rootSessionId
    || run.rootSessionId !== binding.rootSessionId || run.parentConversationId !== binding.turnId) fail('Child continuation owner does not match admission')
  const anchor = await store.delegatedInputAnchor(binding.tenantId, run.runId)
  if (!run.resumeFromRunId || !anchor || anchor.contentHash !== hash(run.task) || anchor.turnId !== run.taskTurnId)
    fail('Child continuation has no immutable delegated input reference')
  return { anchor: anchor!, content: run.task }
}

export async function recordBoundDelegatedInput(db: Client, binding: CollaborationBinding, messageId: string, content: Message['content']): Promise<void> {
  if (binding.kind !== 'child') return
  if (typeof content !== 'string') fail('A delegated task must have its exact string input')
  const store = storeFor(db)
  await store.recordDelegatedInputAnchor(binding.tenantId, binding.invocationRunId,
    { inputRunId: binding.invocationRunId, messageId, turnId: binding.turnId, contentHash: hash(content as string) })
}
