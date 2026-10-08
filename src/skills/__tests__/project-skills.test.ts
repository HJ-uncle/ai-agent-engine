/** Project skill storage: .ae writes, non-destructive legacy reads and script resolution. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { SkillsRegistry } from '../skills-registry.js'
import { loadProjectSkills, withProjectSkillDeletion } from '../project-skills.js'
import { resolveSkillsRoot } from '../import-pipeline.js'
import { resolveSkillRoot } from '../../tools/skill/run-skill-script.js'

let root: string
let registry: SkillsRegistry

function skill(directory: string, name: string, description = directory): string {
  const target = path.join(root, directory, name, 'SKILL.md')
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, '---\nname: ' + name + '\ndescription: ' + description + '\n---\n\nContent\n')
  return target
}

beforeEach(() => {
  root = path.resolve('.e2e-tmp', 'project-skills-' + randomUUID())
  fs.mkdirSync(root, { recursive: true })
  vi.stubEnv('AETHER_GLOBAL_DIR', path.join(root, 'global'))
  vi.stubEnv('SKILLS_ROOT', '')
  registry = new SkillsRegistry()
})
afterEach(() => {
  registry.stop()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  const allowed = path.resolve('.e2e-tmp') + path.sep
  if (!root.startsWith(allowed)) throw new Error('Unsafe project skill fixture')
  fs.rmSync(root, { recursive: true, force: true })
})

describe('project skills use .ae without displacing existing project files', () => {
  it('new default writes ignore existing legacy roots while explicit deployment paths remain honored', () => {
    skill('.aether/skills', 'old')
    skill('SKILLs', 'older')
    vi.spyOn(process, 'cwd').mockReturnValue(root)
    expect(resolveSkillsRoot()).toBe(path.join(root, '.ae', 'skills'))
    vi.stubEnv('SKILLS_ROOT', path.join(root, 'custom'))
    expect(resolveSkillsRoot()).toBe(path.join(root, 'custom'))
  })

  it('merges all three roots with .ae priority and preserves legacy-only skills', () => {
    skill('SKILLs', 'oldest')
    skill('SKILLs', 'same', 'root legacy')
    skill('.aether/skills', 'older')
    skill('.aether/skills', 'same', 'aether legacy')
    const modern = skill('.ae/skills', 'same', 'modern')
    const rows = registry.getAllSkillsByScope(root, 'project')
    expect(rows.map((entry) => entry.name).sort()).toEqual(['older', 'oldest', 'same'])
    expect(rows.find((entry) => entry.name === 'same')?.skillMdPath).toBe(modern)
    expect(fs.readFileSync(path.join(root, '.aether/skills/same/SKILL.md'), 'utf8')).toContain('aether legacy')
  })

  it('a disabled .ae copy shadows enabled legacy copies and legacy toggles use .ae overrides', () => {
    skill('.aether/skills', 'same')
    skill('.aether/skills', 'legacy-only')
    skill('.ae/skills', 'same')
    const config = path.join(root, '.ae/skills/skills.config.json')
    fs.writeFileSync(config, JSON.stringify({ defaults: { same: { enabled: false }, 'legacy-only': { enabled: false } } }))
    expect(registry.getSkills(root).map((entry) => entry.name)).not.toContain('same')
    expect(loadProjectSkills(root).find((entry) => entry.name === 'legacy-only')?.enabled).toBe(false)
    fs.writeFileSync(config, JSON.stringify({ defaults: { 'legacy-only': { enabled: true } } }))
    expect(loadProjectSkills(root).find((entry) => entry.name === 'legacy-only')?.enabled).toBe(true)
    expect(fs.existsSync(path.join(root, '.aether/skills/skills.config.json'))).toBe(false)
  })

  it('adopts a newly created .ae root after startup without losing the old skill layer', () => {
    skill('.aether/skills', 'before')
    vi.spyOn(process, 'cwd').mockReturnValue(root)
    registry.start()
    expect(registry.count).toBe(1)
    skill('.ae/skills', 'after')
    expect(registry.getSkills().map((entry) => entry.name).sort()).toEqual(['after', 'before'])
  })


  it('failed physical deletion restores the exact previous configuration and keeps the skill visible', () => {
    skill('.aether/skills', 'legacy-delete')
    const configPath = path.join(root, '.ae/skills/skills.config.json')
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    const before = '{"defaults": {"legacy-delete": {"enabled": true}}}\n'
    fs.writeFileSync(configPath, before)
    expect(() => withProjectSkillDeletion(root, 'legacy-delete', () => { throw new Error('locked') })).toThrow('locked')
    expect(fs.readFileSync(configPath, 'utf8')).toBe(before)
    expect(loadProjectSkills(root).map((entry) => entry.name)).toEqual(['legacy-delete'])
  })

  it('script resolution selects modern copies and still finds legacy-only scripts', () => {
    skill('SKILLs', 'oldest')
    skill('.aether/skills', 'old')
    skill('.aether/skills', 'same')
    skill('.ae/skills', 'same')
    expect(resolveSkillRoot('bash "$SKILLS_ROOT/same/scripts/run.sh"', root)).toBe(path.join(root, '.ae/skills'))
    expect(resolveSkillRoot('bash "$SKILLS_ROOT/old/scripts/run.sh"', root)).toBe(path.join(root, '.aether/skills'))
    expect(resolveSkillRoot('bash "$SKILLS_ROOT/oldest/scripts/run.sh"', root)).toBe(path.join(root, 'SKILLs'))
  })
})
