/** Child credentials are tested through the production Fastify routes, instance gate and real SQLite sessions. */
import { randomBytes, randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AccountLoginResult, AccountUser } from '../accounts.js'
import type { AccountFamily, ChildAccount } from '../account-family-types.js'
import { issuedFixtureActivation } from './activation-fixture.js'

const account = '/auth/account', children = account + '/children', password = account + '/child-password'
const gate = randomBytes(32).toString('hex')
const scratch = path.resolve('.e2e-tmp')
const passphrase = () => 'Test-only passphrase ' + randomUUID()
const loginName = () => 'child-' + randomUUID()
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH'
type Fields = Record<string, string>
interface Options { session?: AccountLoginResult; body?: Fields; status?: number; instanceGate?: boolean }
let app: FastifyInstance, database: typeof import('../../storage/sqlite/db.js'), fixture: string | undefined, nextClient = 0

beforeAll(async () => {
  mkdirSync(scratch, { recursive: true })
  if (realpathSync(scratch) !== path.join(realpathSync('.'), '.e2e-tmp')) throw new Error('Unexpected test directory')
  fixture = mkdtempSync(path.join(scratch, 'child-password-tests-'))
  const settings = {
    DATA_DIR: path.join(fixture, 'accounts.db'), WORKSPACE_ROOT: path.join(fixture, 'workspace'),
    MEMORY_DB_PATH: path.join(fixture, 'memory.db'), AETHER_GLOBAL_DIR: path.join(fixture, 'global'),
    AUTH_ENABLED: 'true', AETHER_ACCOUNT_REGISTRATION: 'true', AETHER_INSTANCE_TOKEN: gate,
    AETHER_ACCOUNT_PROVIDERS_JSON: '[]', JWT_SECRET: randomBytes(32).toString('hex'), ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  }
  for (const [key, value] of Object.entries(settings)) vi.stubEnv(key, value)
  database = await import('../../storage/sqlite/db.js')
  await database.initDb()
  const file = (await database.getDb().execute('PRAGMA database_list')).rows.find(row => row.name === 'main')?.file
  if (typeof file !== 'string' || realpathSync(file) !== realpathSync(settings.DATA_DIR)) throw new Error('Expected disposable test database')
  const { configureRequestAuthentication, authMiddlewareHook } = await import('../../api/http/middleware.js')
  configureRequestAuthentication()
  app = Fastify({ logger: false }); app.addHook('onRequest', authMiddlewareHook)
  const { accountRoutes } = await import('../../api/http/routes/accounts.js')
  await app.register(accountRoutes); await app.ready()
}, 20_000)
afterEach(() => { vi.restoreAllMocks() })
afterAll(async () => {
  try { try { await app?.close() } finally { await database?.closeDb() } }
  finally {
    vi.unstubAllEnvs()
    if (fixture) {
      const actual = realpathSync(fixture)
      if (path.dirname(actual) !== realpathSync(scratch) || lstatSync(fixture).isSymbolicLink() || !/^child-password-tests-[a-zA-Z0-9]{6}$/.test(path.basename(actual))) throw new Error('Unsafe test cleanup')
      rmSync(actual, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    }
  }
})

function client() {
  // Keep the real rate limit enabled. Each scenario represents a different, legitimate client.
  const remoteAddress = `192.0.2.${++nextClient}`
  async function request<T = void>(method: Method, url: string, { session, body, status = 200, instanceGate = true }: Options = {}): Promise<T> {
    const res = await app.inject({ method, url, remoteAddress, headers: {
      ...(instanceGate ? { 'x-aether-instance-token': gate } : {}), ...(session ? { authorization: 'Bearer ' + session.accessToken } : {}),
    }, ...(body ? { payload: body } : {}) })
    // A regressed endpoint might echo a credential. Never include a request, response body or secret in assertion output.
    expect(res.statusCode, `${method} ${url}`).toBe(status)
    let result: { code: number; data: T }
    try { result = res.json<typeof result>() } catch { throw new Error(`${method} ${url} did not return a JSON envelope`) }
    if (status === 200) { expect(result.code).toBe(200); expect(res.headers['cache-control']).toBe('no-store') }
    else expect(result.data === null, 'denied request returned data').toBe(true)
    return result.data
  }
  async function parent() {
    const session = await request<AccountLoginResult>('POST', account + '/register', { body: { activationCode: await issuedFixtureActivation() } })
    if (typeof session.recoveryKey !== 'string' || !session.recoveryKey) throw new Error('Test parent did not receive its account recovery credential')
    return { ...session, recoveryKey: session.recoveryKey }
  }
  async function setupChild(owner: AccountLoginResult) {
    return (await request<ChildAccount>('POST', children, { session: owner, body: { name: loginName() } })).id
  }
  const managed = (id: string) => `${password}/children/${id}`
  async function set(owner: AccountLoginResult, id: string, body: Fields, expectedName: string) {
    const result = await request<{loginName: string}>('PUT', managed(id), { session: owner, body })
    expect(Object.keys(result)).toEqual(['loginName']); expect(result.loginName === expectedName).toBe(true)
  }
  async function configured(owner: AccountLoginResult) {
    const id = await setupChild(owner), name = loginName(), pass = passphrase()
    await set(owner, id, { loginName: name, password: pass }, name)
    return { id, name, pass }
  }
  const login = (loginName: string, passwordValue: string, status = 200) => request<AccountLoginResult>('POST', password + '/login', { body: { loginName, password: passwordValue }, status })
  const me = (session: AccountLoginResult, status = 200) => request<AccountUser>('GET', account + '/me', { session, status })
  const refresh = (session: AccountLoginResult, status = 200) => request<AccountLoginResult>('POST', account + '/refresh', { body: { refreshToken: session.refreshToken, requestId: randomUUID() }, status })
  const enter = (session: AccountLoginResult, id: string, status = 200) => request<AccountLoginResult>('POST', `${children}/${id}/enter`, { session, body: {}, status })
  const change = (session: AccountLoginResult, proof: Fields, newPassword: string, status = 200) => request('POST', password + '/me', { session, body: { ...proof, newPassword }, status })
  const recover = (loginName: string, recoveryKey: string, newPassword: string, status = 200) => request('POST', password + '/recover', { body: { loginName, recoveryKey, newPassword }, status })
  async function code(session: AccountLoginResult, currentPassword: string) {
    const result = await request<{code: string}>('POST', password + '/reset-code', { session, body: { currentPassword } })
    expect(Object.keys(result)).toEqual(['code']); expect(/^aether_child_reset_[A-Za-z0-9_-]{43}$/.test(result.code)).toBe(true)
    return result.code
  }
  return { request, parent, setupChild, managed, set, configured, login, me, refresh, enter, change, recover, code }
}

describe.sequential('child password HTTP contract', () => {
  it('keeps the instance gate on login/recovery and authenticates private routes', async () => {
    const c = client(), p = await c.parent()
    expect((await c.me(p)).id).toBe(p.user.id)
    await c.request('POST', password + '/login', { instanceGate: false, status: 401, body: { loginName: loginName(), password: passphrase() } })
    await c.request('POST', password + '/recover', { instanceGate: false, status: 401, body: { loginName: loginName(), recoveryKey: p.recoveryKey, newPassword: passphrase() } })
    await c.request('GET', password + '/me', { status: 401 })
    await c.request('GET', password + '/me', { session: p, status: 404 })
  })

  it('requires an initial password, allows renaming alone, and preserves both logins on a name collision', async () => {
    const c = client(), p = await c.parent(), id = await c.setupChild(p), name = loginName(), renamed = loginName(), pass = passphrase()
    const initial = await c.request<{loginName: string | null}>('GET', c.managed(id), { session: p }); expect(initial.loginName === null).toBe(true)
    await c.request('PUT', c.managed(id), { session: p, body: { loginName: name }, status: 400 })
    await c.request('PUT', c.managed(id), { session: p, body: { password: pass }, status: 400 })
    await c.set(p, id, { loginName: name.toUpperCase(), password: pass }, name)
    const old = await c.login(name, pass)
    await c.set(p, id, { loginName: renamed }, renamed)
    await c.login(name, pass, 401); await c.me(old, 401)
    const sibling = await c.configured(p)
    await c.request('PUT', c.managed(sibling.id), { session: p, body: { loginName: renamed.toUpperCase() }, status: 409 })
    expect((await c.login(renamed, pass)).user.id).toBe(id)
    expect((await c.login(sibling.name, sibling.pass)).user.id).toBe(sibling.id)
  })

  it('requires the current password for self-service, retaining only the requesting session', async () => {
    const c = client(), a = await c.configured(await c.parent()), s = await c.login(a.name, a.pass), other = await c.login(a.name, a.pass), next = passphrase()
    expect(s.user.sessionId).not.toBe(other.user.sessionId)
    await c.change(s, { currentPassword: passphrase() }, next, 403); await c.login(a.name, next, 401)
    await c.change(s, { currentPassword: a.pass }, next)
    expect((await c.me(s)).id).toBe(a.id); expect((await c.refresh(s)).user.sessionId).toBe(s.user.sessionId)
    await c.me(other, 401); await c.refresh(other, 401); await c.login(a.name, a.pass, 401)
    expect((await c.login(a.name, next)).user.id).toBe(a.id)
  }, 20_000)

  it('accepts only the named child’s latest one-use code; it cannot be used for ordinary login', async () => {
    const c = client(), p = await c.parent(), a = await c.configured(p), b = await c.configured(p)
    const sa = await c.login(a.name, a.pass), sb = await c.login(b.name, b.pass), next = passphrase()
    await c.request('POST', password + '/reset-code', { session: sa, status: 403, body: { currentPassword: b.pass } })
    const previous = await c.code(sa, a.pass), current = await c.code(sa, a.pass), sibling = await c.code(sb, b.pass)
    expect(current !== previous && current !== sibling).toBe(true)
    for (const wrong of [previous, sibling, p.recoveryKey]) await c.recover(a.name, wrong, next, 403)
    await c.request('POST', account + '/login', { body: { recoveryKey: current }, status: 401 }); await c.login(a.name, next, 401)
    await c.recover(a.name, current, next); await c.recover(a.name, current, passphrase(), 403)
    await c.me(sa, 401); await c.refresh(sa, 401); await c.login(a.name, a.pass, 401)
    expect((await c.login(a.name, next)).user.id).toBe(a.id); expect((await c.me(sb)).id).toBe(b.id)
    const otherNext = passphrase(); await c.recover(b.name, sibling, otherNext)
    expect((await c.login(b.name, otherNext)).user.id).toBe(b.id)
  }, 20_000)

  it('allows exactly one personal proof when changing a password with a signed-in child’s reset code', async () => {
    const c = client(), p = await c.parent(), a = await c.configured(p), s = await c.login(a.name, a.pass), next = passphrase(), token = await c.code(s, a.pass)
    await c.change(s, {}, next, 400); await c.change(s, { currentPassword: a.pass, recoveryKey: token }, next, 400)
    await c.change(s, { recoveryKey: p.recoveryKey }, next, 403); await c.change(s, { recoveryKey: token }, next)
    await c.recover(a.name, token, passphrase(), 403); await c.login(a.name, a.pass, 401)
    expect((await c.me(s)).id).toBe(a.id); expect((await c.login(a.name, next)).user.id).toBe(a.id)
  }, 20_000)

  it('a parent replacing only the password invalidates the old reset code, delegated and independent sessions', async () => {
    const c = client(), p = await c.parent(), a = await c.configured(p), switched = await c.enter(p, a.id)
    const one = await c.login(a.name, a.pass), two = await c.login(a.name, a.pass), token = await c.code(one, a.pass), next = passphrase()
    await c.set(p, a.id, { password: next }, a.name)
    for (const session of [switched, one, two]) { await c.me(session, 401); await c.refresh(session, 401) }
    await c.recover(a.name, token, passphrase(), 403); await c.login(a.name, a.pass, 401)
    expect((await c.login(a.name, next)).user.id).toBe(a.id); expect((await c.me(p)).id).toBe(p.user.id)
  }, 20_000)

  it('denies another primary, sibling, foreign child and delegated sibling without changing the target login', async () => {
    const c = client(), p = await c.parent(), q = await c.parent(), a = await c.configured(p), b = await c.configured(p), external = await c.configured(q)
    const actors = [q, await c.login(b.name, b.pass), await c.login(external.name, external.pass), await c.enter(p, b.id)]
    for (const s of actors) {
      await c.request('GET', c.managed(a.id), { session: s, status: 404 })
      await c.request('PUT', c.managed(a.id), { session: s, body: { loginName: loginName(), password: passphrase() }, status: 404 })
    }
    const self = await c.login(a.name, a.pass)
    await c.request('PUT', c.managed(a.id), { session: self, body: { password: passphrase() }, status: 404 })
    expect((await c.me(self)).id).toBe(a.id); expect((await c.login(a.name, a.pass)).user.id).toBe(a.id)
  }, 20_000)

  it('parent sign-out ends only the delegated child session; the independent identity is unchanged', async () => {
    const c = client(), p = await c.parent(), a = await c.configured(p), d = await c.enter(p, a.id), s = await c.login(a.name, a.pass)
    expect(p.user.accountKind).toBe('primary'); expect(p.user.mainAccountActivated).toBe(true)
    for (const session of [d, s]) {
      expect(session.user.id).toBe(a.id); expect(session.user.accountKind).toBe('child'); expect(session.user.tenantId).not.toBe(p.user.tenantId)
      expect(session.user.mainAccountActivated).toBe(false); expect(Array.isArray(session.user.roles) && session.user.roles.length === 0).toBe(true)
      expect(session.user.hasRecoveryKey).toBe(false); expect('recoveryKey' in session).toBe(false)
    }
    expect(d.user.sessionId).not.toBe(s.user.sessionId)
    await c.request('POST', password + '/reset-code', { session: d, body: { currentPassword: p.recoveryKey }, status: 403 })
    await c.change(d, { recoveryKey: p.recoveryKey }, passphrase(), 403)
    await c.request('POST', account + '/logout', { session: p, body: {} })
    await c.me(d, 401); await c.refresh(d, 401)
    expect((await c.me(s)).id).toBe(a.id); expect((await c.refresh(s)).user.sessionId).toBe(s.user.sessionId)
  }, 20_000)

  it('disabling blocks password login, recovery and delegation; re-enabling does not revive old sessions', async () => {
    const c = client(), p = await c.parent(), a = await c.configured(p), b = await c.configured(p)
    const s = await c.login(a.name, a.pass), sibling = await c.login(b.name, b.pass), d = await c.enter(p, a.id), token = await c.code(s, a.pass)
    await c.request('PATCH', `${children}/${a.id}`, { session: p, body: { status: 'disabled' } })
    expect((await c.request<AccountFamily>('GET', children, { session: p })).children.find(item => item.id === a.id)?.status).toBe('disabled')
    await c.login(a.name, a.pass, 401); await c.recover(a.name, token, passphrase(), 403); await c.enter(p, a.id, 409)
    for (const session of [s, d]) { await c.me(session, 401); await c.refresh(session, 401) }
    expect((await c.me(sibling)).id).toBe(b.id)
    await c.request('PATCH', `${children}/${a.id}`, { session: p, body: { status: 'active' } })
    await c.me(s, 401); await c.me(d, 401); expect((await c.login(a.name, a.pass)).user.id).toBe(a.id)
  }, 20_000)

  it('an older parent session must reverify its own identity before changing a child password', async () => {
    const c = client(), p = await c.parent(), other = await c.parent(), a = await c.configured(p), next = passphrase()
    const now = Date.now.bind(Date); vi.spyOn(Date, 'now').mockImplementation(() => now() + 11 * 60_000)
    await c.request('GET', c.managed(a.id), { session: p }); await c.request('PUT', c.managed(a.id), { session: p, body: { password: next }, status: 403 })
    await c.request('POST', account + '/reauth', { session: p, body: { recoveryKey: other.recoveryKey }, status: 403 })
    await c.request('PUT', c.managed(a.id), { session: p, body: { password: next }, status: 403 })
    expect((await c.request<AccountUser>('POST', account + '/reauth', { session: p, body: { recoveryKey: p.recoveryKey } })).sessionId).toBe(p.user.sessionId)
    await c.set(p, a.id, { password: next }, a.name); await c.login(a.name, a.pass, 401); expect((await c.login(a.name, next)).user.id).toBe(a.id)
  }, 20_000)
})
