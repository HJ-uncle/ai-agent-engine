import { createHash } from 'node:crypto'
import type { Client, Row, Transaction } from '@libsql/client'
import type { BrowserHostAuthority } from '../browser-authority.js'
import { browserAuthorityKey, snapshotBrowserAuthority } from '../browser-authority.js'
import { CollaborationError, type CollaborationBinding, type CollaborationRootScope } from './types.js'

type Query = Pick<Client, 'execute'> | Pick<Transaction, 'execute'>
export type ControllerAuthMethod = 'api-key' | 'jwt' | 'session' | 'local-instance'
export interface ControllerSubject { tenantId: string; key: string; kind: 'account' | 'instance'; method: ControllerAuthMethod }
export const controllerDigest = (value: string): string => createHash('sha256').update(value).digest('hex')
const scope = (b: CollaborationRootScope) => [b.tenantId, b.rootRunId, b.rootAttemptId]
const conflict = (message: string): never => { throw new CollaborationError('conflict', message) }
const prepared = new WeakMap<Client, Promise<void>>()

/** This ledger is separate from participants: a human controller is never a model producer. */
export function ensureControllerSchema(db: Client): Promise<void> {
  let pending = prepared.get(db)
  if (!pending) {
    pending = (async () => {
      await db.execute(`CREATE TABLE IF NOT EXISTS collaboration_controller_roots (
        tenant_id TEXT NOT NULL, root_run_id TEXT NOT NULL, root_attempt_id TEXT NOT NULL,
        root_session_id TEXT NOT NULL, generation TEXT NOT NULL, subject_key TEXT NOT NULL,
        subject_kind TEXT NOT NULL CHECK(subject_kind IN ('account','instance')), auth_method TEXT NOT NULL,
        PRIMARY KEY(tenant_id,root_run_id,root_attempt_id))`)
      await db.execute(`CREATE TABLE IF NOT EXISTS collaboration_controller_origins (
        tenant_id TEXT NOT NULL, root_run_id TEXT NOT NULL, root_attempt_id TEXT NOT NULL, message_id TEXT NOT NULL,
        subject_key TEXT NOT NULL, subject_kind TEXT NOT NULL CHECK(subject_kind IN ('account','instance')),
        auth_method TEXT NOT NULL, root_session_id TEXT NOT NULL, generation TEXT NOT NULL,
        sender_id TEXT NOT NULL, sender_invocation_id TEXT NOT NULL, request_key TEXT NOT NULL,
        recipient_participant_id TEXT NOT NULL, recipient_invocation_id TEXT NOT NULL,
        payload_hash TEXT NOT NULL, payload_bytes INTEGER NOT NULL, payload_body TEXT NOT NULL, accepted_at INTEGER NOT NULL,
        PRIMARY KEY(tenant_id,root_run_id,root_attempt_id,message_id),
        UNIQUE(tenant_id,root_run_id,root_attempt_id,subject_key,request_key))`)
      await db.execute(`CREATE INDEX IF NOT EXISTS collaboration_controller_target
        ON collaboration_controller_origins(tenant_id,recipient_invocation_id)`)
    })().catch(error => { prepared.delete(db); throw error })
    prepared.set(db, pending)
  }
  return pending
}

/** Inputs are frozen authenticated request state, never body or message metadata. */
export function controllerSubject(authority: BrowserHostAuthority, method: ControllerAuthMethod): ControllerSubject {
  const value = snapshotBrowserAuthority(authority)
  if (!value || value.kind === 'instance' && method !== 'local-instance'
    || value.kind === 'account' && !['api-key','jwt','session'].includes(method))
    throw new CollaborationError('forbidden', 'A trusted user controller identity is required')
  return Object.freeze({ tenantId: value.tenantId, key: controllerDigest(browserAuthorityKey(value)), kind: value.kind, method })
}
export const controllerSender = (subject: ControllerSubject): string => 'controller:' + subject.key
export const controllerInvocation = (b: CollaborationRootScope, subject: ControllerSubject): string =>
  'controllerinv:' + controllerDigest(JSON.stringify([...scope(b), subject.key]))

