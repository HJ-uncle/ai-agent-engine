import { afterEach, describe, expect, it, vi } from 'vitest'

const { execute, warn } = vi.hoisted(() => ({
  execute: vi.fn(),
  warn: vi.fn(),
}))

vi.mock('../../sqlite/db.js', () => ({
  getDb: () => ({ execute }),
}))

vi.mock('../../../observability/index.js', () => ({
  logger: { warn },
}))

import { SQLiteTaskQueue } from '../sqlite-queue.js'

describe('SQLiteTaskQueue polling', () => {
  afterEach(() => {
    vi.useRealTimers()
    execute.mockReset()
    warn.mockReset()
  })

  it('observes missing jobs-table errors from the polling timer', async () => {
    execute.mockRejectedValue(new Error('SQLITE_ERROR: no such table: jobs'))
    vi.useFakeTimers()

    const queue = new SQLiteTaskQueue(10)
    queue.registerHandler('test-handler', async () => undefined)
    queue.start()
    await vi.advanceTimersByTimeAsync(11)
    await queue.stop()

    // Schema creation runs during initDb and can lag queue construction. The
    // timer must tolerate that state without an unhandled rejection or noisy
    // warning; the next poll retries once the schema is ready.
    expect(warn).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalled()
  })
})
