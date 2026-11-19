import os from 'node:os'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { createAdminStorageReader, type AdminStorageSnapshot } from './monitor-storage.js'

interface HostMetrics {
  /** Share of total visible host CPU capacity, 0–100%. */
  cpuPercent: number | null; logicalCpus: number | null
  memoryTotalBytes: number | null; memoryFreeBytes: number | null
  uptimeSeconds: number | null; loadAverage: [number, number, number] | null
}
interface EngineMetrics {
  /** 100% is one logical core; a multi-threaded Node process can exceed 100%. Excludes child processes. */
  cpuCorePercent: number | null; availableParallelism: number | null
  rssBytes: number | null; heapUsedBytes: number | null; heapTotalBytes: number | null
  eventLoopUtilizationPercent: number | null; uptimeSeconds: number | null
}
export interface AdminMonitorSnapshot extends AdminStorageSnapshot {
  sampledAt: string; sampleWindowMs: number | null; host: HostMetrics; engine: EngineMetrics
}
export interface CpuFrame {
  atMs: number
  cores: { busyMs: number; idleMs: number }[] | null
  cpu: { user: number; system: number } | null
  loop: { active: number; idle: number } | null
}

function maybe<T>(read: () => T): T | null { try { return read() } catch { return null } }
function nonnegative(n: unknown): n is number { return typeof n === 'number' && Number.isFinite(n) && n >= 0 }
function integer(n: unknown): number | null { return nonnegative(n) && Number.isSafeInteger(n) ? n : null }
function positiveInteger(n: unknown): number | null { const v = integer(n); return v !== null && v > 0 ? v : null }
function seconds(n: unknown): number | null { return nonnegative(n) ? Math.floor(n) : null }
function delta(a: unknown, b: unknown): number | null { return nonnegative(a) && nonnegative(b) && b >= a ? b - a : null }
function round(n: number): number | null { return Number.isFinite(n) ? Math.round(n * 10) / 10 : null }

function cpuFrame(): CpuFrame {
  const cores = maybe(() => os.cpus().map(({ times }) => ({ busyMs: times.user + times.nice + times.sys + times.irq, idleMs: times.idle })))
  return { cores, atMs: performance.now(), cpu: maybe(() => process.cpuUsage()), loop: maybe(() => performance.eventLoopUtilization()) }
}

/** Only differences between real counters describe current utilization. CPU hot-plug, resets and absent samples are unknown, not idle. */
export function cpuDeltas(first: CpuFrame, last: CpuFrame): Pick<HostMetrics, 'cpuPercent'> & Pick<EngineMetrics, 'cpuCorePercent' | 'eventLoopUtilizationPercent'> & { sampleWindowMs: number | null } {
  const elapsed = delta(first.atMs, last.atMs)
  const rates = { cpuPercent: null as number | null, cpuCorePercent: null as number | null, eventLoopUtilizationPercent: null as number | null, sampleWindowMs: elapsed !== null && elapsed >= 1 ? Math.round(elapsed) : null }
  if (elapsed === null || rates.sampleWindowMs === null) return rates
  if (first.cores?.length && first.cores.length === last.cores?.length) {
    let busy = 0, idle = 0, valid = true
    for (let i = 0; i < first.cores.length; i++) {
      const a = first.cores[i], b = last.cores[i], db = delta(a.busyMs, b.busyMs), di = delta(a.idleMs, b.idleMs)
      if (db === null || di === null) { valid = false; break }
      busy += db; idle += di
    }
    if (valid && busy + idle > 0) rates.cpuPercent = round(100 * busy / (busy + idle))
  }
  const user = delta(first.cpu?.user, last.cpu?.user), system = delta(first.cpu?.system, last.cpu?.system)
  if (user !== null && system !== null) rates.cpuCorePercent = round(100 * (user + system) / (elapsed * 1_000))
  const active = delta(first.loop?.active, last.loop?.active), idle = delta(first.loop?.idle, last.loop?.idle)
  if (active !== null && idle !== null && active + idle > 0) rates.eventLoopUtilizationPercent = round(100 * active / (active + idle))
  return rates
}

export function hostLoadAverage(platform: NodeJS.Platform, read: () => number[] = os.loadavg): HostMetrics['loadAverage'] {
  // Node returns the placeholder [0,0,0] on Windows: it is not a measurement.
  if (platform === 'win32') return null
  const values = maybe(read)
  return values?.length === 3 && values.every(nonnegative) ? [values[0], values[1], values[2]] : null
}

function memoryAndCapacity() {
  const total = positiveInteger(maybe(os.totalmem)), free = integer(maybe(os.freemem)), usage = maybe(() => process.memoryUsage())
  return {
    host: { memoryTotalBytes: total, memoryFreeBytes: total !== null && free !== null && free > total ? null : free,
      uptimeSeconds: seconds(maybe(os.uptime)), loadAverage: hostLoadAverage(process.platform) },
    engine: { rssBytes: integer(usage?.rss), heapUsedBytes: integer(usage?.heapUsed), heapTotalBytes: integer(usage?.heapTotal),
      availableParallelism: positiveInteger(maybe(os.availableParallelism)), uptimeSeconds: seconds(maybe(() => process.uptime())) },
  }
}

export interface MonitorSources {
  frame: () => CpuFrame
  pause: () => Promise<void>
  storage: () => Promise<AdminStorageSnapshot>
}
/** Construct once per HTTP server; doing so has no I/O, timer, polling or background sampler. Concurrent authorized reads share one sample. */
export function createAdminMonitor(sources?: Partial<MonitorSources>): () => Promise<AdminMonitorSnapshot> {
  const frame = sources?.frame ?? cpuFrame, pause = sources?.pause ?? (() => delay(160)), storage = sources?.storage ?? createAdminStorageReader()
  let pending: Promise<AdminMonitorSnapshot> | undefined
  async function measure(): Promise<AdminMonitorSnapshot> {
    const cpu = async () => {
      const first = frame(); await pause()
      let last = frame(), rates = cpuDeltas(first, last)
      const start = first.cores, end = last.cores
      // A single Windows core can briefly report fewer idle milliseconds than on the preceding read.
      // Extend this user-requested sample once from its original baseline; never turn a negative delta into zero.
      if (rates.cpuPercent === null && rates.sampleWindowMs !== null && start?.length && end?.length === start.length &&
        end.some((core, i) => core.idleMs < start[i].idleMs || core.busyMs < start[i].busyMs)) {
        await pause(); last = frame(); rates = cpuDeltas(first, last)
      }
      return { ...rates, logicalCpus: positiveInteger(last.cores?.length), sampledAt: new Date().toISOString(), values: memoryAndCapacity() }
    }
    const [{ cpuPercent, cpuCorePercent, eventLoopUtilizationPercent, sampleWindowMs, logicalCpus, sampledAt, values }, disks] = await Promise.all([cpu(), storage()])
    return { sampledAt, sampleWindowMs, host: { cpuPercent, logicalCpus, ...values.host },
      engine: { cpuCorePercent, eventLoopUtilizationPercent, ...values.engine }, ...disks }
  }
  return () => pending ??= measure().finally(() => { pending = undefined })
}