export async function assertControllerRoot(q: Query, b: CollaborationRootScope, subject: ControllerSubject): Promise<Row> {
  if (b.tenantId !== subject.tenantId) throw new CollaborationError('forbidden', 'Controller tenant does not own this scope')
  const row = (await q.execute({ sql: `SELECT * FROM collaboration_controller_roots
    WHERE tenant_id=? AND root_run_id=? AND root_attempt_id=? AND root_session_id=?`, args: [...scope(b), b.rootSessionId] })).rows[0]
  if (!row || row.subject_key !== subject.key || row.subject_kind !== subject.kind)
    throw new CollaborationError('forbidden', 'This user does not own the controller scope')
  return row
}

/** Only actual root admission calls this; inspection and sends never create authority. */
export async function registerControllerRoot(db: Client, b: CollaborationBinding, subject: ControllerSubject): Promise<void> {
  if (b.tenantId !== subject.tenantId || b.kind !== 'root') throw new CollaborationError('forbidden', 'Invalid controller root admission')
  await ensureControllerSchema(db)
  const tx = await db.transaction('write')
  try {
    const admitted = (await tx.execute({ sql: `SELECT c.generation,c.phase,r.session_id,r.turn_id,r.state
      FROM collaboration_roots c JOIN root_runs r ON r.tenant_id=c.tenant_id AND r.run_id=c.root_run_id
      WHERE c.tenant_id=? AND c.root_run_id=? AND c.root_attempt_id=? AND c.root_session_id=?`, args: [...scope(b), b.rootSessionId] })).rows[0]
    let current: {status?: string; attemptId?: string; sessionId?: string; turnId?: string} = {}
    try { current = JSON.parse(String(admitted?.state)) } catch { /* rejected by the exact admission checks below */ }
    if (!admitted || admitted.generation !== b.generation || admitted.phase !== 'open' || admitted.session_id !== b.rootSessionId
      || admitted.turn_id !== b.turnId || current.status !== 'running' || current.attemptId !== b.rootAttemptId
      || current.sessionId !== b.rootSessionId || current.turnId !== b.turnId)
      throw new CollaborationError('forbidden', 'Controller authority requires the actual current root admission')
    const previous = (await tx.execute({ sql: `SELECT subject_key,subject_kind,root_session_id FROM collaboration_controller_roots
      WHERE tenant_id=? AND root_run_id=? LIMIT 1`, args: [b.tenantId, b.rootRunId] })).rows[0]
    // A new verified local process may admit a fresh attempt. It cannot change
    // the old attempt's identity or use that identity to reconcile unknown mail.
    const freshLocal = previous?.subject_kind === 'instance' && subject.kind === 'instance'
    if (previous && ((!freshLocal && previous.subject_key !== subject.key) || previous.subject_kind !== subject.kind || previous.root_session_id !== b.rootSessionId))
      throw new CollaborationError('forbidden', 'A resumed root cannot change its user controller')
    await tx.execute({ sql: `INSERT OR IGNORE INTO collaboration_controller_roots VALUES(?,?,?,?,?,?,?,?)`,
      args: [...scope(b), b.rootSessionId, b.generation, subject.key, subject.kind, subject.method] })
    const existing = await assertControllerRoot(tx, b, subject)
    if (existing.generation !== b.generation) throw new CollaborationError('forbidden', 'Controller root generation changed')
    await tx.commit()
  } catch (error) { if (!tx.closed) await tx.rollback().catch(() => undefined); throw error }
  finally { tx.close() }
}

