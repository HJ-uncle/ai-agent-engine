import type { Client } from '@libsql/client'
import { getDb, getDbEpoch } from '../../storage/sqlite/db.js'
import { getCollaborationRuntime, type CollaborationRuntime } from './runtime.js'
import type { CollaborationProducer, CollaborationBinding } from './types.js'
import type { SubagentRunView } from '../subagent/types.js'

declare const authority: unique symbol
/** These objects are service-owned identities, never serialized request fields. */
export type ExecutionOwner = Readonly<{ [authority]: 'execution' }>
export type DrainEvidence = Readonly<{ [authority]: 'drain' }>
export type ChildTicket = Readonly<{ [authority]: 'ticket' }>
export type RootPreparation = Readonly<{ [authority]: 'preparation' }>
type Phase = 'accepting' | 'draining' | 'cancelling' | 'parking' | 'closed' | 'parked' | 'cleanup_unknown'
export type DrainIntent = 'finish' | 'cancel' | 'park'
interface TicketRecord {
  owner: RecordOwner
  controller: AbortController
  settled: Promise<void>
  resolve(): void
  reject(error: unknown): void
  runId?: string
  producer?: CollaborationProducer
  completion?: Promise<SubagentRunView>
  terminalSeq?: number
  projection?: 'appended' | 'duplicate' | 'suppressed'
  error?: unknown
  done: boolean
  childCaps: ExecutionOwner[]
}
interface RecordOwner {
  service: ExecutionOwners
  cap: ExecutionOwner
  producer: CollaborationProducer
  binding: CollaborationBinding
  epoch: number
  controller: AbortController
  phase: Phase
  intent?: DrainIntent
  cancellationRequested?: boolean
  tickets: Set<TicketRecord>
  completion: Promise<void>
  completionRegistered: boolean
  completeRoot(): void
  failRoot(error: unknown): void
  drain?: Promise<DrainEvidence>
  final?: Promise<unknown>
}
const owners = new WeakMap<ExecutionOwner, { record: RecordOwner; child?: TicketRecord }>()
const tickets = new WeakMap<ChildTicket, TicketRecord>()
const evidence = new WeakMap<DrainEvidence, RecordOwner>()
const databaseRoots = new WeakMap<Client, Map<string, RecordOwner>>()
const preparations = new WeakMap<RootPreparation, { service: ExecutionOwners; controller: AbortController; settled: Promise<void>; finish(): void }>()
const key = (tenantId: string, runId: string, attemptId: string) => JSON.stringify([tenantId, runId, attemptId])
const fail = (message: string): never => { throw new Error('EXECUTION_OWNERSHIP: ' + message) }

