import type { AuthContext } from '../auth/types.js'
import type { AgentContext, BrowserPrincipal } from './agent-context/types.js'

export interface BrowserExecutionIdentity {
  rootSessionId: string
  rootRunId: string
  ownerRunId: string
}

export type BrowserExecutionContext = Pick<AgentContext, 'tenantId' | 'sessionId' | 'rootSessionId' | 'rootRunId' | 'runId' | 'browserPrincipal' | 'browserAuthority' | 'signal'>

const id = (value: unknown): value is string => typeof value === 'string' && value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)

/** Current admission and actual child execution only; continuation snapshots are never consulted. */
export function browserExecutionIdentity(context: BrowserExecutionContext): Readonly<BrowserExecutionIdentity> | undefined {
  const rootSessionId = context.rootSessionId ?? context.sessionId
  const rootRunId = context.rootRunId
  // A child without its own execution identity must not masquerade as the root.
  if (context.sessionId !== rootSessionId && !id(context.runId)) return undefined
  const ownerRunId = context.runId ?? rootRunId
  if (!id(rootSessionId) || !id(rootRunId) || !id(ownerRunId)) return undefined
  return Object.freeze({ rootSessionId, rootRunId, ownerRunId })
}

export function browserExecutionsMatch(left: unknown, right: BrowserExecutionIdentity): boolean {
  if (!left || typeof left !== 'object' || Array.isArray(left)) return false
  const value = left as Record<string, unknown>
  return value.rootSessionId === right.rootSessionId && value.rootRunId === right.rootRunId && value.ownerRunId === right.ownerRunId
}

/** Authenticated request state, never request body/metadata; no credentials enter the context. */
export function browserPrincipalFromAuth(auth?: AuthContext): Readonly<BrowserPrincipal> {
  return Object.freeze({ tenantId: auth?.tenantId ?? 'default', userId: auth?.userId, method: auth?.method ?? 'none' })
}
