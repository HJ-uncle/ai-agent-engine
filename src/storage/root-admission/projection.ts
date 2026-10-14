import type { Client } from '@libsql/client'
import { createHash } from 'node:crypto'
import type { ConversationHistory, Message } from '../../core/agent-context/types.js'
import { withHistoryLock, isSessionHistoryMutating } from '../conversation/serialization.js'
import { admissionError, canonicalAdmissionBody, ensureUserAdmissionSchema } from './index.js'
import { forwardConversationOrigin } from '../conversation/jsonl-origin.js'
import { readServerAdmissionSeed, acknowledgeServerAdmissionUser, ensureServerAdmissionSchema } from './server-seed.js'

export interface AdmissionMessageAnchor { rootRunId: string; turnId: string; userMessageId: string; assistantAnchorId: string }
export interface AdmissionSeed { source?: 'server'; anchor: AdmissionMessageAnchor; message: Message & { conversationId: string }; projected: boolean; seedJson: string; receiptJson: string }
type Scope = { tenantId: string; sessionId: string }
type Query = Pick<Client, 'execute'>

export async function readAdmissionSeed(query: Query, scope: Scope, rootRunId: string): Promise<AdmissionSeed> {
  const row = (await query.execute({ sql: `SELECT s.seed_json,s.user_message_id,s.assistant_message_id,s.projected_at,r.state,a.receipt_json
    FROM user_root_admission_seeds s JOIN root_runs r ON r.tenant_id=s.tenant_id AND r.session_id=s.session_id AND r.run_id=s.root_run_id
    JOIN user_root_admissions a ON a.tenant_id=s.tenant_id AND a.session_id=s.session_id AND a.root_run_id=s.root_run_id
    WHERE s.tenant_id=? AND s.session_id=? AND s.root_run_id=?`, args: [scope.tenantId, scope.sessionId, rootRunId] })).rows[0]
  if (!row) return readServerAdmissionSeed(query, scope, rootRunId)
  try {
    const message = JSON.parse(String(row.seed_json)) as AdmissionSeed['message']
    const root = JSON.parse(String(row.state)) as { runId: string; turnId: string; sessionId: string; userMessageId: string; admissionReceipt: unknown }
    const receipt = JSON.parse(String(row.receipt_json)) as { userSeedDigest: string }
    if (root.runId !== rootRunId || root.sessionId !== scope.sessionId || message.role !== 'user' || !message.id || message.id !== row.user_message_id || root.userMessageId !== message.id || message.conversationId !== root.turnId || typeof row.assistant_message_id !== 'string' || !row.assistant_message_id
      || message.metadata?.rootRunId !== rootRunId || message.metadata?.turnId !== root.turnId) throw new Error('Invalid seed')
    canonicalAdmissionBody(message.content)
    if (createHash('sha256').update(String(row.seed_json)).digest('hex') !== receipt.userSeedDigest || canonicalAdmissionBody(root.admissionReceipt) !== canonicalAdmissionBody(receipt)) throw new Error('Invalid immutable seed')
    return { anchor: { rootRunId, turnId: root.turnId, userMessageId: message.id, assistantAnchorId: row.assistant_message_id }, message, projected: row.projected_at !== null, seedJson: String(row.seed_json), receiptJson: String(row.receipt_json) }
  } catch { admissionError('ADMISSION_SEED_CORRUPT', 503) }
}
export function validateAdmissionUser(message: Message, seed: AdmissionSeed, anchor: AdmissionMessageAnchor): void {
  if (anchor.rootRunId !== seed.anchor.rootRunId || anchor.turnId !== seed.anchor.turnId || anchor.userMessageId !== seed.anchor.userMessageId || anchor.assistantAnchorId !== seed.anchor.assistantAnchorId || message.id !== seed.anchor.userMessageId || message.role !== 'user' || (message as Message & { conversationId?: string }).conversationId !== seed.anchor.turnId || canonicalAdmissionBody(message.content) !== canonicalAdmissionBody(seed.message.content)) admissionError('ADMISSION_USER_PROJECTION_CONFLICT')
}
export async function acknowledgeAdmissionUser(query: Query, scope: Scope, seed: AdmissionSeed): Promise<void> {
  if (seed.source === 'server') return acknowledgeServerAdmissionUser(query, scope, seed)
  const result = await query.execute({ sql: `UPDATE user_root_admission_seeds SET projected_at=COALESCE(projected_at,?)
    WHERE tenant_id=? AND session_id=? AND root_run_id=? AND user_message_id=? AND assistant_message_id=? AND seed_json=?
      AND EXISTS(SELECT 1 FROM root_runs r WHERE r.tenant_id=? AND r.session_id=? AND r.run_id=?)
      AND EXISTS(SELECT 1 FROM user_root_admissions a WHERE a.tenant_id=? AND a.session_id=? AND a.root_run_id=? AND a.receipt_json=?)`,
    args: [Date.now(), scope.tenantId, scope.sessionId, seed.anchor.rootRunId, seed.anchor.userMessageId, seed.anchor.assistantAnchorId, seed.seedJson, scope.tenantId, scope.sessionId, seed.anchor.rootRunId, scope.tenantId, scope.sessionId, seed.anchor.rootRunId, seed.receiptJson] })
  if (result.rowsAffected !== 1) admissionError('ADMISSION_SEED_UNAVAILABLE', 503)
}
/** Assistant identity is reserved in SQLite, never an empty transcript row. */
export function admissionProjectingHistory(history: ConversationHistory, anchor: AdmissionMessageAnchor): ConversationHistory {
  if (!history.appendAdmissionUser) admissionError('ADMISSION_HISTORY_BACKEND_UNSUPPORTED', 503)
  return forwardConversationOrigin(history, new Proxy(history, { get(target, property) {
    if (property === 'append') return (message: Message, scope: Scope) => message.id === anchor.userMessageId
      ? target.appendAdmissionUser!(message, scope, anchor) : target.append(message, scope)
    const value = Reflect.get(target, property, target)
    return typeof value === 'function' ? value.bind(target) : value
  } }))
}
/** Repair only retained terminal roots; never execute a model or resurrect deleted turns. */
export async function projectTerminalAdmissionUsers(db: Client, history: ConversationHistory, scope: Scope, exactRootRunId?: string): Promise<number> {
  await ensureUserAdmissionSchema(db)
  await ensureServerAdmissionSchema(db)
  return withHistoryLock(scope.tenantId, async () => {
    if (isSessionHistoryMutating(scope.tenantId, scope.sessionId)) admissionError('ADMISSION_HISTORY_MUTATING')
    let projected = 0, bytes = 0
    // An observation must release tenant ownership after finite recovery work.
    // Exact receipt/replay reads never depend on another turn's broken outbox.
    const rows = (await db.execute({ sql: `SELECT s.root_run_id,length(CAST(s.seed_json AS BLOB)) AS seed_bytes FROM (
        SELECT tenant_id,session_id,root_run_id,seed_json,projected_at FROM user_root_admission_seeds
        UNION ALL SELECT tenant_id,session_id,root_run_id,seed_json,projected_at FROM server_root_admission_seeds) s
        JOIN root_runs r ON r.tenant_id=s.tenant_id AND r.session_id=s.session_id AND r.run_id=s.root_run_id
        WHERE s.tenant_id=? AND s.session_id=? AND s.projected_at IS NULL
          AND json_extract(r.state,'$.status') IN ('succeeded','failed','cancelled','interrupted')
          ${exactRootRunId === undefined ? '' : 'AND s.root_run_id=?'} ORDER BY r.seq LIMIT 8`,
      args: [scope.tenantId, scope.sessionId, ...(exactRootRunId === undefined ? [] : [exactRootRunId])] })).rows
    if (rows.length && !history.appendAdmissionUser) admissionError('ADMISSION_HISTORY_BACKEND_UNSUPPORTED', 503)
    for (const row of rows) {
        const size = Number(row.seed_bytes)
        if (!Number.isSafeInteger(size) || size < 1) admissionError('ADMISSION_SEED_CORRUPT', 503)
        // Admit one large seed so it cannot permanently starve the tail.
        if (projected && bytes + size > 256 * 1024) break
        const seed = await readAdmissionSeed(db, scope, String(row.root_run_id))
        await history.appendAdmissionUser!(seed.message, scope, seed.anchor); projected++; bytes += size
    }
    return projected
  })
}
