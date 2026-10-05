import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveSkillRoot } from '../run-skill-script.js'

const originalGlobal = process.env.AETHER_GLOBAL_DIR
const originalSkills = process.env.SKILLS_ROOT

afterEach(() => {
  if (originalGlobal === undefined) delete process.env.AETHER_GLOBAL_DIR
  else process.env.AETHER_GLOBAL_DIR = originalGlobal
  if (originalSkills === undefined) delete process.env.SKILLS_ROOT
  else process.env.SKILLS_ROOT = originalSkills
})

describe('run_skill_script skill roots', () => {
  it('finds a project skill before env/global fallback', () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-project-'))
    const global = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-global-'))
    try {
      const projectRoot = path.join(project, '.aether', 'skills')
      const globalRoot = path.join(global, 'skills')
      fs.mkdirSync(path.join(projectRoot, 'project-skill', 'scripts'), { recursive: true })
      fs.mkdirSync(path.join(globalRoot, 'global-skill', 'scripts'), { recursive: true })
      fs.writeFileSync(path.join(projectRoot, 'project-skill', 'scripts', 'echo.sh'), 'printf project', 'utf8')
      fs.writeFileSync(path.join(globalRoot, 'global-skill', 'scripts', 'echo.sh'), 'printf global', 'utf8')
      process.env.SKILLS_ROOT = path.join(global, 'missing-builtins')
      process.env.AETHER_GLOBAL_DIR = global
      expect(resolveSkillRoot('bash "$SKILLS_ROOT/project-skill/scripts/echo.sh"', project)).toBe(projectRoot)
    } finally {
      fs.rmSync(project, { recursive: true, force: true })
      fs.rmSync(global, { recursive: true, force: true })
    }
  })

  it('falls back to the global imported skill when the project has no copy', () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-project-'))
    const global = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-global-'))
    try {
      const globalRoot = path.join(global, 'skills')
      fs.mkdirSync(path.join(globalRoot, 'global-skill', 'scripts'), { recursive: true })
      fs.writeFileSync(path.join(globalRoot, 'global-skill', 'scripts', 'echo.sh'), 'printf global', 'utf8')
      process.env.SKILLS_ROOT = path.join(project, 'missing-builtins')
      process.env.AETHER_GLOBAL_DIR = global
      expect(resolveSkillRoot('bash "$SKILLS_ROOT/global-skill/scripts/echo.sh"', project)).toBe(globalRoot)
    } finally {
      fs.rmSync(project, { recursive: true, force: true })
      fs.rmSync(global, { recursive: true, force: true })
    }
  })
})