/** All source fields are checked against the independent SQL origin, not a readable prefix. */
export async function authenticatedControllerOrigin(q: Query, b: CollaborationRootScope, row: Row,
  recipientInvocationId?: string): Promise<Row | undefined> {
  const origin = (await q.execute({ sql: `SELECT o.*,r.subject_key AS root_subject_key,r.subject_kind AS root_subject_kind,
    r.root_session_id AS owned_root_session_id,r.generation AS owned_generation FROM collaboration_controller_origins o
    LEFT JOIN collaboration_controller_roots r ON r.tenant_id=o.tenant_id AND r.root_run_id=o.root_run_id AND r.root_attempt_id=o.root_attempt_id
    WHERE o.tenant_id=? AND o.root_run_id=? AND o.root_attempt_id=? AND o.message_id=?`, args: [...scope(b), row.message_id] })).rows[0]
  const controllerClaim = String(row.sender_participant_id).startsWith('controller:') || String(row.sender_invocation_run_id).startsWith('controllerinv:')
  if (!origin) { if (controllerClaim) conflict('Controller message has no authenticated user origin'); return undefined }
  if (!controllerClaim || origin.subject_key !== origin.root_subject_key || origin.subject_kind !== origin.root_subject_kind
    || origin.root_session_id !== b.rootSessionId || origin.root_session_id !== origin.owned_root_session_id
    || origin.generation !== origin.owned_generation || !['api-key','jwt','session','local-instance'].includes(String(origin.auth_method))
    || origin.subject_kind === 'instance' && origin.auth_method !== 'local-instance'
    || origin.subject_kind === 'account' && origin.auth_method === 'local-instance'
    || origin.sender_id !== 'controller:' + String(origin.subject_key)
    || origin.sender_invocation_id !== 'controllerinv:' + controllerDigest(JSON.stringify([...scope(b), origin.subject_key]))
    || origin.sender_id !== row.sender_participant_id || origin.sender_invocation_id !== row.sender_invocation_run_id
    || origin.request_key !== row.request_key || origin.recipient_participant_id !== row.recipient_participant_id
    || origin.payload_hash !== row.payload_hash || origin.payload_body !== row.body || Number(origin.payload_bytes) !== Number(row.payload_bytes)
    || Number(origin.accepted_at) !== Number(row.accepted_at) || controllerDigest(String(row.body)) !== row.payload_hash
    || Buffer.byteLength(String(row.body)) !== Number(row.payload_bytes)
    || recipientInvocationId !== undefined && origin.recipient_invocation_id !== recipientInvocationId)
    conflict('Controller message source no longer matches its accepted user provenance')
  return origin
}

