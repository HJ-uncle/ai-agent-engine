import { EventEmitter } from 'node:events'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PluginCapabilityHttpStreams } from '../plugin-capability-stream.js'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('plugin SSE write backpressure', () => {
  it('waits beyond thirty seconds for drain without cancelling a slow receiver', async () => {
    vi.useFakeTimers()
    const timeouts = vi.spyOn(AbortSignal, 'timeout').mockImplementation(delay => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(new Error('timeout')), delay)
      return controller.signal
    })
    let writes = 0, drained = false, signal: AbortSignal | undefined
    const response = Object.assign(new EventEmitter(), {
      writableEnded: false, destroyed: false, writableLength: 1,
      setHeader: vi.fn(), writeHead: vi.fn(), flushHeaders: vi.fn(),
      write: vi.fn(() => ++writes !== 1),
      end() { this.writableEnded = true },
    })
    const request = { raw: new EventEmitter() } as unknown as FastifyRequest
    const reply = { raw: response, hijack: vi.fn(), getHeaders: () => ({}) } as unknown as FastifyReply
    const streams = new PluginCapabilityHttpStreams()
    const running = streams.open(request, reply, async (emit, current) => {
      signal = current
      await emit({ type: 'text-delta', text: 'available when receiver drains' })
      drained = true
      await emit({ type: 'complete', result: { text: 'done' } })
    })
    try {
      await vi.advanceTimersByTimeAsync(31000)
      expect(drained).toBe(false)
      expect(signal?.aborted).toBe(false)
      expect(timeouts).not.toHaveBeenCalled()
      response.writableLength = 0; response.emit('drain')
      await running
      expect(drained).toBe(true)
      expect(response.writableEnded).toBe(true)
      expect(response.write).toHaveBeenCalledTimes(2)
    } finally { await streams.close(); await running }
  })
})
