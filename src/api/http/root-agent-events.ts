import type { RootRun } from '../../storage/root-runs/index.js'
import { emitAgentLifecycleEvent, type AgentLifecycleEvent } from '../../core/runtime-events.js'

const observed = new Map<string, { started: boolean; terminal: boolean }>()
/** Observe durable receipts, including user cancellation outside the SSE producer.
 * A waiting/continued attempt is still the same Agent run, not another start. */
export function publishRootAgentEvent(tenantId: string, run: RootRun): void {
  const type: AgentLifecycleEvent['type'] | undefined = run.status === 'running' && run.startedAt !== undefined ? 'agent.started'
    : run.status === 'succeeded' ? 'agent.completed' : run.status === 'cancelled' ? 'agent.cancelled'
      : run.status === 'failed' || run.status === 'interrupted' ? 'agent.failed' : undefined
  if (!type) return
  const key = JSON.stringify([tenantId, run.sessionId, run.runId]), previous = observed.get(key) ?? { started: false, terminal: false }
  if (previous.terminal || type === 'agent.started' && previous.started) return
  if (type === 'agent.started') previous.started = true; else previous.terminal = true
  observed.delete(key); observed.set(key, previous)
  while (observed.size > 4096) observed.delete(observed.keys().next().value!)
  emitAgentLifecycleEvent({ tenantId, sessionId: run.sessionId, type, payload: { kind: 'main', runId: run.runId,
    status: run.status, turnId: run.turnId, ...(run.requestConfig?.agentId ? { agentId: run.requestConfig.agentId } : {}) } })
}
