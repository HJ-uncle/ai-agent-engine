// Real Fastify serialization/authentication/gates, owned client creation and actual command broker; no model/native browser.
import Fastify, { type FastifyInstance } from 'fastify'
import { SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { browserRoutes } from '../../../api/http/routes/browser.js'
import { authMiddlewareHook, configureRequestAuthentication } from '../../../api/http/middleware.js'
import { configureInstanceToken, hasOwnedInstanceToken, hasValidInstanceToken } from '../../../auth/instance-token.js'
import { browserAuthorityFromTrustedState, type BrowserHostAuthority } from '../../../core/browser-authority.js'
import type { BrowserExecutionContext, BrowserExecutionIdentity } from '../../../core/browser-execution.js'
import { BrowserBridge, type BrowserCommand } from '../browser-bridge.js'
import { NativeHostDemandBroker, type BrowserHostDemand } from '../native-host-demand.js'

let app: FastifyInstance
let bridge: BrowserBridge
let bearerA: string
let bearerB: string
const instanceToken = 'local-host-demand-instance-token'
const jwtSecret = 'local-host-demand-jwt-secret'
const account: BrowserHostAuthority = { kind: 'account', tenantId: 'same-tenant', userId: 'user-a' }
const other: BrowserHostAuthority = { kind: 'account', tenantId: 'same-tenant', userId: 'user-b' }
type Host = { hostId: string; hostToken: string; authority: BrowserHostAuthority }
type Client = { clientId: string; clientToken: string; sessionId: string; protocolVersion: number }
beforeEach(async () => {
  vi.stubEnv('AUTH_ENABLED', 'false'); vi.stubEnv('AETHER_INSTANCE_TOKEN', instanceToken); vi.stubEnv('JWT_SECRET', jwtSecret)
  configureRequestAuthentication()
  bearerA = await new SignJWT({ tenantId: account.tenantId }).setProtectedHeader({ alg: 'HS256' }).setSubject('user-a').setExpirationTime('5m').sign(new TextEncoder().encode(jwtSecret))
  bearerB = await new SignJWT({ tenantId: other.tenantId }).setProtectedHeader({ alg: 'HS256' }).setSubject('user-b').setExpirationTime('5m').sign(new TextEncoder().encode(jwtSecret))
  bridge = new BrowserBridge({ pollTimeoutMs: 5, hostDemand: { pollTimeoutMs: 5, demandTimeoutMs: 1000 } })
  app = Fastify()
  app.addHook('onRequest', authMiddlewareHook)
  await app.register(browserRoutes, { prefix: '/api/v1', bridge })
})
afterEach(async () => { await app.close(); vi.unstubAllEnvs() })
const headers = (who: 'a' | 'b' | 'instance' = 'a') => ({ 'x-aether-instance-token': instanceToken,
  ...(who === 'instance' ? {} : { authorization: `Bearer ${who === 'a' ? bearerA : bearerB}` }) })
async function register(who: 'a' | 'b' | 'instance' = 'a'): Promise<Host> {
  const response = await app.inject({ method: 'POST', url: '/api/v1/browser/hosts', headers: headers(who), payload: { protocolVersion: 1, authorityKind: who === 'instance' ? 'instance' : 'account' } })
  expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('no-store')
  return response.json().data
}
async function demand(host: Host, who: 'a' | 'b' | 'instance' = 'a'): Promise<BrowserHostDemand> {
  const response = await app.inject({ method: 'GET', url: `/api/v1/browser/hosts/${host.hostId}/demands`, headers: { ...headers(who), 'x-aether-browser-host-token': host.hostToken } })
  expect(response.statusCode).toBe(200); expect(response.json().data.demands).toHaveLength(1)
  return response.json().data.demands[0]
}
async function ready(host: Host, pending: BrowserHostDemand, who: 'a' | 'b' | 'instance' = 'a'): Promise<Client> {
  const response = await app.inject({ method: 'POST', url: `/api/v1/browser/hosts/${host.hostId}/demands/${pending.demandId}/client`,
    headers: { ...headers(who), 'x-aether-browser-host-token': host.hostToken }, payload: { demandToken: pending.demandToken, execution: pending.execution } })
  expect(response.statusCode).toBe(200); expect(response.json().data.protocolVersion).toBe(2)
  return response.json().data
}
function context(session = 'root-a', rootRun = 'run-a', ownerRun?: string, authority: BrowserHostAuthority = account, signal?: AbortSignal): BrowserExecutionContext {
  return { tenantId: authority.tenantId, sessionId: ownerRun ? 'child-' + ownerRun : session, rootSessionId: session, rootRunId: rootRun,
    runId: ownerRun, browserAuthority: authority, browserPrincipal: { tenantId: authority.tenantId, method: authority.kind === 'account' ? 'jwt' : 'none',
      ...(authority.kind === 'account' ? { userId: authority.userId } : {}) }, signal }
}
async function command(client: Client, who: 'a' | 'b' | 'instance' = 'a'): Promise<BrowserCommand> {
  const response = await app.inject({ method: 'GET', url: `/api/v1/browser/clients/${client.clientId}/commands`, headers: { ...headers(who), 'x-aether-browser-token': client.clientToken } })
  expect(response.statusCode).toBe(200); expect(response.json().data.commands).toHaveLength(1)
  return response.json().data.commands[0]
}
async function answer(client: Client, queued: BrowserCommand, who: 'a' | 'b' | 'instance' = 'a') {
  const response = await app.inject({ method: 'POST', url: `/api/v1/browser/clients/${client.clientId}/results`, headers: { ...headers(who), 'x-aether-browser-token': client.clientToken },
    payload: { requestId: queued.requestId, execution: queued.execution, success: true, output: 'ACTUAL_PROTOCOL_RESULT', metadata: { code: 'BROWSER_OBSERVATION_COMPLETE', operationPerformed: false } } })
  expect(response.statusCode).toBe(200); return response.json().data.accepted
}
describe('real native host authority negotiation', () => {
  it('never treats standalone compatibility true or an empty gate as owned authority, and freezes an absent startup decision', async () => {
    vi.stubEnv('AETHER_INSTANCE_TOKEN', undefined)
    configureInstanceToken(undefined)
    expect(hasValidInstanceToken({})).toBe(true)
    expect(hasOwnedInstanceToken({})).toBe(false)
    vi.stubEnv('AETHER_INSTANCE_TOKEN', 'new-late-token')
    expect(hasValidInstanceToken({})).toBe(true)
    expect(hasOwnedInstanceToken({ 'x-aether-instance-token': 'new-late-token' })).toBe(false)
    configureInstanceToken('')
    expect(hasOwnedInstanceToken({ 'x-aether-instance-token': '' })).toBe(false)
  })
  it('registers separate account and real default/none instance hosts and rejects account downgrade', async () => {
    const a = await register(), local = await register('instance')
    expect(a.authority).toEqual(account)
    expect(local.authority).toMatchObject({ kind: 'instance', tenantId: 'default' })
    expect(a.hostId).not.toBe(local.hostId)
    const downgraded = await app.inject({ method: 'POST', url: '/api/v1/browser/hosts', headers: headers(), payload: { protocolVersion: 1, authorityKind: 'instance' } })
    expect(downgraded.statusCode).toBe(403)
  })
  it('rejects missing or bad instance credentials before host registration', async () => {
    for (const h of [{}, { 'x-aether-instance-token': 'wrong' }]) {
      const response = await app.inject({ method: 'POST', url: '/api/v1/browser/hosts', headers: h, payload: { protocolVersion: 1, authorityKind: 'instance' } })
      expect(response.statusCode).toBe(401)
    }
  })
  it('refuses anonymous instance hosts when authentication is required or when no configured token exists', async () => {
    vi.stubEnv('AUTH_ENABLED', 'true'); configureRequestAuthentication()
    expect((await app.inject({ method: 'POST', url: '/api/v1/browser/hosts', headers: headers('instance'), payload: { protocolVersion: 1, authorityKind: 'instance' } })).statusCode).toBe(401)
    vi.stubEnv('AUTH_ENABLED', 'false'); vi.stubEnv('AETHER_INSTANCE_TOKEN', undefined); configureRequestAuthentication()
    expect((await app.inject({ method: 'POST', url: '/api/v1/browser/hosts', payload: { protocolVersion: 1, authorityKind: 'instance' } })).statusCode).toBe(403)
  })
  it('enforces singleton, exact same-tenant user ownership and same host renewal', async () => {
    const a = await register(), b = await register('b')
    expect(a.hostId).not.toBe(b.hostId)
    expect((await app.inject({ method: 'POST', url: '/api/v1/browser/hosts', headers: headers(), payload: { protocolVersion: 1, authorityKind: 'account' } })).statusCode).toBe(409)
    const renewal = await app.inject({ method: 'POST', url: '/api/v1/browser/hosts', headers: headers(), payload: { protocolVersion: 1, authorityKind: 'account', hostId: a.hostId, hostToken: a.hostToken } })
    expect(renewal.statusCode).toBe(200); expect(renewal.json().data.hostId).toBe(a.hostId)
    for (const h of [{ ...headers('b'), 'x-aether-browser-host-token': a.hostToken }, { ...headers(), 'x-aether-browser-host-token': 'guessed' }]) {
      expect((await app.inject({ method: 'GET', url: `/api/v1/browser/hosts/${a.hostId}/demands`, headers: h })).statusCode).toBe(404)
    }
  })
  it('validates raw negotiated types and ignores forged body authority instead of selecting its user', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/v1/browser/hosts', headers: headers(), payload: { protocolVersion: '1', authorityKind: 'account' } })).statusCode).toBe(400)
    const response = await app.inject({ method: 'POST', url: '/api/v1/browser/hosts', headers: headers(), payload: { protocolVersion: 1, authorityKind: 'account', authority: other } })
    expect(response.statusCode).toBe(200); expect(response.json().data.authority).toEqual(account)
    expect(browserAuthorityFromTrustedState({ tenantId: 'default', method: 'none' }, { gateVerified: true, authenticationRequired: true, instanceId: 'engine' })).toBeUndefined()
  })
})
describe('first use barrier and owned root isolation', () => {
  it('does not dispatch before handshake ACK, then carries actual owner identity outside model arguments', async () => {
    const host = await register(), ctx = context('root', 'root-run', 'child-run')
    const pending = bridge.execute('tabs', { ownerRunId: 'forged-owner' }, ctx)
    const d = await demand(host)
    expect(d.execution).toEqual({ rootSessionId: 'root', rootRunId: 'root-run', ownerRunId: 'child-run' })
    ctx.tenantId = 'mutated-after-admission'; ctx.rootRunId = 'mutated-run'; ctx.runId = 'mutated-owner'; ctx.browserPrincipal = undefined
    const client = await ready(host, d), c = await command(client)
    expect(c.execution).toEqual(d.execution); expect(c.args.ownerRunId).toBe('forged-owner')
    expect(await answer(client, c)).toBe(true); expect((await pending).success).toBe(true)
  })
  it('routes two roots independently and reuses one handshake for different actual children of the same root run', async () => {
    const host = await register()
    const a = bridge.execute('tabs', {}, context('root-a', 'run-a', 'child-a'))
    const a2 = bridge.execute('tabs', {}, context('root-a', 'run-a', 'child-a2'))
    const b = bridge.execute('tabs', {}, context('root-b', 'run-b', 'child-b'))
    const d1 = await demand(host), d2 = await demand(host)
    expect(new Set([d1.execution.rootSessionId, d2.execution.rootSessionId])).toEqual(new Set(['root-a', 'root-b']))
    const ca = await ready(host, d1), cb = await ready(host, d2)
    expect(ca.clientId).not.toBe(cb.clientId)
    const first = await command(ca); await answer(ca, first)
    const second = await command(ca); await answer(ca, second)
    const third = await command(cb); await answer(cb, third)
    expect(new Set([first.execution?.ownerRunId, second.execution?.ownerRunId])).toEqual(new Set(['child-a', 'child-a2']))
    expect(third.execution?.ownerRunId).toBe('child-b')
    expect((await Promise.all([a, a2, b])).map(value => value.success)).toEqual([true, true, true])
  })
  it('distinguishes two runs of one session and rejects old-root release or stale ACK from changing the later run', async () => {
    const host = await register(), old = bridge.execute('tabs', {}, context('same-session', 'old-run'))
    const d1 = await demand(host), c1 = await ready(host, d1), q1 = await command(c1)
    const fresh = bridge.execute('tabs', {}, context('same-session', 'new-run'))
    const d2 = await demand(host), c2 = await ready(host, d2)
    expect(c1.clientId).not.toBe(c2.clientId)
    bridge.hostDemands.releaseRoot(account, 'same-session', 'old-run')
    expect(await old).toMatchObject({ success: false, metadata: { operationPerformed: 'unknown' } })
    const late = await app.inject({ method: 'POST', url: `/api/v1/browser/hosts/${host.hostId}/demands/${d1.demandId}/client`, headers: { ...headers(), 'x-aether-browser-host-token': host.hostToken }, payload: { demandToken: d1.demandToken, execution: d1.execution } })
    expect(late.statusCode).toBe(409)
    const q2 = await command(c2); expect(q2.execution?.rootRunId).toBe('new-run')
    await answer(c2, q2); expect((await fresh).success).toBe(true)
    expect(q1.execution?.rootRunId).toBe('old-run')
  })
  it('keeps instance Cron-like first use independent of logged-in account ownership', async () => {
    const accountHost = await register(), local = await register('instance')
    const pending = bridge.execute('tabs', {}, context('cron-new-target', 'cron-current-run', undefined, local.authority))
    const empty = await app.inject({ method: 'GET', url: `/api/v1/browser/hosts/${accountHost.hostId}/demands`, headers: { ...headers(), 'x-aether-browser-host-token': accountHost.hostToken } })
    expect(empty.json().data.demands).toEqual([])
    const d = await demand(local, 'instance'), client = await ready(local, d, 'instance'), q = await command(client, 'instance')
    await answer(client, q, 'instance'); expect((await pending).success).toBe(true)
  })
  it('does not wait for a mismatched account host or a child missing its actual run', async () => {
    await register()
    expect(await bridge.execute('tabs', {}, context('other-user', 'other-run', undefined, other))).toMatchObject({ success: false, metadata: { code: 'BROWSER_HOST_UNAVAILABLE', operationPerformed: false } })
    expect(await bridge.execute('tabs', {}, { ...context(), sessionId: 'child-without-run' })).toMatchObject({ success: false, metadata: { operationPerformed: false } })
  })
  it('rejects malformed raw execution and mismatched tokens/triples without creating a client or closing the actual demand', async () => {
    const host = await register(), stop = new AbortController(), pending = bridge.execute('tabs', {}, context('root', 'run', undefined, account, stop.signal)), d = await demand(host)
    for (const [execution, demandToken, status] of [[{ ...d.execution, ownerRunId: 1 }, d.demandToken, 400], [{ ...d.execution, rootRunId: 'wrong' }, d.demandToken, 409], [d.execution, 'x'.repeat(32), 409]] as const) {
      expect((await app.inject({ method: 'POST', url: `/api/v1/browser/hosts/${host.hostId}/demands/${d.demandId}/client`, headers: { ...headers(), 'x-aether-browser-host-token': host.hostToken }, payload: { execution, demandToken } })).statusCode).toBe(status)
    }
    const query = new URLSearchParams(d.execution).toString()
    const state = await app.inject({ method: 'GET', url: `/api/v1/browser/hosts/${host.hostId}/demands/${d.demandId}/state?${query}`, headers: { ...headers(), 'x-aether-browser-host-token': host.hostToken, 'x-aether-browser-demand-token': d.demandToken } })
    expect(state.json().data).toEqual({ active: true, execution: d.execution })
    stop.abort(); expect(await pending).toMatchObject({ metadata: { operationPerformed: false } })
  })
})
describe('handshake lifecycle and bounds', () => {
  it('settles cancellation before client creation as false and never accepts its late registration', async () => {
    const host = await register(), stop = new AbortController(), pending = bridge.execute('tabs', {}, context('cancelled-root', 'cancelled-run', undefined, account, stop.signal)), d = await demand(host)
    stop.abort()
    expect(await pending).toMatchObject({ success: false, status: 'cancelled', metadata: { code: 'BROWSER_COMMAND_CANCELLED', operationPerformed: false } })
    expect((await app.inject({ method: 'POST', url: `/api/v1/browser/hosts/${host.hostId}/demands/${d.demandId}/client`, headers: { ...headers(), 'x-aether-browser-host-token': host.hostToken }, payload: { execution: d.execution, demandToken: d.demandToken } })).statusCode).toBe(409)
  })
  it('cancels only one waiter while its sibling can finish, and host loss after command delivery preserves unknown', async () => {
    const host = await register(), stop = new AbortController()
    const a = bridge.execute('tabs', {}, context('siblings', 'run', 'child-a', account, stop.signal))
    const b = bridge.execute('tabs', {}, context('siblings', 'run', 'child-b'))
    const d = await demand(host); stop.abort(); expect(await a).toMatchObject({ metadata: { operationPerformed: false } })
    const client = await ready(host, d); await command(client)
    bridge.hostDemands.unregister(account, host.hostId, host.hostToken)
    expect(await b).toMatchObject({ success: false, metadata: { operationPerformed: 'unknown' } })
  })
  it('settles all pending first use on host loss/dispose and joins the independent cancellation watch', async () => {
    const host = await register(), pending = bridge.execute('tabs', {}, context()), d = await demand(host)
    const watch = bridge.hostDemands.state(account, host.hostId, host.hostToken, d.demandId, d.demandToken, d.execution, true)
    bridge.hostDemands.dispose()
    expect(await pending).toMatchObject({ success: false, metadata: { code: 'BROWSER_HOST_CLOSED', operationPerformed: false } })
    expect(await watch).toEqual({ active: false })
  })
  it('keeps command queued cancellation false and rejects a late false result after a delivered cancellation', async () => {
    const host = await register(), stop = new AbortController(), pending = bridge.execute('tabs', {}, context('cancel-after-ready', 'run', undefined, account, stop.signal))
    const d = await demand(host), client = await ready(host, d), q = await command(client)
    stop.abort(); const cancelled = await pending
    expect(cancelled).toMatchObject({ metadata: { operationPerformed: 'unknown' } })
    expect(await answer(client, q)).toBe(false)
    expect(cancelled.metadata?.operationPerformed).toBe('unknown')
    const queuedStop = new AbortController(), queued = bridge.execute('tabs', {}, context('cancel-after-ready', 'run', undefined, account, queuedStop.signal))
    await Promise.resolve(); queuedStop.abort()
    expect(await queued).toMatchObject({ metadata: { operationPerformed: false } })
  })
  it('bounds hosts, demands, root slots and waiters without evicting active work; releases exact roots to regain capacity', async () => {
    const released: string[] = [], native = new NativeHostDemandBroker<{ clientId: string }>({ maxHosts: 1, maxDemands: 1, maxDemandsPerHost: 1, maxSlotsPerHost: 1, maxWaitersPerDemand: 1,
      register: (_a, e) => ({ clientId: e.rootRunId }), release: c => { released.push(c.clientId) }, pollTimeoutMs: 5 })
    try {
      const h = native.register(account), execution = { rootSessionId: 'root', rootRunId: 'run', ownerRunId: 'run' }
      expect(() => native.register(other)).toThrow('limit reached')
      const active = native.acquire(account, execution)
      await expect(native.acquire(account, execution)).rejects.toMatchObject({ code: 'BROWSER_HOST_WAITER_CAPACITY' })
      await expect(native.acquire(account, { ...execution, rootSessionId: 'other-root' })).rejects.toMatchObject({ code: 'BROWSER_HOST_DEMAND_CAPACITY' })
      const [d] = await native.poll(account, h.hostId, h.hostToken)
      native.ready(account, h.hostId, h.hostToken, d.demandId, d.demandToken, d.execution)
      expect(await active).toEqual({ clientId: 'run' })
      await expect(native.acquire(account, { ...execution, rootRunId: 'later-run' })).rejects.toMatchObject({ code: 'BROWSER_HOST_SLOT_CAPACITY' })
      native.releaseRoot(account, 'root', 'wrong-run'); expect(released).toEqual([])
      native.releaseRoot(account, 'root', 'run'); expect(released).toEqual(['run'])
      const stop = new AbortController(), next = native.acquire(account, { ...execution, rootRunId: 'later-run' }, stop.signal)
      stop.abort(); await expect(next).rejects.toMatchObject({ code: 'BROWSER_COMMAND_CANCELLED' })
    } finally { native.dispose() }
  })
  it('times out bounded first use and expires a silent host without leaking pending work', async () => {
    const native = new NativeHostDemandBroker<{ clientId: string }>({ demandTimeoutMs: 15, leaseMs: 100, pollTimeoutMs: 5,
      register: () => ({ clientId: 'never' }), release: () => {} })
    try {
      native.register(account)
      await expect(native.acquire(account, { rootSessionId: 'root', rootRunId: 'run', ownerRunId: 'run' })).rejects.toMatchObject({ code: 'BROWSER_HOST_DEMAND_TIMEOUT' })
    } finally { native.dispose() }
    const expiring = new NativeHostDemandBroker<{ clientId: string }>({ demandTimeoutMs: 1000, leaseMs: 10, pollTimeoutMs: 5,
      register: () => ({ clientId: 'never' }), release: () => {} })
    try {
      expiring.register(account)
      await expect(expiring.acquire(account, { rootSessionId: 'root', rootRunId: 'run', ownerRunId: 'run' })).rejects.toMatchObject({ code: 'BROWSER_HOST_DISCONNECTED' })
    } finally { expiring.dispose() }
  })
  it('rejects concurrent poll consumers and recovers after cancellation instead of retaining the poll lock', async () => {
    const host = await register(), stop = new AbortController()
    const first = bridge.hostDemands.poll(account, host.hostId, host.hostToken, stop.signal)
    await expect(bridge.hostDemands.poll(account, host.hostId, host.hostToken)).rejects.toMatchObject({ code: 'BROWSER_HOST_POLL_CONFLICT' })
    stop.abort(); expect(await first).toEqual([])
    expect(await bridge.hostDemands.poll(account, host.hostId, host.hostToken)).toEqual([])
  })
  it('does not resolve a failed registration barrier as ready, releases its capacity and settles waiters with a useful failure', async () => {
    let fail = true
    const native = new NativeHostDemandBroker<{ clientId: string }>({ maxDemands: 1, pollTimeoutMs: 5,
      register: () => { if (fail) throw new Error('FIXTURE_REGISTRATION_FAILED'); return { clientId: 'actual-client' } }, release: () => {} })
    try {
      const host = native.register(account), execution = { rootSessionId: 'root', rootRunId: 'run', ownerRunId: 'run' }
      const pending = native.acquire(account, execution)
      const settled = expect(pending).rejects.toMatchObject({ code: 'BROWSER_HOST_CLIENT_REGISTRATION_FAILED' })
      const [d] = await native.poll(account, host.hostId, host.hostToken)
      expect(() => native.ready(account, host.hostId, host.hostToken, d.demandId, d.demandToken, d.execution)).toThrow('FIXTURE_REGISTRATION_FAILED')
      await settled
      fail = false
      const next = native.acquire(account, execution), [newDemand] = await native.poll(account, host.hostId, host.hostToken)
      native.ready(account, host.hostId, host.hostToken, newDemand.demandId, newDemand.demandToken, newDemand.execution)
      expect(await next).toEqual({ clientId: 'actual-client' })
    } finally { native.dispose() }
  })
  it('honors an explicit native failure without dispatching a command or accepting its later client', async () => {
    const host = await register(), pending = bridge.execute('tabs', {}, context('rejected-root', 'run')), d = await demand(host)
    const response = await app.inject({ method: 'POST', url: `/api/v1/browser/hosts/${host.hostId}/demands/${d.demandId}/reject`, headers: { ...headers(), 'x-aether-browser-host-token': host.hostToken },
      payload: { execution: d.execution, demandToken: d.demandToken, code: 'BROWSER_HOST_WINDOW_CLOSED' } })
    expect(response.statusCode).toBe(200); expect(response.json().data.accepted).toBe(true)
    expect(await pending).toMatchObject({ success: false, metadata: { code: 'BROWSER_HOST_WINDOW_CLOSED', operationPerformed: false } })
    expect((await app.inject({ method: 'POST', url: `/api/v1/browser/hosts/${host.hostId}/demands/${d.demandId}/client`, headers: { ...headers(), 'x-aether-browser-host-token': host.hostToken }, payload: { execution: d.execution, demandToken: d.demandToken } })).statusCode).toBe(409)
  })
})
