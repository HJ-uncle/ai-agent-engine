import { describe, expect, it } from 'vitest'
import { createRuntimeDiagnostics } from '../runtime-diagnostics.js'

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe('on-demand engine runtime measurements', () => {
  it('reads this real V8 process, caches concurrent clients and warms without fake zero delay', () => {
    const collector = createRuntimeDiagnostics()
    try {
      const sample = collector.read()
      expect(sample.pid).toBe(process.pid)
      expect(sample.instanceId.length).toBeGreaterThan(0)
      expect(sample.memory.heapUsedBytes).toBeGreaterThan(0)
      expect(sample.memory.heapTotalBytes).toBeGreaterThanOrEqual(sample.memory.heapUsedBytes)
      expect(sample.memory.heapLimitBytes).toBeGreaterThan(0)
      expect(sample.eventLoop).toEqual({ state: 'warming', intervalMs: null, utilization: null, delay: null })
      for (let index = 0; index < 50; index++) expect(collector.read()).toBe(sample)
    } finally { collector.dispose() }
  })

  it('measures real event loop intervals and resets after idle expiry', async () => {
    const collector = createRuntimeDiagnostics({ minIntervalMs: 15, idleTimeoutMs: 150 })
    try {
      collector.read()
      await wait(65)
      const busyUntil = performance.now() + 35
      while (performance.now() < busyUntil) { /* a bounded real event-loop stall */ }
      await wait(25)
      const measured = collector.read()
      expect(measured.eventLoop.state).toBe('available')
      expect(measured.eventLoop.intervalMs).toBeGreaterThan(70)
      expect(measured.eventLoop.utilization).toBeGreaterThan(0)
      expect(measured.eventLoop.utilization).toBeLessThanOrEqual(1)
      expect(measured.eventLoop.delay!.maxMs).toBeGreaterThan(20)
      expect(measured.eventLoop.delay!.p95Ms).toBeGreaterThan(0)
      await wait(190)
      const resumed = collector.read()
      expect(resumed.eventLoop).toEqual({ state: 'warming', intervalMs: null, utilization: null, delay: null })
      expect(resumed.sampledAt).toBeGreaterThan(measured.sampledAt)
    } finally { collector.dispose() }
    expect(() => collector.read()).toThrow('closed')
  })

  it('gets a fresh complete manual sample in one request, including after idle', async () => {
    const collector = createRuntimeDiagnostics({ minIntervalMs: 15, idleTimeoutMs: 150, sampleWindowMs: 80 })
    try {
      const firstRequest = collector.refresh()
      expect(collector.refresh()).toBe(firstRequest)
      const first = await firstRequest
      expect(first.collection.sampleWindowMs).toBe(80)
      expect(first.eventLoop.state).toBe('available')
      expect(first.eventLoop.intervalMs).toBeGreaterThanOrEqual(70)
      expect(first.eventLoop.delay!.p95Ms).toBeGreaterThan(0)
      expect(first.memory.heapUsedBytes).toBeGreaterThan(0)
      const immediate = await collector.refresh()
      expect(immediate.sampledAt).toBeGreaterThan(first.sampledAt)
      expect(immediate.eventLoop.state).toBe('available')
      await wait(190)
      const afterIdle = await collector.refresh()
      expect(afterIdle.eventLoop.state).toBe('available')
      expect(afterIdle.sampledAt).toBeGreaterThan(immediate.sampledAt)
      // The new window excludes the time spent idle between manual clicks.
      expect(afterIdle.eventLoop.intervalMs).toBeLessThan(afterIdle.sampledAt - immediate.sampledAt)
    } finally { collector.dispose() }
  })

  it('cancels an in-flight manual measurement when disposed', async () => {
    const collector = createRuntimeDiagnostics({ sampleWindowMs: 1000 })
    const pending = collector.refresh()
    const rejected = expect(pending).rejects.toThrow('closed')
    collector.dispose()
    await rejected
    await expect(collector.refresh()).rejects.toThrow('closed')
  })
})
