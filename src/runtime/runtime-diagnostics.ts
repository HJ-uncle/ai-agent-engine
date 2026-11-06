import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { getHeapStatistics } from 'node:v8'
import { getRuntimeIdentity } from './identity.js'

export interface RuntimeDiagnostics {
  schemaVersion: 1
  instanceId: string
  pid: number
  sampledAt: number
  uptimeMs: number
  collection: { minIntervalMs: number; idleTimeoutMs: number; delayResolutionMs: number; sampleWindowMs?: number }
  memory: {
    rssBytes: number; heapUsedBytes: number; heapTotalBytes: number; heapLimitBytes: number
    externalBytes: number; arrayBuffersBytes: number
  }
  eventLoop: {
    state: 'warming' | 'available'
    intervalMs: number | null
    utilization: number | null
    delay: { meanMs: number; p95Ms: number; maxMs: number } | null
  }
}

/** Explicit refreshes measure one bounded window. Legacy interval reads retain
 * their shared cache and stop their histogram after the last client goes idle. */
export function createRuntimeDiagnostics(options: { minIntervalMs?: number; idleTimeoutMs?: number; sampleWindowMs?: number } = {}) {
  const minIntervalMs = Math.max(10, options.minIntervalMs ?? 5_000)
  const idleTimeoutMs = Math.max(minIntervalMs * 2, options.idleTimeoutMs ?? 15_000)
  const delayResolutionMs = 20
  const sampleWindowMs = Math.max(delayResolutionMs * 3, Math.min(1000, options.sampleWindowMs ?? 200))
  const histogram = monitorEventLoopDelay({ resolution: delayResolutionMs })
  let timer: ReturnType<typeof setTimeout> | undefined
  let cached: RuntimeDiagnostics | null = null
  let cachedAt = 0
  let previous: ReturnType<typeof performance.eventLoopUtilization> | null = null
  let active = false
  let disposed = false
  let refreshing: Promise<RuntimeDiagnostics> | null = null
  let cancelRefresh: (() => void) | null = null

  const snapshot = (eventLoop: RuntimeDiagnostics['eventLoop'], windowMs?: number): RuntimeDiagnostics => {
    const memory = process.memoryUsage()
    const heap = getHeapStatistics()
    return {
      schemaVersion: 1,
      instanceId: getRuntimeIdentity().instanceId,
      pid: process.pid,
      sampledAt: Date.now(),
      uptimeMs: process.uptime() * 1000,
      collection: { minIntervalMs, idleTimeoutMs, delayResolutionMs, ...(windowMs === undefined ? {} : { sampleWindowMs: windowMs }) },
      memory: {
        rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, heapTotalBytes: memory.heapTotal,
        heapLimitBytes: heap.heap_size_limit, externalBytes: memory.external,
        arrayBuffersBytes: memory.arrayBuffers,
      },
      eventLoop,
    }
  }

  const stop = () => {
    clearTimeout(timer)
    timer = undefined
    if (active) histogram.disable()
    histogram.reset()
    active = false
    cached = null
    previous = null
  }

  return {
    /** One explicit refresh owns a short measurement window, even after long idle.
     * Concurrent callers share that window; nothing keeps sampling afterwards. */
    refresh(): Promise<RuntimeDiagnostics> {
      if (disposed) return Promise.reject(new Error('Runtime diagnostics is closed'))
      if (refreshing) return refreshing
      const window = monitorEventLoopDelay({ resolution: delayResolutionMs })
      const startedAt = performance.now()
      const baseline = performance.eventLoopUtilization()
      window.enable()
      const pending = new Promise<RuntimeDiagnostics>((resolve, reject) => {
        let settled = false
        const finish = () => {
          if (settled) return false
          settled = true
          clearTimeout(deadline)
          window.disable()
          cancelRefresh = null
          return true
        }
        const deadline = setTimeout(() => {
          if (!finish()) return
          try {
            const intervalMs = Math.max(0, performance.now() - startedAt)
            const delta = performance.eventLoopUtilization(baseline)
            const utilization = delta.active + delta.idle > 0 ? delta.utilization : null
            const delay = window.count > 0 ? { meanMs: window.mean / 1e6, p95Ms: window.percentile(95) / 1e6, maxMs: window.max / 1e6 } : null
            resolve(snapshot({ state: delay && utilization !== null ? 'available' : 'warming', intervalMs, utilization, delay }, sampleWindowMs))
          } catch (cause) { reject(cause) }
          finally { window.reset() }
        }, sampleWindowMs)
        cancelRefresh = () => {
          if (!finish()) return
          window.reset()
          reject(new Error('Runtime diagnostics is closed'))
        }
      })
      refreshing = pending
      void pending.then(() => { if (refreshing === pending) refreshing = null }, () => { if (refreshing === pending) refreshing = null })
      return pending
    },
    read(): RuntimeDiagnostics {
      if (disposed) throw new Error('Runtime diagnostics is closed')
      if (!active) { histogram.enable(); active = true }
      clearTimeout(timer)
      timer = setTimeout(stop, idleTimeoutMs)
      timer.unref()
      const now = performance.now()
      if (cached && now - cachedAt < minIntervalMs) return cached
      const current = performance.eventLoopUtilization()
      const intervalMs = previous ? Math.max(0, now - cachedAt) : null
      const delta = previous ? performance.eventLoopUtilization(current, previous) : null
      const utilization = delta && delta.active + delta.idle > 0 ? delta.utilization : null
      const delay = histogram.count > 0 ? {
        meanMs: histogram.mean / 1e6,
        p95Ms: histogram.percentile(95) / 1e6,
        maxMs: histogram.max / 1e6,
      } : null
      cached = snapshot({ state: delay && utilization !== null ? 'available' : 'warming', intervalMs, utilization, delay })
      previous = current
      cachedAt = now
      // Every report describes a bounded interval, not a growing session history.
      histogram.reset()
      return cached
    },
    dispose() { disposed = true; stop(); cancelRefresh?.() },
  }
}
