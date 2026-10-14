import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import type { Client, Transaction } from '@libsql/client'
import type { CreateSubagentRun, SubagentRunHeader } from '../subagent/types.js'
import { ensureCollaborationSchema } from './schema.js'
import { ensureSQLiteDeliverySchema } from './delivery-schema.js'
import { ensureJSONLDeliverySchema } from './jsonl-delivery-schema.js'
import { CollaborationError, type CollaborationBinding, type CollaborationPage, type CollaborationParticipant,
  type CollaborationPhase, type CollaborationReceipt, type CollaborationRootScope } from './types.js'

type Query = Pick<Client, 'execute'> | Pick<Transaction, 'execute'>
const writeTails = new WeakMap<Client, Promise<unknown>>()
const payloadLimit = 32 * 1024
const backlogLimit = 1024
const pendingDeliverySql = ` AND NOT EXISTS (SELECT 1 FROM collaboration_deliveries d
  WHERE d.tenant_id=collaboration_messages.tenant_id AND d.root_run_id=collaboration_messages.root_run_id
    AND d.root_attempt_id=collaboration_messages.root_attempt_id AND d.message_id=collaboration_messages.message_id)
  AND NOT EXISTS (SELECT 1 FROM collaboration_jsonl_deliveries d WHERE d.tenant_id=collaboration_messages.tenant_id
    AND d.root_run_id=collaboration_messages.root_run_id AND d.root_attempt_id=collaboration_messages.root_attempt_id
    AND d.message_id=collaboration_messages.message_id)`
/** Object key order and omitted undefined fields cannot change retry identity. */
export function admissionFingerprint(input: CreateSubagentRun): string {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value
  return createHash('sha256').update(JSON.stringify(canonical(input))).digest('hex')
}
const scopeArgs = (scope: CollaborationRootScope) => [scope.tenantId, scope.rootRunId, scope.rootAttemptId]
export const rootInvocationId = (rootRunId: string, rootAttemptId: string): string =>
  'rootinv:' + createHash('sha256').update(JSON.stringify([rootRunId, rootAttemptId])).digest('hex')
const fail = (code: ConstructorParameters<typeof CollaborationError>[0], message: string): never => { throw new CollaborationError(code, message) }
function id(value: string, name: string): string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > 256 || /[\x00-\x1f\x7f]/.test(value)) fail('invalid', `Invalid ${name}`)
  return value
}
function limit(value = 64): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 64) fail('invalid', 'Invalid page size')
  return value
}
function receipt(row: Record<string, unknown>): CollaborationReceipt {
  return { messageId: String(row.message_id), rootRunId: String(row.root_run_id), rootAttemptId: String(row.root_attempt_id),
    senderParticipantId: String(row.sender_participant_id), senderInvocationRunId: String(row.sender_invocation_run_id),
    recipientParticipantId: String(row.recipient_participant_id), requestKey: String(row.request_key), payloadHash: String(row.payload_hash),
    payloadBytes: Number(row.payload_bytes), acceptedSeq: Number(row.seq), acceptedAt: Number(row.accepted_at),
    state: row.state as CollaborationReceipt['state'], ...(row.reason === null || row.reason === undefined ? {} : { reason: String(row.reason) }) }
}
interface RootRow { root_session_id: string; turn_id: string; generation: string; phase: CollaborationPhase }
interface Cursor { version: 1; scope: string; revision: number; after: number }

/** SQLite queue/receipts only. No consumer, model execution or automatic recovery is implied. */
export class CollaborationStore {
  constructor(readonly db: Client) {}
  async prepare(): Promise<void> { await ensureCollaborationSchema(this.db); await ensureSQLiteDeliverySchema(this.db); await ensureJSONLDeliverySchema(this.db) }

