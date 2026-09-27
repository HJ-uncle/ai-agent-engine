import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { loadExternalSkills } from '../external-loader.js'

describe('loadExternalSkills / plugin.json', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-plugin-json-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('should prefer plugin.json metadata over SKILL.md frontmatter', () => {
    const skillDir = path.join(tmpDir, 'test-skill')
    fs.mkdirSync(skillDir, { recursive: true })

    fs.writeFileSync(
      path.join(skillDir, 'plugin.json'),
      JSON.stringify({
        id: 'plugin-id',
        name: 'Plugin Name',
        description: 'Plugin Description',
        version: '2.0.0',
        author: 'Alice'
      })
    )

    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: Frontmatter Name\ndescription: Frontmatter Description\nversion: 1.0.0\nauthor: Bob\n---\n# Test\n'
    )

    const skills = loadExternalSkills(tmpDir)
    expect(skills).toHaveLength(1)
    expect(skills[0].id).toBe('plugin-id')
    expect(skills[0].name).toBe('Plugin Name')
    expect(skills[0].description).toBe('Plugin Description')
    expect(skills[0].version).toBe('2.0.0')
    expect(skills[0].author).toBe('Alice')
  })

  it('should use SKILL.md frontmatter if plugin.json fields are missing', () => {
    const skillDir = path.join(tmpDir, 'test-skill-2')
    fs.mkdirSync(skillDir, { recursive: true })

    fs.writeFileSync(
      path.join(skillDir, 'plugin.json'),
      JSON.stringify({
        id: 'plugin-id'
      })
    )

    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: Frontmatter Name\ndescription: Frontmatter Description\nversion: 1.0.0\nauthor: Bob\n---\n# Test\n'
    )

    const skills = loadExternalSkills(tmpDir)
    expect(skills).toHaveLength(1)
    expect(skills[0].id).toBe('plugin-id')
    expect(skills[0].name).toBe('Frontmatter Name')
    expect(skills[0].description).toBe('Frontmatter Description')
    expect(skills[0].version).toBe('1.0.0')
    expect(skills[0].author).toBe('Bob')
  })

  it('should load skill even if SKILL.md is missing but plugin.json is present (and main is not specified)', () => {
    const skillDir = path.join(tmpDir, 'test-skill-3')
    fs.mkdirSync(skillDir, { recursive: true })

    fs.writeFileSync(
      path.join(skillDir, 'plugin.json'),
      JSON.stringify({
        id: 'plugin-id-3',
        name: 'No SKILL.md'
      })
    )

    const skills = loadExternalSkills(tmpDir)
    expect(skills).toHaveLength(1)
    expect(skills[0].name).toBe('No SKILL.md')
    expect(skills[0].skillMdPath).toBe(path.join(skillDir, 'SKILL.md'))
  })
})
