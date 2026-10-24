import { describe, expect, it, vi } from 'vitest'
import { StreamBus } from '../stream-bus.js'
import { observePublication } from '../observe-publication.js'

describe('bounded publication diagnostics', () => {
  it('retains the first cause once per stream while awaiting every producer call and preserving execution', async () => {
    const bus = new StreamBus(new AbortController()), report = vi.fn(), attempted: number[] = []
    await observePublication(bus, () => bus.publish('x'.repeat(1024 * 1024 + 1)), report)
    for (let index = 0; index < 1000; index++) await observePublication(bus, async () => {
      attempted.push(index)
      return bus.publish('continued output ' + index)
    }, report)
    expect(attempted).toEqual(Array.from({ length: 1000 }, (_, index) => index))
    expect(report).toHaveBeenCalledTimes(1)
    expect(report.mock.calls[0][0]).toMatchObject({ reason: 'oversized_frame' })
    expect(bus.abortController.signal.aborted).toBe(false)
    const peer = new StreamBus(new AbortController())
    await observePublication(peer, () => peer.publish('x'.repeat(1024 * 1024 + 1)), report)
    expect(report).toHaveBeenCalledTimes(2)
  })

  it('does not release a held publication barrier and isolates diagnostic failures', async () => {
    const bus = new StreamBus(new AbortController())
    let release!: () => void, settled = false
    const barrier = new Promise<void>(resolve => { release = resolve })
    const observed = observePublication(bus, async () => { await barrier; throw new Error('held failure') }, () => { throw new Error('sink failed') })
      .then(() => { settled = true })
    await Promise.resolve(); expect(settled).toBe(false)
    release(); await observed
    expect(settled).toBe(true)
    expect(bus.abortController.signal.aborted).toBe(false)
  })
})