  async resolveRootAdmission(tenantId: string, rootRunId: string, rootAttemptId: string): Promise<{ rootSessionId: string; turnId: string }> {
    id(tenantId, 'tenantId'); id(rootRunId, 'rootRunId'); id(rootAttemptId, 'rootAttemptId')
    await this.prepare()
    const result = await this.db.execute({ sql: 'SELECT session_id,turn_id,state FROM root_runs WHERE tenant_id=? AND run_id=?', args: [tenantId, rootRunId] })
    if (!result.rows[0]) fail('forbidden', 'Root producer is not admitted')
    const state = JSON.parse(String(result.rows[0].state)) as { status?: string; attemptId?: string }
    if (state.status !== 'running' || state.attemptId !== rootAttemptId) fail('forbidden', 'Root producer is stale or inactive')
    return { rootSessionId: String(result.rows[0].session_id), turnId: String(result.rows[0].turn_id) }
  }

  private async write<T>(operation: (tx: Transaction) => Promise<T>): Promise<T> {
    await this.prepare()
    const previous = writeTails.get(this.db) ?? Promise.resolve()
    const pending = previous.catch(() => undefined).then(async () => {
      const tx = await this.db.transaction('write')
      let committed = false
      try {
        const result = await operation(tx)
        await tx.commit()
        committed = true
        return result
      } catch (error) {
        // A failed commit can have an unknown outcome. Preserve that error;
        // retry/query the same operation key instead of claiming rollback won.
        if (!committed && !tx.closed) await tx.rollback().catch(() => undefined)
        throw error
      } finally { tx.close() }
    })
    writeTails.set(this.db, pending.catch(() => undefined))
    return pending
  }

  private async read<T>(operation: (tx: Transaction) => Promise<T>): Promise<T> {
    await this.prepare()
    const tx = await this.db.transaction('read')
    try { return await operation(tx) } finally { if (!tx.closed) await tx.rollback(); tx.close() }
  }

  private async root(q: Query, scope: CollaborationRootScope): Promise<RootRow> {
    for (const [name, value] of Object.entries(scope)) id(value, name)
    const result = await q.execute({ sql: `SELECT root_session_id,turn_id,generation,phase FROM collaboration_roots
      WHERE tenant_id=? AND root_run_id=? AND root_attempt_id=? AND root_session_id=?`, args: [...scopeArgs(scope), scope.rootSessionId] })
    if (!result.rows[0]) fail('not_found', 'Collaboration root not found')
    return result.rows[0] as unknown as RootRow
  }

  private async assertRootExecution(q: Query, binding: Pick<CollaborationBinding, 'tenantId' | 'rootRunId' | 'rootAttemptId' | 'rootSessionId' | 'turnId'>): Promise<void> {
    const result = await q.execute({ sql: 'SELECT session_id,turn_id,state FROM root_runs WHERE tenant_id=? AND run_id=?', args: [binding.tenantId, binding.rootRunId] })
    const row = result.rows[0]
    if (!row) fail('forbidden', 'Root producer is not admitted')
    const state = JSON.parse(String(row.state)) as { status?: string; attemptId?: string; sessionId?: string; turnId?: string }
    if (row.session_id !== binding.rootSessionId || row.turn_id !== binding.turnId || state.sessionId !== binding.rootSessionId
      || state.turnId !== binding.turnId || state.attemptId !== binding.rootAttemptId || state.status !== 'running') fail('forbidden', 'Root producer is stale or inactive')
  }

