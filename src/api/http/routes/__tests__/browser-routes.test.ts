/** Authenticated client identity/secret and HTTP round trip; no renderer or model request is mocked as success. */
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { browserRoutes } from '../browser.js'
import { BrowserBridge } from '../../../../tools/browser/browser-bridge.js'
import type { AuthContext } from '../../../../auth/types.js'
let app: FastifyInstance
let bridge: BrowserBridge
beforeEach(async () => {
  bridge = new BrowserBridge({ pollTimeoutMs: 10 })
  app = Fastify()
  app.addHook('onRequest', async request => {
    ;(request as FastifyRequest & { authContext?: Partial<AuthContext> }).authContext = {
      tenantId: String(request.headers['x-test-tenant'] ?? 'a'), userId: String(request.headers['x-test-user'] ?? 'user-a'),
    }
  })
  await app.register(browserRoutes, { prefix: '/api/v1', bridge })
})
afterEach(async () => { await app.close() })
async function register() {
  const response = await app.inject({ method: 'POST', url: '/api/v1/browser/clients', payload: { sessionId: 'chat' } })
  expect(response.statusCode).toBe(200)
  expect(response.headers['cache-control']).toBe('no-store')
  return response.json().data as { clientId: string; clientToken: string; sessionId: string }
}
describe('browser client routes', () => {
  it('registers, polls, acknowledges and removes a real queued command', async () => {
    const client = await register()
    const headers = { 'x-aether-browser-token': client.clientToken }
    const result = bridge.execute('open', { url: 'http://localhost:3000' }, { tenantId: 'a', sessionId: 'chat' })
    const response = await app.inject({ method: 'GET', url: `/api/v1/browser/clients/${client.clientId}/commands`, headers })
    expect(response.statusCode).toBe(200)
    const [command] = response.json().data.commands
    expect(command).toMatchObject({ sessionId: 'chat', action: 'open', args: { url: 'http://localhost:3000' } })
    const answer = await app.inject({ method: 'POST', url: `/api/v1/browser/clients/${client.clientId}/results`, headers, payload: { requestId: command.requestId, success: true, output: '{"tabId":"tab-1"}' } })
    expect(answer.json().data.accepted).toBe(true)
    expect(await result).toEqual({ success: true, output: '{"tabId":"tab-1"}' })
    const deleted = await app.inject({ method: 'DELETE', url: `/api/v1/browser/clients/${client.clientId}`, headers })
    expect(deleted.json().data.removed).toBe(true)
  })

  it('keeps a network request id separate from queue identity and rejects cross-user result submission', async () => {
    const client = await register()
    const headers = { 'x-aether-browser-token': client.clientToken }
    const result = bridge.execute('network_detail', { tabId: 'tab', requestId: 'network:request-123', bodyTarget: 'response', bodyOffset: 12000, bodyLimit: 12000 }, { tenantId: 'a', sessionId: 'child', rootSessionId: 'chat' })
    const response = await app.inject({ method: 'GET', url: `/api/v1/browser/clients/${client.clientId}/commands`, headers })
    expect(response.statusCode).toBe(200)
    const [command] = response.json().data.commands
    expect(command).toMatchObject({ sessionId: 'chat', action: 'network_detail', args: { tabId: 'tab', requestId: 'network:request-123', bodyOffset: 12000 } })
    expect(command.requestId).not.toBe(command.args.requestId)
    const payload = { requestId: command.requestId, success: true, output: '{"entry":{"id":"network:request-123"},"response":{"body":{"state":"available","offset":12000,"returnedChars":4,"text":"正文页一","hasMore":true,"nextOffset":12004}}}' }
    for (const other of [{ 'x-test-tenant': 'b' }, { 'x-test-user': 'other' }]) {
      expect((await app.inject({ method: 'POST', url: `/api/v1/browser/clients/${client.clientId}/results`, headers: { ...headers, ...other }, payload })).statusCode).toBe(404)
    }
    const answer = await app.inject({ method: 'POST', url: `/api/v1/browser/clients/${client.clientId}/results`, headers, payload })
    expect(answer.json().data.accepted).toBe(true)
    expect(await result).toMatchObject({ success: true, output: payload.output })
  })

  it('requires secret plus original tenant/user on all client-specific routes', async () => {
    const client = await register()
    for (const headers of [{}, { 'x-aether-browser-token': 'wrong' }, { 'x-aether-browser-token': client.clientToken, 'x-test-tenant': 'b' }, { 'x-aether-browser-token': client.clientToken, 'x-test-user': 'user-b' }]) {
      const response = await app.inject({ method: 'GET', url: `/api/v1/browser/clients/${client.clientId}/commands`, headers })
      expect(response.statusCode).toBe(404)
    }
  })

  it('returns an empty heartbeat after a bounded poll and renews with credentials', async () => {
    const client = await register()
    const response = await app.inject({ method: 'GET', url: `/api/v1/browser/clients/${client.clientId}/commands`, headers: { 'x-aether-browser-token': client.clientToken } })
    expect(response.json().data).toEqual({ commands: [] })
    const resumed = await app.inject({ method: 'POST', url: '/api/v1/browser/clients', payload: client })
    expect(resumed.json().data.clientId).toBe(client.clientId)
  })

  it('rejects invalid sessions, partial resume and attempted replacement', async () => {
    const client = await register()
    for (const payload of [{ sessionId: '../chat' }, { sessionId: 'chat', clientId: client.clientId }, { sessionId: 'chat', clientToken: client.clientToken }]) {
      expect((await app.inject({ method: 'POST', url: '/api/v1/browser/clients', payload })).statusCode).toBe(400)
    }
    expect((await app.inject({ method: 'POST', url: '/api/v1/browser/clients', payload: { sessionId: 'chat' } })).statusCode).toBe(409)
  })
})

