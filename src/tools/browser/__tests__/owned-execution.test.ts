/** Real broker and Fastify schemas: current execution identity, account boundary, bounded metadata, late-result preservation. No native-page ACK claim. */
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AuthContext } from '../../../auth/types.js'
import { browserExecutionIdentity, browserExecutionsMatch, browserPrincipalFromAuth, type BrowserExecutionContext, type BrowserExecutionIdentity } from '../../../core/browser-execution.js'
import { normalizeBrowserFailure } from '../../../core/utils/browser-failure.js'
import { browserRoutes } from '../../../api/http/routes/browser.js'
import { BrowserBridge } from '../browser-bridge.js'

const account = { tenantId: 'owned-tenant', userId: 'user-A', method: 'session' as const }
const context = (rootRunId = 'root-R1', ownerRunId?: string): BrowserExecutionContext => ({
  tenantId: account.tenantId, sessionId: ownerRunId ? 'child-chat' : 'root-chat', rootSessionId: 'root-chat', rootRunId,
  ...(ownerRunId ? { runId: ownerRunId } : {}), browserPrincipal: browserPrincipalFromAuth(account),
})
let bridge: BrowserBridge
let app: FastifyInstance
beforeEach(async () => {
  bridge = new BrowserBridge({ pollTimeoutMs: 5 })
  app = Fastify()
  app.addHook('onRequest', async request => {
    ;(request as FastifyRequest & { authContext?: AuthContext }).authContext = {
      tenantId: String(request.headers['x-test-tenant'] ?? account.tenantId), userId: String(request.headers['x-test-user'] ?? account.userId), method: 'session',
    }
  })
  await app.register(browserRoutes, { prefix: '/api/v1', bridge })
})
afterEach(async () => { await app.close() })

async function client(version = 2) {
  const response = await app.inject({ method: 'POST', url: '/api/v1/browser/clients', payload: { sessionId: 'root-chat', protocolVersion: version } })
  expect(response.statusCode).toBe(200)
  return response.json().data as { clientId: string; clientToken: string; sessionId: string; protocolVersion: 1 | 2; capabilities: Record<string, unknown> }
}
const headers = (registration: { clientToken: string }) => ({ 'x-aether-browser-token': registration.clientToken })
const query = (identity: BrowserExecutionIdentity) => new URLSearchParams({ ...identity, wait: 'false' }).toString()

describe('execution identity source', () => {
  it('uses current admission for the root and actual execution for a child', () => {
    expect(browserExecutionIdentity(context())).toEqual({ rootSessionId: 'root-chat', rootRunId: 'root-R1', ownerRunId: 'root-R1' })
    expect(browserExecutionIdentity(context('root-R2', 'child-current'))).toEqual({ rootSessionId: 'root-chat', rootRunId: 'root-R2', ownerRunId: 'child-current' })
    const withArchivedData = { ...context('root-R3', 'child-next'), continuation: { rootRunId: 'root-old', runId: 'child-old' }, args: { rootRunId: 'forged-root', runId: 'forged-child' } }
    expect(browserExecutionIdentity(withArchivedData)).toEqual({ rootSessionId: 'root-chat', rootRunId: 'root-R3', ownerRunId: 'child-next' })
  })

  it.each(['rootRunId', 'rootSessionId', 'runId'] as const)('rejects invalid %s instead of fabricating an owner', field => {
    const child = context('root-R1', 'child-one')
    expect(browserExecutionIdentity({ ...child, [field]: '' })).toBeUndefined()
    expect(browserExecutionIdentity({ ...child, [field]: '../foreign' })).toBeUndefined()
    expect(browserExecutionIdentity({ ...child, [field]: 'x'.repeat(129) })).toBeUndefined()
  })

  it('requires a child execution id and never substitutes the root for a missing child', () => {
    expect(browserExecutionIdentity({ ...context(), sessionId: 'child' })).toBeUndefined()
    expect(browserExecutionIdentity({ ...context(), rootRunId: undefined, runId: 'child-only' })).toBeUndefined()
  })

  it('copies only the authenticated principal and freezes identity snapshots', () => {
    const auth = { ...account, roles: ['admin'], sessionId: 'auth-session', syntheticPrivateMarker: 'not-exported' }
    const principal = browserPrincipalFromAuth(auth)
    auth.userId = 'user-B'
    expect(principal).toEqual(account)
    expect(Object.keys(principal).sort()).toEqual(['method', 'tenantId', 'userId'])
    expect(Object.isFrozen(principal)).toBe(true)
    const admitted = context()
    const identity = browserExecutionIdentity(admitted)!
    admitted.rootRunId = 'root-later'
    expect(identity.rootRunId).toBe('root-R1')
    expect(Object.isFrozen(identity)).toBe(true)
    expect(browserPrincipalFromAuth()).toEqual({ tenantId: 'default', userId: undefined, method: 'none' })
  })

  it('compares all three execution fields and rejects arrays or omitted identity', () => {
    const identity = browserExecutionIdentity(context())!
    expect(browserExecutionsMatch({ ...identity }, identity)).toBe(true)
    expect(browserExecutionsMatch(undefined, identity)).toBe(false)
    expect(browserExecutionsMatch([identity], identity)).toBe(false)
    for (const field of ['rootSessionId', 'rootRunId', 'ownerRunId'] as const) expect(browserExecutionsMatch({ ...identity, [field]: 'foreign' }, identity)).toBe(false)
  })
})

