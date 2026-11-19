/** Production Fastify registration and real database/JWT authentication for the bundled management page. */
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { SignJWT } from 'jose'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const fixtureParent = fileURLToPath(new URL('../../../../.e2e-tmp/admin-web-validation/http/', import.meta.url))
const instance = randomBytes(32).toString('hex'), key = randomBytes(32).toString('hex')
const otherKey = randomBytes(32).toString('hex'), seed = randomBytes(48).toString('hex')
const canaries = [instance, key, otherKey, seed]
const sentinel = 'disposable-legacy-public-site-marker'
let fixture = '', buildServer: typeof import('../server.js').buildServer
let database: typeof import('../../../storage/sqlite/db.js'), memory: typeof import('../../../storage/memory/db.js')
let viewer = '', tenantUser = ''
const apiKey = (value: string): Record<string, string> => ({ 'x-api-key': value })
const gate = { 'x-aether-instance-token': instance }
const owner = { ...gate, ...apiKey(key) }

function noSensitiveValues(body: string): void {
  // Assertion failures must not copy actual request credentials into test output.
  expect(canaries.some(value => body.includes(value)), 'response must not contain a submitted credential').toBe(false)
}
async function asRole(roles: string[]): Promise<string> {
  return new SignJWT({ tenantId: 'default', roles }).setProtectedHeader({ alg: 'HS256' })
    .setSubject('admin-web-fixture-user').setExpirationTime('5m').sign(new TextEncoder().encode(seed))
}
async function runServer(enabled: boolean, expectedToken: string | undefined, legacy: boolean, run: (server: FastifyInstance) => Promise<void>): Promise<void> {
  vi.stubEnv('AUTH_ENABLED', String(enabled))
  vi.stubEnv('AETHER_INSTANCE_TOKEN', expectedToken)
  vi.stubEnv('PUBLIC_DIR', path.join(fixture, legacy ? 'legacy' : 'absent'))
  const server = await buildServer({ listenHost: '127.0.0.1' })
  try { await server.ready(); await run(server) } finally { await server.close() }
}
interface Status { version: string; instanceToken: string; authenticationRequired: boolean; startedAt: string | number; uptimeSeconds: number }
async function expectStatus(server: FastifyInstance, credentials: Record<string, string>, configured: 'configured' | 'not-set', auth: boolean): Promise<void> {
  const response = await server.inject({ url: '/admin/status', headers: credentials })
  noSensitiveValues(response.body)
  expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toMatch(/no-store/i)
  expect(response.headers['content-type']).toMatch(/application\/json/i)
  const { data, code } = response.json<{ data: Status; code: number }>()
  expect(code).toBe(200)
  expect(Object.keys(data).sort()).toEqual(['authenticationRequired', 'instanceToken', 'startedAt', 'uptimeSeconds', 'version'])
  expect(data).toMatchObject({ instanceToken: configured, authenticationRequired: auth })
  expect(data.version).toBe((await server.inject({ url: '/meta' })).json().data.version)
  expect(Number.isFinite(data.uptimeSeconds) && data.uptimeSeconds >= 0).toBe(true)
  const start = typeof data.startedAt === 'number' ? data.startedAt : Date.parse(data.startedAt)
  expect(Number.isFinite(start) && start > 0 && start <= Date.now()).toBe(true)
}
async function denied(server: FastifyInstance, credentials: Record<string, string>, status: 401 | 403): Promise<void> {
  const response = await server.inject({ url: '/admin/status', headers: credentials })
  noSensitiveValues(response.body)
  expect(response.statusCode).toBe(status); expect(response.json().data).toBeNull()
}

