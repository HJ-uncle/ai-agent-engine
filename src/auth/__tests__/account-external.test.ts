// Real Fastify routes, SQLite flows, account sessions and HTTP OAuth/credential service.
import { issuedFixtureActivation } from './activation-fixture.js'
import fs from 'node:fs'
import path from 'node:path'
import { createServer, type Server } from 'node:http'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { externalAccountRoutes } from '../../api/http/routes/account-external.js'
import { authMiddlewareHook, configureRequestAuthentication } from '../../api/http/middleware.js'
import { registerAccount, getAccountUser, type AccountLoginResult } from '../accounts.js'
import { initDb, getDb, closeDb } from '../../storage/sqlite/db.js'

let upstream: Server, issuer = '', app: FastifyInstance, fixture = ''
let sawUnexpectedCredentialField = false
const fixtureParent = path.resolve('.e2e-tmp', 'account-simplify')
const gate = { 'X-Aether-Instance-Token': 'external-test-instance-token' }
const providerConfig = () => JSON.stringify([
  { id: 'oauth', name: 'Company', type: 'oauth2', issuer, authorizationUrl: `${issuer}/authorize`, tokenUrl: `${issuer}/token`, userInfoUrl: `${issuer}/userinfo`, clientId: 'desktop', mapping: { subject: 'id', userData: 'data' } },
  { id: 'credential', name: 'ERP', type: 'credential', verificationUrl: `${issuer}/verify`, mapping: { subject: 'user.id', name: 'user.name', email: 'user.email', userData: 'user.data' } },
])
async function makeApp(): Promise<FastifyInstance> {
  const server = Fastify({ logger: false })
  configureRequestAuthentication()
  server.addHook('onRequest', authMiddlewareHook)
  await server.register(externalAccountRoutes)
  await server.ready()
  return server
}
beforeAll(async () => {
  upstream = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json')
    if (request.url === '/token') { response.end(JSON.stringify({ access_token: 'upstream-transient-secret', token_type: 'Bearer' })); return }
    if (request.url === '/userinfo') { response.end(JSON.stringify({ id: 'oauth-stable-user', name: 'OAuth User', email: 'same@example.test', data: { team: 'R&D' } })); return }
    if (request.url === '/verify') {
      let body = ''; for await (const chunk of request) body += String(chunk)
      const fields = JSON.parse(body) as Record<string, unknown>, credential = fields.credential
      if (Object.keys(fields).some(key => key !== 'credential')) sawUnexpectedCredentialField = true
      const enrollment = credential === 'new-enrollment-fixture'
      response.end(JSON.stringify({ active: enrollment || credential === 'verified-erp-secret', user: { id: enrollment ? 'new-enrollment-user' : 'erp-stable-user', name: 'ERP User', email: 'same@example.test', data: { company: 'Example' } } })); return
    }
    response.statusCode = 404; response.end('{}')
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const address = upstream.address(); if (!address || typeof address === 'string') throw new Error('Missing port')
  issuer = `http://127.0.0.1:${address.port}`
  fs.mkdirSync(fixtureParent, { recursive: true })
  fixture = fs.mkdtempSync(path.join(fixtureParent, 'external-auth-'))
  vi.stubEnv('DATA_DIR', path.join(fixture, 'account.db'))
  vi.stubEnv('AUTH_ENABLED', 'true'); vi.stubEnv('AETHER_INSTANCE_TOKEN', gate['X-Aether-Instance-Token'])
  vi.stubEnv('ENCRYPTION_KEY', '9'.repeat(64)); vi.stubEnv('AETHER_ACCOUNT_PUBLIC_URL', issuer)
  vi.stubEnv('AETHER_ACCOUNT_PROVIDERS_JSON', providerConfig())
  await initDb(); app = await makeApp()
})
beforeEach(async () => { await getDb().execute('DELETE FROM account_external_limits'); await getDb().execute('DELETE FROM account_external_flows') })
afterAll(async () => {
  await app?.close(); await closeDb()
  if (upstream) await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()))
  vi.unstubAllEnvs()
  if (fixture && path.dirname(fixture) === fixtureParent && path.basename(fixture).startsWith('external-auth-')) {
    try { fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 2, retryDelay: 20 }) }
    catch (error) { if (process.platform !== 'win32' || !error || typeof error !== 'object' || !('code' in error) || error.code !== 'EPERM') throw error }
  }
})
type Flow = { authorizationUrl: string; flowId: string; pollToken: string }
async function begin(mode: 'login' | 'link' | 'reauth' = 'login', account?: AccountLoginResult): Promise<Flow> {
  const response = await app.inject({ method: 'POST', url: '/auth/account/external/start', headers: { ...gate, ...(account ? { Authorization: `Bearer ${account.accessToken}` } : {}) }, payload: { providerId: 'oauth', mode, ...(mode==='login'?{activationCode:await issuedFixtureActivation()}:{}) } })
  expect(response.statusCode, response.body).toBe(200)
  return response.json().data as Flow
}
async function callback(flow: Flow) {
  const state = new URL(flow.authorizationUrl).searchParams.get('state')
  return app.inject({ method: 'GET', url: `/auth/account/external/callback?state=${state}&code=valid-code` })
}
async function poll(flow: Flow, token = flow.pollToken, account?: AccountLoginResult) {
  return app.inject({ method: 'POST', url: '/auth/account/external/poll', headers: { ...gate, ...(account ? { Authorization: `Bearer ${account.accessToken}` } : {}) }, payload: { flowId: flow.flowId, pollToken: token } })
}

