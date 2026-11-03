// 外部 SKILLs 目录动态加载（SKILL.md → 系统提示词注入）
export { loadExternalSkills, buildSkillsSystemPrompt } from './external-loader.js'
export type { ExternalSkill } from './external-loader.js'
// 全局技能注册表（热重载单例）
export { skillsRegistry } from './skills-registry.js'