/** Synchronous admission fences precede every await; joins never hold storage locks. */
export class ExecutionOwners {
  private readonly roots = new Map<string, RecordOwner>()
  private stopping = false
  private readonly preparing = new Set<RootPreparation>()
  constructor(readonly db: Client, readonly collaboration: CollaborationRuntime) {
    if (collaboration.store.db !== db) fail('Collaboration and execution must use the same actual Client')
  }
  private live(record: RecordOwner): void {
    if (record.service !== this || this.db.closed || record.epoch !== getDbEpoch(this.db)) fail('Datasource was closed or replaced')
  }
  reservePreparation(controller: AbortController): RootPreparation {
    if (this.stopping || this.db.closed) fail('Service is not accepting root preparation')
    const cap = Object.freeze({}) as RootPreparation
    let finish!: () => void
    const settled = new Promise<void>(resolve => { finish = resolve })
    preparations.set(cap, { service: this, controller, settled, finish }); this.preparing.add(cap)
    return cap
  }
  finishPreparation(cap: RootPreparation): void {
    const record = preparations.get(cap)
    if (!record || record.service !== this) fail('A live root preparation ticket is required')
    this.preparing.delete(cap); record!.finish(); preparations.delete(cap)
  }
  async joinPreparations(): Promise<void> { await Promise.all([...this.preparing].map(cap => preparations.get(cap)!.settled)) }
  async admitRoot(input: { tenantId: string; rootRunId: string; rootAttemptId: string; controller: AbortController }): Promise<ExecutionOwner> {
    if (this.stopping || input.controller.signal.aborted) fail('Service is stopping or admission was cancelled')
    const initialEpoch = getDbEpoch(this.db)
    if (initialEpoch === undefined || this.db.closed) fail('Datasource has no live trusted reconnect epoch')
    const preparation = this.reservePreparation(input.controller)
    try {
    let producer: CollaborationProducer
    const admission = { tenantId: input.tenantId, rootRunId: input.rootRunId, rootAttemptId: input.rootAttemptId }
    try { producer = await this.collaboration.admitRoot(admission) }
    catch (error) {
      const recovered = await this.collaboration.lookupRootAdmissionReceipt(admission)
      if (!recovered) throw error
      producer = recovered
    }
    const binding = this.collaboration.executionBinding(producer)
    if (this.db.closed || getDbEpoch(this.db) !== initialEpoch) fail('Datasource changed during root admission')
    const id = key(input.tenantId, input.rootRunId, input.rootAttemptId)
    const prior = this.roots.get(id)
    if (prior) { this.live(prior); return prior.cap }
    const cap = Object.freeze({}) as ExecutionOwner
    const epoch = getDbEpoch(this.db)
    if (epoch === undefined) fail('Datasource has no trusted reconnect epoch')
    let completeRoot!: () => void, failRoot!: (error: unknown) => void
    const completion = new Promise<void>((yes, no) => { completeRoot = yes; failRoot = no })
    void completion.catch(() => undefined)
    const record: RecordOwner = { service: this, cap, producer, binding, epoch: epoch!, controller: input.controller,
      phase: 'accepting', tickets: new Set(), completion, completionRegistered: false, completeRoot, failRoot }
    owners.set(cap, { record }); this.roots.set(id, record)
    let allRoots = databaseRoots.get(this.db)
    if (!allRoots) { allRoots = new Map(); databaseRoots.set(this.db, allRoots) }
    allRoots.set(id, record)
    input.controller.signal.addEventListener('abort', () => {
      if (record.phase === 'accepting' || record.phase === 'draining') this.fence(cap, 'cancel', 'Root signal aborted')
    }, { once: true })
    // Cancellation may have won during the durable admission await.
    if (this.stopping || input.controller.signal.aborted) this.fence(cap, 'cancel', 'Cancelled during admission')
    return cap
    } finally { this.finishPreparation(preparation) }
  }
  record(cap: ExecutionOwner): RecordOwner {
    const found = owners.get(cap)
    if (!found || found.child) return fail('A live root capability is required')
    this.live(found.record); return found.record
  }
  assertDispatch(cap: ExecutionOwner): void {
    const found = owners.get(cap)
    if (!found || found.record.service !== this) fail('A live execution capability is required')
    const record = found!.record; this.live(record)
    const allowed = found!.child ? record.phase === 'accepting' || record.phase === 'draining' && record.intent === 'finish' : record.phase === 'accepting'
    if (!allowed || record.controller.signal.aborted || found!.child?.controller.signal.aborted) fail('Attempt dispatch is revoked')
  }
  reserveChild(cap: ExecutionOwner): ChildTicket {
    this.assertDispatch(cap)
    const record = this.record(cap)
    let resolve!: () => void, reject!: (error: unknown) => void
    const settled = new Promise<void>((yes, no) => { resolve = yes; reject = no })
    // The owner retains failures until drain observes them; no unhandled rejection.
    void settled.catch(() => undefined)
    const ticket: TicketRecord = { owner: record, controller: new AbortController(), settled, resolve, reject, done: false, childCaps: [] }
    const capTicket = Object.freeze({}) as ChildTicket
    tickets.set(capTicket, ticket); record.tickets.add(ticket)
    return capTicket
  }
  ticketSignal(ticket: ChildTicket): AbortSignal { return this.ticket(ticket).controller.signal }
  private ticket(cap: ChildTicket): TicketRecord {
    const ticket = tickets.get(cap)
    if (!ticket || ticket.owner.service !== this) return fail('A live child admission ticket is required')
    this.live(ticket.owner); return ticket
  }
  producer(cap: ExecutionOwner): CollaborationProducer { return this.record(cap).producer }
  producerForExecution(cap: ExecutionOwner): CollaborationProducer {
    this.assertDispatch(cap)
    const found = owners.get(cap)!
    if (!found.child) return found.record.producer
    if (!found.child.producer || found.child.done) fail('Child execution has no active admitted producer')
    return found.child.producer!
  }
  attachChild(cap: ChildTicket, runId: string, producer: CollaborationProducer): ExecutionOwner {
    const ticket = this.ticket(cap)
    const binding = this.collaboration.executionBinding(producer), root = ticket.owner.binding
    if (binding.kind !== 'child' || binding.invocationRunId !== runId || binding.tenantId !== root.tenantId
      || binding.rootRunId !== root.rootRunId || binding.rootAttemptId !== root.rootAttemptId
      || binding.rootSessionId !== root.rootSessionId || binding.turnId !== root.turnId || binding.generation !== root.generation)
      fail('Child producer does not own the exact admitted invocation')
    if (ticket.runId && ticket.runId !== runId) fail('Admission ticket changed invocation')
    if (ticket.producer && ticket.producer !== producer) fail('Admission ticket changed producer capability')
    ticket.runId = runId
    ticket.producer = producer
    const child = Object.freeze({}) as ExecutionOwner
    owners.set(child, { record: ticket.owner, child: ticket })
    ticket.childCaps.push(child)
    return child
  }
  completeChild(cap: ChildTicket, receipt: { runId: string; terminalSeq: number; projection: 'appended' | 'duplicate' | 'suppressed' }): void {
    const ticket = this.ticket(cap)
    if (ticket.done) return
    if (ticket.runId !== receipt.runId || !Number.isSafeInteger(receipt.terminalSeq) || receipt.terminalSeq < 1) fail('Child settlement receipt changed identity')
    ticket.terminalSeq = receipt.terminalSeq; ticket.projection = receipt.projection; ticket.done = true; ticket.resolve()
  }
  failChild(cap: ChildTicket, error: unknown): void {
    const ticket = this.ticket(cap)
    if (!ticket.done) { ticket.error = error; ticket.done = true; ticket.reject(error) }
  }
  fence(cap: ExecutionOwner, intent: DrainIntent, reason: string = intent, businessCancellation = true): void {
    const record = this.record(cap)
    if (record.phase === 'closed' || record.phase === 'parked') {
      if (intent === 'cancel' && businessCancellation) record.cancellationRequested = true
      return
    }
    if (record.phase === 'cleanup_unknown') {
      if (intent === 'cancel') {
        if (!record.controller.signal.aborted) record.controller.abort(new Error(reason))
        for (const ticket of record.tickets) if (!ticket.controller.signal.aborted) ticket.controller.abort(new Error(reason))
        return
      }
      fail('Prior cleanup is unknown')
    }
    if (intent === 'cancel' && businessCancellation) record.cancellationRequested = true
    if (!record.intent || intent === 'cancel') record.intent = intent
    record.phase = record.intent === 'cancel' ? 'cancelling' : record.intent === 'park' ? 'parking' : 'draining'
    if (record.intent !== 'finish') {
      if (!record.controller.signal.aborted) record.controller.abort(new Error(reason))
      for (const ticket of record.tickets) if (!ticket.controller.signal.aborted) ticket.controller.abort(new Error(reason))
    }
  }
  drain(cap: ExecutionOwner, intent: DrainIntent): Promise<DrainEvidence> {
    const record = this.record(cap)
    this.fence(cap, intent, intent, false)
    if (record.drain) return record.drain
    record.drain = (async () => {
      await this.collaboration.beginDrain(record.producer)
      // Admission was synchronously closed before this snapshot. A held admission
      // remains a ticket until its executor and durable receipts actually settle.
      const joined = await Promise.allSettled([...record.tickets].map(ticket => ticket.settled))
      const failures = joined.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'CHILD_CLEANUP_UNKNOWN')
      this.live(record)
      const rows = await this.collaboration.store.executionInvocations(record.binding)
      for (const row of rows) {
        const local = [...record.tickets].find(ticket => ticket.runId === row.runId)
        if (!local?.done || local.error || local.terminalSeq !== row.seq || !row.terminal) fail('A durable child has no exact joined executor receipt')
        if (record.intent === 'finish' && local!.projection === 'suppressed') fail('Successful root cannot claim a suppressed parent result')
      }
      const result = Object.freeze({}) as DrainEvidence
      evidence.set(result, record); return result
    })().catch(error => { record.phase = 'cleanup_unknown'; throw error })
    return record.drain
  }
  assertSettlement(cap: ExecutionOwner, proof: DrainEvidence, db: Client): { binding: CollaborationBinding; intent: DrainIntent; cancellationRequested: boolean } {
    const record = this.record(cap)
    if (db !== this.db || evidence.get(proof) !== record || !record.intent || record.phase === 'cleanup_unknown') fail('Drain evidence does not own this physical transaction')
    return { binding: record.binding, intent: record.intent!, cancellationRequested: record.cancellationRequested === true }
  }
  settle<T>(cap: ExecutionOwner, intent: DrainIntent, commit: (proof: DrainEvidence) => Promise<T>): Promise<T> {
    const record = this.record(cap)
    this.fence(cap, intent, intent, false)
    if (record.final) return record.final as Promise<T>
    record.final = (async () => {
      const proof = await this.drain(cap, intent)
      const result = await commit(proof)
      // A park commit may finish before its transport ACK, while cancellation
      // wins locally. Reflect the committed result; finishOwned closes that
      // exact waiting attempt before reporting cancellation complete.
      record.phase = result && typeof result === 'object' && 'status' in result && result.status === 'waiting' ? 'parked' : 'closed'
      this.collaboration.revokeExecutionProducers(record.producer)
      return result
    })().catch(error => { record.phase = 'cleanup_unknown'; throw error })
    return record.final as Promise<T>
  }
  completeParkCancellation(cap: ExecutionOwner): void {
    const record = this.record(cap)
    if (!['parked', 'closed'].includes(record.phase) || !record.cancellationRequested) fail('Park cancellation lacks its exact owner')
    record.phase = 'closed'
  }
  registerCompletion(cap: ExecutionOwner, completion: Promise<void>): void {
    const record = this.record(cap)
    if (record.completionRegistered) fail('Root completion was already registered')
    record.completionRegistered = true
    void completion.then(record.completeRoot, record.failRoot)
  }
  async joinRoot(cap: ExecutionOwner): Promise<void> { await this.record(cap).completion }
  releaseRoot(cap: ExecutionOwner): void {
    const record = this.record(cap)
    if (!['closed','parked'].includes(record.phase) || [...record.tickets].some(ticket => !ticket.done || ticket.error)) fail('Cannot release an unsettled execution owner')
    if (record.phase === 'parked' && record.cancellationRequested) fail('Cancelled park still needs its durable close receipt')
    for (const ticket of record.tickets) for (const child of ticket.childCaps) owners.delete(child)
    owners.delete(cap)
    const id = key(record.binding.tenantId, record.binding.rootRunId, record.binding.rootAttemptId)
    this.roots.delete(id)
    if (databaseRoots.get(this.db)?.get(id) === record) databaseRoots.get(this.db)?.delete(id)
  }
  find(tenantId: string, runId: string, attemptId: string): ExecutionOwner | undefined { return databaseRoots.get(this.db)?.get(key(tenantId, runId, attemptId))?.cap }
  active(tenantId?: string, sessionId?: string): ExecutionOwner[] {
    return [...this.roots.values()].filter(record => (!tenantId || record.binding.tenantId === tenantId) && (!sessionId || record.binding.rootSessionId === sessionId)
      && !['closed', 'parked'].includes(record.phase)).map(record => record.cap)
  }
  ownedRoots(): ExecutionOwner[] { return [...this.roots.values()].filter(record => record.phase !== 'closed').map(record => record.cap) }
  unreleasedRoots(): ExecutionOwner[] { return [...this.roots.values()].map(record => record.cap) }
  stopMaintenance(cap: ExecutionOwner, reason: string): void {
    const record = this.record(cap)
    if (record.phase !== 'closed') fail('Maintenance stop requires a committed terminal owner')
    // Business settlement is immutable; its producer may still be awaiting
    // cancellable post-turn maintenance before releasing its final handles.
    if (!record.controller.signal.aborted) record.controller.abort(new Error(reason))
  }
  stopAdmission(): void {
    this.stopping = true
    for (const cap of this.preparing) preparations.get(cap)!.controller.abort(new Error('Engine shutdown during root preparation'))
    for (const cap of this.unreleasedRoots()) {
      if (this.record(cap).phase === 'closed') this.stopMaintenance(cap, 'Engine shutdown during post-turn maintenance')
      else this.fence(cap, 'cancel', 'Engine shutdown')
    }
  }
}