  async openRoot(binding: CollaborationBinding): Promise<void> {
    if (binding.kind !== 'root' || binding.sessionId !== binding.rootSessionId || binding.invocationRunId !== rootInvocationId(binding.rootRunId, binding.rootAttemptId)) fail('invalid', 'Invalid root binding')
    for (const [name, value] of Object.entries(binding)) id(value, name)
    await this.write(async tx => {
      await this.assertRootExecution(tx, binding)
      const existing = await tx.execute({ sql: 'SELECT generation,phase,root_session_id,turn_id FROM collaboration_roots WHERE tenant_id=? AND root_run_id=? AND root_attempt_id=?', args: scopeArgs(binding) })
      if (existing.rows[0]) {
        const row = existing.rows[0]
        if (row.generation !== binding.generation || row.phase !== 'open' || row.root_session_id !== binding.rootSessionId || row.turn_id !== binding.turnId) fail('conflict', 'Collaboration producer already belongs to another generation')
        return
      }
      const now = Date.now()
      // A tool-response resume changes the private attempt while retaining
      // rootRun/turn identity. Its old attempt must not masquerade as active.
      await tx.execute({ sql: "UPDATE collaboration_roots SET phase='interrupted',updated_at=? WHERE tenant_id=? AND root_run_id=? AND root_attempt_id<>? AND phase IN ('open','draining')", args: [now, binding.tenantId, binding.rootRunId, binding.rootAttemptId] })
      await tx.execute({ sql: "UPDATE collaboration_messages SET state='interrupted',reason='root_attempt_superseded' WHERE tenant_id=? AND root_run_id=? AND root_attempt_id<>? AND state='queued'" + pendingDeliverySql, args: [binding.tenantId, binding.rootRunId, binding.rootAttemptId] })
      await tx.execute({ sql: 'INSERT INTO collaboration_roots VALUES (?,?,?,?,?,?,?,?,?)', args: [...scopeArgs(binding), binding.rootSessionId, binding.turnId, binding.generation, 'open', now, now] })
      await tx.execute({ sql: `INSERT INTO collaboration_participants(tenant_id,root_run_id,root_attempt_id,participant_id,kind,session_id,invocation_run_id,admitted_at)
        VALUES (?,?,?,?,?,?,?,?)`, args: [...scopeArgs(binding), binding.participantId, 'root', binding.sessionId, binding.invocationRunId, now] })
      await tx.execute({ sql: `INSERT INTO collaboration_invocations(tenant_id,root_run_id,root_attempt_id,participant_id,invocation_run_id,admitted_at)
        VALUES (?,?,?,?,?,?)`, args: [...scopeArgs(binding), binding.participantId, binding.invocationRunId, now] })
    })
  }
  async lookupRootAdmissionReceipt(binding: CollaborationBinding): Promise<boolean> {
    return this.read(async tx => {
      const result = await tx.execute({ sql: 'SELECT root_session_id,turn_id,generation,phase FROM collaboration_roots WHERE tenant_id=? AND root_run_id=? AND root_attempt_id=?', args: scopeArgs(binding) })
      if (!result.rows[0]) return false
      const row = result.rows[0]
      if (row.generation !== binding.generation || row.root_session_id !== binding.rootSessionId || row.turn_id !== binding.turnId || row.phase !== 'open') fail('conflict', 'Root admission receipt changed authority')
      await this.assertRootExecution(tx, binding)
      return true
    })
  }

  async assertProducer(q: Query, binding: CollaborationBinding, admit = false): Promise<RootRow> {
    const root = await this.root(q, binding)
    if (root.generation !== binding.generation) fail('forbidden', 'Producer generation does not own this root')
    if (root.phase !== 'open' && !(root.phase === 'draining' && !admit)) fail('closed', 'Collaboration root is not accepting this operation')
    await this.assertRootExecution(q, binding)
    const found = await q.execute({ sql: `SELECT p.kind,p.session_id FROM collaboration_participants p JOIN collaboration_invocations i
      ON i.tenant_id=p.tenant_id AND i.root_run_id=p.root_run_id AND i.root_attempt_id=p.root_attempt_id AND i.participant_id=p.participant_id
      WHERE p.tenant_id=? AND p.root_run_id=? AND p.root_attempt_id=? AND p.participant_id=? AND i.invocation_run_id=?`,
      args: [...scopeArgs(binding), binding.participantId, binding.invocationRunId] })
    if (!found.rows[0] || found.rows[0].session_id !== binding.sessionId || found.rows[0].kind !== binding.kind) fail('forbidden', 'Producer membership does not match')
    if (binding.kind === 'child') {
      const active = await q.execute({ sql: 'SELECT status,child_session_id FROM subagent_runs WHERE tenant_id=? AND run_id=?', args: [binding.tenantId, binding.invocationRunId] })
      if (!active.rows[0] || active.rows[0].child_session_id !== binding.sessionId || !['queued', 'running'].includes(String(active.rows[0].status))) fail('closed', 'Child invocation is not active')
    }
    return root
  }

