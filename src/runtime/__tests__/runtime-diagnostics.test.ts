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
})
