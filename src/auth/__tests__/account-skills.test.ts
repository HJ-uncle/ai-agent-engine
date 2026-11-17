/** Real account admission and read-only skill catalogue; management and filesystem boundaries remain enforced. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AccountLoginResult } from '../accounts.js'

vi.mock('../../tools/web-fetch/security-config.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../tools/web-fetch/security-config.js')>()
  return { ...actual, loadSecurityConfig: () => actual.DEFAULT_CONFIG, saveSecurityConfig: vi.fn() }
})

const parent = path.resolve('.e2e-tmp', 'account-simplify')
let fixture: string, project: string, outside: string, app: FastifyInstance
let database: typeof import('../../storage/sqlite/db.js')
let middleware: typeof import('../../api/http/middleware.js')
let registry: typeof import('../../skills/skills-registry.js')
let workspaces: typeof import('../../workspace/index.js')
let account: AccountLoginResult
const gate = { 'x-aether-instance-token': 'account-skills-fixture' }
const credentials = () => ({ ...gate, authorization: `Bearer ${account.accessToken}` })
const url = (root?: string, extra = '') => `/api/v1/skills?available=1${root ? '&path=' + encodeURIComponent(root) : ''}${extra}`

function seed(root: string, name: string): string {
  const directory = path.join(root, '.ae', 'skills', name)
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}\n---\nFixture.\n`)
  return directory
}
beforeAll(async () => {
  fs.mkdirSync(parent, { recursive: true })
  fixture = fs.mkdtempSync(path.join(parent, 'skills-'))
  project = path.join(fixture, 'projects', 'allowed')
  outside = path.join(fixture, 'outside')
  seed(project, 'project-skill'); seed(outside, 'outside-canary')
  const deployment = path.join(fixture, 'deployment')
  fs.mkdirSync(deployment, { recursive: true })
  vi.stubEnv('DATA_DIR', path.join(fixture, 'accounts.db'))
  vi.stubEnv('WORKSPACE_ROOT', path.join(fixture, 'private'))
  vi.stubEnv('SKILLS_ROOT', deployment)
  vi.stubEnv('AETHER_GLOBAL_DIR', path.join(fixture, 'global'))
  vi.stubEnv('AETHER_ALLOWED_WORKSPACE_ROOTS', path.join(fixture, 'projects'))
  vi.stubEnv('AUTH_ENABLED', 'false')
  vi.stubEnv('AETHER_INSTANCE_TOKEN', gate['x-aether-instance-token'])
  vi.stubEnv('AETHER_ACCOUNT_REGISTRATION', 'true')
  vi.stubEnv('ENCRYPTION_KEY', '5'.repeat(64))
  vi.stubEnv('JWT_SECRET', 'account-skills-jwt-fixture-secret')
  vi.stubEnv('OSM_MODE', 'balanced')
  database = await import('../../storage/sqlite/db.js'); await database.initDb()
  middleware = await import('../../api/http/middleware.js')
  registry = await import('../../skills/skills-registry.js')
  workspaces = await import('../../workspace/index.js')
  middleware.configureRequestAuthentication({ listenHost: '127.0.0.1', desktopOwned: true })
  registry.skillsRegistry.start()
  app = Fastify()
  app.addHook('onRequest', middleware.authMiddlewareHook)
  await app.register((await import('../../api/http/routes/accounts.js')).accountRoutes)
  await app.register((await import('../../api/http/routes/skill-imports.js')).skillImportRoutes, { prefix: '/api/v1' })
  await app.register((await import('../../api/http/routes/settings.js')).settingsRoutes, { prefix: '/api/v1' })
  await app.ready()
})
afterAll(async () => {
  await app?.close()
  registry?.skillsRegistry.stop()
  await database?.closeDb()
  vi.unstubAllEnvs()
  if (path.dirname(path.resolve(fixture)) !== parent || !path.basename(fixture).startsWith('skills-')) throw new Error('Unsafe fixture path')
  fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

describe('account runtime skill catalogue', () => {
  it('keeps available skills readable from local anonymous mode through account registration', async () => {
    const anonymous = await app.inject({ method: 'GET', url: url(project), headers: gate })
    expect(anonymous.json().code).toBe(200)
    expect(anonymous.json().data.permissions).toEqual({ canManage: true })
    const registered = await app.inject({ method: 'POST', url: '/auth/account/register', headers: gate, payload: {} })
    expect(registered.statusCode).toBe(200)
    account = registered.json().data
    expect(account.user.roles).toEqual(['tenant-admin'])
    const authenticated = await app.inject({ method: 'GET', url: url(project), headers: credentials() })
    expect(authenticated.statusCode).toBe(200)
    expect(authenticated.json().code).toBe(200)
    expect(authenticated.json().data.list).toEqual(anonymous.json().data.list)
    expect(authenticated.json().data.list.map((skill: { name: string }) => skill.name)).toContain('project-skill')
    expect(authenticated.json().data.root).toBeUndefined()
    expect(authenticated.json().data.globalRoot).toBeUndefined()
    expect(authenticated.json().data.permissions).toEqual({ canManage: false })
  })

  it('does not let the available flag bypass management reads or mutations', async () => {
    const routes = [
      { method: 'GET' as const, url: '/api/v1/skills?all=1' },
      { method: 'GET' as const, url: '/api/v1/skills?available=0' },
      { method: 'GET' as const, url: '/api/v1/skills/project-skill?available=1' },
      { method: 'GET' as const, url: '/api/v1/skills/imports?available=1' },
      { method: 'POST' as const, url: '/api/v1/skills?available=1', payload: { name: 'forbidden', description: 'Forbidden', content: '# Body', projectRoot: project } },
      { method: 'DELETE' as const, url: '/api/v1/skills/project-skill?available=1&path=' + encodeURIComponent(project) },
    ]
    for (const route of routes) expect((await app.inject({ ...route, headers: credentials() })).json().code).toBe(41015)
    expect(fs.existsSync(path.join(project, '.ae', 'skills', 'forbidden'))).toBe(false)
    expect(fs.existsSync(path.join(project, '.ae', 'skills', 'project-skill', 'SKILL.md'))).toBe(true)
    expect((await app.inject({ method: 'GET', url: url(project), headers: { ...gate, authorization: 'Bearer aether_session_forged' } })).statusCode).toBe(401)
  })

  it('enforces allowed roots and tenant ownership in authenticated deployments', async () => {
    vi.stubEnv('AUTH_ENABLED', 'true'); middleware.configureRequestAuthentication()
    try {
      expect((await app.inject({ method: 'GET', url: url(project), headers: gate })).statusCode).toBe(401)
      expect((await app.inject({ method: 'GET', url: url(project), headers: credentials() })).json().code).toBe(200)
      expect((await app.inject({ method: 'GET', url: url(outside), headers: credentials() })).statusCode).toBe(403)
      const foreign = path.join(fixture, 'private', 'another-tenant', 'session')
      seed(foreign, 'foreign-private-canary')
      expect((await app.inject({ method: 'GET', url: url(foreign), headers: credentials() })).statusCode).toBe(403)
      const bound = path.join(fixture, 'projects', 'foreign-bound')
      seed(bound, 'foreign-bound-canary')
      workspaces.workspaceManager.bind({ tenantId: 'another-tenant', sessionId: 'session' }, bound)
      expect((await app.inject({ method: 'GET', url: url(bound), headers: credentials() })).statusCode).toBe(403)
      const link = path.join(fixture, 'projects', 'outside-link')
      fs.symlinkSync(outside, link, 'junction')
      expect((await app.inject({ method: 'GET', url: url(link), headers: credentials() })).statusCode).toBe(403)
    } finally { vi.stubEnv('AUTH_ENABLED', 'false'); middleware.configureRequestAuthentication() }
  })

  it('does not read escaped metadata through a manifest or skill-root junction', async () => {
    const escaped = seed(project, 'escaped-manifest')
    fs.writeFileSync(path.join(escaped, 'plugin.json'), JSON.stringify({ main: path.join(outside, '.ae', 'skills', 'outside-canary', 'SKILL.md') }))
    const result = await app.inject({ method: 'GET', url: url(project), headers: credentials() })
    const names = result.json().data.list.map((skill: { name: string }) => skill.name)
    expect(names).not.toContain('escaped-manifest'); expect(names).not.toContain('outside-canary')
    const junctionProject = path.join(fixture, 'projects', 'junction-metadata')
    fs.mkdirSync(junctionProject, { recursive: true })
    fs.symlinkSync(path.join(outside, '.ae'), path.join(junctionProject, '.ae'), 'junction')
    const linked = await app.inject({ method: 'GET', url: url(junctionProject), headers: credentials() })
    expect(linked.json().data.list.map((skill: { name: string }) => skill.name)).not.toContain('outside-canary')
  })

  it('returns shared skills without implicitly using the server project when no path is selected', async () => {
    const response = await app.inject({ method: 'GET', url: url(), headers: credentials() })
    expect(response.json().code).toBe(200)
    expect(response.json().data.list.map((skill: { name: string }) => skill.name)).toEqual(['aether-office'])
  })

  it('reports management capabilities from the same authorization rules for account, JWT and API-key callers', async () => {
    const { SignJWT } = await import('jose')
    const jwtHeaders = async (roles: string[]) => ({ ...gate, authorization: 'Bearer ' + await new SignJWT({ tenantId: account.user.tenantId, roles })
      .setProtectedHeader({ alg: 'HS256' }).setSubject(account.user.id).setExpirationTime('5m').sign(new TextEncoder().encode(process.env.JWT_SECRET!)) })
    const key = 'isolated-account-skills-api-key'
    await database.getDb().execute({ sql: 'UPDATE users SET api_key_hash=? WHERE id=?', args: [createHash('sha256').update(key).digest('hex'), account.user.id] })
    const variants = [
      { headers: gate, skills: true, settings: true },
      { headers: credentials(), skills: false, settings: false },
      { headers: await jwtHeaders(['admin']), skills: true, settings: true },
      { headers: await jwtHeaders(['skill-manager']), skills: true, settings: false },
      { headers: await jwtHeaders(['viewer']), skills: false, settings: false },
      { headers: { ...gate, 'x-api-key': key }, skills: true, settings: true },
    ]
    for (const variant of variants) {
      const skillRead = await app.inject({ method: 'GET', url: url(project), headers: variant.headers })
      expect(skillRead.json().data.permissions).toEqual({ canManage: variant.skills })
      const manageRead = await app.inject({ method: 'GET', url: '/api/v1/skills', headers: variant.headers })
      expect(manageRead.json().code).toBe(variant.skills ? 200 : 41015)
      const settings = await app.inject({ method: 'GET', url: '/api/v1/settings', headers: variant.headers })
      expect(settings.json().data.permissions).toEqual({ canManage: variant.settings })
      expect(settings.json().data.SUBAGENT_CONCURRENCY_LIMIT).toEqual(expect.any(Number))
      const write = await app.inject({ method: 'PUT', url: '/api/v1/settings', headers: variant.headers, payload: { SUBAGENT_CONCURRENCY_LIMIT: 'invalid' } })
      expect(write.json().code).toBe(variant.settings ? 400 : 41015)
    }
    const roundtrip = await app.inject({ method: 'PUT', url: '/api/v1/settings', headers: gate, payload: { permissions: { canManage: false } } })
    expect(roundtrip.json().code).toBe(200)
    expect((await database.getDb().execute({ sql: 'SELECT key FROM system_config WHERE key=?', args: ['permissions'] })).rows).toHaveLength(0)
    expect((await app.inject({ method: 'GET', url: '/api/v1/settings', headers: gate })).json().data.permissions).toEqual({ canManage: true })
  })
})
