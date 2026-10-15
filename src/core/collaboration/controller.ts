import { randomUUID } from 'node:crypto'
import type { Row, Transaction } from '@libsql/client'
import type { ExecutionOwner, ExecutionOwners } from './execution-owner.js'
import { CollaborationError, type CollaborationBinding, type CollaborationParticipant, type CollaborationReceipt,
  type CollaborationRootScope } from './types.js'
import { assertControllerRoot, authenticatedControllerOrigin, controllerDigest, controllerInvocation, controllerSender,
  type ControllerSubject } from './controller-origin.js'

const scope = (b: CollaborationRootScope) => [b.tenantId, b.rootRunId, b.rootAttemptId]
const fail = (code: ConstructorParameters<typeof CollaborationError>[0], message: string): never => { throw new CollaborationError(code, message) }
function id(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 256 || /[\x00-\x1f\x7f]/.test(value)) fail('invalid', 'Invalid ' + name)
}
const receipt = (row: Row): CollaborationReceipt => ({ messageId: String(row.message_id), rootRunId: String(row.root_run_id),
  rootAttemptId: String(row.root_attempt_id), senderParticipantId: String(row.sender_participant_id), senderInvocationRunId: String(row.sender_invocation_run_id),
  recipientParticipantId: String(row.recipient_participant_id), requestKey: String(row.request_key), payloadHash: String(row.payload_hash),
  payloadBytes: Number(row.payload_bytes), acceptedSeq: Number(row.seq), acceptedAt: Number(row.accepted_at),
  state: row.state as CollaborationReceipt['state'], ...(row.reason == null ? {} : { reason: String(row.reason) }) })
const participant = (row: Row): CollaborationParticipant => ({ participantId: String(row.participant_id),
  ...(row.parent_participant_id == null ? {} : { parentParticipantId: String(row.parent_participant_id) }),
  kind: row.kind as CollaborationParticipant['kind'], sessionId: String(row.session_id), invocationRunId: String(row.invocation_run_id),
  admittedSeq: Number(row.seq), admittedAt: Number(row.admitted_at) })

