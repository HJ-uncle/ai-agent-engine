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
  elapsedMs: number
}

const empty = (): StageUsage => ({ requests: 0, pendingRequests: 0, failedRequests: 0, unknownUsageRequests: 0,
  promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, elapsedMs: 0 })
const nonnegative = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0

/** Separate physical memory request spend from main-model/context occupancy.
 * Logs contain allowlisted counters only, never memory text or credentials. */
export function createMemoryUsageObserver(logger: Pick<Logger, 'info'> & Partial<Pick<Logger, 'child'>>,
  onAttempt?: LLMAdapterOptions['onRequestAttempt']) {
  const stages: Record<MemoryRequestStage, StageUsage> = { memory_recall: empty(), memory_extraction: empty() }
  const attempts = new Map<string, { stage: MemoryRequestStage; started: number; finished: boolean }>()
  const snapshot = () => ({ recall: { ...stages.memory_recall }, extraction: { ...stages.memory_extraction } })
  const observe = async (event: MemoryRequestAttemptEvent): Promise<void> => {
    const stats = stages[event.stage]
    if (!stats) return
    const existing = attempts.get(event.requestAttemptId)
    if (event.type === 'start') {
      if (existing) return
      await onAttempt?.(event)
      attempts.set(event.requestAttemptId, { stage: event.stage, started: Date.now(), finished: false })
      stats.requests++; stats.pendingRequests++
    } else {
      if (!existing || existing.finished || existing.stage !== event.stage) return
      existing.finished = true
      stats.pendingRequests--
      stats.elapsedMs += Math.max(0, Date.now() - existing.started)
      if (event.outcome !== 'succeeded') stats.failedRequests++
      if (!event.usage || event.usage.unknown) stats.unknownUsageRequests++
      for (const key of ['promptTokens', 'completionTokens', 'cacheHitTokens', 'cacheMissTokens'] as const) stats[key] += nonnegative(event.usage?.[key])
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
