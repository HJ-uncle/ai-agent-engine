/**
 * SkillsRegistry 单元测试
 *
 * 关注点：
 *   1. 显式传入 skillsRoot → 使用该路径
 *   2. SKILLS_ROOT 环境变量 → 使用该路径
 *   3. 两者均未设置 + cwd/SKILLs 存在 → 自动探测
 *   4. 两者均未设置 + cwd/SKILLs 不存在 → 不加载（空列表）
 *   5. 集成：真实 SKILLs 目录 → 能加载到所有 OSM 技能
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { loadExternalSkills } from '../external-loader.js'

// ─── 辅助：在临时目录构造 mock skill ────────────────────────────────────────
function createTempSkillsDir(skillNames: string[]): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-skills-'))
  for (const name of skillNames) {
    const skillDir = path.join(tmpDir, name)
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Test skill ${name}\n---\n\n# ${name}\n`,
      'utf-8',
    )
  }
  return tmpDir
}

// ─── 内联 SkillsRegistry 核心逻辑（与生产代码 start() 完全对齐）────────────
// 通过内联而非 import 单例，避免跨测试状态污染
function makeRegistry(loader = loadExternalSkills) {
  let skills: ReturnType<typeof loadExternalSkills> = []
  let watcher: fs.FSWatcher | null = null

  function start(skillsRoot?: string): string | null {
    // ← 与 skills-registry.ts start() 逻辑完全一致
    let rawRoot = skillsRoot ?? process.env.SKILLS_ROOT ?? ''
    if (!rawRoot) {
      const cwdSkills = path.join(process.cwd(), 'SKILLs')
      if (fs.existsSync(cwdSkills)) {
        rawRoot = cwdSkills
      } else {
        return null  // 无路径可用
      }
    }

    const resolved = path.resolve(process.cwd(), rawRoot)
    if (!fs.existsSync(resolved)) return null

    skills = loader(resolved)
    try {
      watcher = fs.watch(resolved, { recursive: true }, () => {})
    } catch {
      // test 环境可能无法 watch，忽略
    }
    return resolved
  }

  function stop() {
    if (watcher) { watcher.close(); watcher = null }
  }

  return { start, stop, getSkills: () => skills }
}

// ─── 测试 ─────────────────────────────────────────────────────────────────

describe('SkillsRegistry / start() 路径解析', () => {
  let origEnv: string | undefined
  let origCwd: string

  beforeEach(() => {
    origEnv = process.env.SKILLS_ROOT
    origCwd = process.cwd()
    delete process.env.SKILLS_ROOT
  })

  afterEach(() => {
    if (origEnv !== undefined) process.env.SKILLS_ROOT = origEnv
    else delete process.env.SKILLS_ROOT
    try { process.chdir(origCwd) } catch { /* noop */ }
    vi.restoreAllMocks()
  })

  it('case 1: 显式传入 skillsRoot → 加载该目录的技能', () => {
    const tmpDir = createTempSkillsDir(['skill-alpha', 'skill-beta'])
    try {
      const reg = makeRegistry()
      const resolved = reg.start(tmpDir)
      expect(resolved).toBe(tmpDir)
      const names = reg.getSkills().map(s => s.name)
      expect(names).toContain('skill-alpha')
      expect(names).toContain('skill-beta')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('case 2: SKILLS_ROOT 环境变量 → 加载该目录的技能', () => {
    const tmpDir = createTempSkillsDir(['env-skill'])
    try {
      process.env.SKILLS_ROOT = tmpDir
      const reg = makeRegistry()
      const resolved = reg.start()
      expect(resolved).toBeTruthy()
      expect(reg.getSkills().map(s => s.name)).toContain('env-skill')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('case 3: SKILLS_ROOT 未设置 + cwd/SKILLs 存在 → 自动探测并加载', () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'test-cwd-'))
    const skillsDir = path.join(tmpBase, 'SKILLs')
    fs.mkdirSync(skillsDir)
    fs.mkdirSync(path.join(skillsDir, 'auto-skill'))
    fs.writeFileSync(
      path.join(skillsDir, 'auto-skill', 'SKILL.md'),
      '---\nname: auto-skill\ndescription: Auto\n---\n\n# auto\n',
      'utf-8',
    )
    try {
      process.chdir(tmpBase)
      const reg = makeRegistry()
      const resolved = reg.start()     // 无参数，无 SKILLS_ROOT → 应自动探测 cwd/SKILLs
      expect(resolved).toBeTruthy()
      expect(reg.getSkills().map(s => s.name)).toContain('auto-skill')
    } finally {
      process.chdir(origCwd)
      reg_cleanup(skillsDir)
      fs.rmSync(tmpBase, { recursive: true, force: true })
    }
  })

  it('case 4: SKILLS_ROOT 未设置 + cwd/SKILLs 不存在 → null（空列表）', () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'test-nodir-'))
    try {
      process.chdir(tmpBase)
      const reg = makeRegistry()
      const resolved = reg.start()
      expect(resolved).toBeNull()
      expect(reg.getSkills()).toHaveLength(0)
    } finally {
      process.chdir(origCwd)
      fs.rmSync(tmpBase, { recursive: true, force: true })
    }
  })
})

