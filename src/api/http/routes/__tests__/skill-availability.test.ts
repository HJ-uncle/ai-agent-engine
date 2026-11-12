import fs from 'node:fs'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { skillImportRoutes } from '../skill-imports.js'
import { skillsRegistry } from '../../../../skills/skills-registry.js'

// Exercise the real registry and HTTP contract used by the composer, without touching user skills.
const fixtureParent = path.resolve('.e2e-tmp', 'skill-availability')
const methodologySkills = [
  'os-brainstorming', 'os-subagent-driven-dev', 'os-systematic-debugging', 'os-tdd',
  'os-using-superpowers', 'os-verification-before-completion', 'os-writing-plans',
]
let root: string, project: string, app: FastifyInstance

function seedSkill(skillsRoot: string, name: string, enabled = true): void {
  const directory = path.join(skillsRoot, name)
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: Test ${name}\n---\n\nTest instructions.\n`)
  if (!enabled) fs.writeFileSync(path.join(directory, 'plugin.json'), JSON.stringify({ enabled: false }))
}

async function listSkills(query = 'available=1', workspace = project): Promise<Array<{ id: string; name: string; enabled: boolean }>> {
  const response = await app.inject({ method: 'GET', url: `/skills?path=${encodeURIComponent(workspace)}&${query}` })
  expect(response.statusCode).toBe(200)
  const body = response.json()
  expect(body.code).toBe(200)
  return body.data.list
}

beforeEach(async () => {
  fs.mkdirSync(fixtureParent, { recursive: true })
  root = fs.mkdtempSync(path.join(fixtureParent, 'fixture-'))
  project = path.join(root, 'project')
  vi.stubEnv('AUTH_ENABLED', 'false')
  vi.stubEnv('SKILLS_ROOT', path.join(root, 'deployment'))
  vi.stubEnv('AETHER_GLOBAL_DIR', path.join(root, 'global'))
  vi.stubEnv('OSM_MODE', undefined)
  vi.stubEnv('SUPERPOWER_MODE', undefined)
  vi.stubEnv('SUPERPOWER_ENABLED', undefined)
  fs.mkdirSync(path.join(root, 'deployment'), { recursive: true })
  const projectSkills = path.join(project, '.ae', 'skills')
  for (const name of [...methodologySkills, 'aether-office', 'os-custom-helper']) seedSkill(projectSkills, name)
  seedSkill(projectSkills, 'disabled-example', false)
  seedSkill(path.join(root, 'global', 'skills'), 'disabled-example')
  skillsRegistry.start()
  app = Fastify()
  await app.register(skillImportRoutes)
})

afterEach(async () => {
  await app.close()
  skillsRegistry.stop()
  vi.unstubAllEnvs()
  if (path.dirname(root) !== fixtureParent || !path.basename(root).startsWith('fixture-')) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

describe('Skill picker availability', () => {
  it.each([
    [undefined, false], ['off', false], ['balanced', false], ['methodology', true], ['max', true],
  ] as const)('mode %s exposes only enabled skills allowed by the runtime', async (mode, showMethodology) => {
    vi.stubEnv('OSM_MODE', mode)
    const names = (await listSkills()).map(skill => skill.name)
    expect(names).toContain('aether-office')
    // The policy is an exact set, not a blanket os-* prefix ban.
    expect(names).toContain('os-custom-helper')
    expect(names).not.toContain('disabled-example')
    for (const name of methodologySkills) expect(names.includes(name)).toBe(showMethodology)
  })

  it('keeps methodology and disabled entries in the management catalog', async () => {
    vi.stubEnv('OSM_MODE', 'balanced')
    for (const query of ['', 'all=1']) {
      const skills = await listSkills(query)
      expect(skills.map(skill => skill.name)).toEqual(expect.arrayContaining(methodologySkills))
      expect(skills).toContainEqual(expect.objectContaining({ name: 'disabled-example', enabled: false }))
    }
  })

  it('returns execution IDs for picker bindings while preserving management IDs', async () => {
    const pickerSkills = await listSkills()
    const runtimeSkills = skillsRegistry.getSkills(project)
    for (const skill of pickerSkills) {
      expect(runtimeSkills.some(candidate => candidate.id === skill.id || candidate.name === skill.id)).toBe(true)
    }
    expect(pickerSkills).toContainEqual(expect.objectContaining({ id: 'aether-office', name: 'aether-office' }))
    const management = await listSkills('')
    expect(management.find(skill => skill.name === 'aether-office')?.id).toMatch(/^skill-[a-f0-9]{32}$/)
  })

  it('does not resurrect an enabled global copy shadowed by a disabled project skill', async () => {
    const skills = await listSkills('available=1&all=1')
    expect(skills.map(skill => skill.name)).not.toContain('disabled-example')
  })

  it('uses the current mode when the menu reloads after a settings change', async () => {
    vi.stubEnv('OSM_MODE', 'balanced')
    expect((await listSkills('available=1&reload=1')).map(skill => skill.name)).not.toContain('os-tdd')
    vi.stubEnv('OSM_MODE', 'methodology')
    expect((await listSkills('available=1&reload=1')).map(skill => skill.name)).toContain('os-tdd')
  })

  it('loads the selected workspace without leaking another workspace\'s skills', async () => {
    const otherProject = path.join(root, 'other-project')
    seedSkill(path.join(otherProject, '.ae', 'skills'), 'other-workspace')
    const names = (await listSkills('available=1', otherProject)).map(skill => skill.name)
    expect(names).toContain('other-workspace')
    expect(names).toContain('aether-office')
    expect(names).not.toContain('os-custom-helper')
  })
})
