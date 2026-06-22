/**
 * OpenSpec Methodology (OSM) bootstrap 注入
 *
 * 当 `OSM_MODE ∈ {methodology, max}` 时，系统提示词会在请求构造阶段
 * 自动 prepend `os-using-superpowers/SKILL.md` 的完整内容（用
 * `<OSM-ACTIVE>…</OSM-ACTIVE>` 哨兵包裹，便于审计 / grep 日志）。
 *
 * 其余 6 个 OSM 技能（brainstorming / writing-plans / tdd / 等）按需
 * 通过 Agent 自身的 `list_skills` / `get_skill` 工具拉取，避免每轮 token 爆炸。
 *
 * 该模块依赖 `skillsRegistry` 的热重载能力：编辑 SKILL.md 后下一次请求即生效。
 */

import type { Logger } from 'pino'
import { skillsRegistry } from '../skills/index.js'
import { getSkillContent } from '../skills/external-loader.js'
import { resolveOSMMode, OSM_MODE_CONFIG } from './osm.js'
import { logger as defaultLogger } from '../observability/index.js'

/** OSM 方法论 bootstrap 注入 */
export const OSM_BOOTSTRAP_SKILL_NAME = 'os-using-superpowers'

/** bootstrap 块与调用方 baseSystemPrompt 的分隔符 */
const DELIMITER = '\n\n---\n\n'

/** 哨兵标签：方便日志 grep，也帮 LLM 将其识别为方法论硬门 */
const SENTINEL_OPEN = '<OSM-ACTIVE>'
const SENTINEL_CLOSE = '</OSM-ACTIVE>'

/**
 * 静态兜底提示词（参考 lobster OSM_METHODOLOGY_PROMPT 设计）。
 *
 * 当 os-using-superpowers/SKILL.md 不存在时，注入此轻量骨架保证方法论约束不完全哑火。
 * 正文仍可通过 get_skill 按需拉取各子技能。
 */
const OSM_STATIC_FALLBACK_PROMPT = `<openspec-methodology mode="active">
OpenSpec Methodology (OSM) 已启用。请先调用
\`get_skill({ name: "os-using-superpowers" })\` 获取完整方法论入口指引。

核心纪律（先规划后执行，证据先于结论）：
1. 创建/构建/修改前 → get_skill({ name: "os-brainstorming" }) 形成设计并经用户确认。
2. 多步实现 → get_skill({ name: "os-writing-plans" }) 拆出 bite-sized 计划。
3. 写生产代码 → get_skill({ name: "os-tdd" }) 遵循 RED/GREEN/REFACTOR。
4. 遇到 bug / 测试失败 → get_skill({ name: "os-systematic-debugging" }) 先定位根因再修。
5. 宣称完成前 → get_skill({ name: "os-verification-before-completion" }) 用新鲜证据佐证。
6. 大任务可委派 → get_skill({ name: "os-subagent-driven-dev" }) 用 Task 子代理实现+评审。

用户的显式指令始终优先于本方法论。
</openspec-methodology>`

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
export function getOSMBootstrapBlock(log: Logger = defaultLogger): string {
  const mode = resolveOSMMode(log)
  if (!OSM_MODE_CONFIG[mode].methodology) return ''

  const skills = skillsRegistry.getSkills()
  const content = getSkillContent(skills, OSM_BOOTSTRAP_SKILL_NAME)
  if (!content || !content.trim()) {
    if (!__missingWarned) {
      __missingWarned = true
      log.warn(
        { skill: OSM_BOOTSTRAP_SKILL_NAME, mode },
        'OSM: bootstrap SKILL.md not found — falling back to static methodology prompt',
      )
    }
    // 静态 fallback：保证 methodology / max 档有最低限度的方法论约束
    return `${SENTINEL_OPEN}\n${OSM_STATIC_FALLBACK_PROMPT.trim()}\n${SENTINEL_CLOSE}`
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
  const bootstrap = getOSMBootstrapBlock(log)
  if (!bootstrap) return base
  return bootstrap + DELIMITER + base
}
