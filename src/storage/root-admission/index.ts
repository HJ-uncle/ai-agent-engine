import { createHash, randomUUID } from 'node:crypto'
import type { Client, Transaction } from '@libsql/client'
import type { Message } from '../../core/agent-context/types.js'
import type { RootRun } from '../root-runs/index.js'

type Query = Pick<Client, 'execute'> | Pick<Transaction, 'execute'>
export interface EngineDatabaseNamespace { id: string; generation: string }
export interface AdmissionPredecessor { runId: string; attemptId: string; version: number }
export interface UserAdmissionSelector {
  protocolVersion: 1; namespace: EngineDatabaseNamespace; requestKey: string; bodyDigest: string
  owner: 'work' | 'code'; predecessor: AdmissionPredecessor | null
}
export interface PreparedUserAdmission extends UserAdmissionSelector { sessionId: string; userContent: Message['content']; userMetadata?: Record<string, unknown> }
export interface UserAdmissionReceipt extends UserAdmissionSelector {
  sessionId: string; rootRunId: string; turnId: string; userMessageId: string; assistantMessageId: string
  assistantIdentityKind: 'admission-anchor'
  userSeedDigest: string
  attemptId: string; rootVersion: number; rootSequence: number; acceptedAt: number
}
export interface AdmissionReceiptLookup { receipt: UserAdmissionReceipt; run: RootRun & { request: Record<string, unknown>; attemptId: string }; attemptId: string }
const schemas = new WeakMap<Client, Promise<void>>()
const MAX_BODY_BYTES = 2 * 1024 * 1024
export function admissionError(reason: string, statusCode = 409): never {
  throw Object.assign(new Error(reason), { statusCode, code: reason, admissionRequired: true })
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}
function exactFields(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(value, key))) admissionError('INVALID_ADMISSION', 400)
}
function identity(value: unknown, maximum = 256): value is string { return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\x00-\x1f\x7f]/.test(value) }
export function validateNamespace(value: unknown): EngineDatabaseNamespace {
  if (!object(value)) admissionError('INVALID_NAMESPACE', 400)
  exactFields(value, ['id', 'generation'])
  if (!identity(value.id) || !identity(value.generation)) admissionError('INVALID_NAMESPACE', 400)
  return { id: value.id, generation: value.generation }
}
function predecessor(value: unknown): AdmissionPredecessor | null {
  if (value === null) return null
  if (!object(value)) admissionError('INVALID_PREDECESSOR', 400)
  exactFields(value, ['runId', 'attemptId', 'version'])
  if (!identity(value.runId) || !identity(value.attemptId) || !Number.isSafeInteger(value.version) || Number(value.version) < 1) admissionError('INVALID_PREDECESSOR', 400)
  return { runId: value.runId, attemptId: value.attemptId, version: Number(value.version) }
}