  /** Called inside the exact SubagentStore child-admission transaction. */
  async admitChild(tx: Transaction, parent: CollaborationBinding, header: SubagentRunHeader, admission: Readonly<{ created: boolean }>, fingerprint?: string): Promise<CollaborationBinding> {
    await this.assertProducer(tx, parent, true)
    if (header.tenantId !== parent.tenantId || header.rootSessionId !== parent.rootSessionId || header.parentSessionId !== parent.sessionId
      || header.parentConversationId !== parent.turnId) fail('forbidden', 'Child admission does not belong to this producer')
    id(header.runId, 'runId'); id(header.childSessionId, 'childSessionId')
    const child: CollaborationBinding = { ...parent, kind: 'child', participantId: `child:${header.childSessionId}`, sessionId: header.childSessionId, invocationRunId: header.runId }
    id(child.participantId, 'participantId')
    const existing = await tx.execute({ sql: 'SELECT root_run_id,root_attempt_id,participant_id,admission_fingerprint FROM collaboration_invocations WHERE tenant_id=? AND invocation_run_id=?', args: [child.tenantId, child.invocationRunId] })
    if (existing.rows[0]) {
      const row = existing.rows[0]
      if (row.root_run_id !== child.rootRunId || row.root_attempt_id !== child.rootAttemptId || row.participant_id !== child.participantId) fail('conflict', 'Child invocation already belongs to another root')
      if (!fingerprint || row.admission_fingerprint !== fingerprint) fail('conflict', 'Child dispatch payload changed or has no trusted admission fingerprint')
      return child
    }
    if (!admission.created) fail('forbidden', 'A legacy invocation without durable membership cannot be annexed')
    if (!['queued', 'running'].includes(header.status)) fail('forbidden', 'A legacy terminal child cannot become a new active producer')
    const peer = await tx.execute({ sql: 'SELECT session_id,parent_participant_id,kind FROM collaboration_participants WHERE tenant_id=? AND root_run_id=? AND root_attempt_id=? AND participant_id=?', args: [...scopeArgs(child), child.participantId] })
    if (peer.rows[0] && (peer.rows[0].session_id !== child.sessionId || peer.rows[0].parent_participant_id !== parent.participantId || peer.rows[0].kind !== 'child')) fail('conflict', 'Child participant identity cannot change')
    const now = Date.now()
    if (!peer.rows[0]) await tx.execute({ sql: `INSERT INTO collaboration_participants(tenant_id,root_run_id,root_attempt_id,participant_id,parent_participant_id,kind,session_id,invocation_run_id,admitted_at)
      VALUES (?,?,?,?,?,?,?,?,?)`, args: [...scopeArgs(child), child.participantId, parent.participantId, 'child', child.sessionId, child.invocationRunId, now] })
    await tx.execute({ sql: `INSERT INTO collaboration_invocations(tenant_id,root_run_id,root_attempt_id,participant_id,invocation_run_id,admitted_at,admission_fingerprint)
      VALUES (?,?,?,?,?,?,?)`, args: [...scopeArgs(child), child.participantId, child.invocationRunId, now, fingerprint ?? null] })
    return child
  }

