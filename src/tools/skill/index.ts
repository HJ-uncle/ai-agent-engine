/**
 * Skill 相关工具
 *
 * - list_skills：列出所有可用技能（名称 + 描述）
 * - get_skill：按名称获取技能的完整 SKILL.md 内容
 * - run_skill_script：执行技能目录中的 bash/shell 脚本
 */

import type { Tool } from '../../core/agent-context/index.js'
import type { ExternalSkill } from '../../skills/external-loader.js'
import { getSkillContent } from '../../skills/external-loader.js'

export { runSkillScriptTool } from './run-skill-script.js'

export type SkillTool = Tool & { source: 'skill' }

/** OSM 模式上下文：用于在工具输出中说明被隐藏的方法论技能 */
export interface SkillToolOsmContext {
  /** 当前 OSM 档位（off | balanced | methodology | max） */
  osmMode?: string
  /** 因当前模式被隐藏的方法论技能名（os-* 系列） */
  hiddenSkills?: string[]
}

/**
 * 创建技能相关工具，注入已加载的 skills 列表
 */
export function createSkillTools(skills: ExternalSkill[], osm: SkillToolOsmContext = {}): SkillTool[] {
  const hiddenNote =
    osm.hiddenSkills && osm.hiddenSkills.length > 0
      ? `\n\n(${osm.hiddenSkills.length} methodology skill(s) hidden under current OSM mode "${osm.osmMode}" — e.g. ${osm.hiddenSkills.slice(0, 3).join(', ')}${osm.hiddenSkills.length > 3 ? ', …' : ''}. They are only visible in methodology/max mode.)`
      : ''

  const listSkills: SkillTool = {
    name: 'list_skills',
    displayName: '可用技能列表',
    description: '列出所有可用技能的名称和简短描述。',
    source: 'skill',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    async execute(_input, _ctx) {
      if (skills.length === 0) {
        return { success: true, output: `No skills available.${hiddenNote}` }
      }
      const lines = skills.map(
        (sk, i) => `${i + 1}. **${sk.name}** — ${sk.description}`,
      )
      return { success: true, output: `Available skills (${skills.length}):\n\n${lines.join('\n')}${hiddenNote}` }
    },
  }

  const getSkill: SkillTool = {
    name: 'get_skill',
    displayName: '获取技能说明',
    description:
      '根据技能名称获取特定技能的完整使用说明（SKILL.md 内容）。在执行任何技能脚本之前调用此工具，以了解其确切用法。',
    source: 'skill',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: '想要查看的技能名称（须与 list_skills 中列出的名称一致）',
        },
      },
      required: ['name'],
    },
    async execute(input, _ctx) {
      const { name } = input as { name: string }
      const content = getSkillContent(skills, name)
      if (!content) {
        // 区分"被 OSM 模式隐藏"与"真的不存在"，避免误导 Agent
        if (osm.hiddenSkills?.includes(name)) {
          return {
            success: false,
            output: `Skill "${name}" exists but is hidden under the current OSM mode "${osm.osmMode}". Methodology skills (os-*) are only available in methodology/max mode. This is NOT a data inconsistency.`,
          }
        }
        const available = skills.map((s) => s.name).join(', ')
        return {
          success: false,
          output: `Skill "${name}" not found. Available skills: ${available}${hiddenNote}`,
        }
      }
      return { success: true, output: content }
    },
  }

  return [listSkills, getSkill]
}