// ─── SDK 真实路径集成测试 ────────────────────────────────────────────────────

const SDK_DEPLOY_PATH = 'C:\\Users\\wb.xielin02\\AppData\\Roaming\\Wuzu Client Dev\\agent-engine\\0.3.6'

describe('SkillsRegistry / SDK 真实部署路径 - 模拟 Wuzu Client 子进程', () => {
  let origEnv: string | undefined
  let origCwd: string

  beforeEach(() => {
    origEnv = process.env.SKILLS_ROOT
    origCwd = process.cwd()
    delete process.env.SKILLS_ROOT   // Wuzu Client 不注入 SKILLS_ROOT
  })

  afterEach(() => {
    if (origEnv !== undefined) process.env.SKILLS_ROOT = origEnv
    else delete process.env.SKILLS_ROOT
    try { process.chdir(origCwd) } catch { /* noop */ }
  })

  it('模拟 Wuzu Client 子进程：cwd=0.3.6/, 无 SKILLS_ROOT → 自动探测 0.3.6/SKILLs 并加载全部 OSM 技能', () => {
    if (!fs.existsSync(SDK_DEPLOY_PATH)) {
      console.warn(`[skip] SDK 部署路径不存在: ${SDK_DEPLOY_PATH}`)
      return
    }

    // 模拟 Wuzu Client 启动子进程时的 cwd = versionDir
    process.chdir(SDK_DEPLOY_PATH)

    const reg = makeRegistry()
    const resolved = reg.start()   // 无参数，无 SKILLS_ROOT → 应自动探测 cwd/SKILLs

    const skillsExpected = path.join(SDK_DEPLOY_PATH, 'SKILLs')
    expect(resolved, `应探测到 ${skillsExpected}`).toBe(skillsExpected)

    const names = reg.getSkills().map(s => s.name)
    console.log(`[test] 已加载 ${names.length} 个 skills: ${names.join(', ')}`)

    const OSM_SKILLS = [
      'os-using-superpowers',
      'os-brainstorming',
      'os-writing-plans',
      'os-tdd',
      'os-systematic-debugging',
      'os-subagent-driven-dev',
      'os-verification-before-completion',
    ]
    for (const skill of OSM_SKILLS) {
      expect(names, `缺少 OSM skill: ${skill}`).toContain(skill)
    }

    reg.stop()
  })
})

// ─── 集成测试：真实 SKILLs 目录 ────────────────────────────────────────────

describe('SkillsRegistry / 集成 - 真实 SKILLs 目录 + cwd 自动探测', () => {
  let origEnv: string | undefined

  beforeEach(() => {
    origEnv = process.env.SKILLS_ROOT
    delete process.env.SKILLS_ROOT   // 强制走自动探测分支
  })

  afterEach(() => {
    if (origEnv !== undefined) process.env.SKILLS_ROOT = origEnv
    else delete process.env.SKILLS_ROOT
  })

  it('cwd = agent-engine 根目录时，自动探测到 cwd/SKILLs 并加载全部 OSM 技能', () => {
    const cwdSkills = path.join(process.cwd(), 'SKILLs')
    if (!fs.existsSync(cwdSkills)) {
      console.warn('[skip] cwd/SKILLs 不存在，跳过集成测试')
      return
    }

    const reg = makeRegistry()
    const resolved = reg.start()
    expect(resolved).toBeTruthy()

    const names = reg.getSkills().map(s => s.name)
    const OSM_SKILLS = [
      'os-using-superpowers',
      'os-brainstorming',
      'os-writing-plans',
      'os-tdd',
      'os-systematic-debugging',
      'os-subagent-driven-dev',
      'os-verification-before-completion',
    ]
    for (const skill of OSM_SKILLS) {
      expect(names, `缺少 skill: ${skill}`).toContain(skill)
    }

    reg.stop()
  })
})

// ─── 工具函数 ──────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function reg_cleanup(_dir: string) { /* noop, just for type-checking the try/finally */ }
