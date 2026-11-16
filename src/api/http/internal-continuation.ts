import { randomUUID } from 'node:crypto'
import type { AuthContext } from '../../auth/types.js'

/**
 * A short lived process-local capability for an engine-owned continuation.
 * It is never persisted, exposed in an SSE frame, or accepted from a user
 * request without a matching in-memory ticket.  The original authenticated
 * principal is carried forward so an automatic resume cannot widen access.
 */
export const INTERNAL_CONTINUATION_HEADER = 'x-aether-internal-continuation'

interface Ticket {
  auth: AuthContext
  expiresAt: number
}

const tickets = new Map<string, Ticket>()
const ttlMs = 2 * 60 * 1000

function prune(now = Date.now()): void {
  for (const [token, ticket] of tickets) if (ticket.expiresAt <= now) tickets.delete(token)
}

export function mintInternalContinuation(auth: AuthContext): string {
  const token = randomUUID()
  tickets.set(token, { auth: structuredClone(auth), expiresAt: Date.now() + ttlMs })
  prune()
  return token
}

export function resolveInternalContinuation(token: unknown): AuthContext | undefined {
  if (typeof token !== 'string' || token.length < 20 || token.length > 128) return undefined
  const ticket = tickets.get(token)
  if (!ticket || ticket.expiresAt <= Date.now()) {
    tickets.delete(token)
    return undefined
  }
  return structuredClone(ticket.auth)
}

export function revokeInternalContinuation(token: string): void {
  tickets.delete(token)
}

export function clearInternalContinuations(): void {
  tickets.clear()
}
