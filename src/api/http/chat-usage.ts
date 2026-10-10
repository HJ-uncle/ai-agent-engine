import { BILLING_USAGE_KEYS } from '../../storage/conversation/usage.js'
import type { SubagentRun } from '../../core/subagent/types.js'

/** ReAct counters reset per attempt; an approval continuation keeps its turn. */
export function continuedTurnUsage(previous: Record<string, number>, current: Record<string, unknown>): Record<string, unknown> {
  const usage = { ...current }
  for (const key of BILLING_USAGE_KEYS) {
    const value = current[key]
    if (typeof value === 'number' && Number.isFinite(value)) usage[key] = (previous[key] ?? 0) + value
  }
  // currentPromptTokens/contextWindow/modelId describe the latest call and
  // intentionally remain untouched. Model-only updates add no billing usage.
  return usage
}

/** Durable history may be ahead of SSE; replace only the active turn at its cursor. */
export function sessionUsageAtWatermark(session: Record<string, number>, persistedTurn: Record<string, number>,
  publishedTurn?: Record<string, unknown>): Record<string, number> {
  return Object.fromEntries(BILLING_USAGE_KEYS.map(key => {
    let published = publishedTurn?.[key]
    if (key === 'totalTokens' && published === undefined) {
      const input = publishedTurn?.promptTokens, output = publishedTurn?.completionTokens
      published = (typeof input === 'number' && Number.isFinite(input) ? input : 0)
        + (typeof output === 'number' && Number.isFinite(output) ? output : 0)
    }
    return [key, Math.max(0, (session[key] ?? 0) - (persistedTurn[key] ?? 0)
      + (typeof published === 'number' && Number.isFinite(published) ? published : 0))]
  }))
}

export function sessionSubagentRunsAtWatermark(runs: SubagentRun[], ctx: { tenantId: string; sessionId: string },
  activeTurnId?: string, projection: Record<string, unknown>[] = []): SubagentRun[] {
  const visible = new Map<string, SubagentRun>()
  const add = (candidate: unknown) => {
    if (!candidate || typeof candidate !== 'object') return
    const run = candidate as SubagentRun
    if (typeof run.runId !== 'string' || run.tenantId !== ctx.tenantId || run.parentSessionId !== ctx.sessionId) return
    if (!visible.has(run.runId) || visible.get(run.runId)!.lastSeq < run.lastSeq) visible.set(run.runId, run)
  }
  for (const run of runs) if (activeTurnId === undefined || run.parentConversationId !== activeTurnId) add(run)
  if (activeTurnId !== undefined) for (const envelope of projection) {
    const event = envelope.subagentEvent as { snapshot?: unknown } | undefined
    const tool = (envelope.toolResult ?? envelope.toolEnd) as { subagent?: unknown; metadata?: { subagent?: unknown } } | undefined
    const candidate = event?.snapshot ?? tool?.subagent ?? tool?.metadata?.subagent
    if (candidate && typeof candidate === 'object' && (candidate as SubagentRun).parentConversationId === activeTurnId) add(candidate)
  }
  return [...visible.values()]
}

export function sessionSubagentUsage(runs: SubagentRun[], ctx: { tenantId: string; sessionId: string },
  activeTurnId?: string, projection: Record<string, unknown>[] = []): {
  totalTokens: number; count: number; unknown: number; finishedAt?: number
} {
  const visible = sessionSubagentRunsAtWatermark(runs, ctx, activeTurnId, projection)
  let totalTokens = 0, unknown = 0, finishedAt: number | undefined
  for (const run of visible) {
    const usage = run.usage ?? {}
    const tokens = usage.totalTokens ?? (usage.inputTokens !== undefined && usage.outputTokens !== undefined
      ? usage.inputTokens + usage.outputTokens : undefined)
    if (usage.unknown || tokens === undefined || !Number.isFinite(tokens)) unknown++
    if (tokens !== undefined && Number.isFinite(tokens)) totalTokens += Math.max(0, tokens)
    if (run.finishedAt && (finishedAt === undefined || run.finishedAt > finishedAt)) finishedAt = run.finishedAt
  }
  return { totalTokens, count: visible.length, unknown, ...(finishedAt === undefined ? {} : { finishedAt }) }
}
