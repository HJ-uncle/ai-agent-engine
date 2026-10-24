/** Real Fastify download streams + WorkspaceManager: exact nested artifacts and safe boundaries. */
import fs from 'node:fs'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { buildWorkspaceDownloadPrompt } from '../../../../core/workspace-download-prompt.js'
import { clearSecurityMode, setSecurityMode } from '../../../../security/policy-engine.js'
import { WorkspaceManager, workspaceManager } from '../../../../workspace/index.js'
import { workspaceRoutes } from '../workspace.js'

const identity = { tenantId: 'download-tenant', sessionId: 'work 下载 &+#(一)' }
let fixture: string, company: string, app: FastifyInstance

beforeEach(async () => {
  fs.mkdirSync('.e2e-tmp', { recursive: true })
  fixture = fs.mkdtempSync(path.resolve('.e2e-tmp/workspace-download-'))
  company = path.join(fixture, 'company')
  fs.mkdirSync(company)
  vi.stubEnv('AUTH_ENABLED', 'true')
  vi.stubEnv('AETHER_ALLOWED_WORKSPACE_ROOTS', company)
  vi.stubEnv('AETHER_WORKSPACE_BINDINGS_FILE', path.join(fixture, 'state', 'bindings.json'))
  const manager = new WorkspaceManager(path.join(fixture, 'private'))
  manager.bind(identity, company)
  setSecurityMode(identity.tenantId, identity.sessionId, 'safe')
  // Replace only singleton ownership; path authorization and filesystem reads remain real.
  vi.spyOn(workspaceManager, 'resolveSafePath').mockImplementation((context, name) => manager.resolveSafePath(context, name))
  app = Fastify()
  app.decorateRequest('authContext', null)
  app.addHook('onRequest', async request => {
    Object.assign(request, { authContext: { tenantId: identity.tenantId } })
  })
  await app.register(workspaceRoutes, { prefix: '/api/v1' })
  await app.ready()
})

afterEach(async () => {
  await app.close()
  clearSecurityMode(identity.tenantId, identity.sessionId)
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  if (path.dirname(fixture) !== path.resolve('.e2e-tmp') || !path.basename(fixture).startsWith('workspace-download-')) throw new Error('Unsafe download fixture cleanup')
  fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
})

function artifact(relativePath: string, contents: string): void {
  const target = path.join(company, relativePath)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, contents)
}

function download(relativePath: string) {
  const query = new URLSearchParams({ sessionId: identity.sessionId, path: relativePath })
  return app.inject({ method: 'GET', url: `/api/v1/workspace/file/download?${query}` })
}

it('the system prompt example downloads the exact company-relative nested file with an encoded session', async () => {
  const relativePath = 'finance/deliverables/v001/财务报告 2026.xlsx'
  artifact(relativePath, 'confirmed nested finance artifact')
  const prompt = buildWorkspaceDownloadPrompt(identity.sessionId)
  const link = prompt.match(/\]\((\/api\/v1\/workspace\/file\/download\?[^)]+)\)/)?.[1]
  if (!link) throw new Error('The system prompt has no usable Markdown download example')
  const parsed = new URL(link, 'http://fixture.invalid')
  expect([...parsed.searchParams]).toEqual([['sessionId', identity.sessionId], ['path', relativePath]])
  expect(link).not.toMatch(/[\s()]/)
  const response = await app.inject({ method: 'GET', url: link })
  expect(response.statusCode).toBe(200)
  expect(response.body).toBe('confirmed nested finance artifact')
  expect(response.headers['content-disposition']).toBe(`attachment; filename*=UTF-8''${encodeURIComponent(path.basename(relativePath))}`)
})

it('preserves Chinese names, spaces and query/Markdown delimiters without truncation or double decoding', async () => {
  const relativePath = '财务 团队/交付 v002/报告 (最终) & 回款+现金#50%20.xlsx'
  artifact(relativePath, 'exact special-name bytes')
  artifact(relativePath.replace('%20', ' '), 'wrong decoded-name bytes')
  const response = await download(relativePath)
  expect(response.statusCode).toBe(200)
  expect(response.body).toBe('exact special-name bytes')
  expect(response.headers['content-length']).toBe(String(Buffer.byteLength('exact special-name bytes')))
})

it('selects the requested version and role when several files share a basename', async () => {
  const paths = [
    'finance/deliverables/v001/report.xlsx',
    'finance/deliverables/v002/report.xlsx',
    'people/deliverables/v001/report.xlsx',
  ]
  for (const relativePath of paths) artifact(relativePath, relativePath)
  for (const relativePath of paths) {
    const response = await download(relativePath)
    expect(response.statusCode).toBe(200)
    expect(response.body).toBe(relativePath)
  }
  for (const wrongPath of ['report.xlsx', 'deliverables/v001/report.xlsx', 'finance/deliverables/v099/report.xlsx']) {
    const response = await download(wrongPath)
    expect(response.statusCode).toBe(404)
    expect(response.body).toBe('File not found')
  }
})

it.each(['../outside/private.txt', '..\\outside\\private.txt'])('rejects encoded traversal %s without disclosing external bytes', async relativePath => {
  const outside = path.join(fixture, 'outside')
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, 'private.txt'), 'outside secret bytes')
  const response = await download(relativePath)
  // POSIX treats backslashes as literal characters; Windows treats them as traversal.
  expect(response.statusCode).toBe(process.platform !== 'win32' && relativePath.includes('\\') ? 404 : 500)
  expect(response.body).not.toContain('outside secret bytes')
})

it('rejects an absolute external path and an external junction target in safe mode', async context => {
  const outside = path.join(fixture, 'outside')
  fs.mkdirSync(outside)
  const target = path.join(outside, 'private.txt')
  fs.writeFileSync(target, 'outside secret bytes')
  const absolute = await download(target)
  expect(absolute.statusCode).toBe(500)
  expect(absolute.body).toContain('outside any bound workspace')
  expect(absolute.body).not.toContain('outside secret bytes')
  try { fs.symlinkSync(outside, path.join(company, 'escape'), process.platform === 'win32' ? 'junction' : 'dir') }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      console.info('Filesystem link capability unavailable')
      context.skip()
    }
    throw error
  }
  const linked = await download('escape/private.txt')
  expect(linked.statusCode).toBe(500)
  expect(linked.body).toContain('outside any bound workspace')
  expect(linked.body).not.toContain('outside secret bytes')
})
