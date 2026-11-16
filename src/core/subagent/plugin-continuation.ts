import type { CreateSubagentRun, SubagentContinuationProfile, SubagentRunHeader } from './types.js'

// Authorization is attached to the exact host-created admission, never to JSON
// supplied by a model/plugin. Ordinary subagent continuation remains frozen.
const updates = new WeakMap<CreateSubagentRun, { tenantId: string; parentSessionId: string; rootSessionId: string;
  agentId: string; resumeFromRunId: string; continuation: SubagentContinuationProfile }>()

export function authorizePluginContinuationUpdate(input: CreateSubagentRun): CreateSubagentRun {
  if (input.resumeFromRunId && input.agentId && input.continuation?.pluginAgent) updates.set(input, {
    tenantId: input.tenantId, parentSessionId: input.parentSessionId, rootSessionId: input.rootSessionId,
    agentId: input.agentId, resumeFromRunId: input.resumeFromRunId, continuation: structuredClone(input.continuation),
  })
  return input
}

export function pluginContinuationFor(input: CreateSubagentRun, prior: SubagentRunHeader): SubagentContinuationProfile {
  const authorized = updates.get(input)
  if (!authorized) return prior.continuation!
  if (authorized.tenantId !== prior.tenantId || authorized.parentSessionId !== prior.parentSessionId
    || authorized.rootSessionId !== prior.rootSessionId || authorized.agentId !== prior.agentId
    || authorized.resumeFromRunId !== prior.runId || !prior.continuation?.pluginAgent
    || authorized.continuation.projectRoot !== prior.continuation.projectRoot)
    throw new Error('SUBAGENT_RESUME_NOT_OWNED: 插件续跑授权与原任务不一致。')
  return structuredClone(authorized.continuation)
}