let singleton: ExecutionOwners | undefined
export function getExecutionOwners(): ExecutionOwners {
  const db = getDb()
  if (!singleton || singleton.db !== db) singleton = new ExecutionOwners(db, getCollaborationRuntime())
  return singleton
}
export function serviceForOwner(cap: ExecutionOwner): ExecutionOwners {
  const found = owners.get(cap)
  if (!found) return fail('Forged execution capability')
  return found.record.service
}
export function assertOwnedDispatch(cap: ExecutionOwner | undefined): void { if (cap) serviceForOwner(cap).assertDispatch(cap) }

const startup = new WeakMap<Client, Promise<void>>()
export function initializeOwnedExecutionStartup(): Promise<void> {
  const db = getDb()
  let pending = startup.get(db)
  if (!pending) {
    pending = (async () => {
      const { rootRunStore } = await import('../../storage/root-runs/index.js')
      const { getSubagentStore } = await import('../subagent/store.js')
      const { createConversationHistory } = await import('../../storage/conversation/factory.js')
      const { projectPendingSubagents } = await import('../subagent/projection.js')
      await rootRunStore.initialize()
      await getSubagentStore().recoverInterrupted()
      await getCollaborationRuntime().store.recoverInterruptedAtStartup()
      await projectPendingSubagents(createConversationHistory())
    })()
    startup.set(db, pending)
  }
  return pending
}