describe('owned broker protocol', () => {
  it('carries current admission identity outside model action args', async () => {
    const registration = bridge.register(account, 'root-chat', undefined, 2)
    const action = bridge.execute('network_detail', { requestId: 'network-resource', execution: { rootRunId: 'forged' }, rootRunId: 'forged' }, context('root-R2', 'child-current'))
    const [command] = await bridge.poll(account, registration.clientId, registration.clientToken)
    expect(command.execution).toEqual({ rootSessionId: 'root-chat', rootRunId: 'root-R2', ownerRunId: 'child-current' })
    expect(command.sessionId).toBe('root-chat')
    expect(command.requestId).not.toBe(command.args.requestId)
    expect(bridge.result(account, registration.clientId, registration.clientToken, command.requestId, { success: true, output: 'observed' }, command.execution)).toBe(true)
    expect(await action).toEqual({ success: true, output: 'observed' })
  })

  it('does not queue v2 commands without real admission or child identity', async () => {
    const registration = bridge.register(account, 'root-chat', undefined, 2)
    for (const ctx of [{ ...context(), rootRunId: undefined }, { ...context(), sessionId: 'child' }]) {
      expect(await bridge.execute('click', {}, ctx)).toMatchObject({ success: false, metadata: { code: 'BROWSER_EXECUTION_IDENTITY_UNAVAILABLE', operationPerformed: false } })
    }
    expect(await bridge.poll(account, registration.clientId, registration.clientToken)).toEqual([])
  })

  it('does not route an authenticated account to another account in the same tenant', async () => {
    const registration = bridge.register(account, 'root-chat', undefined, 2)
    for (const principal of [undefined, { ...account, userId: 'user-B' }, { ...account, tenantId: 'foreign' }]) {
      expect(await bridge.execute('click', {}, { ...context(), browserPrincipal: principal })).toMatchObject({ success: false, metadata: { code: 'BROWSER_EXECUTION_PRINCIPAL_MISMATCH', operationPerformed: false } })
    }
    expect(await bridge.poll(account, registration.clientId, registration.clientToken)).toEqual([])
  })

  it('rejects mismatched results and preserves the pending original execution', async () => {
    const registration = bridge.register(account, 'root-chat', undefined, 2)
    const action = bridge.execute('click', {}, context('root-R1', 'child-one'))
    const [command] = await bridge.poll(account, registration.clientId, registration.clientToken)
    const correct = command.execution!
    expect(bridge.result(account, registration.clientId, registration.clientToken, command.requestId, { success: true, output: 'missing identity' })).toBe(false)
    for (const field of ['rootSessionId', 'rootRunId', 'ownerRunId'] as const) {
      expect(bridge.result(account, registration.clientId, registration.clientToken, command.requestId, { success: true, output: 'wrong identity' }, { ...correct, [field]: 'foreign' })).toBe(false)
      expect(await bridge.watchRequest(account, registration.clientId, registration.clientToken, command.requestId, false, undefined, { ...correct, [field]: 'foreign' })).toEqual({ active: false })
    }
    expect(await bridge.watchRequest(account, registration.clientId, registration.clientToken, command.requestId, false, undefined, correct)).toEqual({ active: true, execution: correct })
    expect(bridge.result(account, registration.clientId, registration.clientToken, command.requestId, { success: false, output: '', error: 'not dispatched', metadata: { code: 'BROWSER_QUEUE_CANCELLED', operationPerformed: false } }, correct)).toBe(true)
    expect(await action).toMatchObject({ success: false, metadata: { code: 'BROWSER_QUEUE_CANCELLED', operationPerformed: false } })
  })

  it('old root cancellation cannot settle newer root or child command in the same chat', async () => {
    const registration = bridge.register(account, 'root-chat', undefined, 2)
    const oldController = new AbortController()
    const old = bridge.execute('click', {}, { ...context('root-old'), signal: oldController.signal })
    const [oldCommand] = await bridge.poll(account, registration.clientId, registration.clientToken)
    const next = bridge.execute('fill', {}, context('root-new', 'child-new'))
    const [newCommand] = await bridge.poll(account, registration.clientId, registration.clientToken)
    oldController.abort()
    expect(await old).toMatchObject({ status: 'cancelled', metadata: { operationPerformed: 'unknown' } })
    expect(await bridge.watchRequest(account, registration.clientId, registration.clientToken, newCommand.requestId, false, undefined, newCommand.execution)).toMatchObject({ active: true, execution: { rootRunId: 'root-new', ownerRunId: 'child-new' } })
    expect(bridge.result(account, registration.clientId, registration.clientToken, oldCommand.requestId, { success: false, output: 'late false', metadata: { operationPerformed: false } }, oldCommand.execution)).toBe(false)
    expect(bridge.result(account, registration.clientId, registration.clientToken, newCommand.requestId, { success: true, output: 'new result' }, newCommand.execution)).toBe(true)
    expect(await next).toEqual({ success: true, output: 'new result' })
  })

  it('negotiates capabilities honestly and cannot switch version while renewing a client', () => {
    const owned = bridge.register(account, 'root-chat', undefined, 2)
    expect(owned).toMatchObject({ protocolVersion: 2, capabilities: { requestWatch: true, executionIdentity: 1, resultMetadata: 1 } })
    expect(bridge.register(account, 'root-chat', owned, 2)).toEqual(owned)
    expect(() => bridge.register(account, 'root-chat', owned, 1)).toThrow('protocol cannot change')
    const legacy = bridge.register(account, 'legacy-chat')
    expect(legacy.protocolVersion).toBe(1)
    expect(legacy.capabilities).toEqual({ requestWatch: true })
  })
})

