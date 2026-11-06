import { auditLogStore, type AuditLogStore, type AuditRetentionPolicy } from './audit-log.js'

export interface AuditMaintenanceOptions {
  store?: Pick<AuditLogStore, 'maintain'>
  policy?: AuditRetentionPolicy
  intervalMs?: number
  backlogDelayMs?: number
  batchSize?: number
  maxBatches?: number
  maxBatchBytes?: number
  onError?: (error: unknown) => void
}

function configuredInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = process.env[name]
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback
}

export function auditRetentionPolicyFromEnvironment(): AuditRetentionPolicy {
  // Zero disables expiry for a tier. Archives are retained indefinitely; this policy only moves evidence out of the online DB.
  return { allowDays: configuredInteger('AUDIT_RETENTION_ALLOW_DAYS', 30, 0, 36500),
    importantDays: configuredInteger('AUDIT_RETENTION_IMPORTANT_DAYS', 180, 0, 36500) }
}

/** Start after initDb; stop and await completion before closing SQLite. No detached work survives stop(). */
export function startAuditMaintenance(options: AuditMaintenanceOptions = {}): { stop(): Promise<void> } {
  const controller = new AbortController()
  const store = options.store ?? auditLogStore
  const intervalMs = options.intervalMs ?? configuredInteger('AUDIT_MAINTENANCE_INTERVAL_MS', 3_600_000, 1000, 86_400_000)
  const backlogDelayMs = options.backlogDelayMs ?? 1000
  const policy = options.policy ?? auditRetentionPolicyFromEnvironment()
  const onError = options.onError ?? (error => console.warn('[AuditLog] maintenance failed:', error instanceof Error ? error.message : String(error)))
  let timer: ReturnType<typeof setTimeout> | undefined
  let running: Promise<void> | undefined
  let stopped = process.env.AUDIT_MAINTENANCE_ENABLED === 'false'

  const schedule = (delay: number) => {
    if (stopped) return
    timer = setTimeout(() => {
      timer = undefined
      running = (async () => {
        let backlog = false
        try {
          const result = await store.maintain(policy, { signal: controller.signal,
            batchSize: options.batchSize ?? configuredInteger('AUDIT_MAINTENANCE_BATCH_SIZE', 250, 1, 500),
            maxBatchBytes: options.maxBatchBytes ?? configuredInteger('AUDIT_MAINTENANCE_BATCH_BYTES', 4 * 1024 * 1024, 65536, 64 * 1024 * 1024),
            maxBatches: options.maxBatches ?? configuredInteger('AUDIT_MAINTENANCE_MAX_BATCHES', 4, 1, 100) })
          backlog = result.hasBacklog
        } catch (error) { try { onError(error) } catch { /* Logging cannot orphan the lifecycle promise. */ } }
        finally { if (!stopped) schedule(backlog ? backlogDelayMs : intervalMs) }
      })()
    }, Math.max(0, delay))
    timer.unref()
  }
  schedule(0)
  return {
    async stop() {
      stopped = true
      controller.abort()
      if (timer) clearTimeout(timer)
      await running
    },
  }
}
