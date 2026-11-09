import type { Logger } from 'pino'
import type { LLMAdapterOptions } from '../../core/llm-adapter/types.js'
import type { MemoryRequestAttemptEvent, MemoryRequestStage } from './types.js'

interface StageUsage {
  requests: number
  pendingRequests: number
  failedRequests: number
  unknownUsageRequests: number
  promptTokens: number
  completionTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
  unknownCacheHitRequests: number
  unknownCacheMissRequests: number
  derivedCacheMissRequests: number
  providerCacheMissTokens: number
  providerCacheMissKnownRequests: number
  elapsedMs: number
}

const empty = (): StageUsage => ({ requests: 0, pendingRequests: 0, failedRequests: 0, unknownUsageRequests: 0,
  promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, unknownCacheHitRequests: 0,
  unknownCacheMissRequests: 0, derivedCacheMissRequests: 0, providerCacheMissTokens: 0,
  providerCacheMissKnownRequests: 0, elapsedMs: 0 })
const nonnegative = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
const reported = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0

/** Separate physical memory request spend from main-model/context occupancy.
 * Logs contain allowlisted counters only, never memory text or credentials. */
export function createMemoryUsageObserver(logger: Pick<Logger, 'info'> & Partial<Pick<Logger, 'child'>>,
  onAttempt?: LLMAdapterOptions['onRequestAttempt']) {
  const stages: Record<MemoryRequestStage, StageUsage> = { memory_recall: empty(), memory_extraction: empty() }
  const attempts = new Map<string, { stage: MemoryRequestStage; started: number; finished: boolean }>()
  const stageSnapshot = (stats: StageUsage) => ({ ...stats,
    cacheHitTokens: stats.unknownCacheHitRequests ? null : stats.cacheHitTokens,
    cacheMissTokens: stats.unknownCacheMissRequests ? null : stats.cacheMissTokens })
  const snapshot = () => ({ recall: stageSnapshot(stages.memory_recall), extraction: stageSnapshot(stages.memory_extraction) })
  const observe = async (event: MemoryRequestAttemptEvent): Promise<void> => {
    const stats = stages[event.stage]
    if (!stats) return
    const existing = attempts.get(event.requestAttemptId)
    if (event.type === 'start') {
      if (existing) return
      const attempt = { stage: event.stage, started: Date.now(), finished: false }
      attempts.set(event.requestAttemptId, attempt)
      stats.requests++; stats.pendingRequests++
      try { await onAttempt?.(event) }
      catch (error) {
        attempts.delete(event.requestAttemptId)
        stats.requests--; stats.pendingRequests--
        throw error
      }
    } else {
      if (!existing || existing.finished || existing.stage !== event.stage) return
      existing.finished = true
      stats.pendingRequests--
      stats.elapsedMs += Math.max(0, Date.now() - existing.started)
      if (event.outcome !== 'succeeded') stats.failedRequests++
      if (!event.usage || event.usage.unknown) stats.unknownUsageRequests++
      for (const key of ['promptTokens', 'completionTokens'] as const) stats[key] += nonnegative(event.usage?.[key])
      const hit = event.usage?.cacheHitTokens, miss = event.usage?.cacheMissTokens
      if (reported(hit)) stats.cacheHitTokens += hit
      else stats.unknownCacheHitRequests++
      if (reported(miss)) { stats.providerCacheMissTokens += miss; stats.providerCacheMissKnownRequests++ }
      if (event.usage && !event.usage.unknown && reported(hit) && reported(event.usage.promptTokens)) {
        // Total input includes reads. Anthropic's reported creation counter
        // covers writes only; it cannot stand in for all uncached input.
        const uncached = Math.max(0, event.usage.promptTokens - hit)
        stats.cacheMissTokens += uncached
        if (!reported(miss) || miss !== uncached) stats.derivedCacheMissRequests++
      } else if (reported(miss)) stats.cacheMissTokens += miss
      else stats.unknownCacheMissRequests++
      await onAttempt?.(event)
    }
    try {
      const sink = typeof logger.child === 'function' ? logger.child({}, { level: 'info' }) : logger
      sink.info({ event: 'memory.request', stage: event.stage, type: event.type, requestAttemptId: event.requestAttemptId,
        ...(event.type === 'finish' ? { outcome: event.outcome } : {}), memoryUsage: snapshot() }, 'Memory auxiliary request accounting')
    } catch { /* Observability does not change provider outcomes. */ }
  }
  return { observe, snapshot }
}