  /** Lost admission ACK reconciliation is read-only, including after drain. */
  async lookupChildAdmissionReceipt(parent: CollaborationBinding, input: CreateSubagentRun): Promise<CollaborationBinding | null> {
    return this.read(async tx => {
      const root = await this.root(tx, parent)
      if (root.generation !== parent.generation) fail('forbidden', 'Producer generation changed')
      const found = await tx.execute({ sql: `SELECT i.*,r.child_session_id FROM collaboration_invocations i JOIN subagent_runs r
        ON r.tenant_id=i.tenant_id AND r.run_id=i.invocation_run_id
        WHERE i.tenant_id=? AND i.root_run_id=? AND i.root_attempt_id=? AND r.parent_session_id=? AND r.parent_tool_call_id=?`,
        args: [...scopeArgs(parent), input.parentSessionId, input.parentToolCallId] })
      const row = found.rows[0]
      if (!row) return null
      if (!row.admission_fingerprint || row.admission_fingerprint !== admissionFingerprint(input)) fail('conflict', 'Admission receipt payload differs')
      return { ...parent, kind: 'child', participantId: String(row.participant_id), sessionId: String(row.child_session_id), invocationRunId: String(row.invocation_run_id) }
    })
  }

  async executionInvocations(binding: CollaborationBinding): Promise<Array<{ runId: string; seq: number; terminal: boolean }>> {
    const result = await this.db.execute({ sql: `SELECT i.invocation_run_id,r.seq,r.status FROM collaboration_invocations i
      JOIN subagent_runs r ON r.tenant_id=i.tenant_id AND r.run_id=i.invocation_run_id
      WHERE i.tenant_id=? AND i.root_run_id=? AND i.root_attempt_id=?`, args: scopeArgs(binding) })
    return result.rows.map(row => ({ runId: String(row.invocation_run_id), seq: Number(row.seq), terminal: ['succeeded','failed','cancelled','blocked','interrupted'].includes(String(row.status)) }))
  }

  /** RootRunStore calls this in its exact root/Cron terminal transaction. */
  async closeSettledRoot(tx: Transaction, binding: CollaborationBinding): Promise<void> {
    const root = await this.root(tx, binding)
    if (binding.kind !== 'root' || root.generation !== binding.generation || root.phase !== 'draining') fail('forbidden', 'Settlement must own the draining attempt')
    await this.assertRootExecution(tx, binding)
    const active = await tx.execute({ sql: `SELECT 1 FROM collaboration_invocations i JOIN subagent_runs r ON r.tenant_id=i.tenant_id AND r.run_id=i.invocation_run_id
      WHERE i.tenant_id=? AND i.root_run_id=? AND i.root_attempt_id=? AND r.status IN ('queued','running','cancelling') LIMIT 1`, args: scopeArgs(binding) })
    if (active.rows.length) fail('conflict', 'Children are not terminal')
    await tx.execute({ sql: "UPDATE collaboration_roots SET phase='closed',updated_at=? WHERE tenant_id=? AND root_run_id=? AND root_attempt_id=?", args: [Date.now(), ...scopeArgs(binding)] })
    await tx.execute({ sql: "UPDATE collaboration_messages SET state='rejected',reason='root_closed_without_consumer' WHERE tenant_id=? AND root_run_id=? AND root_attempt_id=? AND state='queued'" + pendingDeliverySql, args: scopeArgs(binding) })
  }

