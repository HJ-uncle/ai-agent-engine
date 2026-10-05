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
import { skillsRegistry } from '../skills-registry.js'

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
      const aetherSkills = path.join(process.cwd(), '.aether', 'skills')
      const legacySkills = path.join(process.cwd(), 'SKILLs')
      if (fs.existsSync(aetherSkills)) {
        rawRoot = aetherSkills
      } else if (fs.existsSync(legacySkills)) {
        rawRoot = legacySkills
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

  it('case 4: SKILLS_ROOT 未设置 + .aether/skills 与 SKILLs 均不存在 → null（空列表）', () => {
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

  it('case 5: .aether/skills 与 SKILLs 并存时 → 优先探测 .aether/skills（新约定）', () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'test-aether-'))
    const aetherDir = path.join(tmpBase, '.aether', 'skills')
    const legacyDir = path.join(tmpBase, 'SKILLs')
    for (const dir of [aetherDir, legacyDir]) {
      fs.mkdirSync(path.join(dir, 'probe-skill'), { recursive: true })
      fs.writeFileSync(
        path.join(dir, 'probe-skill', 'SKILL.md'),
        '---\nname: probe-skill\ndescription: Probe\n---\n\n# probe\n',
        'utf-8',
      )
    }
    try {
      process.chdir(tmpBase)
      const reg = makeRegistry()
      const resolved = reg.start()
      // macOS 的 os.tmpdir() 是 /var/... 符号链接，chdir 后 cwd 会规范化为 /private/var/...
      expect(resolved).toBe(fs.realpathSync(aetherDir))
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

  it('cwd = 仓库根目录时，自动探测到 .aether/skills（旧 SKILLs/ 回退）并加载全部 OSM 技能', () => {
    const aetherSkills = path.join(process.cwd(), '.aether', 'skills')
    const legacySkills = path.join(process.cwd(), 'SKILLs')
    if (!fs.existsSync(aetherSkills) && !fs.existsSync(legacySkills)) {
      console.warn('[skip] .aether/skills 与 SKILLs 均不存在，跳过集成测试')
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

describe('SkillsRegistry / env builtins + global/project precedence', () => {
  let originalSkillsRoot: string | undefined
  let originalGlobalDir: string | undefined

  afterEach(() => {
    skillsRegistry.stop()
    if (originalSkillsRoot === undefined) delete process.env.SKILLS_ROOT
    else process.env.SKILLS_ROOT = originalSkillsRoot
    if (originalGlobalDir === undefined) delete process.env.AETHER_GLOBAL_DIR
    else process.env.AETHER_GLOBAL_DIR = originalGlobalDir
  })

  it('SKILLS_ROOT 内置层不阻止全局导入层被采纳', () => {
    originalSkillsRoot = process.env.SKILLS_ROOT
    originalGlobalDir = process.env.AETHER_GLOBAL_DIR
    const envRoot = createTempSkillsDir(['env-built-in'])
    const globalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-global-'))
    const globalRoot = path.join(globalDir, 'skills')
    fs.mkdirSync(path.join(globalRoot, 'global-skill'), { recursive: true })
    fs.writeFileSync(path.join(globalRoot, 'global-skill', 'SKILL.md'), '---\nname: global-skill\ndescription: Global\n---\n', 'utf8')
    process.env.SKILLS_ROOT = envRoot
    process.env.AETHER_GLOBAL_DIR = globalDir
    try {
      skillsRegistry.start()
      const names = skillsRegistry.getSkills().map((skill) => skill.name)
      expect(names).toEqual(expect.arrayContaining(['env-built-in', 'global-skill']))
    } finally {
      fs.rmSync(envRoot, { recursive: true, force: true })
      fs.rmSync(globalDir, { recursive: true, force: true })
    }
  })

  it('停用项目技能仍覆盖同名全局技能，启用过滤发生在合并之后', () => {
    originalSkillsRoot = process.env.SKILLS_ROOT
    originalGlobalDir = process.env.AETHER_GLOBAL_DIR
    const envRoot = createTempSkillsDir(['env-built-in'])
    const globalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-global-'))
    const globalRoot = path.join(globalDir, 'skills')
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'test-workspace-'))
    fs.mkdirSync(path.join(globalRoot, 'same'), { recursive: true })
    fs.writeFileSync(path.join(globalRoot, 'same', 'SKILL.md'), '---\nname: same\ndescription: Global\n---\n', 'utf8')
    const projectRoot = path.join(workspace, '.aether', 'skills')
    fs.mkdirSync(path.join(projectRoot, 'same'), { recursive: true })
    fs.writeFileSync(path.join(projectRoot, 'same', 'SKILL.md'), '---\nname: same\ndescription: Project\n---\n', 'utf8')
    fs.writeFileSync(path.join(projectRoot, 'skills.config.json'), JSON.stringify({ defaults: { same: { enabled: false } } }), 'utf8')
    process.env.SKILLS_ROOT = envRoot
    process.env.AETHER_GLOBAL_DIR = globalDir
    try {
      skillsRegistry.start()
      expect(skillsRegistry.getSkills(workspace).some((skill) => skill.name === 'same')).toBe(false)
      expect(skillsRegistry.getAllSkills(workspace).find((skill) => skill.name === 'same')?.description).toBe('Project')
    } finally {
      fs.rmSync(envRoot, { recursive: true, force: true })
      fs.rmSync(globalDir, { recursive: true, force: true })
      fs.rmSync(workspace, { recursive: true, force: true })
    }
  })
})

// ─── 工具函数 ──────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function reg_cleanup(_dir: string) { /* noop, just for type-checking the try/finally */ }
