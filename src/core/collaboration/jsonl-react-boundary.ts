import { createHash } from 'node:crypto'
import type { AgentContext, Message } from '../agent-context/types.js'
import { serviceForOwner, type ExecutionOwner } from './execution-owner.js'
import { CollaborationError, type CollaborationProducer } from './types.js'
import type { JSONLDeliveryConsumer } from './jsonl-delivery.js'
import type { SQLiteDeliveryBatch } from './sqlite-delivery.js'
import { canonicalJSONLMessage, jsonlHistoryIdentity } from '../../storage/conversation/jsonl-origin.js'
import { readAdmissionSeed } from '../../storage/root-admission/projection.js'
import { withAuthenticatedHistoryMaintenance } from './history-maintenance.js'

declare const boundaryBrand: unique symbol
export type JSONLReActBoundary = Readonly<{ [boundaryBrand]: true }>
interface RecordBoundary { owner: ExecutionOwner; history: AgentContext['history']; tenantId: string; sessionId: string;
  producer: CollaborationProducer; consumer?: JSONLDeliveryConsumer; anchorId?: string; snapshotDigest?: string }
const boundaries = new WeakMap<JSONLReActBoundary, RecordBoundary>()
const fail = (message: string): never => { throw new CollaborationError('forbidden', message) }
const digest = (messages: Message[]) => createHash('sha256').update(JSON.stringify(messages.map(canonicalJSONLMessage))).digest('hex')

export function createJSONLReActBoundary(ctx: AgentContext): JSONLReActBoundary {
  if (!ctx.executionOwner) fail('JSONL delivery requires a live execution owner')
  const service = serviceForOwner(ctx.executionOwner!), origin = jsonlHistoryIdentity(ctx.history)
  if (!origin || origin.db() !== service.db) fail('JSONL delivery needs the same actual receipt datasource')
  const producer = service.producerForExecution(ctx.executionOwner!), b = service.collaboration.executionBinding(producer)
  if (b.tenantId !== ctx.tenantId || b.sessionId !== ctx.sessionId || b.rootRunId !== ctx.rootRunId || b.turnId !== ctx.turnId
    || b.kind === 'child' && b.invocationRunId !== ctx.runId) fail('JSONL context does not own its admitted invocation')
  const capability = Object.freeze({}) as JSONLReActBoundary
  boundaries.set(capability, { owner: ctx.executionOwner!, history: ctx.history, tenantId: ctx.tenantId, sessionId: ctx.sessionId, producer })
  return capability
}
function record(capability: JSONLReActBoundary, ctx: AgentContext): RecordBoundary {
  const found = boundaries.get(capability)
  if (!found || found.owner !== ctx.executionOwner || found.history !== ctx.history || found.tenantId !== ctx.tenantId || found.sessionId !== ctx.sessionId)
    fail('A live private JSONL boundary is required')
  const service = serviceForOwner(found!.owner), origin = jsonlHistoryIdentity(found!.history)
  if (!origin || origin.db() !== service.db || service.producerForExecution(found!.owner) !== found!.producer) fail('JSONL datasource or producer changed')
  return found!
}
export async function bindJSONLReActBoundary(capability: JSONLReActBoundary, ctx: AgentContext, savedInputId?: string, savedInputContent?: Message['content']): Promise<void> {
  const found = record(capability, ctx), service = serviceForOwner(found.owner), b = service.collaboration.executionBinding(found.producer)
  let anchorId = savedInputId, content = savedInputContent
  if (b.kind === 'root') {
    const seed = await readAdmissionSeed(service.db, b, b.rootRunId)
    if (savedInputId !== undefined && savedInputId !== seed.anchor.userMessageId) fail('Saved JSONL root input is not its immutable admitted seed')
    anchorId = seed.anchor.userMessageId; content = seed.message.content
  } else if (!savedInputId || savedInputContent === undefined) fail('JSONL child needs its exact saved delegated input')
  if (!anchorId) fail('JSONL input anchor is absent')
  const consumer = await service.collaboration.bindJSONLDelivery(found.producer, { origin: jsonlHistoryIdentity(found.history)!,
    executionOwner: b.kind === 'child' ? found.owner : undefined,
    tenantId: found.tenantId, sessionId: found.sessionId, anchorId: anchorId!, anchorContent: typeof content === 'string' ? content : JSON.stringify(content) })
  record(capability, ctx)
  if (found.consumer && (found.consumer !== consumer || found.anchorId !== anchorId)) fail('JSONL boundary cannot rebind or replay a replacement input')
  found.consumer = consumer; found.anchorId = anchorId
}
export async function readJSONLReActHistory(capability: JSONLReActBoundary, ctx: AgentContext): Promise<Message[]> {
  const found = record(capability, ctx)
  if (!found.consumer) fail('JSONL input has not been durably bound')
  const messages = await serviceForOwner(found.owner).collaboration.jsonlDeliverySnapshot(found.consumer!, ctx.inheritContext !== false)
  record(capability, ctx); found.snapshotDigest = digest(messages)
  return messages
}
export async function consumeJSONLReActIteration(capability: JSONLReActBoundary, ctx: AgentContext): Promise<SQLiteDeliveryBatch> {
  const found = record(capability, ctx)
  if (!found.consumer) fail('JSONL input has not been durably bound')
  return serviceForOwner(found.owner).collaboration.consumeJSONLDelivery(found.consumer!)
}
export async function maintainJSONLReActHistory<T>(capability: JSONLReActBoundary, ctx: AgentContext, action: () => Promise<T>): Promise<T> {
  const found = record(capability, ctx)
  if (!found.consumer) fail('Maintenance requires the original admitted JSONL input binding')
  return withAuthenticatedHistoryMaintenance(found.owner, found.consumer!, 'jsonl', action)
}
export async function assertJSONLReActDispatch(capability: JSONLReActBoundary, ctx: AgentContext): Promise<void> {
  const found = record(capability, ctx)
  if (!found.consumer || !found.snapshotDigest) fail('JSONL dispatch has no authenticated budgeted history')
  const messages = await serviceForOwner(found.owner).collaboration.jsonlDeliverySnapshot(found.consumer!, ctx.inheritContext !== false)
  record(capability, ctx)
  if (digest(messages) !== found.snapshotDigest) throw new CollaborationError('conflict', 'JSONL history changed after request budgeting; no provider request was dispatched')
}
