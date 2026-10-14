/** Runtime capabilities are object identities, never serialized tool arguments. */
declare const producerBrand: unique symbol
export interface CollaborationProducer { readonly [producerBrand]: true }
export type CollaborationPhase = 'open' | 'draining' | 'closed' | 'interrupted'
export interface CollaborationBinding {
  tenantId: string
  rootRunId: string
  rootAttemptId: string
  rootSessionId: string
  turnId: string
  generation: string
  participantId: string
  sessionId: string
  invocationRunId: string
  kind: 'root' | 'child'
}
export interface CollaborationRootScope {
  tenantId: string
  rootRunId: string
  rootAttemptId: string
  rootSessionId: string
}
export interface CollaborationParticipant {
  participantId: string
  parentParticipantId?: string
  kind: 'root' | 'child'
  sessionId: string
  invocationRunId: string
  admittedSeq: number
  admittedAt: number
}
/** Acceptance is durable queueing. There is deliberately no processed/delivered claim. */
export interface CollaborationReceipt {
  messageId: string
  rootRunId: string
  rootAttemptId: string
  senderParticipantId: string
  senderInvocationRunId: string
  recipientParticipantId: string
  requestKey: string
  payloadHash: string
  payloadBytes: number
  acceptedSeq: number
  acceptedAt: number
  state: 'queued' | 'rejected' | 'interrupted'
  reason?: string
}
export interface CollaborationPage<T> {
  entries: T[]
  /** Exact immutable admission prefix; lifecycle states are current reads. */
  revision: number
  hasMore: boolean
  nextCursor?: string
}
export class CollaborationError extends Error {
  constructor(readonly code: 'invalid' | 'forbidden' | 'not_found' | 'conflict' | 'closed' | 'too_large' | 'full', message: string) {
    super(message)
    this.name = 'CollaborationError'
  }
}
