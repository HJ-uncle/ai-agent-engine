import { afterEach, describe, expect, it, vi } from 'vitest'
import { auditRetentionPolicyFromEnvironment, startAuditMaintenance } from '../audit-maintenance.js'

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs() })

describe('audit maintenance lifecycle', () => {
  it('waits for in-flight work, signals cancellation, and never reschedules after stop', async () => {
    vi.useFakeTimers()
    let complete!: (value: { migrated: number; archived: number; hasBacklog: boolean }) => void
    const maintain = vi.fn(() => new Promise<{ migrated: number; archived: number; hasBacklog: boolean }>(resolve => { complete = resolve }))
    const service = startAuditMaintenance({ store: { maintain }, intervalMs: 20, backlogDelayMs: 1 })
    await vi.advanceTimersByTimeAsync(0)
    expect(maintain).toHaveBeenCalledOnce()
    let stopped = false
    const stopping = service.stop().then(() => { stopped = true })
    expect((maintain.mock.calls[0] as unknown as [unknown, { signal: AbortSignal }])[1].signal.aborted).toBe(true)
    await Promise.resolve()
    expect(stopped).toBe(false)
    complete({ migrated: 1, archived: 1, hasBacklog: true })
    await stopping
    await vi.advanceTimersByTimeAsync(100)
    expect(stopped).toBe(true)
    expect(maintain).toHaveBeenCalledOnce()
  })

  it('uses short bounded follow-ups only while backlog exists and retries failures at normal intervals', async () => {
    vi.useFakeTimers()
    const maintain = vi.fn().mockResolvedValueOnce({ migrated: 1, archived: 0, hasBacklog: true })
      .mockRejectedValueOnce(new Error('archive unavailable')).mockResolvedValue({ migrated: 0, archived: 0, hasBacklog: false })
    const onError = vi.fn()
    const service = startAuditMaintenance({ store: { maintain }, intervalMs: 20, backlogDelayMs: 2, onError })
    await vi.advanceTimersByTimeAsync(2)
    expect(maintain).toHaveBeenCalledTimes(2)
    expect(onError).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(19)
    expect(maintain).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(maintain).toHaveBeenCalledTimes(3)
    await service.stop()
  })

  it('supports disabling maintenance and zero expiry while rejecting malformed environment values', async () => {
    vi.useFakeTimers()
    vi.stubEnv('AUDIT_MAINTENANCE_ENABLED', 'false')
    vi.stubEnv('AUDIT_RETENTION_ALLOW_DAYS', '0')
    vi.stubEnv('AUDIT_RETENTION_IMPORTANT_DAYS', 'no')
    expect(auditRetentionPolicyFromEnvironment()).toEqual({ allowDays: 0, importantDays: 180 })
    const maintain = vi.fn()
    const service = startAuditMaintenance({ store: { maintain } })
    await vi.advanceTimersByTimeAsync(1_000_000)
    expect(maintain).not.toHaveBeenCalled()
    await service.stop()
  })
})
