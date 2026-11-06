import type { Client } from '@libsql/client'
import type { CollaborationRootScope } from './types.js'

const listeners = new WeakMap<Client, Map<string, Set<() => void>>>()
const key = (scope: CollaborationRootScope, participantId: string) =>
  JSON.stringify([scope.tenantId, scope.rootRunId, scope.rootAttemptId, participantId])

/** Signals are hints only; observers recheck the durable queue before waking a model. */
export function subscribeInbox(db: Client, scope: CollaborationRootScope, participantId: string, listener: () => void): () => void {
  let byRecipient = listeners.get(db)
  if (!byRecipient) { byRecipient = new Map(); listeners.set(db, byRecipient) }
  const id = key(scope, participantId)
  let group = byRecipient.get(id)
  if (!group) { group = new Set(); byRecipient.set(id, group) }
  group.add(listener)
  return () => {
    group!.delete(listener)
    if (!group!.size) byRecipient!.delete(id)
    if (!byRecipient!.size) listeners.delete(db)
  }
}

export function notifyInbox(db: Client, scope: CollaborationRootScope, participantId: string): void {
  for (const listener of listeners.get(db)?.get(key(scope, participantId)) ?? []) listener()
}
