/** Actual route handlers and TCP sockets: transport draining must not precede releasing its own polls. */
import { request } from 'node:http'
import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { browserRoutes } from '../browser.js'
import { workbenchRoutes } from '../workbench.js'
import { BrowserBridge } from '../../../../tools/browser/browser-bridge.js'
import { WorkbenchBridge } from '../../../../tools/workbench/bridge.js'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}

function wire(url: string, method: 'GET' | 'POST', headers: Record<string, string>, payload?: unknown) {
  return new Promise<{ statusCode: number | undefined; body: string }>((resolve, reject) => {
    const outgoing = request(url, { method, headers, agent: false }, incoming => {
      let body = ''
      incoming.setEncoding('utf8')
      incoming.on('data', chunk => { body += chunk })
      incoming.on('end', () => resolve({ statusCode: incoming.statusCode, body }))
    })
    outgoing.on('error', reject)
    outgoing.end(payload === undefined ? undefined : JSON.stringify(payload))
  })
}

describe('UI bridge shutdown with an active HTTP poll', () => {
  it.each(['browser', 'workbench'] as const)('releases the %s poll before waiting for its socket to drain', async kind => {
    const app = Fastify()
    // Long enough to distinguish resource release from the natural heartbeat.
    const bridge = kind === 'browser' ? new BrowserBridge({ pollTimeoutMs: 60_000 })
      : new WorkbenchBridge({ leaseMs: 65_000, pollMs: 60_000, commandMs: 20_000 })
    const entered = deferred()
    const pollSpy = vi.spyOn(bridge, 'poll').mockImplementation((identity: { tenantId: string; userId?: string }, id: string, token: string, signal?: AbortSignal) => {
      const result = bridge instanceof BrowserBridge ? BrowserBridge.prototype.poll.call(bridge, identity, id, token, signal)
        : WorkbenchBridge.prototype.poll.call(bridge, identity, id, token)
      entered.resolve()
      return result
    })
    const disposeSpy = vi.spyOn(bridge, 'dispose')
    let timer: ReturnType<typeof setTimeout> | undefined
    let response: ReturnType<typeof wire> | undefined
    try {
      await app.register(kind === 'browser' ? browserRoutes : workbenchRoutes, { bridge, prefix: '/api/v1' })
      const identity = { tenantId: 'default' }
      const client = bridge instanceof BrowserBridge ? bridge.register(identity, 'shutdown-browser')
        : bridge.register(identity, 'shutdown-workbench', ['workspace.context'])
      const base = await app.listen({ host: '127.0.0.1', port: 0 })
      response = kind === 'browser'
        ? wire(`${base}/api/v1/browser/clients/${client.clientId}/commands`, 'GET', { 'x-aether-browser-token': client.clientToken })
        : wire(`${base}/api/v1/workbench/clients/${client.clientId}/poll`, 'POST', { 'content-type': 'application/json' }, { clientToken: client.clientToken })
      // Observe rejection immediately, including a cleanup after an assertion failure.
      void response.catch(() => {})
      await Promise.race([entered.promise, response.then(() => { throw new Error('HTTP poll ended before entering the bridge') })])
      const result = await Promise.race([
        app.close().then(() => 'closed'),
        new Promise<string>(resolve => { timer = setTimeout(() => resolve('poll-retained'), 1500) }),
      ])
      expect(result).toBe('closed')
      expect(disposeSpy).toHaveBeenCalledOnce()
      expect(app.server.listening).toBe(false)
      const received = await response
      expect(received.statusCode).toBe(200)
      expect(JSON.parse(received.body).data).toEqual({ commands: [] })
    } finally {
      clearTimeout(timer)
      // Make the old implementation fail promptly without leaving a one-minute poll.
      bridge.dispose()
      await response?.catch(() => {})
      app.server.closeAllConnections()
      await app.close()
      pollSpy.mockRestore()
      disposeSpy.mockRestore()
    }
  })
})
