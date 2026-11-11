import fs from 'node:fs'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { skillImportRoutes } from '../skill-imports.js'
import { skillsRegistry } from '../../../../skills/skills-registry.js'
import { hashFileContent } from '../../../../shared/file-version.js'

const fixtureParent = path.resolve('.e2e-tmp', 'skill-editing')
let root: string, project: string, app: FastifyInstance
let principal: { tenantId: string; method: 'jwt'; roles: string[] } | undefined
const content = (body = 'Original') => `---\nname: example\ndescription: Test\n---\n\n${body}\n`
const dir = () => path.join(project, '.ae', 'skills', 'example')
const url = (name = 'example') => `/skills/${name}?path=${encodeURIComponent(project)}&scope=project`
function seed() {
  fs.mkdirSync(path.join(dir(), 'assets'), { recursive: true })
  fs.writeFileSync(path.join(dir(), 'SKILL.md'), content())
  fs.writeFileSync(path.join(dir(), 'script.py'), 'print("kept")')
  fs.writeFileSync(path.join(dir(), 'assets', 'image.png'), Buffer.from([1, 2, 3]))
}
beforeEach(async () => {
  fs.mkdirSync(fixtureParent, { recursive: true })
  root = fs.mkdtempSync(path.join(fixtureParent, 'fixture-'))
  project = path.join(root, 'project'); fs.mkdirSync(project)
  vi.stubEnv('AUTH_ENABLED', 'false')
  vi.stubEnv('SKILLS_ROOT', path.join(root, 'deployment'))
  vi.stubEnv('AETHER_GLOBAL_DIR', path.join(root, 'global'))
  vi.spyOn(skillsRegistry, 'reload').mockImplementation(() => {})
  app = Fastify()
  principal = undefined
  app.addHook('onRequest', async request => { (request as any).authContext = principal })
  await app.register(skillImportRoutes)
})
afterEach(async () => {
  await app.close()
  skillsRegistry.stop()
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (path.dirname(root) !== fixtureParent || !path.basename(root).startsWith('fixture-')) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

describe('Skill editing HTTP API', () => {
  it('GET returns an exact content hash and PUT edits only the document', async () => {
    seed()
    const detail = (await app.inject({ method: 'GET', url: url() })).json()
    expect(detail.code).toBe(200)
    expect(detail.data.hash).toBe(hashFileContent(content()))
    const response = (await app.inject({ method: 'PUT', url: url(detail.data.id), payload: {
      content: content('Edited'), expectedHash: detail.data.hash,
    } })).json()
    expect(response.code).toBe(200)
    expect(response.data).toMatchObject({ content: content('Edited'), hash: hashFileContent(content('Edited')),
      resourceChange: { kind: 'skill', action: 'update', id: detail.data.id } })
    expect(fs.readFileSync(path.join(dir(), 'script.py'), 'utf8')).toBe('print("kept")')
    expect(fs.readFileSync(path.join(dir(), 'assets', 'image.png'))).toEqual(Buffer.from([1, 2, 3]))
  })

  it('PUT rejects stale or missing hashes and leaves the current document intact', async () => {
    seed()
    const changed = content('External edit')
    fs.writeFileSync(path.join(dir(), 'SKILL.md'), changed)
    const stale = (await app.inject({ method: 'PUT', url: url(), payload: { content: content('Stale edit'), expectedHash: hashFileContent(content()) } })).json()
    expect(stale.code).toBe(40900)
    const missing = (await app.inject({ method: 'PUT', url: url(), payload: { content: content('Missing hash') } })).json()
    expect(missing.code).toBe(40001)
    expect(fs.readFileSync(path.join(dir(), 'SKILL.md'), 'utf8')).toBe(changed)
  })

  it('POST overwrite requires a revision and preserves the package files', async () => {
    seed()
    const args = { name: 'example', description: 'New description', content: '# New body', overwrite: true, projectRoot: project }
    expect((await app.inject({ method: 'POST', url: '/skills', payload: args })).json().code).toBe(40001)
    expect(fs.readFileSync(path.join(dir(), 'SKILL.md'), 'utf8')).toBe(content())
    const edited = (await app.inject({ method: 'POST', url: '/skills', payload: { ...args, expectedHash: hashFileContent(content()) } })).json()
    expect(edited.code).toBe(200)
    expect(edited.data.resourceChange.action).toBe('update')
    expect(fs.readFileSync(path.join(dir(), 'SKILL.md'), 'utf8')).toContain('# New body')
    expect(fs.readFileSync(path.join(dir(), 'script.py'), 'utf8')).toBe('print("kept")')
    expect(fs.existsSync(path.join(dir(), 'assets', 'image.png'))).toBe(true)
    expect(fs.existsSync(path.join(path.dirname(dir()), '.versions'))).toBe(false)
  })

  it('POST creates in the selected project and returns the initial content hash', async () => {
    const created = (await app.inject({ method: 'POST', url: '/skills', payload: {
      name: 'example', description: 'New\ndescription', content: '# Body', projectRoot: project,
    } })).json()
    expect(created.code).toBe(200)
    expect(created.data.dir).toBe(dir())
    expect(created.data.hash).toBe(hashFileContent(fs.readFileSync(path.join(dir(), 'SKILL.md'))))
    expect(fs.readFileSync(path.join(dir(), 'SKILL.md'), 'utf8')).toContain('description: New description')
  })

  it('PUT rejects an authenticated non-manager even when local auth is disabled', async () => {
    seed()
    principal = { tenantId: 'default', method: 'jwt', roles: [] }
    const response = (await app.inject({ method: 'PUT', url: url(), payload: { content: content('Rejected'), expectedHash: hashFileContent(content()) } })).json()
    expect(response.code).toBe(41015)
    expect(fs.readFileSync(path.join(dir(), 'SKILL.md'), 'utf8')).toBe(content())
  })

  it('PUT rejects a manifest main outside the selected skill', async () => {
    seed()
    fs.writeFileSync(path.join(dir(), 'plugin.json'), JSON.stringify({ main: '../../outside.md' }))
    const response = (await app.inject({ method: 'PUT', url: url(), payload: { content: content('Rejected'), expectedHash: hashFileContent(content()) } })).json()
    expect(response.code).toBe(40300)
    expect(fs.readFileSync(path.join(dir(), 'SKILL.md'), 'utf8')).toBe(content())
  })
})
