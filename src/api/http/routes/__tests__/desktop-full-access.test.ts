/** Real route/auth/token gates: desktop-owned session access must not become a remote admin role. */
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import { SignJWT } from 'jose'
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AuthContext } from '../../../../auth/types.js'
import { requireRoles } from '../../../../auth/guards.js'
import { registerAccount, type AccountLoginResult } from '../../../../auth/accounts.js'
import { closeDb, initDb } from '../../../../storage/sqlite/db.js'
import { TRUSTED_STARTUP_KEYS } from '../../../../storage/sqlite/system-config.js'
import { clearSecurityMode, getSecurityMode } from '../../../../security/policy-engine.js'
import { authMiddlewareHook, configureRequestAuthentication, type RequestAuthenticationStartup } from '../../middleware.js'
import { securityRoutes } from '../security.js'

const secret = 'desktop-session-authority-jwt-secret'
const token = 'desktop-process-owned-instance-token'
const tenantId = 'desktop-session-tenant'
let app: FastifyInstance | undefined
let tenantBearer: string
let adminBearer: string
let viewerBearer: string
let account: AccountLoginResult
const changedSessions: [string, string][] = []

async function bearer(roles?: string[]) {
  return new SignJWT({ tenantId, roles }).setProtectedHeader({ alg: 'HS256' })
    .setSubject('desktop-user').setExpirationTime('5m').sign(new TextEncoder().encode(secret))
}

beforeAll(async () => {
  vi.stubEnv('JWT_SECRET', secret)
  vi.stubEnv('ENCRYPTION_KEY', 'a'.repeat(64))
  vi.stubEnv('AETHER_ACCOUNT_REGISTRATION', 'true')
  await initDb()
  account = await registerAccount()
  tenantBearer = await bearer(['tenant-admin'])
  adminBearer = await bearer(['admin'])
  viewerBearer = await bearer()
})
afterAll(() => { closeDb(); vi.unstubAllEnvs() })
afterEach(async () => {
  await app?.close(); app = undefined
  for (const [tenant, session] of changedSessions.splice(0)) clearSecurityMode(tenant, session)
})

async function start(options: { startup?: RequestAuthenticationStartup; authEnabled?: string; gate?: string; marker?: string } = {}) {
  vi.stubEnv('AUTH_ENABLED', options.authEnabled ?? 'false')
  vi.stubEnv('AETHER_INSTANCE_TOKEN', options.gate)
  vi.stubEnv('AETHER_DESKTOP_OWNED', options.marker)
  vi.stubEnv('JWT_SECRET', secret)
  vi.stubEnv('DEFAULT_SECURITY_MODE', 'standard')
  configureRequestAuthentication(options.startup ?? {})
  // request.ip deliberately trusts proxy headers; authorization must use the raw peer socket instead.
  app = Fastify({ trustProxy: true })
  app.addHook('onRequest', authMiddlewareHook)
  await app.register(securityRoutes, { prefix: '/api/v1' })
  app.put('/global-admin', { preHandler: requireRoles('admin') }, async () => ({ changed: true }))
  app.get('/identity', async request => (request as FastifyRequest & { authContext?: AuthContext }).authContext)
  return app
}
const desktop = { desktopOwned: true, listenHost: '127.0.0.1' }
const headers = (who: string | undefined = tenantBearer, gate: string | undefined = token) => ({
  ...(gate === undefined ? {} : { 'x-aether-instance-token': gate }),
  ...(who === undefined ? {} : { authorization: `Bearer ${who}` }),
})
async function full(options: { who?: string; gate?: string; remoteAddress?: string; extraHeaders?: Record<string, string>; session?: string } = {}) {
  const sessionId = options.session ?? randomUUID()
  changedSessions.push([tenantId, sessionId], [account.user.tenantId, sessionId], ['default', sessionId])
  return app!.inject({ method: 'PUT', url: '/api/v1/security/mode', remoteAddress: options.remoteAddress ?? '127.0.0.1',
    headers: { ...headers(options.who, options.gate), ...options.extraHeaders },
    payload: { sessionId, mode: 'full-access', desktopOwned: true, roles: ['admin'] } })
}