/** A distinct user producer whose authority comes from HTTP auth plus the actual live execution owner. */
export class CollaborationController {
  constructor(private readonly owners: ExecutionOwners) {}
  private get store() { return this.owners.collaboration.store }
  private validate(b: CollaborationRootScope, subject: ControllerSubject): void {
    for (const [name, value] of Object.entries(b)) id(value, name)
    if (b.tenantId !== subject.tenantId) fail('forbidden', 'Controller tenant does not own this scope')
  }
  private live(b: CollaborationRootScope, recipientParticipantId?: string): { owner: ExecutionOwner; binding: CollaborationBinding } {
    const owner = this.owners.find(b.tenantId, b.rootRunId, b.rootAttemptId)
    if (!owner) return fail('closed', 'There is no live execution owner for this attempt')
    const binding = this.owners.controllerBinding(owner, recipientParticipantId)
    if (binding.rootSessionId !== b.rootSessionId) fail('forbidden', 'Controller session does not own this attempt')
    return { owner, binding }
  }
  private async read<T>(action: (tx: Transaction) => Promise<T>): Promise<T> {
    await this.store.prepare()
    const tx = await this.store.db.transaction('read')
    try { return await action(tx) } finally { if (!tx.closed) await tx.rollback(); tx.close() }
  }
  async authorizeInspection(b: CollaborationRootScope, subject: ControllerSubject): Promise<void> {
    this.validate(b, subject)
    await this.read(async tx => {
      const row = (await tx.execute({ sql: `SELECT subject_key,subject_kind FROM collaboration_controller_roots
        WHERE tenant_id=? AND root_run_id=? AND root_attempt_id=?`, args: scope(b) })).rows[0]
      if (row) { await assertControllerRoot(tx, b, subject); return }
      const orphan = (await tx.execute({ sql: `SELECT 1 FROM collaboration_controller_origins
        WHERE tenant_id=? AND root_run_id=? AND root_attempt_id=? LIMIT 1`, args: scope(b) })).rows[0]
      if (orphan) fail('forbidden', 'Controller inspection lost its original user scope')
    })
  }
  private async recipient(tx: Transaction, b: CollaborationBinding, owner: ExecutionOwner, target: string): Promise<CollaborationParticipant> {
    const row = (await tx.execute({ sql: `SELECT * FROM collaboration_participants
      WHERE tenant_id=? AND root_run_id=? AND root_attempt_id=? AND participant_id=?`, args: [...scope(b), target] })).rows[0]
    if (!row) return fail('not_found', 'Recipient is not a participant of this root')
    const result = participant(row)
    if (result.kind === 'child') {
      // Continuations use the same participant but a new invocation. An old
      // caller must never silently steer whichever invocation happens next.
      const latest = (await tx.execute({ sql: `SELECT i.invocation_run_id FROM collaboration_invocations i
        JOIN subagent_runs s ON s.tenant_id=i.tenant_id AND s.run_id=i.invocation_run_id
        WHERE i.tenant_id=? AND i.root_run_id=? AND i.root_attempt_id=? AND i.participant_id=?
          AND s.child_session_id=? AND s.status IN ('queued','running') ORDER BY i.seq DESC LIMIT 1`,
        args: [...scope(b), target, result.sessionId] })).rows[0]
      if (!latest) fail('closed', 'Recipient has no active child invocation')
      result.invocationRunId = String(latest!.invocation_run_id)
    }
    this.owners.assertControllerRecipient(owner, target, result.invocationRunId)
    return result
  }
  async context(subject: ControllerSubject, rootRunId: string, rootSessionId: string, recipientParticipantId?: string) {
    id(rootRunId, 'rootRunId'); id(rootSessionId, 'rootSessionId')
    if (recipientParticipantId !== undefined) id(recipientParticipantId, 'recipientParticipantId')
    const result = await this.read(async tx => {
      const run = (await tx.execute({ sql: 'SELECT session_id,state FROM root_runs WHERE tenant_id=? AND run_id=?', args: [subject.tenantId, rootRunId] })).rows[0]
      if (!run || run.session_id !== rootSessionId) return fail('not_found', 'Controller root not found')
      let state: { attemptId?: unknown; status?: unknown }
      try { state = JSON.parse(String(run.state)) } catch { return fail('conflict', 'Root execution state is malformed') }
      if (state.status !== 'running' || typeof state.attemptId !== 'string') return fail('closed', 'Controller root is not running')
      const b = { tenantId: subject.tenantId, rootRunId, rootAttemptId: state.attemptId, rootSessionId }
      this.validate(b, subject); await assertControllerRoot(tx, b, subject)
      const { owner, binding } = this.live(b, recipientParticipantId)
      await this.store.assertProducer(tx, binding)
      const recipient = recipientParticipantId === undefined ? undefined : await this.recipient(tx, binding, owner, recipientParticipantId)
      this.owners.controllerBinding(owner, recipientParticipantId)
      return { b, recipient }
    })
    const participants = await this.store.participants(result.b, { limit: 64 })
    const current = this.live(result.b, recipientParticipantId)
    if (result.recipient) this.owners.assertControllerRecipient(current.owner, result.recipient.participantId, result.recipient.invocationRunId)
    return { outcome: 'ready' as const, scope: { rootRunId, rootAttemptId: result.b.rootAttemptId, rootSessionId },
      participants, ...(result.recipient ? { recipient: result.recipient } : {}) }
  }
  async findReceipt(b: CollaborationRootScope, subject: ControllerSubject, requestKey: string): Promise<CollaborationReceipt | null> {
    this.validate(b, subject); id(requestKey, 'requestKey')
    return this.read(async tx => {
      await assertControllerRoot(tx, b, subject)
      const row = (await tx.execute({ sql: `SELECT * FROM collaboration_messages
        WHERE tenant_id=? AND root_run_id=? AND root_attempt_id=? AND sender_participant_id=? AND sender_invocation_run_id=? AND request_key=?`,
        args: [...scope(b), controllerSender(subject), controllerInvocation(b, subject), requestKey] })).rows[0]
      if (!row) return null
      await authenticatedControllerOrigin(tx, b, row)
      return receipt(row)
    })
  }
  async send(b: CollaborationRootScope, subject: ControllerSubject, input: { recipientParticipantId: string; recipientInvocationRunId: string; message: string; requestKey: string }): Promise<CollaborationReceipt> {
    this.validate(b, subject); id(input.recipientParticipantId, 'recipientParticipantId'); id(input.recipientInvocationRunId, 'recipientInvocationRunId'); id(input.requestKey, 'requestKey')
    if (typeof input.message !== 'string' || !input.message.trim()) fail('invalid', 'Message body must not be empty')
    const bytes = Buffer.byteLength(input.message)
    if (bytes > 32 * 1024) fail('too_large', 'Message exceeds the 32 KiB queue limit')
    // Resolve only an existing owner; a controller never admits or restarts a child.
    const { owner, binding } = this.live(b, input.recipientParticipantId)
    await this.store.prepare()
    const tx = await this.store.db.transaction('write')
    try {
      this.owners.controllerBinding(owner, input.recipientParticipantId)
      const authority = await assertControllerRoot(tx, b, subject)
      if (authority.generation !== binding.generation) fail('forbidden', 'Controller belongs to an old execution generation')
      await this.store.assertProducer(tx, binding)
      const existing = (await tx.execute({ sql: `SELECT * FROM collaboration_messages WHERE tenant_id=? AND root_run_id=? AND root_attempt_id=?
        AND sender_participant_id=? AND sender_invocation_run_id=? AND request_key=?`,
        args: [...scope(b), controllerSender(subject), controllerInvocation(b, subject), input.requestKey] })).rows[0]
      if (existing) {
        const origin = await authenticatedControllerOrigin(tx, b, existing)
        if (existing.recipient_participant_id !== input.recipientParticipantId || existing.body !== input.message
          || origin?.recipient_invocation_id !== input.recipientInvocationRunId) fail('conflict', 'Request key was already accepted differently')
        this.owners.assertControllerRecipient(owner, input.recipientParticipantId, input.recipientInvocationRunId)
        await tx.commit(); return receipt(existing)
      }
      const recipient = await this.recipient(tx, binding, owner, input.recipientParticipantId)
      if (recipient.invocationRunId !== input.recipientInvocationRunId) fail('conflict', 'Recipient invocation changed; refresh the selected child before sending')
      const count = (await tx.execute({ sql: `SELECT count(*) AS n FROM collaboration_messages m
        WHERE m.tenant_id=? AND m.root_run_id=? AND m.root_attempt_id=? AND m.recipient_participant_id=? AND m.state='queued'
        AND NOT EXISTS (SELECT 1 FROM collaboration_deliveries d WHERE d.tenant_id=m.tenant_id AND d.root_run_id=m.root_run_id AND d.root_attempt_id=m.root_attempt_id AND d.message_id=m.message_id)
        AND NOT EXISTS (SELECT 1 FROM collaboration_jsonl_deliveries d WHERE d.tenant_id=m.tenant_id AND d.root_run_id=m.root_run_id AND d.root_attempt_id=m.root_attempt_id AND d.message_id=m.message_id AND d.state IN ('integrated','suppressed'))`,
        args: [...scope(b), input.recipientParticipantId] })).rows[0]
      if (Number(count.n) >= 1024) fail('full', 'Recipient queue is full; no message was accepted')
      const messageId = randomUUID(), now = Date.now(), hash = controllerDigest(input.message)
      const row = (await tx.execute({ sql: `INSERT INTO collaboration_messages
        (tenant_id,root_run_id,root_attempt_id,message_id,sender_participant_id,sender_invocation_run_id,recipient_participant_id,request_key,payload_hash,payload_bytes,body,accepted_at,state)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'queued') RETURNING *`, args: [...scope(b), messageId, controllerSender(subject), controllerInvocation(b, subject),
          input.recipientParticipantId, input.requestKey, hash, bytes, input.message, now] })).rows[0]
      await tx.execute({ sql: `INSERT INTO collaboration_controller_origins VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        args: [...scope(b), messageId, subject.key, subject.kind, subject.method, b.rootSessionId, binding.generation,
          controllerSender(subject), controllerInvocation(b, subject), input.requestKey, input.recipientParticipantId, recipient.invocationRunId, hash, bytes, input.message, now] })
      this.owners.assertControllerRecipient(owner, input.recipientParticipantId, recipient.invocationRunId)
      await tx.commit()
      return receipt(row)
    } catch (error) { if (!tx.closed) await tx.rollback().catch(() => undefined); throw error }
    finally { tx.close() }
  }
}
