import { createHash } from 'node:crypto'
import type { AgentContext, Message } from '../agent-context/types.js'
import type { Row } from '@libsql/client'
import { serviceForOwner, type ExecutionOwner } from './execution-owner.js'
import type { CollaborationProducer } from './types.js'
import { CollaborationError } from './types.js'
import type { SQLiteDeliveryConsumer, SQLiteDeliveryBatch } from './sqlite-delivery.js'
import { sqliteHistoryIdentity } from '../../storage/conversation/sqlite-origin.js'
import { readAdmissionSeed } from '../../storage/root-admission/projection.js'
import { withAuthenticatedHistoryMaintenance } from './history-maintenance.js'

declare const boundaryBrand: unique symbol
export type SQLiteReActBoundary = Readonly<{ [boundaryBrand]: true }>
interface RecordBoundary {
  owner: ExecutionOwner
  history: AgentContext['history']
  tenantId: string
  sessionId: string
  producer: CollaborationProducer
  consumer?: SQLiteDeliveryConsumer
  anchorId?: string
  snapshotDigest?: string
}
const boundaries = new WeakMap<SQLiteReActBoundary, RecordBoundary>()
const fail = (message: string): never => { throw new CollaborationError('forbidden', message) }
const digest = (rows: Row[]) => createHash('sha256').update(JSON.stringify(rows,
  (_key, value) => typeof value === 'bigint' ? String(value) : value)).digest('hex')

/** Explicit private opt-in only. No route, model argument or environment flag mints this object. */
export function createSQLiteReActBoundary(ctx: AgentContext): SQLiteReActBoundary {
  if (!ctx.executionOwner) fail('SQLite ReAct delivery requires a live execution owner')
  const service = serviceForOwner(ctx.executionOwner!), identity = sqliteHistoryIdentity(ctx.history)
  if (!identity || identity.db !== service.db) fail('SQLite ReAct delivery needs the same actual SQLite history Client')
  const producer = service.producerForExecution(ctx.executionOwner!)
  const binding = service.collaboration.executionBinding(producer)
  if (binding.tenantId !== ctx.tenantId || binding.sessionId !== ctx.sessionId
    || binding.rootRunId !== ctx.rootRunId || binding.turnId !== ctx.turnId
    || binding.kind === 'child' && binding.invocationRunId !== ctx.runId)
    fail('SQLite ReAct delivery context does not own this admitted invocation')
  const capability = Object.freeze({}) as SQLiteReActBoundary
  boundaries.set(capability, { owner: ctx.executionOwner!, history: ctx.history,
    tenantId: ctx.tenantId, sessionId: ctx.sessionId, producer })
  return capability
}
function record(capability: SQLiteReActBoundary, ctx: AgentContext): RecordBoundary {
  const found = boundaries.get(capability)
  if (!found || found.owner !== ctx.executionOwner || found.history !== ctx.history
    || found.tenantId !== ctx.tenantId || found.sessionId !== ctx.sessionId)
    fail('A live private SQLite ReAct boundary is required')
  const service = serviceForOwner(found!.owner), identity = sqliteHistoryIdentity(found!.history)
  if (!identity || identity.db !== service.db || service.producerForExecution(found!.owner) !== found!.producer)
    fail('SQLite ReAct history or producer authority changed')
  return found!
}

/** Root identity comes from its immutable admission seed; child identity comes from the actual saved task input. */
export async function bindSQLiteReActBoundary(capability: SQLiteReActBoundary, ctx: AgentContext,
  savedInputId?: string, savedInputContent?: Message['content']): Promise<void> {
  const found = record(capability, ctx), service = serviceForOwner(found.owner)
  const binding = service.collaboration.executionBinding(found.producer)
  let anchorId = savedInputId
  let anchorContent = savedInputContent
  if (binding.kind === 'root') {
    const seed = await readAdmissionSeed(service.db, binding, binding.rootRunId)
    if (savedInputId !== undefined && savedInputId !== seed.anchor.userMessageId)
      fail('The saved root input is not its admitted human seed')
    anchorId = seed.anchor.userMessageId
    anchorContent = seed.message.content
  } else if (!savedInputId || savedInputContent === undefined) fail('Child delivery continuation needs its exact saved delegated input')
  if (!anchorId) fail('No persisted input anchor is available')
  record(capability, ctx)
  const consumer = await service.collaboration.bindSQLiteDelivery(found.producer, {
    executionOwner: binding.kind === 'child' ? found.owner : undefined,
    db: service.db, tenantId: found.tenantId, sessionId: found.sessionId, anchorId: anchorId!,
    anchorContent: typeof anchorContent === 'string' ? anchorContent : JSON.stringify(anchorContent),
  })
  if (found.consumer && (found.consumer !== consumer || found.anchorId !== anchorId))
    fail('This boundary cannot move to a replacement history epoch or input')
  found.consumer = consumer; found.anchorId = anchorId
}
export async function readSQLiteReActHistory(capability: SQLiteReActBoundary, ctx: AgentContext): Promise<Message[]> {
  const found = record(capability, ctx)
  if (!found.consumer) fail('SQLite ReAct input has not been durably bound')
  const rows = await serviceForOwner(found.owner).collaboration.sqliteDeliverySnapshot(found.consumer!, ctx.inheritContext !== false)
  const identity = sqliteHistoryIdentity(found.history)!
  record(capability, ctx)
  found.snapshotDigest = digest(rows)
  return rows.map(identity.decode)
}
export async function consumeSQLiteReActIteration(capability: SQLiteReActBoundary, ctx: AgentContext): Promise<SQLiteDeliveryBatch> {
  const found = record(capability, ctx)
  if (!found.consumer) fail('SQLite ReAct input has not been durably bound')
  // An invalidated consumer is never replaced or used to replay suppressed mail.
  return serviceForOwner(found.owner).collaboration.consumeSQLiteDelivery(found.consumer!)
}
export async function maintainSQLiteReActHistory<T>(capability: SQLiteReActBoundary, ctx: AgentContext, action: () => Promise<T>): Promise<T> {
  const found = record(capability, ctx)
  if (!found.consumer) fail('Maintenance requires the original admitted input binding')
  return withAuthenticatedHistoryMaintenance(found.owner, found.consumer!, 'sqlite', action)
}
export async function assertSQLiteReActDispatch(capability: SQLiteReActBoundary, ctx: AgentContext): Promise<void> {
  const found = record(capability, ctx)
  if (!found.consumer || !found.snapshotDigest) fail('SQLite ReAct dispatch has no admitted history snapshot')
  const rows = await serviceForOwner(found.owner).collaboration.sqliteDeliverySnapshot(found.consumer!, ctx.inheritContext !== false)
  record(capability, ctx)
  if (digest(rows) !== found.snapshotDigest) throw new CollaborationError('conflict', 'History changed after request budgeting; no provider request was dispatched')
}