describe('desktop-owned full-access mode is a bounded session capability', () => {
  it('lets a real signed-in local tenant administrator switch without changing identity or instance roles', async () => {
    await start({ startup: desktop, gate: token, marker: '1' })
    const sessionId = randomUUID()
    const response = await full({ who: account.accessToken, session: sessionId })
    expect(response.statusCode).toBe(200)
    expect(response.json().data).toEqual({ sessionId, mode: 'full-access' })
    expect(getSecurityMode(account.user.tenantId, sessionId)).toBe('full-access')
    expect(getSecurityMode('default', sessionId)).toBe('standard')
    expect(getSecurityMode('another-tenant', sessionId)).toBe('standard')
    const identity = await app!.inject({ url: '/identity', headers: headers(account.accessToken) })
    expect(identity.json()).toMatchObject({ tenantId: account.user.tenantId, userId: account.user.id, method: 'session', roles: ['tenant-admin'] })
    const instanceAdmin = await app!.inject({ method: 'PUT', url: '/global-admin', headers: headers(account.accessToken), payload: {} })
    expect(instanceAdmin.json().code).toBe(41015)
  })

  it.each(['127.0.0.1', '127.23.4.5', '::1', '::ffff:127.0.0.1', '0:0:0:0:0:0:0:1'])('accepts a real loopback peer %s', async remoteAddress => {
    await start({ startup: desktop, gate: token })
    expect((await full({ remoteAddress })).json().data.mode).toBe('full-access')
  })
  it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1'])('accepts the actual numeric loopback listen host %s', async listenHost => {
    await start({ startup: { desktopOwned: true, listenHost }, gate: token })
    expect((await full()).statusCode).toBe(200)
  })
  it.each(['0.0.0.0', '::', '192.0.2.1', 'localhost', '', undefined])('does not grant owner access for an unverified/wildcard listener %s', async listenHost => {
    await start({ startup: { desktopOwned: true, listenHost }, gate: token })
    expect((await full()).statusCode).toBe(403)
  })
  it.each(['192.0.2.1', '10.0.0.2', '::ffff:192.0.2.1', '2001:db8::1'])('rejects a non-loopback socket %s despite forged local metadata', async remoteAddress => {
    await start({ startup: desktop, gate: token })
    const response = await full({ remoteAddress, extraHeaders: { host: '127.0.0.1', 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '::1', 'x-aether-desktop-owned': '1' } })
    expect(response.statusCode).toBe(403)
    expect(response.json().code).toBe(40300)
  })
  it('does not infer desktop ownership from an instance token, startup environment, or request claims', async () => {
    await start({ gate: token, marker: '1' })
    const response = await full({ extraHeaders: { 'x-aether-desktop-owned': '1', 'x-aether-engine-host': '127.0.0.1' } })
    expect(response.statusCode).toBe(403)
  })
  it('retains full-access refusal for authentication-required deployments', async () => {
    await start({ startup: desktop, gate: token, authEnabled: 'true', marker: '1' })
    expect((await full()).statusCode).toBe(403)
  })
  it('preserves remote instance-admin access and ordinary tenant modes', async () => {
    await start({ gate: token, authEnabled: 'true' })
    expect((await full({ who: adminBearer, remoteAddress: '192.0.2.1' })).statusCode).toBe(200)
    expect((await full()).statusCode).toBe(403)
    for (const mode of ['safe', 'standard']) {
      const sessionId = randomUUID(); changedSessions.push([tenantId, sessionId])
      const response = await app!.inject({ method: 'PUT', url: '/api/v1/security/mode', headers: headers(), payload: { sessionId, mode } })
      expect(response.json().data).toEqual({ sessionId, mode })
    }
  })
  it('does not turn an authenticated viewer into a tenant administrator', async () => {
    await start({ startup: desktop, gate: token })
    const response = await full({ who: viewerBearer })
    expect(response.json().code).toBe(41015)
  })
  it.each([undefined, ''])('requires a configured nonempty instance gate %s', async gate => {
    await start({ startup: desktop, gate })
    const response = await full()
    expect(response.statusCode).toBe(gate === undefined ? 403 : 401)
  })
  it('rejects a wrong or missing request token before allowing mode mutation', async () => {
    await start({ startup: desktop, gate: token })
    expect((await full({ gate: 'wrong-token' })).statusCode).toBe(401)
    const response = await app!.inject({ method: 'PUT', url: '/api/v1/security/mode', headers: { authorization: `Bearer ${tenantBearer}` }, payload: { sessionId: randomUUID(), mode: 'full-access' } })
    expect(response.statusCode).toBe(401)
  })
  it('keeps the existing local anonymous mode switch', async () => {
    await start({ startup: desktop, gate: token })
    const sessionId = randomUUID(); changedSessions.push(['default', sessionId])
    const response = await app!.inject({ method: 'PUT', url: '/api/v1/security/mode', headers: { 'x-aether-instance-token': token }, payload: { sessionId, mode: 'full-access' } })
    expect(response.json().data).toEqual({ sessionId, mode: 'full-access' })
  })
  it('does not acquire ownership or anonymous deployment rights from late environment changes', async () => {
    await start({ startup: { desktopOwned: false, listenHost: '0.0.0.0' }, gate: token, authEnabled: 'true' })
    vi.stubEnv('AUTH_ENABLED', 'false'); vi.stubEnv('AETHER_DESKTOP_OWNED', '1'); vi.stubEnv('AETHER_ENGINE_HOST', '127.0.0.1')
    expect((await full()).statusCode).toBe(403)
  })
  it('retains the frozen owner decision and instance secret after runtime environment edits', async () => {
    await start({ startup: desktop, gate: token })
    vi.stubEnv('AETHER_DESKTOP_OWNED', '0'); vi.stubEnv('AETHER_ENGINE_HOST', '0.0.0.0'); vi.stubEnv('AUTH_ENABLED', 'true'); vi.stubEnv('AETHER_INSTANCE_TOKEN', 'late-token')
    expect((await full()).statusCode).toBe(200)
    expect((await full({ gate: 'late-token' })).statusCode).toBe(401)
  })
  it('marks desktop ownership as deployment configuration protected from settings/DB updates', () => {
    expect(TRUSTED_STARTUP_KEYS.has('AETHER_DESKTOP_OWNED')).toBe(true)
  })
})
