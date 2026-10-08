/** Real HTTP authentication, SQLite persistence, rotation/replay, tenant isolation and identity binding. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AuthContext } from '../types.js'
import type { AccountLoginResult, AccountUser } from '../accounts.js'

const fixture = path.resolve('.e2e-tmp', `accounts-${randomUUID()}`)
let app: FastifyInstance
let accounts: typeof import('../accounts.js')
let database: typeof import('../../storage/sqlite/db.js')
let middleware: typeof import('../../api/http/middleware.js')
const instanceHeaders = { 'x-aether-instance-token': 'test-instance-account-token' }
const headers = (session: AccountLoginResult) => ({ ...instanceHeaders, authorization: `Bearer ${session.accessToken}` })
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

beforeAll(async () => {
  fs.mkdirSync(fixture, { recursive: true })
  vi.stubEnv('DATA_DIR', path.join(fixture, 'accounts.db'))
  vi.stubEnv('AUTH_ENABLED', 'true')
  vi.stubEnv('JWT_SECRET', 'account-boundary-fixture-secret')
  vi.stubEnv('ENCRYPTION_KEY', '3'.repeat(64))
  vi.stubEnv('AETHER_INSTANCE_TOKEN', instanceHeaders['x-aether-instance-token'])
  vi.stubEnv('AETHER_ACCOUNT_PROVIDERS_JSON', '[]')
  database = await import('../../storage/sqlite/db.js')
  await database.initDb()
  accounts = await import('../accounts.js')
  middleware = await import('../../api/http/middleware.js')
  middleware.configureRequestAuthentication()
  app = Fastify()
  app.addHook('onRequest', middleware.authMiddlewareHook)
  const { accountRoutes } = await import('../../api/http/routes/accounts.js')
  await app.register(accountRoutes)
  const { modelsRoutes } = await import('../../api/http/routes/models.js')
  const { securityRoutes } = await import('../../api/http/routes/security.js')
  const { requireRoles } = await import('../guards.js')
  await app.register(modelsRoutes)
  await app.register(securityRoutes, { prefix: '/api/v1' })
  app.put('/global-admin', { preHandler: requireRoles('admin') }, async () => ({ changed: true }))
  app.get('/protected', async (request: FastifyRequest & { authContext?: AuthContext }) => request.authContext)
  await app.ready()
})

afterAll(async () => {
  await app?.close()
  database?.closeDb()
  vi.unstubAllEnvs()
  const expected = path.resolve('.e2e-tmp') + path.sep
  if (!fixture.startsWith(expected)) throw new Error('Unsafe fixture path')
  try { fs.rmSync(fixture, { recursive: true, force: true }) }
  catch (error) { if (!(error instanceof Error) || !('code' in error) || !['EPERM', 'EBUSY'].includes(String(error.code))) throw error }
})

async function register(): Promise<AccountLoginResult> {
  // Use distinct legitimate source addresses to avoid coupling lifecycle tests to the rate-limit test.
  const response = await app.inject({ method: 'POST', url: '/auth/account/register', headers: instanceHeaders, remoteAddress: `192.0.2.${++counter}`, payload: {} })
  expect(response.statusCode).toBe(200)
  return response.json().data as AccountLoginResult
}
let counter = 1

describe('account lifecycle with enabled authentication and owned-instance gate', () => {
  it('does not bypass the instance gate or expose protected user information', async () => {
    expect((await app.inject({ method: 'POST', url: '/auth/account/register', payload: {} })).statusCode).toBe(401)
    expect((await app.inject({ method: 'GET', url: '/auth/account/me', headers: instanceHeaders })).statusCode).toBe(401)
    expect((await app.inject({ method: 'POST', url: '/auth/account/register/extra', headers: instanceHeaders, payload: {} })).statusCode).toBe(401)
  })
  it('creates isolated random users and hashes every persistent credential', async () => {
    const a = await register(), b = await register()
    expect(a.user.id).not.toBe(b.user.id)
    expect(a.user.tenantId).not.toBe(b.user.tenantId)
    expect(a.user.tenantId).not.toBe('default')
    expect(a.user.name).toMatch(/^用户 /)
    expect(a.recoveryKey).toMatch(/^aether_recovery_/)
    const response = await app.inject({ method: 'GET', url: '/protected', headers: headers(a) })
    expect(response.json()).toMatchObject({ userId: a.user.id, tenantId: a.user.tenantId, method: 'session', roles: ['tenant-admin'] })
    const stored = await database.getDb().execute({ sql: 'SELECT s.access_hash, p.recovery_hash, r.token_hash FROM account_sessions s JOIN account_profiles p ON p.user_id=s.user_id JOIN account_refresh_tokens r ON r.session_id=s.id WHERE s.user_id=?', args: [a.user.id] })
    expect(stored.rows[0]).toMatchObject({ access_hash: digest(a.accessToken), recovery_hash: digest(a.recoveryKey!), token_hash: digest(a.refreshToken) })
    const me = await app.inject({ method: 'GET', url: '/auth/account/me', headers: headers(a) })
    expect(me.json().data.id).toBe(a.user.id)
    expect(me.headers['cache-control']).toBe('no-store')
    expect(me.body).not.toContain(a.accessToken)
    expect(me.body).not.toContain(a.recoveryKey)
  })
  it('validates profiles and keeps arbitrary metadata outside authorization', async () => {
    const a = await register()
    const update = await app.inject({ method: 'PATCH', url: '/auth/account/profile', headers: headers(a), payload: { name: '研发用户', bio: 'Hello', userData: { department: '研发', roles: ['admin'], custom: { tags: ['test'] } } } })
    expect(update.statusCode).toBe(200)
    expect(update.json().data).toMatchObject({ name: '研发用户', bio: 'Hello', userData: { department: '研发', roles: ['admin'] } })
    expect((await app.inject({ method: 'GET', url: '/protected', headers: headers(a) })).json().roles).toEqual(['tenant-admin'])
    for (const payload of [{ tenantId: 'default' }, { name: 'x'.repeat(101) }, { avatarUrl: 'javascript:alert(1)' }, { userData: { data: 'x'.repeat(17000) } }]) {
      expect((await app.inject({ method: 'PATCH', url: '/auth/account/profile', headers: headers(a), payload })).statusCode).toBe(400)
    }
  })
  it('restores exactly the original account through its recovery credential', async () => {
    const a = await register()
    const response = await app.inject({ method: 'POST', url: '/auth/account/login', headers: instanceHeaders, payload: { recoveryKey: a.recoveryKey } })
    expect(response.statusCode).toBe(200)
    expect(response.json().data.user).toMatchObject({ id: a.user.id, tenantId: a.user.tenantId })
    expect(response.json().data.recoveryKey).toBeUndefined()
    expect((await app.inject({ method: 'POST', url: '/auth/account/login', headers: instanceHeaders, payload: { recoveryKey: 'wrong' } })).statusCode).toBe(401)
  })
  it('rotates refresh tokens atomically and revokes the whole session on replay', async () => {
    const a = await register()
    const refresh = await app.inject({ method: 'POST', url: '/auth/account/refresh', headers: instanceHeaders, payload: { refreshToken: a.refreshToken } })
    expect(refresh.statusCode).toBe(200)
    const b = refresh.json().data as AccountLoginResult
    expect(b.user.id).toBe(a.user.id)
    expect(b.refreshToken).not.toBe(a.refreshToken)
    expect((await app.inject({ method: 'GET', url: '/protected', headers: headers(a) })).statusCode).toBe(401)
    expect((await app.inject({ method: 'GET', url: '/protected', headers: headers(b) })).statusCode).toBe(200)
    expect((await app.inject({ method: 'POST', url: '/auth/account/refresh', headers: instanceHeaders, payload: { refreshToken: a.refreshToken } })).statusCode).toBe(401)
    expect((await app.inject({ method: 'GET', url: '/protected', headers: headers(b) })).statusCode).toBe(401)
    expect((await app.inject({ method: 'POST', url: '/auth/account/refresh', headers: instanceHeaders, payload: { refreshToken: b.refreshToken } })).statusCode).toBe(401)
  })
  it('enforces access expiry while allowing a valid refresh and rejects expired session families', async () => {
    const a = await register()
    await database.getDb().execute({ sql: 'UPDATE account_sessions SET access_expires_at=? WHERE id=?', args: [Date.now() - 1, a.user.sessionId!] })
    expect((await app.inject({ method: 'GET', url: '/protected', headers: headers(a) })).statusCode).toBe(401)
    const b = await accounts.refreshAccountSession(a.refreshToken)
    await database.getDb().execute({ sql: 'UPDATE account_sessions SET expires_at=? WHERE id=?', args: [Date.now() - 1, b.user.sessionId!] })
    await expect(accounts.refreshAccountSession(b.refreshToken)).rejects.toThrow('登录已失效')
  })
  it('lists only owned sessions and prevents revoking another user session', async () => {
    const a = await register(), b = await register()
    const list = await app.inject({ method: 'GET', url: '/auth/account/sessions', headers: headers(a) })
    expect(list.json().data).toHaveLength(1)
    expect(list.json().data[0]).toMatchObject({ id: a.user.sessionId, current: true })
    await app.inject({ method: 'DELETE', url: `/auth/account/sessions/${b.user.sessionId}`, headers: headers(a) })
    expect((await app.inject({ method: 'GET', url: '/protected', headers: headers(b) })).statusCode).toBe(200)
    expect((await app.inject({ method: 'POST', url: '/auth/account/logout', headers: headers(a), payload: {} })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/protected', headers: headers(a) })).statusCode).toBe(401)
    await expect(accounts.refreshAccountSession(a.refreshToken)).rejects.toThrow('登录已失效')
  })
  it('recovery rotation invalidates old recovery credentials and other sessions', async () => {
    const a = await register(), b = await accounts.loginAccount(a.recoveryKey!)
    const rotated = await app.inject({ method: 'POST', url: '/auth/account/recovery', headers: headers(a), payload: {} })
    expect(rotated.statusCode).toBe(200)
    await expect(accounts.loginAccount(a.recoveryKey!)).rejects.toThrow('恢复凭证无效')
    expect((await accounts.loginAccount(rotated.json().data.recoveryKey)).user.id).toBe(a.user.id)
    expect((await app.inject({ method: 'GET', url: '/protected', headers: headers(b) })).statusCode).toBe(401)
    expect((await app.inject({ method: 'GET', url: '/protected', headers: headers(a) })).statusCode).toBe(200)
    await database.getDb().execute({ sql: 'UPDATE account_sessions SET authenticated_at=? WHERE id=?', args: [Date.now() - 11 * 60_000, a.user.sessionId!] })
    expect((await app.inject({ method: 'POST', url: '/auth/account/recovery', headers: headers(a), payload: {} })).statusCode).toBe(403)
  })
  it('preserves legacy API-key user IDs and tenant data on login', async () => {
    const id = randomUUID(), key = randomUUID(), tenant = `legacy-${randomUUID()}`
    await database.getDb().execute({ sql: 'INSERT INTO users(id,tenant_id,api_key_hash,name) VALUES(?,?,?,?)', args: [id, tenant, digest(key), 'Legacy'] })
    await database.getDb().execute({ sql: 'INSERT INTO memories(tenant_id,session_id,key,value) VALUES(?,?,?,?)', args: [tenant, 'history', 'sentinel', 'existing data'] })
    const result = await accounts.loginAccount(key)
    expect(result.user).toMatchObject({ id, tenantId: tenant })
    expect((await app.inject({ method: 'GET', url: '/protected', headers: headers(result) })).json().roles).toEqual(['admin'])
    expect((await database.getDb().execute({ sql: 'SELECT value FROM memories WHERE tenant_id=?', args: [tenant] })).rows[0].value).toBe('existing data')
  })
  it('verifies explicit login tokens in local auth-disabled mode instead of losing the account', async () => {
    const a = await register()
    vi.stubEnv('AUTH_ENABLED', 'false'); middleware.configureRequestAuthentication()
    try {
      expect((await app.inject({ method: 'GET', url: '/protected', headers: headers(a) })).json().userId).toBe(a.user.id)
      expect((await app.inject({ method: 'GET', url: '/protected', headers: instanceHeaders })).json()).toMatchObject({ tenantId: 'default', method: 'none' })
      expect((await app.inject({ method: 'GET', url: '/protected', headers: { ...instanceHeaders, authorization: 'Bearer aether_session_invalid' } })).statusCode).toBe(401)
      expect((await app.inject({ method: 'GET', url: '/auth/account/me', headers: instanceHeaders })).statusCode).toBe(401)
    } finally { vi.stubEnv('AUTH_ENABLED', 'true'); middleware.configureRequestAuthentication() }
  })
})

describe('verified third-party identity mapping', () => {
  it('automatically creates once, keeps metadata, and never merges by email', async () => {
    const identity = { providerId: 'enterprise', issuer: 'https://issuer.example', subject: randomUUID(), email: 'same@example.com', name: 'Third Party', userData: { department: 'R&D', employeeCode: '123' } }
    const a = await accounts.completeExternalIdentity(identity) as AccountLoginResult
    const b = await accounts.completeExternalIdentity(identity) as AccountLoginResult
    expect(a.user.id).toBe(b.user.id)
    expect(b.user.identities[0].userData).toEqual(identity.userData)
    const c = await accounts.completeExternalIdentity({ ...identity, subject: randomUUID() }) as AccountLoginResult
    expect(c.user.id).not.toBe(a.user.id)
    const d = await accounts.completeExternalIdentity({ ...identity, issuer: 'https://different.example' }) as AccountLoginResult
    expect(d.user.id).not.toBe(a.user.id)
  })
  it('binds to the current account without changing user/tenant and rejects takeover', async () => {
    const a = await register(), b = await register()
    const authA = await accounts.authenticateAccountSession(a.accessToken), authB = await accounts.authenticateAccountSession(b.accessToken)
    const identity = { providerId: 'binding-provider', subject: randomUUID(), userData: { name: 'custom', roles: ['admin'] } }
    const linked = await accounts.completeExternalIdentity(identity, authA) as AccountUser
    expect(linked).toMatchObject({ id: a.user.id, tenantId: a.user.tenantId, name: a.user.name })
    expect((await accounts.completeExternalIdentity(identity) as AccountLoginResult).user.id).toBe(a.user.id)
    await expect(accounts.completeExternalIdentity(identity, authB)).rejects.toThrow('已绑定其他账号')
    const old = { ...authA, authenticatedAt: Date.now() - 11 * 60_000 }
    await expect(accounts.completeExternalIdentity({ ...identity, subject: randomUUID() }, old)).rejects.toThrow('重新验证登录')
    await accounts.revokeAccountSession(authA, authA.sessionId)
    await expect(accounts.completeExternalIdentity({ ...identity, subject: randomUUID() }, authA)).rejects.toThrow('登录已失效')
  })
  it('serializes concurrent first login into exactly one internal user', async () => {
    const identity = { providerId: 'concurrent', subject: randomUUID() }
    const results = await Promise.all(Array.from({ length: 8 }, () => accounts.completeExternalIdentity(identity) as Promise<AccountLoginResult>))
    expect(new Set(results.map(result => result.user.id)).size).toBe(1)
    const rows = await database.getDb().execute({ sql: 'SELECT user_id FROM account_identities WHERE provider_id=? AND subject=?', args: [identity.providerId, identity.subject] })
    expect(rows.rows).toHaveLength(1)
  })
  it('prevents unlinking the last usable login route without recovery', async () => {
    const identity = { providerId: 'unlink', subject: randomUUID() }
    const result = await accounts.completeExternalIdentity(identity) as AccountLoginResult
    const auth = await accounts.authenticateAccountSession(result.accessToken)
    await database.getDb().execute({ sql: 'UPDATE account_profiles SET recovery_hash=NULL WHERE user_id=?', args: [auth.userId!] })
    await expect(accounts.unlinkAccountIdentity(auth, identity.providerId)).rejects.toThrow('先配置恢复凭证')
    await accounts.rotateAccountRecovery(auth)
    expect((await accounts.unlinkAccountIdentity(auth, identity.providerId)).identities).toHaveLength(0)
  })
  it('throttles repeated attempts and supports disabling public registration', async () => {
    for (let attempt = 0; attempt < 10; attempt++) await accounts.checkAccountRateLimit('rate-limit-fixture', 'register')
    await expect(accounts.checkAccountRateLimit('rate-limit-fixture', 'register')).rejects.toThrow('操作过于频繁')
    vi.stubEnv('AETHER_ACCOUNT_REGISTRATION', 'false')
    try { await expect(accounts.registerAccount()).rejects.toThrow('关闭一键创建') }
    finally { vi.stubEnv('AETHER_ACCOUNT_REGISTRATION', 'true') }
  })
})

describe('durable idempotent refresh recovery', () => {
  it('returns the same encrypted retry result after response loss and database reopening', async () => {
    const account = await register(), requestId = randomUUID()
    const first = await accounts.refreshAccountSession(account.refreshToken, requestId)
    const stored = await database.getDb().execute({ sql: 'SELECT request_hash,retry_result,retry_expires_at FROM account_refresh_tokens WHERE token_hash=?', args: [digest(account.refreshToken)] })
    expect(stored.rows[0].request_hash).toBe(digest(requestId))
    expect(String(stored.rows[0].retry_result)).not.toContain(first.accessToken)
    expect(String(stored.rows[0].retry_result)).not.toContain(first.refreshToken)
    database.closeDb()
    const second = await accounts.refreshAccountSession(account.refreshToken, requestId)
    expect(second).toEqual(first)
    expect((await accounts.authenticateAccountSession(second.accessToken)).userId).toBe(account.user.id)
  })
  it('serializes simultaneous retries of the same refresh request into one token generation', async () => {
    const account = await register(), requestId = randomUUID()
    const results = await Promise.all(Array.from({ length: 8 }, () => accounts.refreshAccountSession(account.refreshToken, requestId)))
    expect(new Set(results.map(result => result.accessToken)).size).toBe(1)
    expect(new Set(results.map(result => result.refreshToken)).size).toBe(1)
    const stored = await database.getDb().execute({ sql: 'SELECT COUNT(*) AS count FROM account_refresh_tokens WHERE session_id=?', args: [account.user.sessionId!] })
    expect(Number(stored.rows[0].count)).toBe(2)
  })
  it('rejects a consumed refresh token paired with a different request ID and revokes the session', async () => {
    const account = await register(), first = await accounts.refreshAccountSession(account.refreshToken, randomUUID())
    await expect(accounts.refreshAccountSession(account.refreshToken, randomUUID())).rejects.toThrow('会话已撤销')
    await expect(accounts.authenticateAccountSession(first.accessToken)).rejects.toThrow('登录已失效')
  })
  it('limits idempotent retry time and never resurrects a revoked session', async () => {
    const account = await register(), requestId = randomUUID()
    const first = await accounts.refreshAccountSession(account.refreshToken, requestId)
    const auth = await accounts.authenticateAccountSession(first.accessToken)
    await accounts.revokeAccountSession(auth, auth.sessionId)
    await expect(accounts.refreshAccountSession(account.refreshToken, requestId)).rejects.toThrow('登录已失效')
    const other = await register(), otherRequest = randomUUID()
    await accounts.refreshAccountSession(other.refreshToken, otherRequest)
    await database.getDb().execute({ sql: 'UPDATE account_refresh_tokens SET retry_expires_at=? WHERE token_hash=?', args: [Date.now() - 1, digest(other.refreshToken)] })
    await expect(accounts.refreshAccountSession(other.refreshToken, otherRequest)).rejects.toThrow('会话已撤销')
  })
  it('supports requestId on the real HTTP contract and validates malformed identifiers', async () => {
    const account = await register(), requestId = randomUUID()
    const payload = { refreshToken: account.refreshToken, requestId }
    const first = await app.inject({ method: 'POST', url: '/auth/account/refresh', headers: instanceHeaders, payload })
    const retry = await app.inject({ method: 'POST', url: '/auth/account/refresh', headers: instanceHeaders, payload })
    expect(first.statusCode).toBe(200)
    expect(retry.json().data).toEqual(first.json().data)
    expect((await app.inject({ method: 'POST', url: '/auth/account/refresh', headers: instanceHeaders, payload: { ...payload, requestId: 123 } })).statusCode).toBe(400)
  })
})

describe('account and tenant administrator boundaries', () => {
  it('rejects legacy JWT identity confusion on account endpoints while preserving legacy business auth', async () => {
    const account = await register()
    const { SignJWT } = await import('jose')
    const token = await new SignJWT({ tenantId: 'wrong-tenant', roles: ['admin'] })
      .setProtectedHeader({ alg: 'HS256' }).setSubject(account.user.id)
      .sign(new TextEncoder().encode(process.env.JWT_SECRET!))
    const jwtHeaders = { ...instanceHeaders, authorization: `Bearer ${token}` }
    expect((await app.inject({ method: 'GET', url: '/protected', headers: jwtHeaders })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/auth/account/me', headers: jwtHeaders })).statusCode).toBe(401)
    expect((await app.inject({ method: 'PATCH', url: '/auth/account/profile', headers: jwtHeaders, payload: { name: 'takeover' } })).statusCode).toBe(401)
    expect((await accounts.getAccountUser(account.user.id)).name).toBe(account.user.name)
  })
  it('allows own models but cannot read, update, or delete another tenant models', async () => {
    const a = await register(), b = await register()
    const model = await app.inject({ method: 'POST', url: '/api/v1/models', headers: headers(a), payload: { provider: 'openai', modelId: 'account-fixture', apiKey: 'fixture-model-key-12345', baseUrl: 'https://models.example.com/v1', displayName: 'Original' } })
    expect(model.statusCode).toBe(200)
    const id = model.json().data.id as string
    const other = await app.inject({ method: 'GET', url: '/api/v1/models', headers: headers(b) })
    expect(other.json().data).toEqual([])
    expect((await app.inject({ method: 'PUT', url: `/api/v1/models/${id}`, headers: headers(b), payload: { displayName: 'Stolen' } })).statusCode).toBe(404)
    await app.inject({ method: 'DELETE', url: `/api/v1/models/${id}`, headers: headers(b) })
    const stored = await database.getDb().execute({ sql: 'SELECT display_name, deleted_at FROM models WHERE id=?', args: [id] })
    expect(stored.rows[0]).toMatchObject({ display_name: 'Original', deleted_at: null })
    expect((await app.inject({ method: 'POST', url: `/api/v1/models/${id}/test`, headers: headers(b), payload: {} })).statusCode).toBe(404)
  })
  it.each(['http://127.0.0.1:12323', 'http://169.254.169.254', 'http://[::1]', 'http://[::ffff:127.0.0.1]', 'http://10.0.0.1', 'http://2130706433', 'http://0.0.0.0', 'file:///etc/passwd', 'http://user:pass@models.example.com'])('rejects private or invalid temporary model probe endpoint %s before making a network call', async baseUrl => {
    const account = await register()
    const response = await app.inject({ method: 'POST', url: '/api/v1/models/new/test', headers: headers(account), payload: { provider: 'openai', modelId: 'test', apiKey: 'fixture-only', baseUrl } })
    expect(response.statusCode).toBe(400)
    expect(response.json().message).toContain('Invalid base URL')
  })
  it('keeps security modes tenant scoped and denies full-access and instance admin mutations', async () => {
    const a = await register(), b = await register(), sessionId = randomUUID()
    const setMode = await app.inject({ method: 'PUT', url: '/api/v1/security/mode', headers: headers(a), payload: { sessionId, mode: 'standard' } })
    expect(setMode.json().data).toMatchObject({ sessionId, mode: 'standard' })
    const otherMode = await app.inject({ method: 'GET', url: `/api/v1/security/mode?sessionId=${sessionId}`, headers: headers(b) })
    expect(otherMode.json().data.mode).toBe('safe')
    expect((await app.inject({ method: 'PUT', url: '/api/v1/security/mode', headers: headers(a), payload: { sessionId, mode: 'full-access' } })).statusCode).toBe(403)
    expect((await app.inject({ method: 'PUT', url: '/global-admin', headers: headers(a), payload: {} })).json().code).toBe(41015)
  })
})
