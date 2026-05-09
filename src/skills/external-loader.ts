/**
 * 外部 Skill 加载器
 *
 * 从 SKILLs 目录扫描技能定义（SKILL.md）。
 *
 * 设计原则（避免超出 LLM 上下文限制）：
 *   - 系统提示词只注入「技能目录索引」（名称 + 一行描述），不注入全文
 *   - LLM 可通过内置 `get_skill` 工具按需获取某个技能的完整说明
 *
 * 配置入口：SKILLS_ROOT 环境变量（或 .env 中设置）
 */

import fs from 'node:fs'
import path from 'node:path'
import { logger } from '../observability/index.js'

export interface ExternalSkill {
  name: string
  description: string
  skillMdPath: string  // SKILL.md 文件的绝对路径（按需读取全文）
  order: number
  enabled: boolean
  /**
   * 内联 SKILL.md 内容（来自客户端 inlineSkills 透传）
   * 当此字段非空时，getSkillContent 优先返回它而不再读 skillMdPath。
   * 用于 wuzu 桌面客户端把本地安装的 skill 透传到 agent-engine，
   * 让 agent-engine 即使本地 SKILLS_ROOT 没有同名 skill 也能让 LLM 看到完整说明。
   */
  inlineContent?: string
}

interface SkillsConfig {
  defaults?: Record<string, { order?: number; enabled?: boolean }>
}

// 解析 SKILL.md frontmatter (--- key: value ---)
function parseFrontmatter(raw: string): {
  meta: Record<string, string>
  body: string
} {
  const meta: Record<string, string> = {}
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
  if (!fmMatch) return { meta, body: raw }

  for (const line of fmMatch[1].split('\n')) {
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim()
    const val = line.slice(colonIdx + 1).trim()
    if (key) meta[key] = val
  }
  return { meta, body: fmMatch[2] }
}

/**
 * 扫描并加载所有外部技能（只读元数据，不读全文）
 */
export function loadExternalSkills(skillsRoot?: string): ExternalSkill[] {
  const rawRoot = skillsRoot ?? process.env.SKILLS_ROOT
  if (!rawRoot) {
    logger.debug('SKILLS_ROOT not set, skipping external skill loading')
    return []
  }

  // 支持相对路径（相对于 cwd）
  const root = path.resolve(process.cwd(), rawRoot)

  if (!fs.existsSync(root)) {
    logger.warn({ root }, 'SKILLS_ROOT directory does not exist')
    return []
  }

  // 读取 skills.config.json（如果存在）
  const configPath = path.join(root, 'skills.config.json')
  let config: SkillsConfig = {}
  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as SkillsConfig
    } catch {
      logger.warn({ configPath }, 'Failed to parse skills.config.json')
    }
  }

  const defaults = config.defaults ?? {}
  const skills: ExternalSkill[] = []

  // 遍历所有子目录
  let dirs: string[]
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch (err) {
    logger.warn({ root, err }, 'Failed to read SKILLS_ROOT directory')
    return []
  }

  for (const dirName of dirs) {
    const skillDir = path.join(root, dirName)
    const skillMdPath = path.join(skillDir, 'SKILL.md')

    if (!fs.existsSync(skillMdPath)) continue

    // 只读取元数据（前几行 frontmatter），不加载全文
    let raw: string
    try {
      // 只读前 4KB 用于解析元数据，节省内存
      const buf = Buffer.alloc(4096)
      const fd = fs.openSync(skillMdPath, 'r')
      const bytesRead = fs.readSync(fd, buf, 0, 4096, 0)
      fs.closeSync(fd)
      raw = buf.subarray(0, bytesRead).toString('utf-8')
    } catch {
      continue
    }

    const { meta } = parseFrontmatter(raw)

    const name = meta['name'] ?? dirName
    const description = meta['description'] ?? `Skill: ${name}`

    const cfg = defaults[dirName] ?? {}
    const order = cfg.order ?? 999
    const enabled = cfg.enabled !== false  // 默认 true

    if (!enabled) {
      logger.debug({ name }, 'Skill disabled in config, skipping')
      continue
    }

    skills.push({ name, description, skillMdPath, order, enabled })
  }

  skills.sort((a, b) => a.order - b.order)
  logger.info({ count: skills.length, root }, 'External skills indexed')
  return skills
}

/**
 * 按名称读取技能的完整 SKILL.md 内容（供 get_skill 工具调用）
 *
 * 读取优先级：
 *   1. skill.inlineContent（来自客户端透传，无 fs 依赖）
 *   2. skill.skillMdPath（agent-engine 本地 SKILLS_ROOT 文件）
 */
export function getSkillContent(skills: ExternalSkill[], name: string): string | null {
  const skill = skills.find(
    (s) => s.name.toLowerCase() === name.toLowerCase() ||
           (s.skillMdPath && path.basename(path.dirname(s.skillMdPath)).toLowerCase() === name.toLowerCase())
  )
  if (!skill) return null

  // 优先返回 inline 内容（客户端透传的虚拟 skill 无本地文件）
  if (skill.inlineContent && skill.inlineContent.trim()) {
    return skill.inlineContent
  }

  if (!skill.skillMdPath) return null
  try {
    return fs.readFileSync(skill.skillMdPath, 'utf-8')
  } catch {
    return null
  }
}

/**
 * 构建技能目录索引（轻量，只含名称 + 描述）
 * 注入到系统提示词，不包含全文内容
 */
export function buildSkillsSystemPrompt(skills: ExternalSkill[]): string {
  if (skills.length === 0) return ''

  const rows = skills
    .map((sk, i) => `${String(i + 1).padStart(2, ' ')}. **${sk.name}** — ${sk.description}`)
    .join('\n')

  return [
    '---',
    '# Available Skills Index',
    '',
    `You have access to ${skills.length} external skills. **You MUST use them when the user's request matches.**`,
    '',
    '## Mandatory Workflow (NEVER skip any step):',
    'When the user\'s request matches a skill below — regardless of language (中文/English/etc.) — you MUST:',
    '1. Identify the matching skill name from the index below (map Chinese intent → English skill name).',
    '2. Call `get_skill` with that exact English skill name → e.g. `get_skill({name: "web-search"})`.',
    '3. Read the returned SKILL.md instructions carefully.',
    '4. Call `run_skill_script` with the exact bash command shown in SKILL.md.',
    '',
    '## Critical Rules:',
    '- **NEVER** answer from memory if a matching skill exists — always execute it.',
    '- **NEVER** guess or invent tool names. Always use `get_skill` first.',
    '- **NEVER** skip `run_skill_script` — reading SKILL.md alone is not enough.',
    '- User may write in **Chinese** (中文): map their intent to the English skill name below.',
    '  Examples: "搜索新闻/查新闻" → `web-search` | "搜索音乐" → `music-search` | "查电影" → `films-search`',
    '- If unsure which skill fits, call `list_skills` for the full list, then proceed with the workflow.',
    '',
    '## Skills Index:',
    rows,
    '---',
  ].join('\n')
}