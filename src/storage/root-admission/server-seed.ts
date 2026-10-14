import { createHash } from 'node:crypto'
import type { Client, Transaction } from '@libsql/client'
import type { Message } from '../../core/agent-context/types.js'
import type { RootRun } from '../root-runs/index.js'
import type { CronAutomationRun } from '../cron/runs.js'
import type { AdmissionSeed } from './projection.js'
import { admissionError, canonicalAdmissionBody, readDatabaseNamespace, type EngineDatabaseNamespace } from './index.js'

type Query = Pick<Client, 'execute'>
type Scope = { tenantId: string; sessionId: string }
interface PreparedServerInput { content: Message['content']; metadata: Record<string, unknown> }
export interface ServerAdmissionReceipt {
  protocolVersion: 1
  authority: 'server-root-admission'
  namespace: EngineDatabaseNamespace
  tenantId: string; sessionId: string; rootRunId: string; turnId: string
  userMessageId: string; assistantMessageId: string; attemptId: string
  rootVersion: number; rootSequence: number; acceptedAt: number; userSeedDigest: string
  provenance: { kind: 'legacy-chat' } | { kind: 'cron'; runId: string; jobId: string; jobRevision: number; scheduleRevision: number }
}
const schemas = new WeakMap<Client, Promise<void>>()
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype

/** Capture the display input before the creator's first await; request IDs never authorize it. */
export function prepareServerAdmissionInput(request: Record<string, unknown>): PreparedServerInput | undefined {
  const attachments = Array.isArray(request.attachments) ? request.attachments : []
  if (!(typeof request.message === 'string' && (request.message.length || attachments.length) || Array.isArray(request.message) && request.message.length)) return undefined
  const metadata = { ...(record(request.metadata) ? request.metadata : {}) }
  delete metadata.attachments
  if (attachments.length) metadata.attachments = attachments.map(attachment => {
    if (!record(attachment) || typeof attachment.name !== 'string' || !attachment.name || attachment.type !== undefined && typeof attachment.type !== 'string') admissionError('INVALID_ADMISSION_ATTACHMENT', 400)
    return { name: attachment.name, ...(attachment.type !== undefined ? { type: attachment.type } : {}) }
  })
  return JSON.parse(canonicalAdmissionBody({ content: request.message, metadata })) as PreparedServerInput
}
export function ensureServerAdmissionSchema(db: Client): Promise<void> {
  let pending = schemas.get(db)
  if (!pending) {
    pending = db.execute(`CREATE TABLE IF NOT EXISTS server_root_admission_seeds (
      tenant_id TEXT NOT NULL,session_id TEXT NOT NULL,root_run_id TEXT NOT NULL,
      user_message_id TEXT NOT NULL,assistant_message_id TEXT NOT NULL,seed_json TEXT NOT NULL,
      receipt_json TEXT NOT NULL,projected_at INTEGER,PRIMARY KEY(tenant_id,root_run_id))`).then(async () => {
      await db.execute('CREATE INDEX IF NOT EXISTS server_root_admission_outbox ON server_root_admission_seeds(tenant_id,session_id,projected_at)')
    }).catch(error => { schemas.delete(db); throw error })
    schemas.set(db, pending)
  }
  return pending
}

/** Only the creator's transaction, after Cron claim validation, supplies provenance. */
export async function bindServerAdmissionSeed(tx: Transaction, tenantId: string, input: PreparedServerInput,
  run: RootRun & { attemptId: string }, automation: CronAutomationRun | null): Promise<ServerAdmissionReceipt> {
  if (automation && canonicalAdmissionBody(input.content) !== canonicalAdmissionBody(automation.snapshot.message)) admissionError('AUTOMATION_ADMISSION_SEED_CONFLICT')
  const message = { id: run.userMessageId, role: 'user' as const, content: input.content, createdAt: run.createdAt,
    conversationId: run.turnId, metadata: { ...input.metadata, rootRunId: run.runId, turnId: run.turnId } }
  const seedJson = JSON.stringify(message)
  const receipt: ServerAdmissionReceipt = { protocolVersion: 1, authority: 'server-root-admission', namespace: await readDatabaseNamespace(tx),
    tenantId, sessionId: run.sessionId, rootRunId: run.runId, turnId: run.turnId, userMessageId: run.userMessageId,
    assistantMessageId: run.assistantMessageId, attemptId: run.attemptId, rootVersion: run.version, rootSequence: run.seq, acceptedAt: run.createdAt,
    userSeedDigest: digest(seedJson), provenance: automation ? { kind: 'cron', runId: automation.id, jobId: automation.jobId,
      jobRevision: automation.jobRevision, scheduleRevision: automation.scheduleRevision } : { kind: 'legacy-chat' } }
  await tx.execute({ sql: 'INSERT INTO server_root_admission_seeds VALUES(?,?,?,?,?,?,?,NULL)',
    args: [tenantId, run.sessionId, run.runId, run.userMessageId, run.assistantMessageId, seedJson, JSON.stringify(receipt)] })
  return receipt
}