describe('persistent browser and credential login flows', () => {
  it('requires instance admission for initiation while allowing only state-protected callback without headers', async () => {
    expect((await app.inject({ method: 'GET', url: '/auth/account/providers' })).statusCode).toBe(401)
    const capabilities = (await app.inject({ method: 'GET', url: '/auth/account/providers', headers: gate })).json().data
    expect(capabilities.providers).toHaveLength(2)
    expect(capabilities).toMatchObject({ registrationEnabled: true, activationCodeRequired: true })
    expect((await app.inject({ method: 'GET', url: '/auth/account/external/callback?state=bad&code=x' })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: '/auth/account/external/start', payload: { providerId: 'oauth' } })).statusCode).toBe(401)
  })
  it('requires local enrollment only for a first provider login and never forwards the opening code', async () => {
    const send = (activationCode?: string) => app.inject({ method: 'POST', url: '/auth/account/external/credential', headers: gate,
      payload: { providerId: 'credential', credential: 'new-enrollment-fixture', mode: 'login', ...(activationCode ? { activationCode } : {}) } })
    sawUnexpectedCredentialField = false
    expect((await send()).statusCode).toBe(403)
    const code = await issuedFixtureActivation(), enrolled = await send(code)
    expect(enrolled.statusCode).toBe(200)
    expect(enrolled.json().data.user).toMatchObject({ accountKind: 'primary', mainAccountActivated: true })
    const returning = await send()
    expect(returning.json().data.user.id).toBe(enrolled.json().data.user.id)
    expect(enrolled.body.includes(code)).toBe(false)
    expect(sawUnexpectedCredentialField).toBe(false)
    const otherCode = await issuedFixtureActivation()
    const begin = await app.inject({ method: 'POST', url: '/auth/account/external/start', headers: gate,
      payload: { providerId: 'oauth', mode: 'login', activationCode: otherCode } })
    expect(begin.statusCode).toBe(200)
    expect(begin.body.includes(otherCode)).toBe(false)
    const row = (await getDb().execute({sql:'SELECT payload FROM account_external_flows WHERE id=?', args:[begin.json().data.flowId]})).rows[0]
    expect(String(row.payload).includes(otherCode)).toBe(false)
  })
  it('survives route/server recreation, encrypts verifier and only yields credentials once to poll secret holder', async () => {
    const flow = await begin()
    expect((await poll(flow)).json().data).toEqual({ status: 'pending' })
    const stored = (await getDb().execute({ sql: 'SELECT * FROM account_external_flows WHERE id=?', args: [flow.flowId] })).rows[0]
    expect(JSON.stringify(stored)).not.toContain(flow.pollToken)
    expect(JSON.stringify(stored)).not.toContain(new URL(flow.authorizationUrl).searchParams.get('state'))
    expect(String(stored.payload)).not.toContain('codeVerifier')
    await app.close(); closeDb(); app = await makeApp()
    const finished = await callback(flow)
    expect(finished.statusCode, finished.body).toBe(200)
    expect(finished.body).not.toContain('aether_session_')
    expect((await poll(flow, 'x'.repeat(43))).statusCode).toBe(400)
    const [first, second] = await Promise.all([poll(flow), poll(flow)])
    expect([first.statusCode, second.statusCode].filter(code => code === 200)).toHaveLength(1)
    const accepted = first.statusCode === 200 ? first : second
    expect(accepted.json().data).toMatchObject({ status: 'complete', result: { user: { identities: [{ providerId: 'oauth' }] } } })
    expect(accepted.json().data.result.accessToken).toMatch(/^aether_session_/)
    expect((await getDb().execute({ sql: 'SELECT * FROM account_external_flows WHERE id=?', args: [flow.flowId] })).rows).toHaveLength(0)
    expect((await callback(flow)).statusCode).toBe(400)
  })
  it('rejects callback replay and does not reveal an existing result', async () => {
    const flow = await begin(); expect((await callback(flow)).statusCode).toBe(200)
    expect((await callback(flow)).statusCode).toBe(400)
    expect((await poll(flow)).statusCode).toBe(200)
  })
  it('handles concurrent starts, callbacks and account issuance without SQLite writer contention', async () => {
    const flows = await Promise.all(Array.from({ length: 8 }, () => begin()))
    const callbacks = await Promise.all(flows.map(flow => callback(flow)))
    expect(callbacks.map(response => response.statusCode)).toEqual(Array(8).fill(200))
    const results = await Promise.all(flows.map(flow => poll(flow)))
    expect(results.map(response => response.statusCode)).toEqual(Array(8).fill(200))
    expect(new Set(results.map(response => response.json().data.result.user.id)).size).toBe(1)
    expect(new Set(results.map(response => response.json().data.result.accessToken)).size).toBe(8)
  })
  it('rejects expired flows', async () => {
    const flow = await begin()
    await getDb().execute({ sql: 'UPDATE account_external_flows SET expires_at=? WHERE id=?', args: [Date.now() - 1, flow.flowId] })
    expect((await callback(flow)).statusCode).toBe(400)
    expect((await poll(flow)).statusCode).toBe(400)
  })
  it('refuses anonymous binding and refuses invalid supplied user sessions', async () => {
    const request = { method: 'POST' as const, url: '/auth/account/external/start', payload: { providerId: 'oauth', mode: 'link' } }
    expect((await app.inject({ ...request, headers: gate })).statusCode).toBe(401)
    expect((await app.inject({ ...request, headers: { ...gate, Authorization: 'Bearer aether_session_forged' } })).statusCode).toBe(401)
  })
  it('checks account session revocation again when the browser returns', async () => {
    const account = await registerAccount(await issuedFixtureActivation()), flow = await begin('link', account)
    await getDb().execute({ sql: 'UPDATE account_sessions SET revoked_at=? WHERE id=?', args: [Date.now(), account.user.sessionId ?? ''] })
    expect((await callback(flow)).statusCode).toBe(400)
    expect((await poll(flow)).statusCode).toBe(400)
  })
  it('checks revocation between callback and result consumption', async () => {
    const account = await registerAccount(await issuedFixtureActivation()), flow = await begin('link', account)
    expect((await callback(flow)).statusCode).toBe(200)
    await getDb().execute({ sql: 'UPDATE account_sessions SET revoked_at=? WHERE id=?', args: [Date.now(), account.user.sessionId ?? ''] })
    expect((await poll(flow)).statusCode).toBe(401)
  })
  it('binds verified existing-platform identity without changing original user or tenant', async () => {
    const account = await registerAccount(await issuedFixtureActivation())
    const linked = await app.inject({ method: 'POST', url: '/auth/account/external/credential', headers: { ...gate, Authorization: `Bearer ${account.accessToken}` },
      payload: { providerId: 'credential', credential: 'verified-erp-secret', mode: 'link' } })
    expect(linked.statusCode, linked.body).toBe(200)
    expect(linked.json().data).toMatchObject({ id: account.user.id, tenantId: account.user.tenantId, identities: [{ providerId: 'credential', subject: 'erp-stable-user' }] })
    const login = await app.inject({ method: 'POST', url: '/auth/account/external/credential', headers: gate, payload: { providerId: 'credential', credential: 'verified-erp-secret', mode: 'login', activationCode: await issuedFixtureActivation() } })
    expect(login.json().data.user).toMatchObject({ id: account.user.id, tenantId: account.user.tenantId })
    const competitor = await registerAccount(await issuedFixtureActivation())
    const collision = await app.inject({ method: 'POST', url: '/auth/account/external/credential', headers: { ...gate, Authorization: `Bearer ${competitor.accessToken}` },
      payload: { providerId: 'credential', credential: 'verified-erp-secret', mode: 'link' } })
    expect(collision.statusCode).toBe(409)
  })
  it('rejects unverified custom identity and enforces attempt rate limits in storage', async () => {
    const forged = await app.inject({ method: 'POST', url: '/auth/account/external/credential', headers: gate,
      payload: { providerId: 'credential', credential: 'forged', subject: 'attacker', userData: { admin: true } } })
    expect(forged.statusCode).toBe(400)
    for (let i = 0; i < 10; i++) expect((await app.inject({ method: 'POST', url: '/auth/account/external/credential', headers: gate, payload: { providerId: 'credential', credential: 'forged' } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: '/auth/account/external/credential', headers: gate, payload: { providerId: 'credential', credential: 'forged' } })).statusCode).toBe(429)
    await app.close(); app = await makeApp()
    expect((await app.inject({ method: 'POST', url: '/auth/account/external/credential', headers: gate, payload: { providerId: 'credential', credential: 'forged' } })).statusCode).toBe(429)
  })

  it('reauthenticates a browser identity in place and requires the original session when polling', async () => {
    const loginFlow = await begin(); await callback(loginFlow)
    const account = (await poll(loginFlow)).json().data.result as AccountLoginResult
    const old = Date.now() - 11 * 60_000
    await getDb().execute({ sql: 'UPDATE account_sessions SET authenticated_at=? WHERE id=?', args: [old, account.user.sessionId!] })
    const flow = await begin('reauth', account)
    expect((await poll(flow)).statusCode).toBe(401)
    const competitor = await registerAccount(await issuedFixtureActivation())
    expect((await poll(flow, flow.pollToken, competitor)).statusCode).toBe(403)
    const secondLogin = await begin(); await callback(secondLogin)
    const otherSession = (await poll(secondLogin)).json().data.result as AccountLoginResult
    expect(otherSession.user.id).toBe(account.user.id)
    const before = (await getDb().execute({ sql: 'SELECT COUNT(*) AS total FROM account_sessions WHERE user_id=?', args: [account.user.id] })).rows[0].total
    expect((await poll(flow, flow.pollToken, otherSession)).statusCode).toBe(403)
    expect((await poll(flow, flow.pollToken, account)).json().data.status).toBe('pending')
    expect((await callback(flow)).statusCode).toBe(200)
    const response = await poll(flow, flow.pollToken, account)
    expect(response.statusCode).toBe(200)
    const user = response.json().data.result
    expect(user).toMatchObject({ id: account.user.id, tenantId: account.user.tenantId, sessionId: account.user.sessionId, roles: ['tenant-admin'] })
    expect(Date.parse(user.authenticatedAt)).toBeGreaterThan(old)
    expect(user.accessToken).toBeUndefined()
    expect((await getDb().execute({ sql: 'SELECT COUNT(*) AS total FROM account_sessions WHERE user_id=?', args: [account.user.id] })).rows[0].total).toBe(before)
  })

  it('does not bind or create an account when reauthentication uses an unrelated browser identity', async () => {
    const account = await registerAccount(await issuedFixtureActivation()), flow = await begin('reauth', account)
    const before = (await getDb().execute('SELECT COUNT(*) AS total FROM users')).rows[0].total
    expect((await callback(flow)).statusCode).toBe(200)
    expect((await poll(flow, flow.pollToken, account)).statusCode).toBe(403)
    expect((await getAccountUser(account.user.id, account.user.sessionId)).identities).toHaveLength(0)
    expect((await getDb().execute('SELECT COUNT(*) AS total FROM users')).rows[0].total).toBe(before)
  })

  it.each(['pending', 'callback', 'complete'] as const)('rejects reauthentication when the original session is revoked at %s', async stage => {
    const account = await registerAccount(await issuedFixtureActivation()), flow = await begin('reauth', account)
    if (stage === 'complete') expect((await callback(flow)).statusCode).toBe(200)
    await getDb().execute({ sql: 'UPDATE account_sessions SET revoked_at=? WHERE id=?', args: [Date.now(), account.user.sessionId!] })
    if (stage === 'callback') expect((await callback(flow)).statusCode).toBe(400)
    else expect((await poll(flow, flow.pollToken, account)).statusCode).toBe(401)
    expect((await getAccountUser(account.user.id, account.user.sessionId)).authenticatedAt).toBe(account.user.authenticatedAt)
  })

  it('reauthenticates credential identities only when already bound to the same account', async () => {
    const login = await app.inject({ method: 'POST', url: '/auth/account/external/credential', headers: gate,
      payload: { providerId: 'credential', credential: 'verified-erp-secret', mode: 'login', activationCode: await issuedFixtureActivation() } })
    const account = login.json().data as AccountLoginResult, old = Date.now() - 11 * 60_000
    await getDb().execute({ sql: 'UPDATE account_sessions SET authenticated_at=? WHERE id=?', args: [old, account.user.sessionId!] })
    const request = { method: 'POST' as const, url: '/auth/account/external/credential', payload: { providerId: 'credential', credential: 'verified-erp-secret', mode: 'reauth' } }
    expect((await app.inject({ ...request, headers: gate })).statusCode).toBe(401)
    const other = await registerAccount(await issuedFixtureActivation())
    expect((await app.inject({ ...request, headers: { ...gate, Authorization: `Bearer ${other.accessToken}` } })).statusCode).toBe(403)
    expect((await getAccountUser(other.user.id)).identities).toHaveLength(0)
    const response = await app.inject({ ...request, headers: { ...gate, Authorization: `Bearer ${account.accessToken}` } })
    expect(response.statusCode).toBe(200)
    expect(response.json().data).toMatchObject({ id: account.user.id, sessionId: account.user.sessionId })
    expect(Date.parse(response.json().data.authenticatedAt)).toBeGreaterThan(old)
    expect(response.json().data.accessToken).toBeUndefined()
    await getDb().execute({ sql: 'UPDATE account_sessions SET revoked_at=? WHERE id=?', args: [Date.now(), account.user.sessionId!] })
    expect((await app.inject({ ...request, headers: { ...gate, Authorization: `Bearer ${account.accessToken}` } })).statusCode).toBe(401)
  })
})