describe('owned HTTP schema and transport', () => {
  it('HTTP serializers preserve current root and child identity plus result metadata', async () => {
    const registration = await client()
    expect(registration.capabilities).toMatchObject({ executionIdentity: 1, resultMetadata: 1 })
    const action = bridge.execute('click', { tabId: 'tab' }, context('root-R2', 'child-current'))
    const polled = await app.inject({ method: 'GET', url: `/api/v1/browser/clients/${registration.clientId}/commands`, headers: headers(registration) })
    expect(polled.statusCode).toBe(200)
    const command = polled.json().data.commands[0]
    expect(command.execution).toEqual({ rootSessionId: 'root-chat', rootRunId: 'root-R2', ownerRunId: 'child-current' })
    const watch = await app.inject({ method: 'GET', url: `/api/v1/browser/clients/${registration.clientId}/requests/${command.requestId}/state?${query(command.execution)}`, headers: headers(registration) })
    expect(watch.json().data).toEqual({ active: true, execution: command.execution })
    const metadata = { code: 'BROWSER_QUEUE_CANCELLED', operationPerformed: false }
    const answer = await app.inject({ method: 'POST', url: `/api/v1/browser/clients/${registration.clientId}/results`, headers: headers(registration), payload: { requestId: command.requestId, execution: command.execution, success: false, output: '', error: 'queued request cancelled', status: 'cancelled', metadata } })
    expect(answer.statusCode).toBe(200)
    expect(answer.json().data.accepted).toBe(true)
    const result = await action
    expect(result).toEqual({ success: false, output: '', error: 'queued request cancelled', status: 'cancelled', metadata })
    expect(normalizeBrowserFailure(result, 'click').metadata).toMatchObject(metadata)
  })

  it.each([false, true, 'unknown'] as const)('preserves explicit operationPerformed %s through HTTP', async operationPerformed => {
    const registration = await client()
    const action = bridge.execute('fill', {}, context())
    const response = await app.inject({ method: 'GET', url: `/api/v1/browser/clients/${registration.clientId}/commands`, headers: headers(registration) })
    const command = response.json().data.commands[0]
    const answer = await app.inject({ method: 'POST', url: `/api/v1/browser/clients/${registration.clientId}/results`, headers: headers(registration), payload: { requestId: command.requestId, execution: command.execution, success: false, output: '', error: 'explicit native outcome', metadata: { code: 'BROWSER_INPUT_FAILED', operationPerformed } } })
    expect(answer.json().data.accepted).toBe(true)
    const result = await action
    expect(result.metadata?.operationPerformed).toBe(operationPerformed)
    expect(normalizeBrowserFailure(result).metadata?.operationPerformed).toBe(operationPerformed)
  })

  it('rejects incomplete or malformed identities and result phase metadata without consuming the command', async () => {
    const registration = await client()
    const action = bridge.execute('click', {}, context())
    const response = await app.inject({ method: 'GET', url: `/api/v1/browser/clients/${registration.clientId}/commands`, headers: headers(registration) })
    const command = response.json().data.commands[0]
    const base = { requestId: command.requestId, success: false, output: '', execution: command.execution }
    for (const patch of [
      { execution: { rootSessionId: 'root-chat', rootRunId: 'root-R1' } },
      { execution: { ...command.execution, ownerRunId: '../foreign' } },
      { execution: { ...command.execution, ownerRunId: 1 } },
      { success: 'false' },
      { output: null },
      { metadata: { code: 'BROWSER_INPUT_FAILED', operationPerformed: null } },
      { metadata: { code: 'BROWSER_INPUT_FAILED', operationPerformed: 1 } },
      { metadata: { code: 'BROWSER_INPUT_FAILED', operationPerformed: 'false' } },
      { metadata: { code: 'unbounded-error', operationPerformed: false } },
      { metadata: { code: 'BROWSER_' + 'X'.repeat(100), operationPerformed: false } },
      { metadata: { code: 'BROWSER_INPUT_FAILED', operationPerformed: false, syntheticPrivateMarker: 'not-supported' } },
    ]) {
      expect((await app.inject({ method: 'POST', url: `/api/v1/browser/clients/${registration.clientId}/results`, headers: headers(registration), payload: { ...base, ...patch } })).statusCode).toBe(400)
    }
    const missing = await app.inject({ method: 'POST', url: `/api/v1/browser/clients/${registration.clientId}/results`, headers: headers(registration), payload: { requestId: command.requestId, success: true, output: 'missing' } })
    expect(missing.json().data.accepted).toBe(false)
    const partialWatch = await app.inject({ method: 'GET', url: `/api/v1/browser/clients/${registration.clientId}/requests/${command.requestId}/state?rootRunId=root-R1`, headers: headers(registration) })
    expect(partialWatch.statusCode).toBe(400)
    expect(bridge.result(account, registration.clientId, registration.clientToken, command.requestId, { success: true, output: 'still pending' }, command.execution)).toBe(true)
    expect(await action).toEqual({ success: true, output: 'still pending' })
  })

  it('preserves an original cancellation even when a late native false result arrives', async () => {
    const registration = await client()
    const controller = new AbortController()
    const action = bridge.execute('click', {}, { ...context(), signal: controller.signal })
    const response = await app.inject({ method: 'GET', url: `/api/v1/browser/clients/${registration.clientId}/commands`, headers: headers(registration) })
    const command = response.json().data.commands[0]
    controller.abort()
    const cancelled = await action
    expect(cancelled).toMatchObject({ status: 'cancelled', metadata: { operationPerformed: 'unknown' } })
    const late = await app.inject({ method: 'POST', url: `/api/v1/browser/clients/${registration.clientId}/results`, headers: headers(registration), payload: { requestId: command.requestId, execution: command.execution, success: false, output: '', metadata: { code: 'BROWSER_QUEUE_CANCELLED', operationPerformed: false } } })
    expect(late.json().data.accepted).toBe(false)
    expect(cancelled.metadata?.operationPerformed).toBe('unknown')
  })

  it('keeps original account and secret checks on owned watch and result routes', async () => {
    const registration = await client()
    const action = bridge.execute('click', {}, context())
    const response = await app.inject({ method: 'GET', url: `/api/v1/browser/clients/${registration.clientId}/commands`, headers: headers(registration) })
    const command = response.json().data.commands[0]
    const payload = { requestId: command.requestId, execution: command.execution, success: true, output: 'foreign result' }
    for (const foreign of [{ 'x-test-user': 'user-B' }, { 'x-test-tenant': 'other-tenant' }, { 'x-aether-browser-token': 'wrong' }]) {
      expect((await app.inject({ method: 'POST', url: `/api/v1/browser/clients/${registration.clientId}/results`, headers: { ...headers(registration), ...foreign }, payload })).statusCode).toBe(404)
      expect((await app.inject({ method: 'GET', url: `/api/v1/browser/clients/${registration.clientId}/requests/${command.requestId}/state?${query(command.execution)}`, headers: { ...headers(registration), ...foreign } })).statusCode).toBe(404)
    }
    expect(bridge.result(account, registration.clientId, registration.clientToken, command.requestId, { success: true, output: 'owned' }, command.execution)).toBe(true)
    expect(await action).toEqual({ success: true, output: 'owned' })
  })

  it('rejects unsupported versions and retains the same negotiated version on renew', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/v1/browser/clients', payload: { sessionId: 'other', protocolVersion: 3 } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: '/api/v1/browser/clients', payload: { sessionId: 'other', protocolVersion: '2' } })).statusCode).toBe(400)
    const registration = await client()
    const changed = await app.inject({ method: 'POST', url: '/api/v1/browser/clients', payload: { sessionId: registration.sessionId, clientId: registration.clientId, clientToken: registration.clientToken, protocolVersion: 1 } })
    expect(changed.statusCode).toBe(409)
    const resumed = await app.inject({ method: 'POST', url: '/api/v1/browser/clients', payload: { sessionId: registration.sessionId, clientId: registration.clientId, clientToken: registration.clientToken, protocolVersion: 2 } })
    expect(resumed.json().data.protocolVersion).toBe(2)
  })
})
