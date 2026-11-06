import type { Client } from '@libsql/client'
import { compactTerminalHistoryMaintenance, type HistoryMaintenanceCompactionOptions,
  type HistoryMaintenanceCompactionResult } from './history-maintenance-storage.js'

export interface HistoryMaintenanceLifecycleOptions {
  enabled?: boolean
  startupDelayMs?: number
  intervalMs?: number
  backlogDelayMs?: number
  batchSize?: number
  maxRows?: number
  maxPayloadBytes?: number
  onResult?: (result: HistoryMaintenanceCompactionResult) => void
  onError?: (error: unknown) => void
}
function configured(name: string, value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  const input = value ?? (process.env[name] ? Number(process.env[name]) : fallback)
  return Number.isSafeInteger(input) && input >= minimum && input <= maximum ? input : fallback
}

/** Call after DB initialization; await stop() before closing DB. Each wake processes a bounded work slice. */
export function startHistoryMaintenance(db: Client, options: HistoryMaintenanceLifecycleOptions = {}): { stop(): Promise<void> } {
  const abort = new AbortController()
  const startup = configured('HISTORY_MAINTENANCE_STARTUP_DELAY_MS', options.startupDelayMs, 30_000, 0, 86_400_000)
  const interval = configured('HISTORY_MAINTENANCE_INTERVAL_MS', options.intervalMs, 3_600_000, 1000, 86_400_000)
  const backlog = configured('HISTORY_MAINTENANCE_BACKLOG_DELAY_MS', options.backlogDelayMs, 1000, 1, 86_400_000)
  const budgets: HistoryMaintenanceCompactionOptions = {
    batchSize: configured('HISTORY_MAINTENANCE_BATCH_SIZE', options.batchSize, 16, 1, 256),
    maxRows: configured('HISTORY_MAINTENANCE_MAX_ROWS', options.maxRows, 128, 1, 100_000),
    maxPayloadBytes: configured('HISTORY_MAINTENANCE_MAX_BYTES', options.maxPayloadBytes, 8 * 1024 * 1024, 1, 256 * 1024 * 1024), signal: abort.signal,
  }
  const onError = options.onError ?? (error => console.warn('[history-maintenance]', error instanceof Error ? error.message : String(error)))
  let stopped = !(options.enabled ?? process.env.HISTORY_MAINTENANCE_ENABLED !== 'false')
  let timer: ReturnType<typeof setTimeout> | undefined, running: Promise<void> | undefined, afterId: string | undefined
  const reportError = (error: unknown) => { try { onError(error) } catch { /* Reporting cannot break shutdown. */ } }
  const schedule = (delay: number) => {
    if (stopped) return
    timer = setTimeout(() => {
      timer = undefined
      running = (async () => {
        let delay = interval
        try {
          const result = await compactTerminalHistoryMaintenance(db, { ...budgets, afterId })
          afterId = result.hasMore ? result.afterId : undefined
          if (result.hasMore) delay = backlog
          if (result.skippedCorrupt) reportError(new Error(`Retained ${result.skippedCorrupt} corrupt maintenance payloads for diagnosis`))
          options.onResult?.(result)
        } catch (error) { afterId = undefined; reportError(error) }
        finally { schedule(delay) }
      })()
    }, delay)
    timer.unref()
  }
  schedule(startup)
  return { async stop() { stopped = true; abort.abort(); if (timer) clearTimeout(timer); await running } }
}