describe('browser request cancellation watch routes', () => {
  it('confirms a delivered request and independently reports its run cancellation', async () => {
    const registration = await app.inject({ method: 'POST', url: '/api/v1/browser/clients', payload: { sessionId: 'chat' } })
    const client = registration.json().data
    expect(client.capabilities).toMatchObject({ requestWatch: true })
    const headers = { 'x-aether-browser-token': client.clientToken }
    const controller = new AbortController()
    const action = bridge.execute('click', { tabId: 'A', navigationId: 1, ref: '1:1' }, { tenantId: 'a', sessionId: 'chat', signal: controller.signal })
    const polled = await app.inject({ method: 'GET', url: `/api/v1/browser/clients/${client.clientId}/commands`, headers })
    const command = polled.json().data.commands[0]
    const url = `/api/v1/browser/clients/${client.clientId}/requests/${command.requestId}/state`
    const initial = await app.inject({ method: 'GET', url: url + '?wait=false', headers })
    expect(initial.statusCode).toBe(200)
    expect(initial.headers['cache-control']).toBe('no-store')
    expect(initial.json().data).toEqual({ active: true })
    const waiting = app.inject({ method: 'GET', url: url + '?wait=true', headers }).then(response => response)
    controller.abort()
    expect((await waiting).json().data).toEqual({ active: false })
    expect(await action).toMatchObject({ status: 'cancelled' })
    expect((await app.inject({ method: 'GET', url: url + '?wait=false', headers })).json().data).toEqual({ active: false })
    const late = await app.inject({ method: 'POST', url: `/api/v1/browser/clients/${client.clientId}/results`, headers,
      payload: { requestId: command.requestId, success: true, output: 'late result' } })
    expect(late.json().data.accepted).toBe(false)
  })

  it('does not expose request state without the original tenant, user and token', async () => {
    const client = await register()
    for (const headers of [{}, { 'x-aether-browser-token': 'wrong' },
      { 'x-aether-browser-token': client.clientToken, 'x-test-tenant': 'other' },
      { 'x-aether-browser-token': client.clientToken, 'x-test-user': 'other' }]) {
      const response = await app.inject({ method: 'GET', url: `/api/v1/browser/clients/${client.clientId}/requests/unknown/state?wait=false`, headers })
      expect(response.statusCode).toBe(404)
    }
    const headers = { 'x-aether-browser-token': client.clientToken }
    expect((await app.inject({ method: 'GET', url: `/api/v1/browser/clients/${client.clientId}/requests/unknown/state?wait=invalid`, headers })).statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: `/api/v1/browser/clients/${client.clientId}/requests/unknown/state?wait=false`, headers })).json().data).toEqual({ active: false })
  })
})
