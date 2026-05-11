import { describe, it, expect } from 'vitest'
import path from 'node:path'
import fs from 'node:fs'
import { loadExternalSkills } from '../external-loader.js'

/**
 * Superpower 方法论技能包测试
 *
 *   - discoverability（Task 7.12）：7 个 superpower-* skill 能被 loader 扫到
 *   - Claude-Code 工具别名门卫（spec scenario "Skills use agent-engine tool names only"）：
 *     7 个 SKILL.md + 各自附带的 `*-prompt.md` / `visual-companion.md` 等
 *     不得出现 `Bash/Read/Write/Task/Grep/Glob/Edit` 后跟 " tool"，
 *     也不得出现 `TodoWrite`/`WebFetch`/`WebSearch`/`Skill tool` 等独立别名。
 *     `references/agent-engine-tools.md` 作为翻译对照表本身允许出现这些词，跳过。
 */

const SKILLS_ROOT = path.resolve(process.cwd(), './skills')

const EXPECTED = [
  'superpower-using-superpowers',
  'superpower-brainstorming',
  'superpower-writing-plans',
  'superpower-tdd',
  'superpower-systematic-debugging',
  'superpower-subagent-driven-dev',
  'superpower-verification-before-completion',
]

describe('skills / superpower methodology pack', () => {
  it('全部 7 个 superpower-* skill 能被 loadExternalSkills 扫到', () => {
    const all = loadExternalSkills(SKILLS_ROOT)
    const names = new Set(all.map(s => s.name))
    // 兼容：有的 SKILL.md 前文里 name 可能就是目录名
    const dirNames = new Set(all.map(s => path.basename(path.dirname(s.skillMdPath))))

    for (const expected of EXPECTED) {
      const found = names.has(expected) || dirNames.has(expected)
      expect(found, `missing skill: ${expected}`).toBe(true)
    }
  })

  it('每个 superpower-* skill 都带有非空 description', () => {
    const all = loadExternalSkills(SKILLS_ROOT)
    const superpower = all.filter(s =>
      path.basename(path.dirname(s.skillMdPath)).startsWith('superpower-'),
    )
    expect(superpower.length).toBeGreaterThanOrEqual(EXPECTED.length)
    for (const s of superpower) {
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
 * 不要把整个 references/ 目录 blanket-exempt——未来如果又塞回跨平台对照表，
 * 这个测试应当重新 fail。
 */
const EXEMPT_ABSOLUTE = new Set<string>([
  path.resolve(SKILLS_ROOT, 'superpower-using-superpowers', 'references', 'agent-engine-tools.md'),
])

describe('skills / superpower no Claude Code tool aliases', () => {
  const supDirs = EXPECTED.map(n => path.join(SKILLS_ROOT, n))

  it('每个 superpower-* skill 目录都真实存在', () => {
    for (const d of supDirs) {
      expect(fs.existsSync(d), `missing dir: ${d}`).toBe(true)
    }
  })

  it('7 个 skill 包内任何 .md 文件都不得出现 Claude Code 工具别名（translation table 除外）', () => {
    const offenders: Array<{ file: string; line: number; pattern: string; text: string }> = []

    for (const dir of supDirs) {
      if (!fs.existsSync(dir)) continue
      for (const file of collectMarkdown(dir)) {
        if (EXEMPT_ABSOLUTE.has(path.resolve(file))) continue
        const lines = fs.readFileSync(file, 'utf-8').split(/\r?\n/)
        lines.forEach((text, i) => {
          for (const { label, regex } of FORBIDDEN_PATTERNS) {
            if (regex.test(text)) {
              offenders.push({
                file: path.relative(SKILLS_ROOT, file),
                line: i + 1,
                pattern: label,
                text: text.trim().slice(0, 140),
              })
            }
          }
        })
      }
    }

    if (offenders.length > 0) {
      const msg = offenders
        .map(o => `  ${o.file}:${o.line}  [${o.pattern}]  ${o.text}`)
        .join('\n')
      throw new Error(
        `Superpower skill pack leaked Claude Code tool aliases:\n${msg}\n\n` +
        `Fix by translating through skills/superpower-using-superpowers/references/agent-engine-tools.md, ` +
        `or extend EXEMPT_ABSOLUTE if the reference is deliberate.`,
      )
    }
    expect(offenders).toEqual([])
  })
})

