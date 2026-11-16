/** Host lifecycle bus. No plugin dependency, model text, credentials or task payloads. */
export interface AgentLifecycleEvent {
  tenantId: string
  sessionId: string
  type: 'agent.started' | 'agent.completed' | 'agent.failed' | 'agent.cancelled'
  payload: { kind: 'main' | 'subagent'; runId: string; status: string; childSessionId?: string; parentSessionId?: string; rootSessionId?: string; agentId?: string; turnId?: string }
}
const listeners = new Set<(event: AgentLifecycleEvent) => void>()
export function onAgentLifecycleEvent(listener: (event: AgentLifecycleEvent) => void): () => void { listeners.add(listener); return () => { listeners.delete(listener) } }
/** Observers cannot delay or fail the producer, including when a plugin is broken. */
export function emitAgentLifecycleEvent(event: AgentLifecycleEvent): void {
  for (const listener of listeners) { try { listener(event) } catch { /* Observation never changes Agent outcomes. */ } }
}