export async function readServerAdmissionSeed(query: Query, scope: Scope, rootRunId: string): Promise<AdmissionSeed> {
  const rootRow = (await query.execute({ sql: 'SELECT state FROM root_runs WHERE tenant_id=? AND session_id=? AND run_id=?', args: [scope.tenantId, scope.sessionId, rootRunId] })).rows[0]
  if (!rootRow) admissionError('ADMISSION_SEED_UNAVAILABLE', 503)
  let root: RootRun & { attemptId: string }
  try { root = JSON.parse(String(rootRow.state)) as typeof root } catch { admissionError('ADMISSION_SEED_CORRUPT', 503) }
  // Existing readable legacy IDs are deliberately insufficient; never backfill them on a read.
  if (root!.admissionReceipt || !root!.serverAdmissionReceipt) admissionError('ADMISSION_SEED_UNAVAILABLE', 503)
  const row = (await query.execute({ sql: 'SELECT user_message_id,assistant_message_id,seed_json,receipt_json,projected_at FROM server_root_admission_seeds WHERE tenant_id=? AND session_id=? AND root_run_id=?', args: [scope.tenantId, scope.sessionId, rootRunId] })).rows[0]
  if (!row) admissionError('ADMISSION_SEED_UNAVAILABLE', 503)
  try {
    const receipt = JSON.parse(String(row.receipt_json)) as ServerAdmissionReceipt, message = JSON.parse(String(row.seed_json)) as AdmissionSeed['message']
    const namespace = await readDatabaseNamespace(query)
    if (receipt.protocolVersion !== 1 || receipt.authority !== 'server-root-admission' || receipt.tenantId !== scope.tenantId || receipt.sessionId !== scope.sessionId
      || receipt.rootRunId !== rootRunId || root!.runId !== rootRunId || root!.sessionId !== scope.sessionId || receipt.turnId !== root!.turnId
      || receipt.namespace.id !== namespace.id || receipt.namespace.generation !== namespace.generation
      || receipt.userMessageId !== row.user_message_id || root!.userMessageId !== row.user_message_id || receipt.assistantMessageId !== row.assistant_message_id
      || receipt.userSeedDigest !== digest(String(row.seed_json)) || canonicalAdmissionBody(root!.serverAdmissionReceipt) !== canonicalAdmissionBody(receipt)
      || message.id !== receipt.userMessageId || message.role !== 'user' || message.conversationId !== root!.turnId
      || message.metadata?.rootRunId !== rootRunId || message.metadata?.turnId !== root!.turnId
      || message.createdAt !== receipt.acceptedAt || receipt.acceptedAt !== root!.createdAt
      || !receipt.attemptId || receipt.rootVersion !== 1 || receipt.rootVersion > root!.version || !Number.isSafeInteger(receipt.rootSequence) || receipt.rootSequence < 1 || receipt.rootSequence !== root!.seq
      || !['legacy-chat', 'cron'].includes(receipt.provenance.kind)) throw new Error('Invalid server seed')
    if (receipt.provenance.kind === 'cron') {
      const occurrence = (await query.execute({ sql: 'SELECT job_id,job_revision,schedule_revision,root_run_id,snapshot_json FROM cron_runs WHERE tenant_id=? AND id=?', args: [scope.tenantId, receipt.provenance.runId] })).rows[0]
      if (!occurrence || occurrence.root_run_id !== rootRunId || occurrence.job_id !== receipt.provenance.jobId
        || Number(occurrence.job_revision) !== receipt.provenance.jobRevision || Number(occurrence.schedule_revision) !== receipt.provenance.scheduleRevision
        || canonicalAdmissionBody(JSON.parse(String(occurrence.snapshot_json)).message) !== canonicalAdmissionBody(message.content)) throw new Error('Invalid immutable Cron claim')
    }
    canonicalAdmissionBody(message.content)
    return { source: 'server', anchor: { rootRunId, turnId: root!.turnId, userMessageId: receipt.userMessageId, assistantAnchorId: receipt.assistantMessageId },
      message, projected: row.projected_at !== null, seedJson: String(row.seed_json), receiptJson: String(row.receipt_json) }
  } catch { admissionError('ADMISSION_SEED_CORRUPT', 503) }
}
export async function acknowledgeServerAdmissionUser(query: Query, scope: Scope, seed: AdmissionSeed): Promise<void> {
  const updated = await query.execute({ sql: `UPDATE server_root_admission_seeds SET projected_at=COALESCE(projected_at,?)
    WHERE tenant_id=? AND session_id=? AND root_run_id=? AND user_message_id=? AND assistant_message_id=? AND seed_json=? AND receipt_json=?
      AND EXISTS(SELECT 1 FROM root_runs r WHERE r.tenant_id=? AND r.session_id=? AND r.run_id=?)`,
    args: [Date.now(), scope.tenantId, scope.sessionId, seed.anchor.rootRunId, seed.anchor.userMessageId, seed.anchor.assistantAnchorId,
      seed.seedJson, seed.receiptJson, scope.tenantId, scope.sessionId, seed.anchor.rootRunId] })
  if (updated.rowsAffected !== 1) admissionError('ADMISSION_SEED_UNAVAILABLE', 503)
}
