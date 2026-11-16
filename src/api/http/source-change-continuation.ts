import type { FastifyInstance } from 'fastify'
import type { AuthContext } from '../../auth/types.js'
import { rootRunStore } from '../../storage/root-runs/index.js'
import { getSourceChangeWaitStatus } from '../../runtime/source-change-wait.js'
import type { SourceChangePendingAction } from '../../runtime/source-change-protocol.js'
import { INTERNAL_CONTINUATION_HEADER, mintInternalContinuation } from './internal-continuation.js'

interface StoredContinuationRun {
  runId: string
  sessionId: string
  status: string
  pending: Array<{
    requestId: string
    toolCallId: string
    toolName: string
    pendingAction?: Record<string, unknown>
    status: string
  }>
  request?: Record<string, unknown>
}

interface Scheduled {
  app: FastifyInstance
  timer?: ReturnType<typeof setTimeout>
  stopped: boolean
}

const scheduled = new Map<string, Scheduled>()

const keyOf = (tenantId: string, runId: string, requestId: string): string =>
  JSON.stringify([tenantId, runId, requestId])

function routePath(app: FastifyInstance): string {
  const prefix = typeof (app as FastifyInstance & { prefix?: unknown }).prefix === 'string'
    ? String((app as FastifyInstance & { prefix?: string }).prefix)
    : ''
  return `${prefix.replace(/\/$/, '')}/chat` || '/chat'
}

function waitAction(value: unknown): SourceChangePendingAction | undefined {
  if (!value || typeof value !== 'object' || (value as { type?: unknown }).type !== 'source_change') return undefined
  const action = value as Partial<SourceChangePendingAction>
  return action.wait?.mode === 'external-writer' && action.after && typeof action.root === 'string'
    ? action as SourceChangePendingAction : undefined
}

/**
 * Keep a parked source-change run visible while another execution owns the
 * overlapping workspace. Once the authoritative wait probe reports a stable
 * window, resume the exact parked tool call with `recheck`. The route itself
 * performs all normal admission, identity, policy and final source checks.
 */
export function scheduleSourceChangeContinuation(input: {
  app: FastifyInstance
  tenantId: string
  sessionId: string
  runId: string
  requestId: string
  auth: AuthContext
}): void {
  const key = keyOf(input.tenantId, input.runId, input.requestId)
  if (scheduled.has(key)) return
  const state: Scheduled = { app: input.app, stopped: false }
  scheduled.set(key, state)

  const poll = async (): Promise<void> => {
    if (state.stopped) return
    try {
      const stored = await rootRunStore.get(input.tenantId, input.runId) as unknown as StoredContinuationRun | null
      const pending = stored?.pending.find(item => item.requestId === input.requestId && item.status === 'pending')
      const action = waitAction(pending?.pendingAction)
      if (!stored || stored.sessionId !== input.sessionId || stored.status !== 'waiting' || !pending || !action) {
        scheduled.delete(key)
        return
      }
      const status = await getSourceChangeWaitStatus({
        tenantId: input.tenantId,
        root: action.root,
        currentSessionId: stored.sessionId,
        currentRunId: stored.runId,
        snapshot: action.after,
        stableWindowMs: action.wait!.stableWindowMs,
      })
      if (status.ready) {
        const request = stored.request ?? {}
        const body = {
          ...request,
          message: '',
          sessionId: stored.sessionId,
          toolResponse: {
            toolCallId: pending.toolCallId,
            name: pending.toolName,
            output: 'recheck',
            requestId: pending.requestId,
            runId: stored.runId,
          },
        }
        const ticket = mintInternalContinuation(input.auth)
        const response = await input.app.inject({
          method: 'POST',
          url: routePath(input.app),
          headers: {
            'content-type': 'application/json',
            [INTERNAL_CONTINUATION_HEADER]: ticket,
            'x-aether-tool-profile': typeof request.toolProfile === 'string' ? request.toolProfile : 'general',
            'x-aether-run-lifetime': 'durable',
            'x-aether-subagent-protocol': '2',
          },
          payload: body,
        })
        // A successful injection owns the resumed stream. The stream may end
        // in another wait (for example a second source race); the next poll
        // observes the new durable request and either continues or stops.
        if (response.statusCode >= 200 && response.statusCode < 300) {
          const latest = await rootRunStore.get(input.tenantId, input.runId) as unknown as StoredContinuationRun | null
          const next = latest?.pending.find(item => item.requestId === input.requestId && item.status === 'pending')
          if (!waitAction(next?.pendingAction)) scheduled.delete(key)
          else {
            state.timer = setTimeout(() => { void poll() }, 2_000)
            state.timer.unref()
          }
          return
        }
      }
    } catch {
      // A transient database/transport failure is intentionally treated as
      // “still waiting”. The next bounded poll retries without guessing that
      // the external writer has ended.
    }
    if (!state.stopped) {
      state.timer = setTimeout(() => { void poll() }, 2_000)
      state.timer.unref()
    }
  }
  void poll()
}

export function cancelSourceChangeContinuations(app?: FastifyInstance): void {
  for (const [key, state] of scheduled) {
    if (app && state.app !== app) continue
    state.stopped = true
    if (state.timer) clearTimeout(state.timer)
    scheduled.delete(key)
  }
}
