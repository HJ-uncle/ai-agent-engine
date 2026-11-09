import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryUsageObserver } from '../usage.js'
import type { MemoryRequestAttemptEvent, MemoryRequestStage } from '../types.js'
import type { RequestAttemptUsage } from '../../../core/llm-adapter/types.js'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

const start = (id: string, stage: MemoryRequestStage = 'memory_recall'): MemoryRequestAttemptEvent => ({
  type: 'start', requestAttemptId: id, provider: 'fixture-provider', model: 'fixture-model', stage,
})
const finish = (id: string, stage: MemoryRequestStage = 'memory_recall', usage?: RequestAttemptUsage,
  outcome: 'succeeded' | 'failed' | 'cancelled' = 'succeeded'): MemoryRequestAttemptEvent => ({
  type: 'finish', requestAttemptId: id, provider: 'fixture-provider', model: 'fixture-model', stage, outcome, ...(usage ? { usage } : {}),
})

describe('separate physical memory request accounting', () => {
  it('deduplicates repeated starts and finishes without duplicating provider usage or forwarding', async () => {
    const info = vi.fn(), forward = vi.fn()
    const observer = createMemoryUsageObserver({ info }, forward)
    const began = start('recall-1')
    const ended = finish('recall-1', 'memory_recall', { promptTokens: 120, completionTokens: 8, cacheHitTokens: 96, cacheMissTokens: 24 })
    await observer.observe(began)
    await observer.observe(began)
    await observer.observe(ended)
    await observer.observe(ended)
    expect(observer.snapshot().recall).toMatchObject({ requests: 1, pendingRequests: 0, failedRequests: 0,
      unknownUsageRequests: 0, promptTokens: 120, completionTokens: 8, cacheHitTokens: 96, cacheMissTokens: 24 })
    expect(forward.mock.calls.map(call => call[0])).toEqual([began, ended])
    expect(info).toHaveBeenCalledTimes(2)
  })

  it('keeps recall and extraction costs and elapsed times independent', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000)
    const observer = createMemoryUsageObserver({ info: vi.fn() })
    await observer.observe(start('recall'))
    vi.setSystemTime(1_010)
    await observer.observe(start('extract', 'memory_extraction'))
    vi.setSystemTime(1_030)
    await observer.observe(finish('recall', 'memory_recall', { promptTokens: 99, completionTokens: 3 }))
    vi.setSystemTime(1_110)
    await observer.observe(finish('extract', 'memory_extraction', { promptTokens: 200, completionTokens: 40 }))
    expect(observer.snapshot()).toMatchObject({
      recall: { requests: 1, pendingRequests: 0, promptTokens: 99, completionTokens: 3, elapsedMs: 30 },
      extraction: { requests: 1, pendingRequests: 0, promptTokens: 200, completionTokens: 40, elapsedMs: 100 },
    })
  })

  it('marks missing and incomplete usage as unknown while retaining the reported lower bound', async () => {
    const observer = createMemoryUsageObserver({ info: vi.fn() })
    await observer.observe(start('missing'))
    await observer.observe(finish('missing'))
    await observer.observe(start('partial'))
    await observer.observe(finish('partial', 'memory_recall', { promptTokens: 77, completionTokens: 0, unknown: true }))
    expect(observer.snapshot().recall).toMatchObject({ requests: 2, pendingRequests: 0, unknownUsageRequests: 2,
      promptTokens: 77, completionTokens: 0 })
  })

  it('counts failures and cancellations without inventing a successful zero-cost request', async () => {
    const observer = createMemoryUsageObserver({ info: vi.fn() })
    await observer.observe(start('failure'))
    await observer.observe(finish('failure', 'memory_recall', undefined, 'failed'))
    await observer.observe(start('cancelled', 'memory_extraction'))
    await observer.observe(finish('cancelled', 'memory_extraction', { promptTokens: 12, completionTokens: 2 }, 'cancelled'))
    expect(observer.snapshot().recall).toMatchObject({ requests: 1, failedRequests: 1, pendingRequests: 0, unknownUsageRequests: 1 })
    expect(observer.snapshot().extraction).toMatchObject({ requests: 1, failedRequests: 1, pendingRequests: 0,
      promptTokens: 12, completionTokens: 2, unknownUsageRequests: 0 })
  })

  it('ignores an unpaired or wrong-stage finish rather than corrupting a pending physical attempt', async () => {
    const forward = vi.fn()
    const observer = createMemoryUsageObserver({ info: vi.fn() }, forward)
    await observer.observe(finish('not-started', 'memory_extraction', { promptTokens: 900, completionTokens: 900 }))
    await observer.observe(start('one'))
    await observer.observe(finish('one', 'memory_extraction', { promptTokens: 700, completionTokens: 700 }))
    expect(observer.snapshot()).toMatchObject({ recall: { requests: 1, pendingRequests: 1, promptTokens: 0 }, extraction: { requests: 0, promptTokens: 0 } })
    expect(forward).toHaveBeenCalledTimes(1)
    await observer.observe(finish('one', 'memory_recall', { promptTokens: 10, completionTokens: 1 }))
    expect(observer.snapshot().recall).toMatchObject({ pendingRequests: 0, promptTokens: 10 })
  })

  it('logs only allowlisted accounting fields and returns snapshots that cannot mutate the observer', async () => {
    const info = vi.fn()
    const observer = createMemoryUsageObserver({ info })
    const event = Object.assign(start('private-payload'), { prompt: 'PRIVATE_MEMORY_FIXTURE_4832', apiKey: 'FAKE_CREDENTIAL_FIXTURE_1948' })
    await observer.observe(event)
    await observer.observe(finish('private-payload', 'memory_recall', { promptTokens: 5, completionTokens: 1 }))
    expect(JSON.stringify(info.mock.calls)).not.toMatch(/PRIVATE_MEMORY_FIXTURE|FAKE_CREDENTIAL_FIXTURE|apiKey|"prompt"/)
    const snapshot = observer.snapshot()
    snapshot.recall.promptTokens = 50_000
    expect(observer.snapshot().recall.promptTokens).toBe(5)
  })

  it('does not let a diagnostic logger failure replace the provider outcome', async () => {
    const observer = createMemoryUsageObserver({ info: vi.fn(() => { throw new Error('Fixture log unavailable') }) })
    await expect(observer.observe(start('log-failure'))).resolves.toBeUndefined()
    await expect(observer.observe(finish('log-failure', 'memory_recall', { promptTokens: 3, completionTokens: 1 }))).resolves.toBeUndefined()
    expect(observer.snapshot().recall).toMatchObject({ requests: 1, pendingRequests: 0, failedRequests: 0, promptTokens: 3 })
  })
})
