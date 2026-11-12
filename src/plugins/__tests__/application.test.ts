import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PluginService } from '../service.js'
import { pluginRoutes } from '../../api/http/routes/plugins.js'
import type { CreatePluginInput } from '../types.js'
import type { AuthContext } from '../../auth/types.js'
import { clearSecurityMode, getSecurityMode, setSecurityMode } from '../../security/policy-engine.js'

let root: string, service: PluginService, app: FastifyInstance, principal: AuthContext | undefined
const id = 'currency-fixture'
const input = (multiplier = 7.2): CreatePluginInput => ({
  manifest: { apiVersion: 1, id, name: '货币换算器', version: String(multiplier), description: '使用用户指定的确定汇率换算', runtime: 'node',
    tools: [{ name: 'convert', description: '转换金额', entry: 'main.mjs', inputSchema: { type: 'object', properties: { amount: { type: 'number', minimum: 0 }, emitArtifact: { type: 'boolean' } }, required: ['amount'], additionalProperties: false } }] },
  files: { 'main.mjs': `process.stdin.setEncoding('utf8');let text='';for await(const c of process.stdin)text+=c;const {args}=JSON.parse(text);console.log(JSON.stringify({result:{converted:args.amount*${multiplier}},artifacts:args.emitArtifact?[{path:'report/result.txt',content:'preview only'}]:[]}))`,
    'examples/cases.json': JSON.stringify({ cases: [{ name: '有效预填', tool: 'convert', args: { amount: 100 } }, { name: '未知工具', tool: 'missing', args: {} }, { name: '重复工具', tool: 'convert', args: { amount: 200 } }] }) },
})
const invoke = (revision = 1, args: unknown = { amount: 100 }, tool = 'convert') => app.inject({ method: 'POST', url: `/plugins/runtime/apps/${id}/invoke`, payload: { revision, tool, args } })
const view = (query = '') => app.inject({ method: 'GET', url: `/plugins/runtime/apps/${id}${query}` })
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-application-'))
  vi.stubEnv('DATA_DIR', path.join(root, 'state', 'agent.db')); vi.stubEnv('AUTH_ENABLED', 'false'); vi.stubEnv('DEFAULT_SECURITY_MODE', 'standard')
  service = new PluginService(); principal = undefined
  app = Fastify()
  app.addHook('onRequest', async request => { if (principal) (request as typeof request & { authContext?: AuthContext }).authContext = principal })
  await app.register(pluginRoutes)
})
afterEach(async () => {
  await app.close(); clearSecurityMode('default', 'plugin-application'); vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('plugin-application-')) throw new Error('Unsafe application fixture cleanup')
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('published plugin applications', () => {
  it('opens only a published snapshot, prefills schema-valid examples and returns no source, revisions or host directory', async () => {
    await service.create('default', input())
    expect((await view()).statusCode).toBe(409)
    expect((await invoke()).statusCode).toBe(409)
    await service.publish('default', id, 1)
    const application = (await view()).json().data.application
    expect(application).toMatchObject({ id, name: '货币换算器', revision: 1, hash: expect.stringMatching(/^sha256:/), execution: { allowed: true }, examples: [{ name: '有效预填', tool: 'convert', args: { amount: 100 } }] })
    expect(Object.keys(application).sort()).toEqual(['description', 'examples', 'execution', 'hash', 'id', 'manifest', 'name', 'revision'])
    expect(JSON.stringify(application)).not.toContain(root)
    expect(JSON.stringify(application)).not.toContain('process.stdin')
    const result = (await invoke()).json().data
    expect(result).toMatchObject({ result: { converted: 720 }, artifacts: [], stderr: '', plugin: { id, revision: 1, hash: application.hash } })
  })

  it('keeps an opened revision fixed across draft changes and another publication, then immediately blocks disabled plugins', async () => {
    await service.create('default', input()); await service.publish('default', id, 1)
    await service.update('default', id, { ...input(8), expectedRevision: 1 })
    expect((await view()).json().data.application.manifest.version).toBe('7.2')
    expect((await invoke(2)).statusCode).toBe(409)
    await service.publish('default', id, 2)
    expect((await view()).json().data.application.revision).toBe(2)
    expect((await view('?revision=1')).json().data.application.revision).toBe(1)
    expect((await invoke(1)).json().data.result).toEqual({ converted: 720 })
    expect((await invoke(2)).json().data.result).toEqual({ converted: 800 })
    await service.setEnabled('default', id, false)
    expect((await view('?revision=1')).statusCode).toBe(409)
    expect((await invoke(1)).statusCode).toBe(409)
  })

  it('keeps auth and tenant checks on both discovery and invocation', async () => {
    await service.create('default', input()); await service.publish('default', id, 1)
    vi.stubEnv('AUTH_ENABLED', 'true')
    expect((await view()).statusCode).toBe(403); expect((await invoke()).statusCode).toBe(403)
    principal = { tenantId: 'default', method: 'jwt', roles: ['viewer'] }
    expect((await view()).statusCode).toBe(403); expect((await invoke()).statusCode).toBe(403)
    principal = { tenantId: 'other', method: 'jwt', roles: ['plugin-manager'] }
    expect((await view()).statusCode).toBe(404); expect((await invoke()).statusCode).toBe(404)
    principal = { tenantId: 'default', method: 'jwt', roles: ['plugin-manager'] }
    expect((await view()).statusCode).toBe(200); expect((await invoke()).json().data.result.converted).toBe(720)
  })

  it('does not execute in safe default mode or accept client-selected modes, sessions or working directories', async () => {
    await service.create('default', input()); await service.publish('default', id, 1)
    vi.stubEnv('DEFAULT_SECURITY_MODE', 'safe')
    expect((await view()).json().data.application.execution).toMatchObject({ allowed: false, reason: expect.stringContaining('安全模式') })
    expect((await invoke()).statusCode).toBe(403)
    for (const extra of [{ securityMode: 'full-access' }, { sessionId: 'approved-session' }, { workspace: root }]) {
      expect((await app.inject({ method: 'POST', url: `/plugins/runtime/apps/${id}/invoke`, payload: { revision: 1, tool: 'convert', args: { amount: 100 }, ...extra } })).statusCode).toBe(400)
    }
  })

  it('does not inherit an unrelated chat override even when the chat ID equals the old application policy key', async () => {
    await service.create('default', input()); await service.publish('default', id, 1)
    vi.stubEnv('DEFAULT_SECURITY_MODE', 'safe')
    setSecurityMode('default', 'plugin-application', 'full-access')
    expect(getSecurityMode('default', 'plugin-application')).toBe('full-access')
    expect((await view()).json().data.application.execution.allowed).toBe(false)
    expect((await invoke()).statusCode).toBe(403)
    vi.stubEnv('DEFAULT_SECURITY_MODE', 'standard')
    setSecurityMode('default', 'plugin-application', 'safe')
    expect((await view()).json().data.application.execution.allowed).toBe(true)
    expect((await invoke()).json().data.result.converted).toBe(720)
  })

  it('requires a fixed revision and validates tool inputs, query parameters and sealed bytes on every use', async () => {
    await service.create('default', input()); await service.publish('default', id, 1)
    expect((await app.inject({ method: 'POST', url: `/plugins/runtime/apps/${id}/invoke`, payload: { tool: 'convert', args: { amount: 100 } } })).statusCode).toBe(400)
    expect((await view('?revision=0')).statusCode).toBe(400)
    expect((await view('?revision=1&allowDraft=true')).statusCode).toBe(400)
    expect((await invoke(1, { amount: '100' })).statusCode).toBe(400)
    expect((await invoke(1, { amount: -1 })).statusCode).toBe(400)
    expect((await invoke(1, { amount: 100 }, 'missing')).statusCode).toBe(404)
    const snapshot = await service.snapshot('default', id, 1)
    fs.appendFileSync(path.join(snapshot.directory, 'main.mjs'), '\n// modified after publication')
    expect((await view()).statusCode).toBe(409); expect((await invoke()).statusCode).toBe(409)
  })

  it('previews artifacts without writing them and returns explicit plugin failures as failures', async () => {
    await service.create('default', input()); await service.publish('default', id, 1)
    const snapshot = await service.snapshot('default', id, 1)
    const result = (await invoke(1, { amount: 100, emitArtifact: true })).json().data
    expect(result.artifacts).toEqual([{ path: 'report/result.txt', content: 'preview only' }])
    expect(fs.existsSync(path.join(snapshot.directory, 'report'))).toBe(false)
    expect(fs.existsSync(path.join(root, 'report'))).toBe(false)
    const failing = input(); failing.files['main.mjs'] = 'console.log(JSON.stringify({error:{code:"RATE_UNAVAILABLE",message:"汇率不可用"}}))'
    await service.update('default', id, { ...failing, expectedRevision: 1 }); await service.publish('default', id, 2)
    const error = await invoke(2)
    expect(error.statusCode).toBe(400); expect(error.json().message).toContain('[RATE_UNAVAILABLE] 汇率不可用')
    failing.files['main.mjs'] = 'console.log(JSON.stringify({result:1,artifacts:[{path:"../outside.txt",content:"must not be written"}]}))'
    await service.update('default', id, { ...failing, expectedRevision: 2 }); await service.publish('default', id, 3)
    const badArtifact = await invoke(3)
    expect(badArtifact.statusCode).toBe(400)
    expect(fs.existsSync(path.join(root, 'outside.txt'))).toBe(false)
  })

  it('ignores malformed, oversized or schema-invalid saved examples without changing execution validation', async () => {
    const fixture = input()
    fixture.files['examples/cases.json'] = JSON.stringify({ cases: [{ tool: 'convert', args: { amount: 'not a number' } }, { tool: 'convert', args: { amount: 3 } }] })
    await service.create('default', fixture); await service.publish('default', id, 1)
    expect((await view()).json().data.application.examples).toEqual([{ name: 'convert', tool: 'convert', args: { amount: 3 } }])
    fixture.files['examples/cases.json'] = '{broken'
    await service.update('default', id, { ...fixture, expectedRevision: 1 }); await service.publish('default', id, 2)
    expect((await view()).json().data.application.examples).toEqual([])
    fixture.files['examples/cases.json'] = JSON.stringify({ padding: 'x'.repeat(256 * 1024), cases: [] })
    await service.update('default', id, { ...fixture, expectedRevision: 2 }); await service.publish('default', id, 3)
    expect((await view()).json().data.application.examples).toEqual([])
    expect((await invoke(3)).json().data.result.converted).toBe(720)
  })

  it('cancels the owned plugin process when the user disconnects during an invocation', async () => {
    const fixture = input()
    fixture.files['main.mjs'] = "import fs from 'node:fs';for await(const chunk of process.stdin){};fs.writeFileSync('active-process.json',JSON.stringify({pid:process.pid}));setInterval(()=>{},1000)"
    await service.create('default', fixture); await service.publish('default', id, 1)
    const snapshot = await service.snapshot('default', id, 1), marker = path.join(snapshot.directory, 'active-process.json')
    const base = await app.listen({ port: 0, host: '127.0.0.1' })
    const abort = new AbortController()
    const pending = fetch(base + `/plugins/runtime/apps/${id}/invoke`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: 1, tool: 'convert', args: { amount: 1 } }), signal: abort.signal }).catch(error => error)
    let pid: number | undefined
    try {
      await vi.waitFor(() => expect(fs.existsSync(marker)).toBe(true), { timeout: 8000, interval: 40 })
      pid = JSON.parse(fs.readFileSync(marker, 'utf8')).pid
      expect(alive(pid!)).toBe(true)
      abort.abort(); await pending
      await vi.waitFor(() => expect(alive(pid!)).toBe(false), { timeout: 12000, interval: 100 })
    } finally {
      abort.abort(); await pending
      if (pid && alive(pid)) { try { process.kill(pid, 'SIGKILL') } catch { /* Already exited. */ } }
    }
  }, 25000)
})
