import type { AgentContext } from '../core/agent-context/types.js'
import { serviceForOwner, type ExecutionOwner, type ExecutionOwners } from '../core/collaboration/execution-owner.js'
import type { CollaborationBinding } from '../core/collaboration/types.js'

interface Binding { sessionId: string; pluginId: string; userId?: string }
const bindings = new WeakMap<ExecutionOwners, Map<string, Readonly<Binding>>>()
const key = (binding: CollaborationBinding) => JSON.stringify([
  binding.tenantId, binding.rootSessionId, binding.rootRunId, binding.rootAttemptId, binding.generation,
])

/** Host-only delegation: retain the genuine execution identity while targeting its bound user's workbench. */
export function bindPluginWorkbench(owner: ExecutionOwner, input: Binding): () => void {
  const service = serviceForOwner(owner)
  const execution = service.collaboration.executionBinding(service.producer(owner))
  if (execution.kind !== 'root' || !input.sessionId || !input.pluginId) throw new Error('PLUGIN_WORKBENCH_AUTHORITY')
  let roots = bindings.get(service)
  if (!roots) { roots = new Map(); bindings.set(service, roots) }
  const id = key(execution), binding = Object.freeze({ ...input })
  if (roots.has(id)) throw new Error('PLUGIN_WORKBENCH_ALREADY_BOUND')
  roots.set(id, binding)
  return () => { if (roots!.get(id) === binding) roots!.delete(id) }
}

export type PluginWorkbenchContext = Pick<AgentContext,
  'tenantId' | 'sessionId' | 'rootSessionId' | 'rootRunId' | 'runId' | 'executionOwner' | 'browserPrincipal'>

/** Never consult model/plugin JSON or persisted metadata to establish a live UI delegation. */
export function pluginWorkbenchBinding(ctx: PluginWorkbenchContext): Readonly<Binding> | undefined {
  if (!ctx.executionOwner) return undefined
  const service = serviceForOwner(ctx.executionOwner)
  const execution = service.collaboration.executionBinding(service.producerForExecution(ctx.executionOwner))
  const binding = bindings.get(service)?.get(key(execution))
  if (!binding) return undefined
  if (execution.tenantId !== ctx.tenantId || execution.sessionId !== ctx.sessionId
    || execution.rootSessionId !== (ctx.rootSessionId ?? ctx.sessionId) || execution.rootRunId !== ctx.rootRunId
    || (execution.kind === 'root' ? execution.rootRunId : execution.invocationRunId) !== (ctx.runId ?? ctx.rootRunId)
    || binding.userId !== ctx.browserPrincipal?.userId) throw new Error('PLUGIN_WORKBENCH_CONTEXT_MISMATCH')
  return binding
}
