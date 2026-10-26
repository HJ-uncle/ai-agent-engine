import type { IToolRegistry } from '../core/agent-context/index.js'
import { mathSkill } from './math.js'
import { timeSkill } from './time.js'
import { trustBuiltinTool } from '../security/tool-policy.js'

export { mathSkill } from './math.js'
export { timeSkill } from './time.js'
// 外部 SKILLs 目录动态加载（SKILL.md → 系统提示词注入）
export { loadExternalSkills, buildSkillsSystemPrompt } from './external-loader.js'
export type { ExternalSkill } from './external-loader.js'
// 全局技能注册表（热重载单例）
export { skillsRegistry } from './skills-registry.js'

/**
 * 注册内置工具型 Skill（计算、时间等）。
 * web-search 及其他技能均由外部 SKILLs/ 目录通过 run_skill_script 调用，不在此注册。
 */
export function registerBuiltinSkills(registry: IToolRegistry): void {
  registry.register(trustBuiltinTool(mathSkill, 'readonly'))
  registry.register(trustBuiltinTool(timeSkill, 'readonly'))
}