type ConsoleWindow = Window & { Event: typeof Event; eval(source: string): void }
async function withRuleConsole(server: FastifyInstance, adminKey: string, verify: (doc: Document, requests: string[]) => Promise<void>): Promise<void> {
  const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
    JSDOM: new (html: string, options: { url: string; runScripts: 'outside-only' }) => { window: ConsoleWindow }
  }
  const [page, script] = await Promise.all(['/admin/', '/admin/app.js'].map(url => server.inject({ url })))
  const { window } = new JSDOM(page.body, { url: 'http://127.0.0.1/admin/', runScripts: 'outside-only' })
  const doc = window.document, requests: string[] = []
  try {
    window.fetch = async (target, init) => {
      const url = new URL(String(target)); requests.push(url.pathname)
      expect(url.origin).toBe('http://127.0.0.1'); expect(init?.method).toBe('GET')
      const response = await server.inject({ url: url.pathname + url.search, headers: Object.fromEntries(new Headers(init?.headers)) })
      return new Response(response.body, { status: response.statusCode })
    }
    window.eval(script.body)
    doc.querySelector<HTMLInputElement>('#admin-secret')!.value = adminKey
    doc.querySelector<HTMLInputElement>('#instance-token')!.value = instance
    doc.querySelector('#access-form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
    await verify(doc, requests)
  } finally { window.close() }
}

beforeAll(async () => {
  fs.mkdirSync(fixtureParent, { recursive: true }); fixture = fs.mkdtempSync(path.join(fixtureParent, 'profile-'))
  for (const [name, value] of Object.entries({ DATA_DIR: path.join(fixture, 'db', 'engine.db'), MEMORY_DB_PATH: path.join(fixture, 'memory', 'memory.db'),
    AETHER_GLOBAL_DIR: path.join(fixture, 'global'), PROGRAMDATA: path.join(fixture, 'managed'), WORKSPACE_ROOT: path.join(fixture, 'workspace'),
    SKILLS_ROOT: path.join(fixture, 'skills'), MCP_CONFIG_PATH: path.join(fixture, 'mcp.json'), QA_LOG_DIR: path.join(fixture, 'qa'),
    QA_LOG_ENABLED: 'false', ENABLE_LONG_TERM_MEMORY: 'false', LOG_LEVEL: 'silent', JWT_SECRET: seed, ENCRYPTION_KEY: randomBytes(32).toString('hex') })) vi.stubEnv(name, value)
  for (const child of ['workspace', 'skills', 'legacy/admin']) fs.mkdirSync(path.join(fixture, child), { recursive: true })
  for (const file of ['index.html', 'm.html', 'admin/index.html', 'admin/app.js', 'admin/an-old-page.html']) {
    fs.writeFileSync(path.join(fixture, 'legacy', file), sentinel)
  }
  // Scheduler dispatch is orthogonal; route registration, both auth gates, SQLite and app assets remain real.
  const { cronScheduler } = await import('../../../scheduler/cron-scheduler.js')
  vi.spyOn(cronScheduler, 'start').mockImplementation(() => {})
  const { SQLiteTaskQueue } = await import('../../../storage/task-queue/sqlite-queue.js')
  vi.spyOn(SQLiteTaskQueue.prototype, 'start').mockImplementation(() => {})
  database = await import('../../../storage/sqlite/db.js'); memory = await import('../../../storage/memory/db.js')
  await database.initDb()
  for (const [id, tenant, value] of [['local-admin', 'default', key], ['other-admin', 'other-tenant', otherKey]]) {
    await database.getDb().execute({ sql: 'INSERT INTO users(id, tenant_id, api_key_hash) VALUES (?, ?, ?)',
      args: [id, tenant, createHash('sha256').update(value).digest('hex')] })
  }
  viewer = await asRole(['viewer']); tenantUser = await asRole(['tenant-admin']); canaries.push(viewer, tenantUser)
  ;({ buildServer } = await import('../server.js'))
}, 30_000)