  async send(binding: CollaborationBinding, target: string, body: string, requestKey: string): Promise<CollaborationReceipt> {
    id(target, 'recipientParticipantId'); id(requestKey, 'requestKey')
    if (typeof body !== 'string' || !body.length) fail('invalid', 'Message body must not be empty')
    const bytes = Buffer.byteLength(body, 'utf8')
    if (bytes > payloadLimit) fail('too_large', 'Message exceeds the 32 KiB queue limit')
    const payloadHash = createHash('sha256').update(body).digest('hex')
    return this.write(async tx => {
      // A retry may read its prior durable receipt after closure, but never
      // creates a fresh message through a stale/closed producer.
      const root = await this.root(tx, binding)
      if (root.generation !== binding.generation) fail('forbidden', 'Producer generation does not own this root')
      const prior = await tx.execute({ sql: `SELECT * FROM collaboration_messages WHERE tenant_id=? AND root_run_id=? AND root_attempt_id=?
        AND sender_participant_id=? AND sender_invocation_run_id=? AND request_key=?`, args: [...scopeArgs(binding), binding.participantId, binding.invocationRunId, requestKey] })
      if (prior.rows[0]) {
        if (prior.rows[0].recipient_participant_id !== target || prior.rows[0].payload_hash !== payloadHash || prior.rows[0].body !== body) fail('conflict', 'Request key was already accepted differently')
        return receipt(prior.rows[0])
      }
      await this.assertProducer(tx, binding)
      const recipient = await tx.execute({ sql: 'SELECT kind FROM collaboration_participants WHERE tenant_id=? AND root_run_id=? AND root_attempt_id=? AND participant_id=?', args: [...scopeArgs(binding), target] })
      if (!recipient.rows[0]) fail('not_found', 'Recipient is not a participant of this root')
      if (root.phase === 'draining' && recipient.rows[0].kind === 'root') fail('closed', 'Root model has ended; message would not be integrated')
      const count = await tx.execute({ sql: `SELECT count(*) AS count FROM collaboration_messages m WHERE tenant_id=? AND root_run_id=? AND root_attempt_id=? AND recipient_participant_id=? AND state='queued'
        AND NOT EXISTS (SELECT 1 FROM collaboration_deliveries d WHERE d.tenant_id=m.tenant_id AND d.root_run_id=m.root_run_id
          AND d.root_attempt_id=m.root_attempt_id AND d.message_id=m.message_id)
        AND NOT EXISTS (SELECT 1 FROM collaboration_jsonl_deliveries d WHERE d.tenant_id=m.tenant_id AND d.root_run_id=m.root_run_id
          AND d.root_attempt_id=m.root_attempt_id AND d.message_id=m.message_id AND d.state IN ('integrated','suppressed'))`, args: [...scopeArgs(binding), target] })
      if (Number(count.rows[0].count) >= backlogLimit) fail('full', 'Recipient queue is full; no message was accepted')
      const inserted = await tx.execute({ sql: `INSERT INTO collaboration_messages(tenant_id,root_run_id,root_attempt_id,message_id,sender_participant_id,sender_invocation_run_id,recipient_participant_id,request_key,payload_hash,payload_bytes,body,accepted_at,state)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING *`, args: [...scopeArgs(binding), randomUUID(), binding.participantId, binding.invocationRunId, target, requestKey, payloadHash, bytes, body, Date.now(), 'queued'] })
      return receipt(inserted.rows[0])
    })
  }

  async findReceipt(scope: CollaborationRootScope, messageId: string): Promise<CollaborationReceipt | null> {
    id(messageId, 'messageId')
    return this.read(async tx => {
      await this.root(tx, scope)
      const result = await tx.execute({ sql: 'SELECT * FROM collaboration_messages WHERE tenant_id=? AND root_run_id=? AND root_attempt_id=? AND message_id=?', args: [...scopeArgs(scope), messageId] })
      return result.rows[0] ? receipt(result.rows[0]) : null
    })
  }

  async findReceiptByKey(binding: CollaborationBinding, requestKey: string): Promise<CollaborationReceipt | null> {
    id(requestKey, 'requestKey')
    return this.read(async tx => {
      const root = await this.root(tx, binding)
      if (root.generation !== binding.generation) fail('forbidden', 'Producer generation does not own this root')
      const result = await tx.execute({ sql: `SELECT * FROM collaboration_messages WHERE tenant_id=? AND root_run_id=? AND root_attempt_id=? AND sender_participant_id=? AND sender_invocation_run_id=? AND request_key=?`, args: [...scopeArgs(binding), binding.participantId, binding.invocationRunId, requestKey] })
      return result.rows[0] ? receipt(result.rows[0]) : null
    })
  }

