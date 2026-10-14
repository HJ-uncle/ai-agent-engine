import type { Client, Transaction } from '@libsql/client'
import { serviceForOwner, type ExecutionOwner } from './execution-owner.js'
import type { CollaborationStore } from './store.js'
import { CollaborationError, type CollaborationBinding, type CollaborationProducer } from './types.js'

/** The original consumer retains the actual owner; readable bindings cannot grant continuation. */
export function assertDeliveryExecution(store: CollaborationStore, producer: CollaborationProducer,
  binding: CollaborationBinding, owner?: ExecutionOwner): boolean {
  if (!owner) return false
  const service = serviceForOwner(owner)
  if (service.db !== store.db || service.collaboration.store !== store
    || service.producerForExecution(owner) !== producer || service.collaboration.executionBinding(producer) !== binding)
    throw new CollaborationError('forbidden', 'Delivery does not own this exact canonical execution')
  // producerForExecution checks the live ticket, datasource epoch, finish intent,
  // cancellation and terminal settlement on every call, including after awaits.
  return binding.kind === 'child'
}

export async function assertDeliveryProducer(store: CollaborationStore, query: Client | Transaction,
  producer: CollaborationProducer, binding: CollaborationBinding, owner?: ExecutionOwner): Promise<void> {
  const childContinuation = assertDeliveryExecution(store, producer, binding, owner)
  await store.assertProducer(query, binding, !childContinuation)
  assertDeliveryExecution(store, producer, binding, owner)
}
