import { describe, expect, it } from 'vitest'
import { configuredSubagentConcurrency, parseSubagentConcurrency } from '../concurrency.js'
import { SubagentPool } from '../pool.js'

describe('subagent concurrency', () => {
  it('defaults to five, keeps explicit deployment limits and validates writes strictly', () => {
    expect(configuredSubagentConcurrency('')).toBe(5)
    expect(configuredSubagentConcurrency('3')).toBe(3)
    expect(configuredSubagentConcurrency('25')).toBe(16)
    for (const value of [0, -1, 17, 1.5, true, null, '', '1e1', 'bad']) expect(parseSubagentConcurrency(value)).toBeUndefined()
    expect(parseSubagentConcurrency('5')).toBe(5)
    expect(parseSubagentConcurrency(16)).toBe(16)
  })

  it('runs five per parent and releases the sixth only when a slot is free', async () => {
    const pool = new SubagentPool()
    const releases = await Promise.all(Array.from({ length: 5 }, () => pool.acquire('tenant:parent')))
    let started = false
    const sixth = pool.acquire('tenant:parent').then(release => { started = true; return release })
    const unrelated = await pool.acquire('tenant:another-parent')
    await Promise.resolve()
    expect(started).toBe(false)
    releases[0]()
    const releaseSixth = await sixth
    expect(started).toBe(true)
    releases.forEach(release => release()); releaseSixth(); unrelated()
  })

  it('growing wakes FIFO waiters immediately; shrinking waits without cancelling active work', async () => {
    const pool = new SubagentPool(1)
    const first = await pool.acquire('parent')
    const order: number[] = []
    const second = pool.acquire('parent').then(release => { order.push(2); return release })
    const third = pool.acquire('parent').then(release => { order.push(3); return release })
    pool.setLimit(2)
    const releaseSecond = await second
    expect(order).toEqual([2])
    pool.setLimit(1)
    first(); await Promise.resolve()
    expect(order).toEqual([2])
    releaseSecond()
    const releaseThird = await third
    expect(order).toEqual([2, 3])
    releaseThird()
  })

  it('an aborted queued task stays cancelled across resizing and releases remain idempotent', async () => {
    const pool = new SubagentPool(1), controller = new AbortController()
    const first = await pool.acquire('parent')
    const queued = pool.acquire('parent', controller.signal).catch(error => error)
    controller.abort()
    pool.setLimit(5)
    expect((await queued).name).toBe('AbortError')
    first(); first()
    const release = await pool.acquire('parent'); release()
  })
})
