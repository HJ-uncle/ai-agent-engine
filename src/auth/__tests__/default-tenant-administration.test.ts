import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import { SignJWT, type JWTPayload } from 'jose'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AuthContext } from '../types.js'

const fixtures = fileURLToPath(new URL('../../../.e2e-tmp/service-credentials/tenant-administration-tests', import.meta.url))
const signingSecret = randomBytes(48).toString('hex')
const gate = { 'x-aether-instance-token': randomBytes(32).toString('hex') }
let directory = '', app: FastifyInstance, database: typeof import('../../storage/sqlite/db.js')
type Credentials = Record<string, string>
const keyHeader = (value: string): Credentials => ({ 'x-api-key': value })
const freshKey = () => randomBytes(32).toString('base64url')
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
async function jwt(claims: JWTPayload): Promise<Credentials> {
  const token = await new SignJWT(claims).setProtectedHeader({ alg: 'HS256' }).setExpirationTime('5m').sign(new TextEncoder().encode(signingSecret))
  return { authorization: 'Bearer ' + token }
}
const status = (credentials: Credentials) => app.inject({ method: 'GET', url: '/admin/status', headers: { ...gate, ...credentials } })
const business = (credentials: Credentials) => app.inject({ method: 'GET', url: '/fixture/business', headers: { ...gate, ...credentials } })
const register = (credentials: Credentials, userId: string, token: string, name = 'fixture-admin') => app.inject({
  method: 'POST', url: '/auth/user', headers: { ...gate, ...credentials }, payload: { userId, token, name },
})
async function registered(tenantId: string) {
  return (await database.getDb().execute({ sql: 'SELECT api_key_hash, name FROM users WHERE tenant_id = ?', args: [tenantId] })).rows
}

beforeAll(async () => {
  fs.mkdirSync(fixtures, { recursive: true }); directory = fs.mkdtempSync(path.join(fixtures, 'run-'))
  for (const [key, value] of Object.entries({ DATA_DIR: path.join(directory, 'agent.db'), AETHER_GLOBAL_DIR: path.join(directory, 'global'),
    WORKSPACE_ROOT: path.join(directory, 'workspace'), QA_LOG_DIR: path.join(directory, 'qa'), QA_LOG_ENABLED: 'false', LOG_LEVEL: 'silent',
    AUTH_ENABLED: 'true', AETHER_INSTANCE_TOKEN: gate['x-aether-instance-token'], JWT_SECRET: signingSecret, ENCRYPTION_KEY: randomBytes(32).toString('hex') })) vi.stubEnv(key, value)
  database = await import('../../storage/sqlite/db.js'); await database.initDb()
  const { configureRequestAuthentication, authMiddlewareHook } = await import('../../api/http/middleware.js')
  const { adminRoutes } = await import('../../api/http/routes/admin.js')
  const { authRoutes } = await import('../../api/http/routes/auth.js')
  configureRequestAuthentication(); app = Fastify(); app.addHook('onRequest', authMiddlewareHook)
  await app.register(adminRoutes); await app.register(authRoutes)
  // Probe only the ordinary workload identity; no extra authorization rule is applied to this route.
  app.get('/fixture/business', (req: FastifyRequest & { authContext?: AuthContext }) => ({ tenantId: req.authContext?.tenantId }))
  await app.ready()
})
afterAll(async () => {
  try { await app?.close(); await database?.closeDb() }
  finally {
    vi.unstubAllEnvs()
    if (directory) {
      const target = fs.realpathSync(directory)
      if (path.dirname(target) !== fs.realpathSync(fixtures) || fs.lstatSync(directory).isSymbolicLink()) throw new Error('Unexpected fixture directory')
      fs.rmSync(target, { recursive: true, force: true })
    }
  }
})

describe('default-tenant administration', () => {
  it('preserves implicit workload identity but requires an explicit default claim for both reading status and managing the default key', async () => {
    const legacy = await Promise.all([jwt({ roles: ['admin'] }), jwt({ sub: 'default', roles: ['admin'] }), jwt({ tenantId: null, sub: 'default', roles: ['admin'] })])
    for (const credential of legacy) expect((await business(credential)).json()).toEqual({ tenantId: 'default' })
    const denied = [...legacy, await jwt({ tenantId: 'elsewhere', sub: 'default', roles: ['admin'] }), await jwt({ tenantId: 'default', roles: ['viewer'] })]
    for (const credential of denied) {
      expect((await status(credential)).statusCode).toBe(403)
      expect((await register(credential, 'default', freshKey())).statusCode).toBe(403)
    }
    expect(await registered('default')).toHaveLength(0)
    const owner = await jwt({ tenantId: 'default', sub: 'operator', roles: ['admin'] }), original = freshKey()
    expect((await status(owner)).statusCode).toBe(200)
    expect((await register(owner, 'default', original)).statusCode).toBe(200)
    for (const credential of denied) expect((await register(credential, 'default', freshKey(), 'replacement')).statusCode).toBe(403)
    expect(await registered('default')).toEqual([{ api_key_hash: digest(original), name: 'fixture-admin' }])
    expect((await status(keyHeader(original))).statusCode).toBe(200)
  })

  it('never creates or replaces a user on invalid key input and preserves ordinary tenants and valid rotations', async () => {
    const tenant = 'fixture-other-tenant', admin = await jwt({ sub: tenant, roles: ['admin'] })
    expect((await business(admin)).json()).toEqual({ tenantId: tenant })
    const invalid = ['', ' \t ', ' leading', 'trailing ', 'internal space', 'fixture-invalid\r\nline', 'invalid\u0000', 'invalid\u007f', '密钥', 'x'.repeat(4097)]
    for (const value of invalid) {
      const response = await register(admin, tenant, value)
      expect(response.statusCode).toBe(400); expect(response.json().code).toBe(40000)
      expect(response.body).not.toContain('fixture-invalid')
    }
    expect(await registered(tenant)).toHaveLength(0)
    const original = freshKey(), next = 'valid+._~!-' + freshKey()
    expect((await register(admin, tenant, original)).statusCode).toBe(200)
    for (const value of invalid) expect((await register(keyHeader(original), tenant, value, 'replacement')).statusCode).toBe(400)
    expect(await registered(tenant)).toEqual([{ api_key_hash: digest(original), name: 'fixture-admin' }])
    expect((await register(keyHeader(original), tenant, next)).statusCode).toBe(200)
    expect((await business(keyHeader(original))).statusCode).toBe(401)
    expect((await business(keyHeader(next))).json()).toEqual({ tenantId: tenant })
  })
})
