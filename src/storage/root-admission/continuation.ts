import { createHash, randomUUID } from 'node:crypto'
import type { Client, Transaction } from '@libsql/client'
import type { RootRun } from '../root-runs/index.js'
import type { ControllerSubject } from '../../core/collaboration/controller-origin.js'
import { ensureControllerSchema } from '../../core/collaboration/controller-origin.js'
import { getExecutionOwners } from '../../core/collaboration/execution-owner.js'
import { assertChildContinuationSelection } from '../../core/subagent/continuation-selection.js'
import { readAdmissionSeed } from './projection.js'
import { readPluginRootProvenance } from './plugin-owner.js'
import { admissionError, assertDatabaseNamespace, canonicalAdmissionBody, validateNamespace,
  type AdmissionPredecessor, type EngineDatabaseNamespace } from './index.js'

type Query = Pick<Client, 'execute'> | Pick<Transaction, 'execute'>
type StoredRoot = RootRun & { attemptId: string; request: Record<string, unknown> }
type Transport = { toolProfile: string; runLifetime: string; subagentProtocol: 1 | 2 }
export interface RootContinuationSelector {
  protocolVersion: 1; namespace: EngineDatabaseNamespace; requestKey: string; bodyDigest: string
  owner: 'work' | 'code'; predecessor: AdmissionPredecessor; turnId: string
  childRunId?: string
}
export interface PreparedRootContinuation extends RootContinuationSelector { sessionId: string }
export interface RootContinuationReceipt extends RootContinuationSelector {
  sessionId: string; rootRunId: string; userMessageId: string; assistantMessageId: string; assistantAnchorId: string
  assistantIdentityKind: 'continuation-segment'; attemptId: string; previousAttemptId: string
  rootVersion: number; rootSequence: number; acceptedAt: number
}
export interface RootContinuationLookup { receipt: RootContinuationReceipt; run: RootRun; attemptId: string }
const schemas = new WeakMap<Client, Promise<void>>()
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
const identity = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value)
function fields(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) admissionError('INVALID_CONTINUATION', 400)
}
export function rootContinuationDigest(body: { sessionId: string }, transport: Transport,
  selector: Omit<RootContinuationSelector, 'requestKey' | 'bodyDigest'>): string {
  return createHash('sha256').update(canonicalAdmissionBody({ selector, transport, body })).digest('hex')
}
/** A separate operation, never an empty user message or a synthetic approval. */
export function prepareRootContinuation(body: Record<string, unknown>, transport: Transport): PreparedRootContinuation | undefined {
  if (body.continuation === undefined) return undefined
  fields(body, ['sessionId', 'continuation'])
  const value = body.continuation
  if (!identity(body.sessionId) || !object(value)) admissionError('INVALID_CONTINUATION', 400)
  fields(value, ['protocolVersion', 'namespace', 'requestKey', 'bodyDigest', 'owner', 'predecessor', 'turnId', ...(Object.hasOwn(value, 'childRunId') ? ['childRunId'] : [])])
  if (value.protocolVersion !== 1 || !identity(value.requestKey) || !identity(value.turnId)
    || !['work', 'code'].includes(String(value.owner)) || typeof value.bodyDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.bodyDigest)
    || !object(value.predecessor) || Object.hasOwn(value, 'childRunId') && !identity(value.childRunId)) admissionError('INVALID_CONTINUATION', 400)
  const prior = value.predecessor
  fields(prior, ['runId', 'attemptId', 'version'])
  if (!identity(prior.runId) || !identity(prior.attemptId) || !Number.isSafeInteger(prior.version) || Number(prior.version) < 1) admissionError('INVALID_CONTINUATION', 400)
  const selector = { protocolVersion: 1 as const, namespace: validateNamespace(value.namespace), owner: value.owner as 'work' | 'code',
    predecessor: { runId: prior.runId, attemptId: prior.attemptId, version: Number(prior.version) }, turnId: value.turnId,
    ...(typeof value.childRunId === 'string' ? { childRunId: value.childRunId } : {}) }
  const bodyDigest = rootContinuationDigest({ sessionId: body.sessionId }, transport, selector)
  if (bodyDigest !== value.bodyDigest) admissionError('CONTINUATION_BODY_DIGEST_MISMATCH')
  return { ...selector, sessionId: body.sessionId, requestKey: value.requestKey, bodyDigest }
}
export function ensureRootContinuationSchema(db: Client): Promise<void> {
  let pending = schemas.get(db)
  if (!pending) {
    pending = (async () => {
      await ensureControllerSchema(db)
      await db.executeMultiple(`CREATE TABLE IF NOT EXISTS root_continuations (
        tenant_id TEXT NOT NULL,session_id TEXT NOT NULL,namespace_id TEXT NOT NULL,generation TEXT NOT NULL,
        request_key TEXT NOT NULL,body_digest TEXT NOT NULL,root_run_id TEXT NOT NULL,attempt_id TEXT NOT NULL,
        subject_key TEXT NOT NULL,subject_kind TEXT NOT NULL,receipt_json TEXT NOT NULL,
        PRIMARY KEY(tenant_id,session_id,namespace_id,generation,request_key),UNIQUE(tenant_id,root_run_id,attempt_id));
        CREATE TABLE IF NOT EXISTS root_attempt_history (
        tenant_id TEXT NOT NULL,root_run_id TEXT NOT NULL,attempt_id TEXT NOT NULL,state_json TEXT NOT NULL,
        PRIMARY KEY(tenant_id,root_run_id,attempt_id));
        CREATE TABLE IF NOT EXISTS root_admission_subjects (
        tenant_id TEXT NOT NULL,session_id TEXT NOT NULL,root_run_id TEXT NOT NULL,initial_attempt_id TEXT NOT NULL,
        subject_key TEXT NOT NULL,subject_kind TEXT NOT NULL,PRIMARY KEY(tenant_id,root_run_id));`)
    })().catch(error => { schemas.delete(db); throw error })
    schemas.set(db, pending)
  }
  return pending
}
/** Persist the verified caller in the admission commit, including crashes before an owner can be installed. */
export async function bindRootAdmissionSubject(tx: Transaction, tenantId: string, run: StoredRoot, actor: ControllerSubject | undefined): Promise<void> {
  if (!actor) return
  if (actor.tenantId !== tenantId) admissionError('CONTINUATION_NOT_OWNED', 403)
  await tx.execute({ sql: 'INSERT INTO root_admission_subjects VALUES(?,?,?,?,?,?)',
    args: [tenantId, run.sessionId, run.runId, run.attemptId, actor.key, actor.kind] })
}
function sameSubject(row: Record<string, unknown> | undefined, actor: ControllerSubject | undefined, tenantId: string): void {
  if (!actor || actor.tenantId !== tenantId || !row || row.subject_kind !== actor.kind
    || actor.kind !== 'instance' && row.subject_key !== actor.key) admissionError('CONTINUATION_NOT_OWNED', 403)
}
export async function assertRootContinuationSubject(q: Query, tenantId: string,
  root: { runId: string; attemptId: string; sessionId: string }, actor: ControllerSubject | undefined): Promise<void> {
  const args = [tenantId, root.runId, root.attemptId, root.sessionId]
  const subject = (await q.execute({ sql: 'SELECT subject_key,subject_kind FROM collaboration_controller_roots WHERE tenant_id=? AND root_run_id=? AND root_attempt_id=? AND root_session_id=?', args })).rows[0]
    ?? (await q.execute({ sql: 'SELECT subject_key,subject_kind FROM root_continuations WHERE tenant_id=? AND root_run_id=? AND attempt_id=? AND session_id=?', args })).rows[0]
    ?? (await q.execute({ sql: 'SELECT subject_key,subject_kind FROM root_admission_subjects WHERE tenant_id=? AND root_run_id=? AND session_id=?', args: [tenantId, root.runId, root.sessionId] })).rows[0]
  sameSubject(subject, actor, tenantId)
}
/** Exact old receipts remain tied to their accepted attempt even after another continuation. */
export async function lookupRootContinuation(q: Query, tenantId: string, sessionId: string,
  selector: Pick<RootContinuationSelector, 'namespace' | 'requestKey' | 'bodyDigest'>, actor: ControllerSubject | undefined,
  project: (run: StoredRoot) => RootRun): Promise<RootContinuationLookup | null> {
  if (!actor || actor.tenantId !== tenantId) admissionError('CONTINUATION_NOT_OWNED', 403)
  await assertDatabaseNamespace(q, selector.namespace)
  const row = (await q.execute({ sql: `SELECT * FROM root_continuations WHERE tenant_id=? AND session_id=?
    AND namespace_id=? AND generation=? AND request_key=?`, args: [tenantId, sessionId, selector.namespace.id, selector.namespace.generation, selector.requestKey] })).rows[0]
  if (!row) return null
  sameSubject(row, actor, tenantId)
  if (row.body_digest !== selector.bodyDigest) admissionError('CONTINUATION_KEY_BODY_CONFLICT')
  const rootRow = (await q.execute({ sql: 'SELECT seq,state FROM root_runs WHERE tenant_id=? AND session_id=? AND run_id=?', args: [tenantId, sessionId, String(row.root_run_id)] })).rows[0]
  if (!rootRow) admissionError('CONTINUATION_RECEIPT_UNAVAILABLE', 503)
  try {
    const receipt = JSON.parse(String(row.receipt_json)) as RootContinuationReceipt
    const current = { ...JSON.parse(String(rootRow.state)), seq: Number(rootRow.seq) } as StoredRoot
    const audit = current.attemptId === receipt.attemptId ? undefined : (await q.execute({ sql: 'SELECT state_json FROM root_attempt_history WHERE tenant_id=? AND root_run_id=? AND attempt_id=?',
      args: [tenantId, current.runId, receipt.attemptId] })).rows[0]
    const run = current.attemptId === receipt.attemptId ? project(current) : audit ? JSON.parse(String(audit.state_json)) as RootRun : undefined
    if (!run || receipt.protocolVersion !== 1 || receipt.rootRunId !== row.root_run_id || receipt.attemptId !== row.attempt_id
      || receipt.sessionId !== sessionId || receipt.requestKey !== selector.requestKey || receipt.bodyDigest !== selector.bodyDigest
      || canonicalAdmissionBody(receipt.namespace) !== canonicalAdmissionBody(selector.namespace)
      || run.runId !== receipt.rootRunId || run.sessionId !== sessionId || run.turnId !== receipt.turnId
      || run.attemptId !== receipt.attemptId || run.userMessageId !== receipt.userMessageId
      || canonicalAdmissionBody(run.continuationReceipt) !== canonicalAdmissionBody(receipt)) throw new Error('Invalid continuation receipt')
    await readAdmissionSeed(q, { tenantId, sessionId }, current.runId)
    return { receipt, run, attemptId: receipt.attemptId }
  } catch { admissionError('CONTINUATION_RECEIPT_UNAVAILABLE', 503) }
}
/** Call inside the same transaction that changes the current attempt. */
export async function validateContinuationTarget(tx: Query, tenantId: string, input: PreparedRootContinuation,
  actor: ControllerSubject | undefined) {
  await assertDatabaseNamespace(tx, input.namespace)
  const row = (await tx.execute({ sql: 'SELECT seq,state FROM root_runs WHERE tenant_id=? AND session_id=? ORDER BY seq DESC LIMIT 1', args: [tenantId, input.sessionId] })).rows[0]
  if (!row) admissionError('CONTINUATION_RUN_NOT_FOUND', 404)
  const previous = { ...JSON.parse(String(row.state)), seq: Number(row.seq) } as StoredRoot
  if (previous.runId !== input.predecessor.runId || previous.attemptId !== input.predecessor.attemptId
    || previous.version !== input.predecessor.version || previous.turnId !== input.turnId) admissionError('CONTINUATION_PREDECESSOR_CHANGED')
  await assertRootContinuationSubject(tx, tenantId, previous, actor)
  if (!['failed', 'interrupted', 'cancelled', ...(input.childRunId ? ['succeeded'] : [])].includes(previous.status)) admissionError('CONTINUATION_NOT_RESUMABLE')
  if (previous.pending.some(item => item.status === 'pending')) admissionError('CONTINUATION_REQUIRES_PENDING_RESPONSE')
  if (readPluginRootProvenance(previous.request) || previous.serverAdmissionReceipt?.provenance.kind === 'plugin-agent'
    || previous.request.automationRunId !== undefined) admissionError('CONTINUATION_REQUIRES_ORIGINAL_HOST', 403)
  if (previous.admissionReceipt && previous.admissionReceipt.owner !== input.owner) admissionError('CONTINUATION_OWNER_CHANGED')
  if (getExecutionOwners().find(tenantId, previous.runId, previous.attemptId)) admissionError('CONTINUATION_OWNER_NOT_DRAINED')
  if (input.childRunId) await assertChildContinuationSelection(tx, { tenantId, parentSessionId: input.sessionId, parentTurnId: input.turnId, runId: input.childRunId })
  const seed = await readAdmissionSeed(tx, { tenantId, sessionId: input.sessionId }, previous.runId)
  const active = (await tx.execute({ sql: "SELECT 1 FROM root_runs WHERE tenant_id=? AND session_id=? AND json_extract(state,'$.status') IN ('running','waiting') LIMIT 1", args: [tenantId, input.sessionId] })).rows
  if (active.length) admissionError('CONTINUATION_SESSION_BUSY')
  return { previous, seed }
}
export async function prepareContinuationAttempt(tx: Transaction, tenantId: string, input: PreparedRootContinuation,
  actor: ControllerSubject | undefined, project: (run: StoredRoot) => RootRun): Promise<{ run: StoredRoot; receipt: RootContinuationReceipt }> {
  const { previous, seed } = await validateContinuationTarget(tx, tenantId, input, actor)
  // Only bounded public state is copied; transcripts and private requests stay in their original stores.
  await tx.execute({ sql: 'INSERT INTO root_attempt_history VALUES(?,?,?,?)', args: [tenantId, previous.runId, previous.attemptId, JSON.stringify(project(previous))] })
  const now = Date.now(), run: StoredRoot = { ...previous, attemptId: randomUUID(), assistantMessageId: randomUUID(),
    version: previous.version + 1, status: 'running', updatedAt: now }
  delete run.startedAt; delete run.finishedAt; delete run.error; delete run.stopReason; delete run.activity; delete run.compaction
  const { sessionId: _sessionId, ...selector } = input
  const receipt: RootContinuationReceipt = { ...selector, sessionId: input.sessionId, rootRunId: run.runId, userMessageId: run.userMessageId,
    assistantMessageId: run.assistantMessageId, assistantAnchorId: seed.anchor.assistantAnchorId, assistantIdentityKind: 'continuation-segment',
    attemptId: run.attemptId, previousAttemptId: previous.attemptId, rootVersion: run.version, rootSequence: run.seq, acceptedAt: now }
  run.continuationReceipt = receipt
  await tx.execute({ sql: 'INSERT INTO root_continuations VALUES(?,?,?,?,?,?,?,?,?,?,?)', args: [tenantId, input.sessionId, input.namespace.id,
    input.namespace.generation, input.requestKey, input.bodyDigest, run.runId, run.attemptId, actor!.key, actor!.kind, JSON.stringify(receipt)] })
  return { run, receipt }
}
