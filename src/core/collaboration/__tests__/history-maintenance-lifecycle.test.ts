import type { Client } from '@libsql/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { compactTerminalHistoryMaintenance, type HistoryMaintenanceCompactionResult } from '../history-maintenance-storage.js'
import { startHistoryMaintenance } from '../history-maintenance-lifecycle.js'

vi.mock('../history-maintenance-storage.js', () => ({ compactTerminalHistoryMaintenance: vi.fn() }))
const compact = vi.mocked(compactTerminalHistoryMaintenance)
const complete = (more = false): HistoryMaintenanceCompactionResult => ({ scanned: 1, compacted: 1, skippedCorrupt: 0,
  originalPayloadBytes: 4096, storedPayloadBytes: 512, reclaimedPayloadBytes: 3584, afterId: 'cursor-one', hasMore: more })
beforeEach(() => { vi.useFakeTimers(); compact.mockReset() })
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs() })
describe('history maintenance lifecycle', () => {
  it('waits at startup, follows bounded backlog with a cursor, then restarts the next cycle from the beginning', async () => {
    compact.mockResolvedValueOnce(complete(true)).mockResolvedValue(complete())
    const job = startHistoryMaintenance({} as Client, { intervalMs: 1000, backlogDelayMs: 10 })
    await vi.advanceTimersByTimeAsync(29_999); expect(compact).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1); expect(compact).toHaveBeenCalledTimes(1)
    expect(compact.mock.calls[0][1]).toMatchObject({ batchSize: 16, maxRows: 128, maxPayloadBytes: 8 * 1024 * 1024 })
    await vi.advanceTimersByTimeAsync(10); expect(compact.mock.calls[1][1]?.afterId).toBe('cursor-one')
    await vi.advanceTimersByTimeAsync(1000); expect(compact.mock.calls[2][1]?.afterId).toBeUndefined()
    await job.stop(); await vi.advanceTimersByTimeAsync(10_000); expect(compact).toHaveBeenCalledTimes(3)
  })
  it('does not overlap work and stop waits for the active bounded batch with cancellation signalled', async () => {
    let finish!: (value: HistoryMaintenanceCompactionResult) => void
    compact.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const job = startHistoryMaintenance({} as Client, { startupDelayMs: 0, intervalMs: 1000 })
    await vi.advanceTimersByTimeAsync(10_000); expect(compact).toHaveBeenCalledTimes(1)
    let stopped = false
    const pending = job.stop().then(() => { stopped = true })
    await Promise.resolve(); expect(stopped).toBe(false)
    expect(compact.mock.calls[0][1]?.signal?.aborted).toBe(true)
    finish(complete(true)); await pending; expect(stopped).toBe(true)
    await vi.advanceTimersByTimeAsync(10_000); expect(compact).toHaveBeenCalledTimes(1)
  })
  it('reports corrupt retained rows, survives reporting errors, and honors explicit disable', async () => {
    compact.mockResolvedValue({ ...complete(), skippedCorrupt: 2 })
    const onError = vi.fn(() => { throw new Error('logger failed') })
    const job = startHistoryMaintenance({} as Client, { startupDelayMs: 0, onError })
    await vi.advanceTimersByTimeAsync(0); expect(onError).toHaveBeenCalledOnce(); await job.stop()
    compact.mockClear(); const disabled = startHistoryMaintenance({} as Client, { enabled: false, startupDelayMs: 0 })
    await vi.advanceTimersByTimeAsync(100_000); expect(compact).not.toHaveBeenCalled(); await disabled.stop()
  })
})