/** Finish exact-invocation mail with the child, before its participant can continue. */
export async function interruptControllerInvocation(q: Query, child: { tenantId: string; runId: string; childSessionId: string }): Promise<void> {
  // A standalone/legacy SubagentStore may never have enabled collaboration.
  const enabled = (await q.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='collaboration_controller_origins'")).rows.length
  if (!enabled) return
  // The controller ledger can be prepared before the collaboration main tables.
  // Only this tenant's exact invocation can require terminal mail cleanup; an
  // unrelated origin must not break a standalone child or force feature setup.
  const relevant = await q.execute({ sql: `SELECT 1 FROM collaboration_controller_origins
    WHERE tenant_id=? AND recipient_invocation_id=? LIMIT 1`, args: [child.tenantId, child.runId] })
  if (!relevant.rows.length) return
  const pending = `o.tenant_id=? AND o.recipient_invocation_id=? AND m.state='queued'
    AND NOT EXISTS (SELECT 1 FROM collaboration_deliveries d WHERE d.tenant_id=m.tenant_id
      AND d.root_run_id=m.root_run_id AND d.root_attempt_id=m.root_attempt_id AND d.message_id=m.message_id)
    AND NOT EXISTS (SELECT 1 FROM collaboration_jsonl_deliveries d WHERE d.tenant_id=m.tenant_id
      AND d.root_run_id=m.root_run_id AND d.root_attempt_id=m.root_attempt_id AND d.message_id=m.message_id AND d.state IN ('integrated','suppressed'))`
  const joined = `FROM collaboration_controller_origins o JOIN collaboration_messages m ON m.tenant_id=o.tenant_id
    AND m.root_run_id=o.root_run_id AND m.root_attempt_id=o.root_attempt_id AND m.message_id=o.message_id
    LEFT JOIN collaboration_controller_roots r ON r.tenant_id=o.tenant_id AND r.root_run_id=o.root_run_id AND r.root_attempt_id=o.root_attempt_id`
  const invalid = await q.execute({ sql: `SELECT 1 ${joined} WHERE ${pending} AND (
    r.subject_key IS NULL OR o.subject_key IS NOT r.subject_key OR o.subject_kind IS NOT r.subject_kind
    OR o.root_session_id IS NOT r.root_session_id OR o.generation IS NOT r.generation
    OR o.sender_id IS NOT m.sender_participant_id OR o.sender_invocation_id IS NOT m.sender_invocation_run_id
    OR o.sender_id IS NOT 'controller:'||o.subject_key OR substr(o.sender_invocation_id,1,14)<>'controllerinv:'
    OR o.request_key IS NOT m.request_key OR o.recipient_participant_id IS NOT m.recipient_participant_id
    OR o.recipient_participant_id IS NOT ? OR o.payload_hash IS NOT m.payload_hash OR o.payload_bytes IS NOT m.payload_bytes
    OR o.payload_body IS NOT m.body OR o.accepted_at IS NOT m.accepted_at
    OR o.auth_method NOT IN ('api-key','jwt','session','local-instance')
    OR o.subject_kind='instance' AND o.auth_method<>'local-instance' OR o.subject_kind='account' AND o.auth_method='local-instance') LIMIT 1`,
    args: [child.tenantId, child.runId, 'child:' + child.childSessionId] })
  if (invalid.rows.length) conflict('Unconsumed controller mail lost its exact authenticated invocation source')
  // An interrupted receipt remains queryable with its original identity/body.
  // A pending JSONL file reservation may already have physical bytes; retain
  // and suppress that origin instead of letting those bytes become human input.
  await q.execute({ sql: `UPDATE collaboration_messages SET state='interrupted',reason='target_invocation_finished_before_consumption'
    WHERE (tenant_id,root_run_id,root_attempt_id,message_id) IN (SELECT m.tenant_id,m.root_run_id,m.root_attempt_id,m.message_id ${joined}
      WHERE ${pending} AND EXISTS (SELECT 1 FROM subagent_runs s WHERE s.tenant_id=o.tenant_id AND s.run_id=o.recipient_invocation_id
        AND s.child_session_id=? AND s.status IN ('succeeded','failed','cancelled','blocked','interrupted')))`,
    args: [child.tenantId, child.runId, child.childSessionId] })
  await q.execute({ sql: `UPDATE collaboration_jsonl_deliveries SET state='suppressed',reason='target_invocation_finished_before_consumption'
    WHERE state='pending' AND recipient_invocation_run_id=? AND (tenant_id,root_run_id,root_attempt_id,message_id) IN (
      SELECT m.tenant_id,m.root_run_id,m.root_attempt_id,m.message_id ${joined} WHERE o.tenant_id=? AND o.recipient_invocation_id=?
        AND m.state='interrupted' AND m.reason='target_invocation_finished_before_consumption')`, args: [child.runId, child.tenantId, child.runId] })
}

export function collaborationEnvelope(b: CollaborationBinding, row: Row, origin?: Row): {
  historyMessageId: string; content: string; metadata: { collaborationDelivery: {
    version: number; messageId: string; rootRunId: string; recipientInvocationRunId: string; source?: 'user-controller' } }
} {
  const historyMessageId = (origin ? 'controller:' : 'peer:') + controllerDigest(JSON.stringify([...scope(b), row.message_id]))
  const content = origin ? '[用户追加指令]\n' + JSON.stringify({ source: 'authenticated-user-controller', messageId: String(row.message_id) }) + '\n\n' + String(row.body)
    : '[对等 Agent 消息]\n' + JSON.stringify({ sender: String(row.sender_participant_id), invocation: String(row.sender_invocation_run_id), messageId: String(row.message_id) }) + '\n\n' + String(row.body)
  return { historyMessageId, content, metadata: { collaborationDelivery: { version: 1, messageId: String(row.message_id),
    rootRunId: b.rootRunId, recipientInvocationRunId: b.invocationRunId, ...(origin ? { source: 'user-controller' as const } : {}) } } }
}

/** Projection reads revalidate SQL provenance as well as the physical history receipt. */
export async function assertControllerDeliveryOrigins(q: Query, history: { tenantId: string; sessionId: string }, backend: 'sqlite' | 'jsonl'): Promise<void> {
  const table = backend === 'sqlite' ? 'collaboration_deliveries' : 'collaboration_jsonl_deliveries'
  const hasController = await q.execute({ sql: `SELECT 1 FROM ${table} d WHERE d.tenant_id=? AND d.history_session_id=? AND d.state='integrated'
    AND (substr(d.history_message_id,1,11)='controller:' OR EXISTS (SELECT 1 FROM collaboration_controller_origins o
      WHERE o.tenant_id=d.tenant_id AND o.root_run_id=d.root_run_id AND o.root_attempt_id=d.root_attempt_id AND o.message_id=d.message_id)) LIMIT 1`,
    args: [history.tenantId, history.sessionId] })
  if (!hasController.rows.length) return
  // Compare large bodies inside SQLite. Normal history reads must not fetch one
  // duplicate body per historical controller message or add N round trips.
  const bad = await q.execute({ sql: `SELECT 1 FROM ${table} d
    LEFT JOIN collaboration_messages m ON m.tenant_id=d.tenant_id AND m.root_run_id=d.root_run_id
      AND m.root_attempt_id=d.root_attempt_id AND m.message_id=d.message_id
    LEFT JOIN collaboration_controller_origins o ON o.tenant_id=d.tenant_id AND o.root_run_id=d.root_run_id
      AND o.root_attempt_id=d.root_attempt_id AND o.message_id=d.message_id
    LEFT JOIN collaboration_controller_roots r ON r.tenant_id=d.tenant_id AND r.root_run_id=d.root_run_id AND r.root_attempt_id=d.root_attempt_id
    WHERE d.tenant_id=? AND d.history_session_id=? AND d.state='integrated'
      AND (o.message_id IS NOT NULL OR substr(m.sender_participant_id,1,11)='controller:'
        OR substr(m.sender_invocation_run_id,1,14)='controllerinv:' OR substr(d.history_message_id,1,11)='controller:')
      AND (o.message_id IS NULL OR m.message_id IS NULL OR r.subject_key IS NULL
        OR o.subject_key IS NOT r.subject_key OR o.subject_kind IS NOT r.subject_kind
        OR o.root_session_id IS NOT r.root_session_id OR o.generation IS NOT r.generation
        OR o.sender_id IS NOT m.sender_participant_id OR o.sender_invocation_id IS NOT m.sender_invocation_run_id
        OR o.sender_id IS NOT 'controller:'||o.subject_key OR substr(o.sender_invocation_id,1,14)<>'controllerinv:'
        OR o.request_key IS NOT m.request_key OR o.recipient_participant_id IS NOT m.recipient_participant_id
        OR o.recipient_invocation_id IS NOT d.recipient_invocation_run_id OR o.payload_hash IS NOT m.payload_hash
        OR o.payload_bytes IS NOT m.payload_bytes OR o.payload_body IS NOT m.body OR o.accepted_at IS NOT m.accepted_at
        OR o.auth_method NOT IN ('api-key','jwt','session','local-instance')
        OR o.subject_kind='instance' AND o.auth_method<>'local-instance' OR o.subject_kind='account' AND o.auth_method='local-instance'
        OR substr(d.history_message_id,1,11)<>'controller:') LIMIT 1`, args: [history.tenantId, history.sessionId] })
  if (bad.rows.length) conflict('An integrated controller delivery lost its authenticated user provenance')
}