  private sign(key: Buffer, body: string): Buffer { return createHmac('sha256', key).update(body).digest() }
  private cursor(key: Buffer, value: Cursor): string {
    const encoded = Buffer.from(JSON.stringify(value)).toString('base64url')
    return `${encoded}.${this.sign(key, encoded).toString('base64url')}`
  }
  private decode(key: Buffer, raw: string | undefined, scope: string): Cursor | undefined {
    if (raw === undefined) return undefined
    if (typeof raw !== 'string' || raw.length > 4096 || !/^[\w-]+\.[\w-]+$/.test(raw)) fail('invalid', 'Invalid collaboration cursor')
    const [encoded, signature] = raw.split('.')
    const expected = this.sign(key, encoded), actual = Buffer.from(signature, 'base64url')
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) fail('invalid', 'Cursor signature does not match')
    let value: Cursor
    try { value = JSON.parse(Buffer.from(encoded, 'base64url').toString()) as Cursor } catch { return fail('invalid', 'Invalid collaboration cursor') }
    if (value.version !== 1 || value.scope !== scope || !Number.isSafeInteger(value.revision) || value.revision < 0
      || !Number.isSafeInteger(value.after) || value.after < 0 || value.after > value.revision) fail('invalid', 'Cursor scope or revision does not match')
    return value
  }

  async participants(scope: CollaborationRootScope, options: { cursor?: string; limit?: number } = {}): Promise<CollaborationPage<CollaborationParticipant>> {
    const size = limit(options.limit)
    // Create the signing key outside read transactions, so reads never request
    // a write lock or introduce startup/recovery side effects.
    return this.read(async tx => {
      await this.root(tx, scope)
      const key = await this.keyRead(tx)
      const fingerprint = createHash('sha256').update(JSON.stringify(['participants', ...scopeArgs(scope), scope.rootSessionId])).digest('hex')
      const cursor = this.decode(key, options.cursor, fingerprint)
      const max = await tx.execute({ sql: 'SELECT coalesce(max(seq),0) AS revision FROM collaboration_participants WHERE tenant_id=? AND root_run_id=? AND root_attempt_id=?', args: scopeArgs(scope) })
      const revision = cursor?.revision ?? Number(max.rows[0].revision)
      const result = await tx.execute({ sql: `SELECT * FROM collaboration_participants WHERE tenant_id=? AND root_run_id=? AND root_attempt_id=? AND seq>? AND seq<=? ORDER BY seq LIMIT ?`, args: [...scopeArgs(scope), cursor?.after ?? 0, revision, size + 1] })
      const entries = result.rows.slice(0, size).map(row => ({ participantId: String(row.participant_id),
        ...(row.parent_participant_id === null ? {} : { parentParticipantId: String(row.parent_participant_id) }),
        kind: row.kind as CollaborationParticipant['kind'], sessionId: String(row.session_id), invocationRunId: String(row.invocation_run_id), admittedSeq: Number(row.seq), admittedAt: Number(row.admitted_at) }))
      const hasMore = result.rows.length > size
      return { entries, revision, hasMore, ...(hasMore ? { nextCursor: this.cursor(key, { version: 1, scope: fingerprint, revision, after: entries.at(-1)!.admittedSeq }) } : {}) }
    })
  }

  private async keyRead(q: Query): Promise<Buffer> {
    const result = await q.execute("SELECT value FROM collaboration_metadata WHERE key='cursor-signing-key'")
    if (!result.rows[0]) fail('conflict', 'Cursor key has not been prepared')
    return Buffer.from(String(result.rows[0].value), 'hex')
  }

  async receipts(scope: CollaborationRootScope, participantId: string, options: { cursor?: string; limit?: number } = {}): Promise<CollaborationPage<CollaborationReceipt>> {
    id(participantId, 'participantId'); const size = limit(options.limit)
    return this.read(async tx => {
      await this.root(tx, scope)
      const member = await tx.execute({ sql: 'SELECT 1 FROM collaboration_participants WHERE tenant_id=? AND root_run_id=? AND root_attempt_id=? AND participant_id=?', args: [...scopeArgs(scope), participantId] })
      if (!member.rows[0]) fail('not_found', 'Participant not found')
      const key = await this.keyRead(tx), fingerprint = createHash('sha256').update(JSON.stringify(['receipts', ...scopeArgs(scope), scope.rootSessionId, participantId])).digest('hex')
      const cursor = this.decode(key, options.cursor, fingerprint)
      const max = await tx.execute({ sql: 'SELECT coalesce(max(seq),0) AS revision FROM collaboration_messages WHERE tenant_id=? AND root_run_id=? AND root_attempt_id=? AND recipient_participant_id=?', args: [...scopeArgs(scope), participantId] })
      const revision = cursor?.revision ?? Number(max.rows[0].revision)
      // Do not load body columns for public bounded receipt pages.
      const result = await tx.execute({ sql: `SELECT seq,message_id,root_run_id,root_attempt_id,sender_participant_id,sender_invocation_run_id,recipient_participant_id,request_key,payload_hash,payload_bytes,accepted_at,state,reason
        FROM collaboration_messages WHERE tenant_id=? AND root_run_id=? AND root_attempt_id=? AND recipient_participant_id=? AND seq>? AND seq<=? ORDER BY seq LIMIT ?`, args: [...scopeArgs(scope), participantId, cursor?.after ?? 0, revision, size + 1] })
      const entries = result.rows.slice(0, size).map(receipt), hasMore = result.rows.length > size
      return { entries, revision, hasMore, ...(hasMore ? { nextCursor: this.cursor(key, { version: 1, scope: fingerprint, revision, after: entries.at(-1)!.acceptedSeq }) } : {}) }
    })
  }

  async phase(binding: CollaborationBinding, phase: 'draining' | 'closed'): Promise<void> {
    await this.write(async tx => {
      const root = await this.root(tx, binding)
      if (binding.kind !== 'root' || root.generation !== binding.generation) fail('forbidden', 'Only the root producer may close admission')
      if (root.phase === phase) return
      if (root.phase !== 'open' && !(root.phase === 'draining' && phase === 'closed')) fail('closed', 'Root phase cannot be reopened')
      await this.assertProducer(tx, binding)
      await tx.execute({ sql: 'UPDATE collaboration_roots SET phase=?,updated_at=? WHERE tenant_id=? AND root_run_id=? AND root_attempt_id=?', args: [phase, Date.now(), ...scopeArgs(binding)] })
      if (phase === 'closed') await tx.execute({ sql: "UPDATE collaboration_messages SET state='rejected',reason='root_closed_without_consumer' WHERE tenant_id=? AND root_run_id=? AND root_attempt_id=? AND state='queued'" + pendingDeliverySql, args: scopeArgs(binding) })
    })
  }

  /** Startup owner calls this once before producers are admitted; GET never calls it. */
  async recoverInterruptedAtStartup(): Promise<number> {
    return this.write(async tx => {
      const result = await tx.execute({ sql: "UPDATE collaboration_roots SET phase='interrupted',updated_at=? WHERE phase IN ('open','draining') RETURNING tenant_id,root_run_id,root_attempt_id", args: [Date.now()] })
      await tx.execute("UPDATE collaboration_messages SET state='interrupted',reason='engine_restarted_before_consumer' WHERE state='queued' AND EXISTS (SELECT 1 FROM collaboration_roots r WHERE r.tenant_id=collaboration_messages.tenant_id AND r.root_run_id=collaboration_messages.root_run_id AND r.root_attempt_id=collaboration_messages.root_attempt_id AND r.phase='interrupted')" + pendingDeliverySql)
      return result.rows.length
    })
  }
}
