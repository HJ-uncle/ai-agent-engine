/**
 * Superpower 方法论 bootstrap 注入
 *
 * 当 `SUPERPOWER_MODE ∈ {methodology, max}` 时，系统提示词会在请求构造阶段
 * 自动 prepend `superpower-using-superpowers/SKILL.md` 的完整内容（用
 * `<SUPERPOWER-ACTIVE>…</SUPERPOWER-ACTIVE>` 哨兵包裹，便于审计 / grep 日志）。
 *
 * 其余 6 个方法论技能（brainstorming / writing-plans / tdd / 等）按需
 * 通过 Agent 自身的 `list_skills` / `get_skill` 工具拉取，避免每轮 token 爆炸。
 *
 * 该模块依赖 `skillsRegistry` 的热重载能力：编辑 SKILL.md 后下一次请求即生效。
 */

import type { Logger } from 'pino'
import { skillsRegistry } from '../skills/index.js'
import { getSkillContent } from '../skills/external-loader.js'
import { resolveSuperpowerMode, SUPERPOWER_MODE_CONFIG } from './superpower.js'
import { logger as defaultLogger } from '../observability/index.js'

/** 方法论 bootstrap 对应的技能名（== 目录名） */
export const SUPERPOWER_BOOTSTRAP_SKILL_NAME = 'superpower-using-superpowers'

/** bootstrap 块与调用方 baseSystemPrompt 的分隔符 */
const DELIMITER = '\n\n---\n\n'

/** 哨兵标签：方便日志 grep，也帮 LLM 将其识别为方法论硬门 */
const SENTINEL_OPEN = '<SUPERPOWER-ACTIVE>'
const SENTINEL_CLOSE = '</SUPERPOWER-ACTIVE>'

let __missingWarned = false

/**
 * 测试辅助：重置"缺失告警已触发过一次"的标志位。
 * 仅供单测使用，不对外暴露稳定语义。
 */
export function __resetBootstrapWarnFlagForTests(): void {
  __missingWarned = false
}

/**
 * 取当前模式下应当前置到 baseSystemPrompt 的 bootstrap 文本。
 *
 * 返回值：
 *   - mode ∈ {off, balanced}                        → `''`
 *   - mode ∈ {methodology, max} 且技能存在         → `<SENTINEL>\n<SKILL.md 全文>\n</SENTINEL>`
 *   - mode 需要注入但 SKILL.md 找不到              → `''`，首次会打一次 warn
 *
 * 每次调用都从 `skillsRegistry.getSkills()` 现取现读（registry 自身有热重载），
 * 保证编辑 SKILL.md 后的下一次请求能看到更新。
 */
export function getSuperpowerBootstrapBlock(log: Logger = defaultLogger): string {
  const mode = resolveSuperpowerMode(log)
  if (!SUPERPOWER_MODE_CONFIG[mode].methodology) return ''

  const skills = skillsRegistry.getSkills()
  const content = getSkillContent(skills, SUPERPOWER_BOOTSTRAP_SKILL_NAME)
  if (!content || !content.trim()) {
    if (!__missingWarned) {
      __missingWarned = true
      log.warn(
        { skill: SUPERPOWER_BOOTSTRAP_SKILL_NAME, mode },
        'superpower: bootstrap SKILL.md not found — methodology mode degraded to plain system prompt',
      )
    }
    return ''
  }

  return `${SENTINEL_OPEN}\n${content.trim()}\n${SENTINEL_CLOSE}`
}

/**
 * 辅助：将 bootstrap 块 prepend 到调用方的 baseSystemPrompt。
 *
 * - bootstrap 为空 → 返回 base 原样（不插入分隔符，避免 off/balanced 多一行垃圾）
 * - bootstrap 非空 → `bootstrap + DELIMITER + base`
 */
export function prependBootstrapToSystemPrompt(
  base: string,
  log: Logger = defaultLogger,
): string {
  const bootstrap = getSuperpowerBootstrapBlock(log)
  if (!bootstrap) return base
  return bootstrap + DELIMITER + base
}
