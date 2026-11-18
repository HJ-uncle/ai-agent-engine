/** Fixed operational labels only; paths, queries and tool output are never stage names. */
export const SHUTDOWN_STAGES = [
  'engine.shutdown', 'engine.consolidator.stop', 'engine.skills.stop',
  'http.server.close', 'http.owned.stop', 'http.cron.stop', 'http.executions.stop',
  'http.terminals.stop', 'http.commands.stop', 'http.onClose', 'sqlite.knowledge.close',
  'maintenance.audit.stop', 'maintenance.history.stop', 'sqlite.memory.close', 'sqlite.main.close',
] as const
export type ShutdownStage = typeof SHUTDOWN_STAGES[number]

export interface ShutdownLogger {
  info(record: Record<string, unknown>, message: string): void
  warn(record: Record<string, unknown>, message: string): void
  child?(bindings: Record<string, never>, options: { level: 'info' }): ShutdownLogger
}

const allowedStages = new Set<string>(SHUTDOWN_STAGES)
const DEFAULT_PENDING_AFTER_MS = 10_000
const sqliteStages = new Set<ShutdownStage>(['sqlite.main.close', 'sqlite.memory.close', 'sqlite.knowledge.close'])
const receiptBooleans = ['requested', 'acknowledged', 'nativeClosed', 'exited', 'stdioClosed', 'forcedKill', 'healthy'] as const
const receiptCounts = ['sourceEpoch', 'pendingOperationsAtRequest', 'transactionsAtRequest'] as const
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const errorList = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string')
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0

/** Settled receipts only; absent evidence is never a guessed lifecycle state. */
function logSqliteReceipt(logger: ShutdownLogger, stage: ShutdownStage, value: unknown): void {
  if (!sqliteStages.has(stage)) return
  try {
    if (!record(value) || typeof value.healthy !== 'boolean' || !errorList(value.errors) || !Array.isArray(value.receipts)) return
    const receipts: Record<string, unknown>[] = []
    for (const receipt of value.receipts) {
      if (!record(receipt) || !receiptBooleans.every(key => typeof receipt[key] === 'boolean')
        || !receiptCounts.every(key => count(receipt[key])) || !errorList(receipt.errors)
        || !(receipt.pid === null || count(receipt.pid))
        || !(receipt.exitCode === null || Number.isSafeInteger(receipt.exitCode))) return
      // Never spread the receipt or include errors/signal/custom properties.
      receipts.push(Object.fromEntries([
        ...receiptCounts.map(key => [key, receipt[key]]), ['pid', receipt.pid], ['exitCode', receipt.exitCode],
        ...receiptBooleans.map(key => [key, receipt[key]]), ['errorCount', receipt.errors.length],
      ]))
    }
    const summary = { event: 'shutdown.sqlite.close', schemaVersion: 1, stage, healthy: value.healthy,
      errorCount: value.errors.length, receiptCount: receipts.length, receipts }
    if (value.healthy) logger.info(summary, 'SQLite shutdown receipt settled')
    else logger.warn(summary, 'SQLite shutdown receipt is unhealthy')
  } catch { /* Receipt diagnostics cannot change the actual close result. */ }
}

/** Observe the actual join; elapsed time is never a close receipt or a deadline. */
export async function observeShutdownStage<T>(
  logger: ShutdownLogger, stage: ShutdownStage, operation: () => T | PromiseLike<T>,
  options: { pendingAfterMs?: number } = {},
): Promise<Awaited<T>> {
  if (!allowedStages.has(stage)) throw new TypeError('Unknown shutdown stage')
  let sink = logger
  // Keep this allowlisted evidence visible without changing the application's
  // log level. Diagnostics must never prevent the actual cleanup from running.
  try { sink = logger.child?.({}, { level: 'info' }) ?? logger } catch { /* Use the original sink. */ }
  const started = performance.now()
  const emit = (phase: 'start' | 'pending' | 'end', outcome?: 'fulfilled' | 'rejected') => {
    const record = { event: 'shutdown.stage', schemaVersion: 1, stage, phase,
      elapsedMs: phase === 'start' ? 0 : Math.max(0, Math.round(performance.now() - started)),
      ...(outcome ? { outcome } : {}) }
    // No thrown message, error object, operation arguments or returned data
    // enters diagnostics. A fulfilled promise does not imply a healthy receipt.
    try {
      if (phase === 'pending') sink.warn(record, 'Shutdown stage still pending')
      else sink.info(record, phase === 'start' ? 'Shutdown stage started' : 'Shutdown stage finished')
    } catch { /* Logging cannot change the close result. */ }
  }
  emit('start')
  const delay = Number.isSafeInteger(options.pendingAfterMs) && options.pendingAfterMs! > 0
    ? options.pendingAfterMs! : DEFAULT_PENDING_AFTER_MS
  const pending = setTimeout(() => emit('pending'), delay)
  pending.unref()
  try {
    const result = await operation()
    logSqliteReceipt(sink, stage, result)
    emit('end', 'fulfilled')
    return result
  } catch (error) {
    emit('end', 'rejected')
    throw error
  } finally { clearTimeout(pending) }
}
