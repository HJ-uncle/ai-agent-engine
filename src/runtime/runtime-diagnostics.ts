import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { getHeapStatistics } from 'node:v8'
import { getRuntimeIdentity } from './identity.js'

export interface RuntimeDiagnostics {
  schemaVersion: 1
  instanceId: string
  pid: number
  sampledAt: number
  uptimeMs: number
  collection: { minIntervalMs: number; idleTimeoutMs: number; delayResolutionMs: number }
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

/** No background profiler: one histogram per server, enabled by an explicit
 * authenticated read and released after the last interested client goes idle. */
export function createRuntimeDiagnostics(options: { minIntervalMs?: number; idleTimeoutMs?: number } = {}) {
  const minIntervalMs = Math.max(10, options.minIntervalMs ?? 5_000)
  const idleTimeoutMs = Math.max(minIntervalMs * 2, options.idleTimeoutMs ?? 15_000)
  const delayResolutionMs = 20
  const histogram = monitorEventLoopDelay({ resolution: delayResolutionMs })
  let timer: ReturnType<typeof setTimeout> | undefined
  let cached: RuntimeDiagnostics | null = null
  let cachedAt = 0
  let previous: ReturnType<typeof performance.eventLoopUtilization> | null = null
  let active = false
  let disposed = false

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
    read(): RuntimeDiagnostics {
      if (disposed) throw new Error('Runtime diagnostics is closed')
      if (!active) { histogram.enable(); active = true }
      clearTimeout(timer)
      timer = setTimeout(stop, idleTimeoutMs)
      timer.unref()
      const now = performance.now()
      if (cached && now - cachedAt < minIntervalMs) return cached
      const memory = process.memoryUsage()
      const heap = getHeapStatistics()
      const current = performance.eventLoopUtilization()
      const intervalMs = previous ? Math.max(0, now - cachedAt) : null
      const delta = previous ? performance.eventLoopUtilization(current, previous) : null
      const utilization = delta && delta.active + delta.idle > 0 ? delta.utilization : null
      const delay = histogram.count > 0 ? {
        meanMs: histogram.mean / 1e6,
        p95Ms: histogram.percentile(95) / 1e6,
        maxMs: histogram.max / 1e6,
      } : null
      cached = {
        schemaVersion: 1,
        instanceId: getRuntimeIdentity().instanceId,
        pid: process.pid,
        sampledAt: Date.now(),
        uptimeMs: process.uptime() * 1000,
        collection: { minIntervalMs, idleTimeoutMs, delayResolutionMs },
        memory: {
          rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, heapTotalBytes: memory.heapTotal,
          heapLimitBytes: heap.heap_size_limit, externalBytes: memory.external,
          arrayBuffersBytes: memory.arrayBuffers,
        },
        eventLoop: { state: delay && utilization !== null ? 'available' : 'warming', intervalMs, utilization, delay },
      }
      previous = current
      cachedAt = now
      // Every report describes a bounded interval, not a growing session history.
      histogram.reset()
      return cached
    },
    dispose() { disposed = true; stop() },
  }
}