/** JSON keys are sorted; array order and omitted/empty/false values remain distinct. */
export function canonicalAdmissionBody(value: unknown): string {
  const visited = new Set<object>(); let nodes = 0; let size = 0
  const add = (text: string): string => { size += Buffer.byteLength(text); if (size > MAX_BODY_BYTES) admissionError('ADMISSION_BODY_TOO_LARGE', 413); return text }
  const walk = (entry: unknown, depth: number): string => {
    if (++nodes > 40_000 || depth > 24) admissionError('ADMISSION_BODY_TOO_LARGE', 413)
    if (entry === null || typeof entry === 'boolean') return add(String(entry))
    if (typeof entry === 'string') return add(JSON.stringify(entry))
    if (typeof entry === 'number' && Number.isFinite(entry)) return add(JSON.stringify(entry))
    if (!Array.isArray(entry) && !object(entry)) admissionError('INVALID_ADMISSION_BODY', 400)
    if (visited.has(entry)) admissionError('INVALID_ADMISSION_BODY', 400)
    visited.add(entry)
    const descriptors = Object.getOwnPropertyDescriptors(entry)
    if (Object.getOwnPropertySymbols(entry).length || Object.values(descriptors).some(field => field.get || field.set)) admissionError('INVALID_ADMISSION_BODY', 400)
    if (Array.isArray(entry)) {
      if (Object.keys(descriptors).length !== entry.length + 1 || entry.some((_item, index) => !Object.hasOwn(entry, index))
        || Object.keys(descriptors).some(key => key !== 'length' && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= entry.length || !descriptors[key].enumerable))) admissionError('INVALID_ADMISSION_BODY', 400)
    } else if (Object.values(descriptors).some(field => !field.enumerable)) admissionError('INVALID_ADMISSION_BODY', 400)
    const join = (parts: string[]) => parts.map((part, index) => (index ? add(',') : '') + part).join('')
    const encoded = Array.isArray(entry)
      ? add('[') + join(entry.map(item => walk(item, depth + 1))) + add(']')
      : add('{') + join(Object.keys(entry).sort().map(key => add(JSON.stringify(key)) + add(':') + walk(entry[key], depth + 1))) + add('}')
    visited.delete(entry); return encoded
  }
  const encoded = walk(value, 0)
  if (Buffer.byteLength(encoded) > MAX_BODY_BYTES) admissionError('ADMISSION_BODY_TOO_LARGE', 413)
  return encoded
}
export function userAdmissionDigest(body: Record<string, unknown>, transport: { toolProfile: string; runLifetime: string; subagentProtocol: 1 | 2 }, selector: Omit<UserAdmissionSelector, 'requestKey' | 'bodyDigest'>): string {
  const { admission: _admission, ...request } = body
  return createHash('sha256').update(canonicalAdmissionBody({ selector, transport, body: request })).digest('hex')
}
/** Capture before awaits; neither a renderer digest nor its namespace grants authority. */
export function prepareUserAdmission(body: Record<string, unknown>, transport: { toolProfile: string; runLifetime: string; subagentProtocol: 1 | 2 }): PreparedUserAdmission | undefined {
  if (body.admission === undefined) return undefined
  if (body.automationRunId !== undefined || body.cronJobId !== undefined || body.toolResponse !== undefined) admissionError('USER_ADMISSION_CANNOT_CLAIM_AUTOMATION_OR_RESUME', 400)
  const value = body.admission
  if (!object(value)) admissionError('INVALID_ADMISSION', 400)
  exactFields(value, ['protocolVersion', 'namespace', 'requestKey', 'bodyDigest', 'owner', 'predecessor'])
  if (value.protocolVersion !== 1 || !identity(value.requestKey) || typeof value.bodyDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.bodyDigest) || !['work', 'code'].includes(String(value.owner))) admissionError('INVALID_ADMISSION', 400)
  // Attachment-only submissions carry an explicit empty display message; the
  // existing attachment validator below still rejects malformed file labels.
  const attachmentOnly = Array.isArray(body.attachments) && body.attachments.length > 0
  if (!identity(body.sessionId) || !(typeof body.message === 'string' && (body.message.length || attachmentOnly) || Array.isArray(body.message) && body.message.length)) admissionError('ADMISSION_REQUIRES_SESSION_AND_MESSAGE', 400)
  const base = { protocolVersion: 1 as const, namespace: validateNamespace(value.namespace), owner: value.owner as 'work' | 'code', predecessor: predecessor(value.predecessor) }
  const bodyDigest = userAdmissionDigest(body, transport, base)
  if (bodyDigest !== value.bodyDigest) admissionError('ADMISSION_BODY_DIGEST_MISMATCH')
  const userMetadata: Record<string, unknown> = { ...(object(body.metadata) ? body.metadata : {}) }
  // Transcript presentation keeps only attachment labels. Never copy an
  // inline file payload or a caller's stale attachment field into this seed.
  delete userMetadata.attachments
  if (Array.isArray(body.attachments)) userMetadata.attachments = body.attachments.map(attachment => {
    if (!object(attachment) || typeof attachment.name !== 'string' || !attachment.name || attachment.type !== undefined && typeof attachment.type !== 'string') admissionError('INVALID_ADMISSION_ATTACHMENT', 400)
    return { name: attachment.name, ...(attachment.type !== undefined ? { type: attachment.type } : {}) }
  })
  const copy = JSON.parse(canonicalAdmissionBody({ userContent: body.message, userMetadata })) as Pick<PreparedUserAdmission, 'userContent' | 'userMetadata'>
  return { ...base, requestKey: value.requestKey, bodyDigest, sessionId: body.sessionId, ...copy }
}

