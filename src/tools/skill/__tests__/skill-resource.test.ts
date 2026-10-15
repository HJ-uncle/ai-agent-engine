import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ExternalSkill } from '../../../skills/external-loader.js'
import type { AgentContext } from '../../../core/agent-context/index.js'
import { readSkillResource } from '../skill-resource.js'
import { createSkillTools } from '../index.js'

let root: string, skill: ExternalSkill
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-skill-resource-'))
  const directory = path.join(root, 'office')
  fs.mkdirSync(path.join(directory, 'references'), { recursive: true })
  fs.writeFileSync(path.join(directory, 'SKILL.md'), '# Main instruction\n')
  fs.writeFileSync(path.join(directory, 'references', 'documents.md'), '# Word reference\n真实内容\n')
  skill = { name: 'aether-office', description: 'fixture', skillMdPath: path.join(directory, 'SKILL.md'), enabled: true, order: 0 }
})
afterEach(() => {
  const resolved = path.resolve(root)
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('aether-skill-resource-')) throw new Error('Unsafe skill reference fixture cleanup')
  fs.rmSync(resolved, { recursive: true, force: true })
})

describe('selected skill reference reads without workspace expansion', () => {
  it('reads only a selected skill reference and retains the default get_skill body contract', async () => {
    const tool = createSkillTools([skill]).find(candidate => candidate.name === 'get_skill')!
    const ctx = {} as AgentContext
    const main = await tool.execute({ name: skill.name }, ctx)
    expect(main).toMatchObject({ success: true, output: '# Main instruction\n' })
    const reference = await tool.execute({ name: skill.name, resource: 'references/documents.md' }, ctx)
    expect(reference).toMatchObject({ success: true, output: '# Word reference\n真实内容\n', metadata: { skill: skill.name, resource: 'references/documents.md' } })
    expect(readSkillResource([], skill.name, 'references/documents.md').success).toBe(false)
  })

  it.each(['../SKILL.md', '/references/documents.md', 'C:/private.md', 'references/../../private.md', 'references/./documents.md', 'references\\documents.md', 'references/run.js', 'SKILL.md'])('blocks disallowed relative resource %s', resource => {
    const result = readSkillResource([skill], skill.name, resource)
    expect(result).toMatchObject({ success: false, error: 'SKILL_RESOURCE_UNAVAILABLE' })
    expect(result.output).not.toContain('真实内容')
  })

  it('blocks an in-directory symlink which escapes the selected skill root', () => {
    fs.writeFileSync(path.join(root, 'private.md'), 'must not be exposed')
    fs.mkdirSync(path.join(root, 'outside'))
    fs.writeFileSync(path.join(root, 'outside', 'secret.md'), 'must not be exposed')
    fs.symlinkSync(path.join(root, 'outside'), path.join(path.dirname(skill.skillMdPath), 'references', 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    const result = readSkillResource([skill], skill.name, 'references/escape/secret.md')
    expect(result).toMatchObject({ success: false })
    expect(result.output).not.toContain('must not be exposed')
  })

  it('rejects oversized and invalid-UTF8 references and inline skills without a real local root', () => {
    const dir = path.join(path.dirname(skill.skillMdPath), 'references')
    fs.writeFileSync(path.join(dir, 'large.md'), Buffer.alloc(128 * 1024 + 1, 'x'))
    fs.writeFileSync(path.join(dir, 'invalid.md'), Buffer.from([0xff, 0xfe]))
    expect(readSkillResource([skill], skill.name, 'references/large.md').success).toBe(false)
    expect(readSkillResource([skill], skill.name, 'references/invalid.md').success).toBe(false)
    expect(readSkillResource([{ ...skill, skillMdPath: '', inlineContent: '# Inline' }], skill.name, 'references/documents.md').success).toBe(false)
    expect(readSkillResource([{ ...skill, inlineContent: '# Overridden' }], skill.name, 'references/documents.md').success).toBe(false)
  })
})
