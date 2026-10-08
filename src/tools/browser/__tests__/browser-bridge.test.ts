/** Session/tenant isolation, cancellation and at-most-once delivery through the real in-memory broker. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserBridge, type BrowserAction } from '../browser-bridge.js'
const identity = { tenantId: 'tenant-a', userId: 'user-a' }
const ctx = { tenantId: identity.tenantId, sessionId: 'chat-a' }
const bridges: BrowserBridge[] = []
const create = (options: ConstructorParameters<typeof BrowserBridge>[0] = {}) => {
  const bridge = new BrowserBridge(options); bridges.push(bridge); return bridge
}
afterEach(() => { bridges.splice(0).forEach(bridge => bridge.dispose()); vi.useRealTimers() })

describe('browser reverse bridge', () => {
  it('rejects unsupported and unmapped actions before queuing a browser command', async () => {
    const bridge = create()
    bridge.register(identity, 'chat-a')
    for (const action of ['evaluate', 'network_request']) {
      expect(await bridge.execute(action as BrowserAction, {}, ctx)).toMatchObject({ success: false, metadata: { code: 'BROWSER_UNKNOWN_ACTION' } })
    }
  })


  it('routes a child agent to its root owner and resolves exactly the acknowledged operation', async () => {
    const bridge = create()
    const client = bridge.register(identity, ctx.sessionId)
    const result = bridge.execute('snapshot', { tabId: 'tab-1' }, { ...ctx, sessionId: 'child', rootSessionId: ctx.sessionId })
    const [command] = await bridge.poll(identity, client.clientId, client.clientToken)
    expect(command).toMatchObject({ sessionId: 'chat-a', action: 'snapshot', args: { tabId: 'tab-1' } })
    expect(command.expiresAt).toBeGreaterThan(Date.now())
    expect(bridge.result(identity, client.clientId, client.clientToken, command.requestId, { success: true, output: '{"text":"hello"}' })).toBe(true)
    expect(await result).toEqual({ success: true, output: '{"text":"hello"}' })
    expect(bridge.result(identity, client.clientId, client.clientToken, command.requestId, { success: true, output: 'duplicate' })).toBe(false)
  })

  it('rejects cross-tenant, cross-user and wrong-secret access without revealing clients', async () => {
    const bridge = create()
    const client = bridge.register(identity, 'chat-a')
    for (const other of [{ tenantId: 'tenant-b', userId: 'user-a' }, { tenantId: 'tenant-a', userId: 'user-b' }]) {
      await expect(bridge.poll(other, client.clientId, client.clientToken)).rejects.toMatchObject({ statusCode: 404 })
      expect(() => bridge.unregister(other, client.clientId, client.clientToken)).toThrow('not found')
    }
    await expect(bridge.poll(identity, client.clientId, 'wrong')).rejects.toMatchObject({ statusCode: 404 })
    expect(await bridge.execute('tabs', {}, { ...ctx, tenantId: 'tenant-b' })).toMatchObject({ success: false, metadata: { code: 'BROWSER_CLIENT_UNAVAILABLE' } })
    expect(await bridge.execute('tabs', {}, { ...ctx, sessionId: 'other-chat' })).toMatchObject({ success: false })
  })

  it('does not let a second client silently replace an active session', () => {
    const bridge = create()
    const client = bridge.register(identity, 'chat-a')
    expect(() => bridge.register(identity, 'chat-a')).toThrow('active browser client')
    expect(bridge.register(identity, 'chat-a', client)).toEqual(client)
    expect(() => bridge.register(identity, 'chat-b', client)).toThrow('cannot change')
  })

  it('wakes long polling and prevents concurrent consumers', async () => {
    const bridge = create()
    const client = bridge.register(identity, 'chat-a')
    const poll = bridge.poll(identity, client.clientId, client.clientToken)
    await expect(bridge.poll(identity, client.clientId, client.clientToken)).rejects.toMatchObject({ statusCode: 409 })
    const result = bridge.execute('click', { tabId: 'tab-1', navigationId: 1, ref: 'r1' }, ctx)
    const [command] = await poll
    bridge.result(identity, client.clientId, client.clientToken, command.requestId, { success: true, output: 'clicked' })
    expect(await result).toMatchObject({ success: true, output: 'clicked' })
  })

  it('expires idle leases and settles commands on disconnect', async () => {
    vi.useFakeTimers()
    const bridge = create({ leaseMs: 50, commandTimeoutMs: 200 })
    const client = bridge.register(identity, 'chat-a')
    const pending = bridge.execute('snapshot', { tabId: 'tab-1' }, ctx)
    await vi.advanceTimersByTimeAsync(51)
    await expect(bridge.poll(identity, client.clientId, client.clientToken)).rejects.toMatchObject({ statusCode: 404 })
    expect(await pending).toMatchObject({ success: false, metadata: { code: 'BROWSER_CLIENT_DISCONNECTED' } })
    expect(bridge.register(identity, 'chat-a').clientId).not.toBe(client.clientId)
  })

  it('times out operations without redelivering a potentially completed click', async () => {
    vi.useFakeTimers()
    const bridge = create({ commandTimeoutMs: 25, pollTimeoutMs: 5 })
    const client = bridge.register(identity, 'chat-a')
    const result = bridge.execute('click', { tabId: 'tab-1', navigationId: 1, ref: 'r1' }, ctx)
    const [command] = await bridge.poll(identity, client.clientId, client.clientToken)
    await vi.advanceTimersByTimeAsync(26)
    expect(await result).toMatchObject({ success: false, metadata: { code: 'BROWSER_COMMAND_TIMEOUT' } })
    expect(bridge.result(identity, client.clientId, client.clientToken, command.requestId, { success: true, output: 'late' })).toBe(false)
    const poll = bridge.poll(identity, client.clientId, client.clientToken)
    await vi.advanceTimersByTimeAsync(6)
    expect(await poll).toEqual([])
  })

  it('removes cancelled commands before delivery and reports already-aborted contexts', async () => {
    const bridge = create()
    const client = bridge.register(identity, 'chat-a')
    const controller = new AbortController()
    const result = bridge.execute('click', { tabId: 'tab-1' }, { ...ctx, signal: controller.signal })
    controller.abort()
    expect(await result).toMatchObject({ success: false, status: 'cancelled' })
    expect(await bridge.execute('tabs', {}, { ...ctx, signal: controller.signal })).toMatchObject({ status: 'cancelled' })
    const pollController = new AbortController()
    const poll = bridge.poll(identity, client.clientId, client.clientToken, pollController.signal)
    pollController.abort()
    expect(await poll).toEqual([])
  })

  it('keeps different chat queues separate and unregister fails in-flight requests', async () => {
    const bridge = create()
    const first = bridge.register(identity, 'chat-a')
    const second = bridge.register(identity, 'chat-b')
    const result = bridge.execute('tabs', {}, ctx)
    const [command] = await bridge.poll(identity, first.clientId, first.clientToken)
    expect(bridge.result(identity, second.clientId, second.clientToken, command.requestId, { success: true, output: 'wrong' })).toBe(false)
    bridge.unregister(identity, first.clientId, first.clientToken)
    expect(await result).toMatchObject({ success: false, metadata: { code: 'BROWSER_CLIENT_DISCONNECTED' } })
  })
})
