import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SkillsRegistry } from '../skills-registry.js'

let root: string, registry: SkillsRegistry
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-builtin-office-'))
  vi.stubEnv('SKILLS_ROOT', '')
  vi.stubEnv('AETHER_GLOBAL_DIR', path.join(root, 'global'))
  fs.mkdirSync(path.join(root, 'runtime-dist'))
  vi.spyOn(process, 'cwd').mockReturnValue(path.join(root, 'runtime-dist'))
  registry = new SkillsRegistry()
})
afterEach(() => {
  registry.stop()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  const resolved = path.resolve(root)
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('aether-builtin-office-')) throw new Error('Unsafe builtin skill fixture cleanup')
  fs.rmSync(resolved, { recursive: true, force: true })
})
function writeSkill(directory: string, content: string) {
  fs.mkdirSync(path.join(directory, 'aether-office'), { recursive: true })
  fs.writeFileSync(path.join(directory, 'aether-office', 'SKILL.md'), `---\nname: aether-office\ndescription: ${content}\n---\n\n# ${content}\n`)
}

describe('packaged Office skill discovery and precedence', () => {
  it('finds the packaged skill from a cwd without project/global skill directories and loads its local guide', () => {
    registry.start()
    const skill = registry.getSkills().find(candidate => candidate.name === 'aether-office')
    expect(skill).toMatchObject({ name: 'aether-office', builtin: true, enabled: true })
    expect(fs.readFileSync(skill!.skillMdPath, 'utf8')).toContain('office_document')
    expect(fs.existsSync(path.join(path.dirname(skill!.skillMdPath), 'references', 'documents.md'))).toBe(true)
    const separate = path.join(root, 'other-workspace')
    fs.mkdirSync(separate)
    expect(registry.getSkills(separate).find(candidate => candidate.name === 'aether-office')).toMatchObject({ builtin: true })
  })

  it('preserves explicit start(root) isolation even when no skill exists there', () => {
    const explicit = path.join(root, 'explicit')
    fs.mkdirSync(explicit)
    registry.start(explicit)
    expect(registry.getSkills()).toEqual([])
    expect(registry.getSkills(path.join(root, 'other-workspace'))).toEqual([])
  })

  it('lets a disabled project copy shadow the packaged fallback without resurrection', () => {
    const project = path.join(root, 'project'), directory = path.join(project, '.ae', 'skills')
    writeSkill(directory, 'Project-specific office')
    fs.writeFileSync(path.join(directory, 'skills.config.json'), JSON.stringify({ defaults: { 'aether-office': { enabled: false } } }))
    registry.start()
    expect(registry.getSkills(project).find(candidate => candidate.name === 'aether-office')).toBeUndefined()
    const disabled = registry.getAllSkills(project).find(candidate => candidate.name === 'aether-office')
    expect(disabled).toMatchObject({ enabled: false, scope: 'project', description: 'Project-specific office' })
    expect(disabled!.builtin).toBeUndefined()
    expect(registry.getSkills().find(candidate => candidate.name === 'aether-office')).toMatchObject({ enabled: true, builtin: true })
  })

  it('honors an environment deployment layer and a higher-priority user global override', () => {
    const environment = path.join(root, 'deployment')
    writeSkill(environment, 'Deployment office')
    writeSkill(path.join(root, 'global', 'skills'), 'User office')
    vi.stubEnv('SKILLS_ROOT', environment)
    registry.start()
    // Default-cwd legacy precedence keeps the explicit deployment layer above
    // global. Request-scoped workspace layering gives user global its existing
    // override position; packaged fallback remains lowest in both cases.
    expect(registry.getSkills().filter(skill => skill.name === 'aether-office')).toMatchObject([{ description: 'Deployment office' }])
    expect(registry.getSkills(path.join(root, 'project')).filter(skill => skill.name === 'aether-office')).toMatchObject([{ description: 'User office' }])
  })
})
