import { describe, it, expect } from 'vitest'
import path from 'node:path'
import fs from 'node:fs'
import { loadExternalSkills } from '../external-loader.js'

/**
 * OpenSpec 方法论 (OSM) 技能包测试
 *
 *   - discoverability：7 个 os-* skill 能被 loader 扫到
 *   - Claude-Code 工具别名门卫：
 *     7 个 SKILL.md + 各自附带的 `*-prompt.md` / `visual-companion.md` 等
 *     不得出现 `Bash/Read/Write/Task/Grep/Glob/Edit` 后跟 " tool"，
 *     也不得出现 `TodoWrite`/`WebFetch`/`WebSearch`/`Skill tool` 等独立别名。
 *     `references/agent-engine-tools.md` 作为翻译对照表本身允许出现这些词，跳过。
 */

// 技能根目录：.aether/skills（新约定）优先，旧 SKILLs/ 回退
const SKILLS_ROOT = (() => {
  const candidates = [
    path.resolve(process.cwd(), '.aether', 'skills'),
    path.resolve(process.cwd(), 'SKILLs'),
  ]
  return candidates.find(p => fs.existsSync(p)) ?? candidates[0]
})()

const EXPECTED = [
  'os-using-superpowers',
  'os-brainstorming',
  'os-writing-plans',
  'os-tdd',
  'os-systematic-debugging',
  'os-subagent-driven-dev',
  'os-verification-before-completion',
]

describe('skills / OSM methodology pack', () => {
  it('全部 7 个 os-* skill 能被 loadExternalSkills 扫到', () => {
    const all = loadExternalSkills(SKILLS_ROOT)
    const names = new Set(all.map(s => s.name))
    // 兼容：有的 SKILL.md 前文里 name 可能就是目录名
    const dirNames = new Set(all.map(s => path.basename(path.dirname(s.skillMdPath))))

    for (const expected of EXPECTED) {
      const found = names.has(expected) || dirNames.has(expected)
      expect(found, `missing skill: ${expected}`).toBe(true)
    }
  })

  it('每个 os-* skill 都带有非空 description', () => {
    const all = loadExternalSkills(SKILLS_ROOT)
    const osSkills = all.filter(s =>
      path.basename(path.dirname(s.skillMdPath)).startsWith('os-'),
    )
    expect(osSkills.length).toBeGreaterThanOrEqual(EXPECTED.length)
    for (const s of osSkills) {
      expect(s.description).toBeTruthy()
      expect(typeof s.description).toBe('string')
      expect(s.description.trim().length).toBeGreaterThan(0)
    }
  })
})

// ─── Claude Code 工具别名门卫 ────────────────────────────────────────────────

/** 递归收集某个目录下所有 .md 文件 */
function collectMarkdown(dir: string): string[] {
  const result: string[] = []
  if (!fs.existsSync(dir)) return result
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) result.push(...collectMarkdown(full))
    else if (entry.isFile() && entry.name.endsWith('.md')) result.push(full)
  }
  return result
}

/**
 * 两组正则：
 *   1. `X tool` 形式，X ∈ Claude Code 文件/子代理/TODO 工具名
 *   2. 独立出现的 `TodoWrite` / `WebFetch` / `WebSearch`
 *   3. `Skill tool` 单独模式（agent-engine 叫 `get_skill`）
 *
 * 用 (?:Bash|…)\s+tool 形式避免误伤英文动词 "Write the failing test" 等。
 */
const FORBIDDEN_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  { label: 'X tool alias (Bash/Read/Write/Task/Grep/Glob/Edit)', regex: /\b(Bash|Read|Write|Task|Grep|Glob|Edit)\s+tool\b/ },
  { label: 'Skill tool alias', regex: /\bSkill\s+tool\b/ },
  { label: 'TodoWrite alias', regex: /\bTodoWrite\b/ },
  { label: 'WebFetch alias', regex: /\bWebFetch\b/ },
  { label: 'WebSearch alias', regex: /\bWebSearch\b/ },
]

/**
 * 允许豁免的文件：这份翻译对照表必须出现这些词才能说清楚"把 X 替换成 Y"。
 */
const EXEMPT_ABSOLUTE = new Set<string>([
  path.resolve(SKILLS_ROOT, 'os-using-superpowers', 'references', 'agent-engine-tools.md'),
])

describe('skills / OSM no Claude Code tool aliases', () => {
  const osDirs = EXPECTED.map(n => path.join(SKILLS_ROOT, n))

  it('每个 os-* skill 目录都真实存在', () => {
    for (const d of osDirs) {
      expect(fs.existsSync(d), `missing dir: ${d}`).toBe(true)
    }
  })

  it('OSM 技能包中不包含 Claude Code 专用工具别名', () => {
    for (const dir of osDirs) {
      const files = collectMarkdown(dir)
      for (const file of files) {
        if (EXEMPT_ABSOLUTE.has(file)) continue

        const content = fs.readFileSync(file, 'utf-8')
        for (const pattern of FORBIDDEN_PATTERNS) {
          const match = content.match(pattern.regex)
          expect(match, `Forbidden pattern "${pattern.label}" found in ${file}: ${match?.[0]}`).toBeNull()
        }
      }
    }
  })
})
