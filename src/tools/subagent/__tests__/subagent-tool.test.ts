import { describe, it, expect, vi, beforeEach } from 'vitest'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

/**
 * subagent-tool — role 参数相关测试
 *
 * 关注点：
 *   1. `__loadRoleTemplateForTests` 按 role 定位 skill 目录下的 `<role>-prompt.md`
 *   2. 找不到 skill / 找不到文件 / 空文件 → 返回 null
 *   3. 真实仓库 skill 文件可被解析（基于 `skills/superpower-subagent-driven-dev`）
 *   4. Tool schema 将 role 参数限制为白名单三值
 *   5. execute 对非法 role 立即失败（不进入 LLM 流程）
 */

const mockSkills: Array<{ name: string; skillMdPath: string }> = []
vi.mock('../../../skills/index.js', () => ({
  skillsRegistry: { getSkills: () => mockSkills },
}))

import {
  subagentTool,
  ROLE_VALUES,
  __loadRoleTemplateForTests,
  type SubagentRole,
} from '../subagent-tool.js'

let tmpDir: string

beforeEach(() => {
  mockSkills.length = 0
  if (tmpDir && fs.existsSync(tmpDir)) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  }
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-role-'))
})

// ──────────────────────────────────────────────────────────────────────────
describe('subagent-tool / ROLE_VALUES', () => {
  it('三个预设角色按约定值暴露', () => {
    expect(ROLE_VALUES).toEqual(['implementer', 'spec-reviewer', 'code-quality-reviewer'])
  })

  it('Tool schema 的 role enum 与 ROLE_VALUES 对齐', () => {
    const schema = subagentTool.parameters as any
    expect(schema.properties.role.enum).toEqual([...ROLE_VALUES])
    expect(schema.properties.task.type).toBe('string')
    expect(schema.required).toContain('task')
    expect(schema.required).not.toContain('role')
  })
})

// ──────────────────────────────────────────────────────────────────────────
describe('subagent-tool / __loadRoleTemplateForTests', () => {
  function installFakeSkill(content: string, filename = 'implementer-prompt.md') {
    const skillDir = path.join(tmpDir, 'superpower-subagent-driven-dev')
    fs.mkdirSync(skillDir, { recursive: true })
    const skillMd = path.join(skillDir, 'SKILL.md')
    fs.writeFileSync(skillMd, '# fake skill')
    fs.writeFileSync(path.join(skillDir, filename), content)
    mockSkills.push({
      name: 'superpower-subagent-driven-dev',
      skillMdPath: skillMd,
    })
  }

  it('skill 未注册 → null', () => {
    expect(__loadRoleTemplateForTests('implementer')).toBeNull()
  })

  it('skill 注册但对应 role prompt 文件缺失 → null', () => {
    const skillDir = path.join(tmpDir, 'superpower-subagent-driven-dev')
    fs.mkdirSync(skillDir, { recursive: true })
    const skillMd = path.join(skillDir, 'SKILL.md')
    fs.writeFileSync(skillMd, '# fake')
    mockSkills.push({ name: 'superpower-subagent-driven-dev', skillMdPath: skillMd })

    expect(__loadRoleTemplateForTests('spec-reviewer')).toBeNull()
  })

  it('prompt 文件存在且非空 → 返回原文', () => {
    installFakeSkill('YOU ARE IMPLEMENTER\n- TDD only', 'implementer-prompt.md')
    const tpl = __loadRoleTemplateForTests('implementer')
    expect(tpl).toContain('YOU ARE IMPLEMENTER')
    expect(tpl).toContain('TDD only')
  })

  it('prompt 文件为空白 → null（避免注入空 preamble）', () => {
    installFakeSkill('   \n  \t\n', 'implementer-prompt.md')
    expect(__loadRoleTemplateForTests('implementer')).toBeNull()
  })

  it('三个 role 分别定位各自的 <role>-prompt.md', () => {
    const skillDir = path.join(tmpDir, 'superpower-subagent-driven-dev')
    fs.mkdirSync(skillDir, { recursive: true })
    const skillMd = path.join(skillDir, 'SKILL.md')
    fs.writeFileSync(skillMd, '# fake')
    fs.writeFileSync(path.join(skillDir, 'implementer-prompt.md'), 'A')
    fs.writeFileSync(path.join(skillDir, 'spec-reviewer-prompt.md'), 'B')
    fs.writeFileSync(path.join(skillDir, 'code-quality-reviewer-prompt.md'), 'C')
    mockSkills.push({ name: 'superpower-subagent-driven-dev', skillMdPath: skillMd })

    expect(__loadRoleTemplateForTests('implementer')).toBe('A')
    expect(__loadRoleTemplateForTests('spec-reviewer')).toBe('B')
    expect(__loadRoleTemplateForTests('code-quality-reviewer')).toBe('C')
  })

  it('通过目录名定位（skill.name 不匹配时按 skillMdPath 父目录名定位）', () => {
    const skillDir = path.join(tmpDir, 'superpower-subagent-driven-dev')
    fs.mkdirSync(skillDir, { recursive: true })
    const skillMd = path.join(skillDir, 'SKILL.md')
    fs.writeFileSync(skillMd, '# fake')
    fs.writeFileSync(path.join(skillDir, 'implementer-prompt.md'), 'OK')
    mockSkills.push({ name: 'some-other-display-name', skillMdPath: skillMd })

    expect(__loadRoleTemplateForTests('implementer')).toBe('OK')
  })
})

// ──────────────────────────────────────────────────────────────────────────
describe('subagent-tool / execute 输入校验', () => {
  const fakeCtx: any = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => fakeCtx.logger },
    tokenBudget: 10000,
    signal: undefined,
    tenantId: 't',
  }

  it('非法 role 立即返回错误（不进入 LLM / registry 初始化）', async () => {
    const result = await subagentTool.execute(
      { task: 'noop', role: 'hacker' as unknown as SubagentRole },
      fakeCtx,
    )
    expect(result.success).toBe(false)
    expect(String(result.output)).toContain("未知 role 'hacker'")
    expect(String(result.output)).toContain('implementer')
  })
})