afterAll(async () => {
  try { await Promise.all([database?.closeDb(), memory?.closeMemoryDb()]) }
  finally { vi.restoreAllMocks(); vi.unstubAllEnvs() }
  if (!fixture) return
  const exact = path.resolve(fixture)
  if (path.dirname(exact) !== path.resolve(fixtureParent) || !path.basename(exact).startsWith('profile-') || fs.lstatSync(exact).isSymbolicLink()) throw new Error('Invalid isolated admin test profile')
  fs.rmSync(exact, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
}, 30_000)

describe('built-in engine administration web', () => {
  it('serves just the management shell on GET and HEAD before either credential is supplied', async () => {
    await runServer(true, instance, false, async server => {
      for (const method of ['GET', 'HEAD'] as const) {
        const redirect = await server.inject({ method, url: '/admin' })
        expect([301, 302, 307, 308]).toContain(redirect.statusCode); expect(redirect.headers.location).toBe('/admin/')
        for (const [url, mime] of [['/admin/', /text\/html/i], ['/admin/app.js', /(?:text|application)\/javascript/i], ['/admin/app.css', /text\/css/i]] as const) {
          const response = await server.inject({ method, url }); noSensitiveValues(response.body)
          expect(response.statusCode).toBe(200); expect(response.headers['content-type']).toMatch(mime)
          if (method === 'HEAD') expect(response.body).toBe('')
          else { expect(response.body.length).toBeGreaterThan(0); expect(response.body).not.toContain(sentinel) }
        }
      }
      for (const url of ['/health', '/meta']) expect((await server.inject({ url })).statusCode).toBe(200)
      for (const url of ['/api/v1/tools', '/metrics']) expect((await server.inject({ url })).statusCode).toBe(401)
      for (const url of ['/admin/', '/admin/app.js', '/admin/app.css', '/admin/status']) {
        const response = await server.inject({ method: 'POST', url }); expect(response.statusCode).not.toBe(200); noSensitiveValues(response.body)
      }
    })
  })

  it('requires the live instance token and a verified administrator of the default tenant', async () => {
    await runServer(true, instance, false, async server => {
      await denied(server, {}, 401); await denied(server, apiKey(key), 401); await denied(server, { ...gate, ...apiKey('invalid-test-key') }, 401)
      await denied(server, gate, 401); await denied(server, { ...gate, authorization: 'Bearer ' + viewer }, 403)
      await denied(server, { ...gate, authorization: 'Bearer ' + tenantUser }, 403)
      await denied(server, { ...gate, ...apiKey(otherKey) }, 403); await expectStatus(server, owner, 'configured', true)
    })
  })

  it('protects the live monitor and returns only scoped numerical data to an authorized administrator', async () => {
    await runServer(true, instance, false, async server => {
      for (const [credentials, expected] of [[{}, 401], [apiKey(key), 401], [{ ...gate, ...apiKey(otherKey) }, 403]] as const) {
        const response = await server.inject({ url: '/admin/monitor', headers: credentials })
        noSensitiveValues(response.body); expect(response.statusCode).toBe(expected); expect(response.json().data).toBeNull()
      }
      const response = await server.inject({ url: '/admin/monitor', headers: owner })
      noSensitiveValues(response.body); expect(response.body.includes(fixture)).toBe(false)
      expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toMatch(/no-store/i)
      const sample = response.json().data
      expect(Object.keys(sample).sort()).toEqual(['dataVolume','engine','host','resources','sampleWindowMs','sampledAt'])
      expect(Date.parse(sample.sampledAt)).toBeGreaterThan(0); expect(sample.sampleWindowMs).toBeGreaterThan(0)
      expect(sample.engine.rssBytes).toBeGreaterThan(0); expect(sample.resources.mainDatabaseBytes).toBeGreaterThan(0)
      expect(sample.resources.queuePending).toBe(0); expect(sample.resources.queueRunning).toBe(0)
    })
  })

  it('keeps the status credentialed in auth-off mode and reads frozen startup settings without a configured instance token', async () => {
    await runServer(false, undefined, false, async server => {
      await denied(server, {}, 401); await denied(server, apiKey(otherKey), 403)
      await expectStatus(server, apiKey(key), 'not-set', false)
      vi.stubEnv('AUTH_ENABLED', 'true'); vi.stubEnv('AETHER_INSTANCE_TOKEN', instance)
      await expectStatus(server, apiKey(key), 'not-set', false)
    })
  })

  it('does not provision or replace a default tenant key from the anonymous standalone service', async () => {
    await runServer(false, undefined, false, async server => {
      const candidate = randomBytes(32).toString('hex'); canaries.push(candidate)
      const keyRecord = () => database.getDb().execute({ sql: 'SELECT api_key_hash FROM users WHERE tenant_id = ?', args: ['default'] })
      const existing = (await keyRecord()).rows[0]?.api_key_hash
      expect(typeof existing).toBe('string')
      const response = await server.inject({ method: 'POST', url: '/auth/user', payload: { userId: 'default', token: candidate } })
      noSensitiveValues(response.body); expect([401, 403]).toContain(response.statusCode)
      expect((await keyRecord()).rows[0]?.api_key_hash === existing).toBe(true)
      await expectStatus(server, apiKey(key), 'not-set', false)
    })
  })
  it('fails closed for an explicitly empty instance token while preserving access to the shell and health', async () => {
    await runServer(false, '', false, async server => {
      for (const url of ['/admin/', '/admin/app.js', '/health', '/meta']) expect((await server.inject({ url })).statusCode).toBe(200)
      await denied(server, apiKey(key), 401); await denied(server, { ...apiKey(key), 'x-aether-instance-token': '' }, 401); await denied(server, owner, 401)
    })
  })

  it('reserves the entire management namespace when the deployment also serves a legacy SPA', async () => {
    await runServer(true, instance, true, async server => {
      const homepage = await server.inject({ url: '/', headers: owner }); expect(homepage.body).toContain(sentinel)
      const fallback = await server.inject({ url: '/legacy-section', headers: owner }); expect(fallback.body).toContain(sentinel)
      for (const url of ['/admin/', '/admin/app.js']) {
        const page = await server.inject({ url }); expect(page.statusCode).toBe(200); expect(page.body).not.toContain(sentinel)
      }
      for (const url of ['/admin/an-old-page.html', '/admin/missing', '/admin/section/unknown']) {
        const missing = await server.inject({ url, headers: owner }); expect(missing.statusCode).toBe(404); expect(missing.body).not.toContain(sentinel)
        expect(missing.headers['content-type']).not.toMatch(/text\/html/i)
      }
    })
  })

  it('persists operational rules across HTTP servers, prevents stale changes, and restores archives atomically', async () => {
    let id = '', archive: any
    await runServer(true, instance, false, async server => {
      const payload = { name: '验收规则', metric: 'hostMemory', threshold: 1, enabled: true }
      const made = await server.inject({ method: 'POST', url: '/admin/rules', headers: owner, payload }); expect(made.statusCode).toBe(200)
      id = made.json().data.id
      const archived = await server.inject({ url:'/admin/rules/archive', headers:owner }); archive = archived.json().data
      expect(archive.rules.some((r: any) => r.id===id)).toBe(true); noSensitiveValues(archived.body)
      const change = await server.inject({ method:'PATCH', url:'/admin/rules/'+id, headers:owner, payload:{revision:1,threshold:80} }); expect(change.json().data.revision).toBe(2)
      expect((await server.inject({ method:'PATCH',url:'/admin/rules/'+id,headers:owner,payload:{revision:1,enabled:false} })).statusCode).toBe(409)
      expect((await server.inject({ method:'DELETE',url:'/admin/rules/'+id+'?revision=1',headers:owner })).statusCode).toBe(409)
      const conflict = { ...archive, rules:[{ ...archive.rules[0],id:'d9774210-8df3-432a-b483-5fde334cab57',name:'不能部分创建' }, ...archive.rules] }
      expect((await server.inject({method:'POST',url:'/admin/rules/restore',headers:owner,payload:conflict})).statusCode).toBe(409)
      expect((await server.inject({url:'/admin/rules',headers:owner})).json().data.items).toHaveLength(1)
    })
    await runServer(true, instance, false, async server => {
      const before = await server.inject({url:'/admin/rules/'+id,headers:owner}); expect(before.json().data).toMatchObject({revision:2,threshold:80})
      const evaluation = await server.inject({url:'/admin/rules/evaluation',headers:owner});expect(evaluation.statusCode).toBe(200);expect(evaluation.json().data.items[0]).toMatchObject({id,revision:2})
      expect((await server.inject({method:'DELETE',url:'/admin/rules/'+id+'?revision=2',headers:owner})).statusCode).toBe(200)
      for (const [added,unchanged] of [[1,0],[0,1]]) expect((await server.inject({method:'POST',url:'/admin/rules/restore',headers:owner,payload:archive})).json().data).toEqual({added,unchanged})
      const log = await server.inject({url:'/admin/audit',headers:owner}); const events = log.json().data.items
      for (const action of ['rule.create','rule.update','rule.delete','rule.restore']) expect(events.some((r: any) => r.action===action && r.outcome==='success')).toBe(true)
      noSensitiveValues(log.body)
    })
  })

  it('checks both role grants before disclosing rule evaluations and rechecks revocation without reconnecting', async () => {
    await runServer(true, instance, false, async server => {
      const post = async (url: string, payload: any) => { const result = await server.inject({method:'POST',url,headers:owner,payload}); expect(result.statusCode).toBe(200); return result.json().data }
      const role = await post('/admin/roles',{name:'仅查看规则',permissions:['rules.read']})
      const m = await post('/admin/members',{name:'规则审阅员', roleId:role.id})
      const issued = await post('/admin/members/'+m.id+'/credentials',{}); canaries.push(issued.key)
      const headers = { ...gate, 'x-aether-admin-key': issued.key }
      expect((await server.inject({url:'/admin/rules',headers})).statusCode).toBe(200)
      expect((await server.inject({ url: '/admin/me', headers })).json().data).toMatchObject({ id: m.id, roleId: role.id, roleName: role.name, permissions: ['rules.read'] })
      for (const url of ['/admin/roles','/admin/monitor','/admin/rules/evaluation','/admin/audit']) expect((await server.inject({url,headers})).statusCode).toBe(403)
      expect((await server.inject({url:'/admin/rules',method:'POST',headers,payload:{}})).statusCode).toBe(403)
      expect((await server.inject({url:'/admin/rules',headers:{'x-aether-admin-key':issued.key}})).statusCode).toBe(401)
      expect((await server.inject({url:'/api/v1/tools',headers})).statusCode).toBe(401)
      await withRuleConsole(server, issued.key, async (doc, requests) => {
        const content = doc.querySelector('#view-content')!, identity = doc.querySelector('#viewer-role')!
        const checkButton = () => [...content.querySelectorAll('button')].find(button => button.textContent === '检查当前指标')
        await vi.waitFor(() => expect(content.textContent).toContain('查看运行指标'))
        expect(identity.textContent).toBe(role.name)
        expect(content.textContent).not.toContain('点击检查'); expect(checkButton()).toBeUndefined()
        expect(requests).toEqual(['/admin/me', '/admin/rules'])

        const updated = await server.inject({ method: 'PATCH', url: '/admin/roles/' + role.id, headers: owner,
          payload: { name: '监控值班', permissions: ['rules.read', 'metrics.read'] } })
        expect(updated.statusCode).toBe(200)
        doc.querySelector<HTMLButtonElement>('#view-refresh')!.click()
        await vi.waitFor(() => expect(content.textContent).toContain('点击检查'))
        expect(identity.textContent).toBe('监控值班')
        expect(requests).toEqual(['/admin/me', '/admin/rules', '/admin/me', '/admin/rules'])
        const check = checkButton(); expect(check).toBeDefined(); check!.click()
        await vi.waitFor(() => expect(content.textContent).toContain('检查于'), { timeout: 3000 })
        expect(requests.filter(url => url === '/admin/rules/evaluation')).toHaveLength(1)
      })
      expect((await server.inject({method:'DELETE',url:'/admin/members/'+m.id+'/credentials/'+issued.id,headers:owner})).statusCode).toBe(200)
      expect((await server.inject({url:'/admin/rules',headers})).statusCode).toBe(401)
      const audit = await server.inject({url:'/admin/audit',headers:owner}); noSensitiveValues(audit.body)
    })
  })
})