export function ensureUserAdmissionSchema(db: Client): Promise<void> {
  let pending = schemas.get(db)
  if (!pending) {
    pending = (async () => {
      await db.executeMultiple(`CREATE TABLE IF NOT EXISTS engine_database_namespace (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), namespace_id TEXT NOT NULL, generation TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS user_root_admissions (
        tenant_id TEXT NOT NULL, session_id TEXT NOT NULL, request_key TEXT NOT NULL,
        namespace_id TEXT NOT NULL, generation TEXT NOT NULL, body_digest TEXT NOT NULL,
        root_run_id TEXT NOT NULL UNIQUE, receipt_json TEXT NOT NULL,
        PRIMARY KEY(tenant_id,session_id,request_key,namespace_id,generation));
        CREATE TABLE IF NOT EXISTS user_root_admission_seeds (
        tenant_id TEXT NOT NULL, session_id TEXT NOT NULL, root_run_id TEXT NOT NULL,
        user_message_id TEXT NOT NULL, assistant_message_id TEXT NOT NULL, seed_json TEXT NOT NULL,
        projected_at INTEGER, PRIMARY KEY(tenant_id,root_run_id));
        CREATE INDEX IF NOT EXISTS user_root_admission_outbox ON user_root_admission_seeds(tenant_id,session_id,projected_at);`)
      await db.execute({ sql: 'INSERT OR IGNORE INTO engine_database_namespace VALUES(1,?,?)', args: [randomUUID(), randomUUID()] })
      await readDatabaseNamespace(db)
    })().catch(error => { schemas.delete(db); throw error })
    schemas.set(db, pending)
  }
  return pending
}
export async function readDatabaseNamespace(query: Query): Promise<EngineDatabaseNamespace> {
  const row = (await query.execute('SELECT namespace_id,generation FROM engine_database_namespace WHERE singleton=1')).rows[0]
  if (!row || !identity(row.namespace_id) || !identity(row.generation)) admissionError('ENGINE_NAMESPACE_UNAVAILABLE', 503)
  return { id: row.namespace_id, generation: row.generation }
}
export async function assertDatabaseNamespace(query: Query, expected: EngineDatabaseNamespace): Promise<void> {
  const current = await readDatabaseNamespace(query)
  if (current.id !== expected.id || current.generation !== expected.generation) admissionError('ENGINE_NAMESPACE_CHANGED')
}
export async function lookupUserAdmission(query: Query, tenantId: string, sessionId: string, selector: Pick<UserAdmissionSelector, 'namespace' | 'requestKey' | 'bodyDigest'>): Promise<AdmissionReceiptLookup | null> {
  await assertDatabaseNamespace(query, selector.namespace)
  const row = (await query.execute({ sql: `SELECT a.body_digest,a.receipt_json,r.seq,r.state,s.user_message_id,s.assistant_message_id,s.seed_json FROM user_root_admissions a
    LEFT JOIN root_runs r ON r.tenant_id=a.tenant_id AND r.session_id=a.session_id AND r.run_id=a.root_run_id
    LEFT JOIN user_root_admission_seeds s ON s.tenant_id=a.tenant_id AND s.session_id=a.session_id AND s.root_run_id=a.root_run_id
    WHERE a.tenant_id=? AND a.session_id=? AND a.request_key=? AND a.namespace_id=? AND a.generation=?`,
    args: [tenantId, sessionId, selector.requestKey, selector.namespace.id, selector.namespace.generation] })).rows[0]
  if (!row) return null
  if (row.body_digest !== selector.bodyDigest) admissionError('ADMISSION_KEY_BODY_CONFLICT')
  let receipt: UserAdmissionReceipt, run: AdmissionReceiptLookup['run']
  try {
    receipt = JSON.parse(String(row.receipt_json)); run = { ...JSON.parse(String(row.state)), seq: Number(row.seq) }
    if (!object(receipt) || !object(receipt.namespace) || !object(run)) throw new Error('Invalid persisted admission')
  }
  catch { admissionError('ADMISSION_RECEIPT_UNAVAILABLE', 503) }
  try {
    predecessor(receipt.predecessor)
    if (!row.state || receipt.protocolVersion !== 1 || !['work', 'code'].includes(receipt.owner) || receipt.assistantIdentityKind !== 'admission-anchor'
      || !identity(receipt.attemptId) || !Number.isSafeInteger(receipt.rootVersion) || receipt.rootVersion < 1 || receipt.acceptedAt !== run.createdAt
      || receipt.requestKey !== selector.requestKey || receipt.bodyDigest !== selector.bodyDigest || receipt.namespace.id !== selector.namespace.id || receipt.namespace.generation !== selector.namespace.generation || receipt.sessionId !== sessionId || run.sessionId !== sessionId || run.runId !== receipt.rootRunId || run.turnId !== receipt.turnId || run.userMessageId !== receipt.userMessageId || row.user_message_id !== receipt.userMessageId || row.assistant_message_id !== receipt.assistantMessageId || !identity(run.attemptId) || run.seq !== receipt.rootSequence
      || typeof row.seed_json !== 'string' || createHash('sha256').update(row.seed_json).digest('hex') !== receipt.userSeedDigest
      || canonicalAdmissionBody(run.admissionReceipt) !== canonicalAdmissionBody(receipt)) throw new Error('Invalid persisted receipt')
  } catch { admissionError('ADMISSION_RECEIPT_UNAVAILABLE', 503) }
  return { receipt, run, attemptId: run.attemptId }
}
/** Latest root, private attempt and version are checked in the same physical admission transaction. */
export async function assertAdmissionPredecessor(query: Query, tenantId: string, admission: PreparedUserAdmission): Promise<void> {
  const row = (await query.execute({ sql: 'SELECT state FROM root_runs WHERE tenant_id=? AND session_id=? ORDER BY seq DESC LIMIT 1', args: [tenantId, admission.sessionId] })).rows[0]
  if (!row) { if (admission.predecessor) admissionError('ADMISSION_PREDECESSOR_CHANGED'); return }
  const run = JSON.parse(String(row.state)) as RootRun & { attemptId: string }
  const prior = admission.predecessor
  if (!prior || prior.runId !== run.runId || prior.attemptId !== run.attemptId || prior.version !== run.version) admissionError('ADMISSION_PREDECESSOR_CHANGED')
  if (!['succeeded', 'failed', 'cancelled', 'interrupted'].includes(run.status)) admissionError('ADMISSION_PREDECESSOR_NOT_TERMINAL')
}
export async function bindUserAdmission(tx: Transaction, tenantId: string, admission: PreparedUserAdmission, run: RootRun & { attemptId: string }): Promise<UserAdmissionReceipt> {
  const seed: Message & { conversationId: string } = { id: run.userMessageId, role: 'user', content: admission.userContent,
    createdAt: run.createdAt, conversationId: run.turnId, metadata: { ...admission.userMetadata, rootRunId: run.runId, turnId: run.turnId } }
  const seedJson = JSON.stringify(seed)
  const receipt: UserAdmissionReceipt = { protocolVersion: 1, namespace: admission.namespace, owner: admission.owner, requestKey: admission.requestKey,
    bodyDigest: admission.bodyDigest, predecessor: admission.predecessor, sessionId: run.sessionId, rootRunId: run.runId, turnId: run.turnId,
    userMessageId: run.userMessageId, assistantMessageId: run.assistantMessageId, assistantIdentityKind: 'admission-anchor', userSeedDigest: createHash('sha256').update(seedJson).digest('hex'), attemptId: run.attemptId, rootVersion: run.version, rootSequence: run.seq, acceptedAt: run.createdAt }
  await tx.execute({ sql: 'INSERT INTO user_root_admission_seeds VALUES(?,?,?,?,?,?,NULL)', args: [tenantId, run.sessionId, run.runId, run.userMessageId, run.assistantMessageId, seedJson] })
  await tx.execute({ sql: 'INSERT INTO user_root_admissions VALUES(?,?,?,?,?,?,?,?)', args: [tenantId, run.sessionId, admission.requestKey, admission.namespace.id, admission.namespace.generation, admission.bodyDigest, run.runId, JSON.stringify(receipt)] })
  return receipt
}
