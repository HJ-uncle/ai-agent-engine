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

/**
 * 创建技能相关工具，注入已加载的 skills 列表
 */
export function createSkillTools(skills: ExternalSkill[]): SkillTool[] {
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
        return { success: true, output: 'No skills available.' }
      }
      const lines = skills.map(
        (sk, i) => `${i + 1}. **${sk.name}** — ${sk.description}`,
      )
      return { success: true, output: `Available skills (${skills.length}):\n\n${lines.join('\n')}` }
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
        const available = skills.map((s) => s.name).join(', ')
        return {
          success: false,
          output: `Skill "${name}" not found. Available skills: ${available}`,
        }
      }
      return { success: true, output: content }
    },
  }

  return [listSkills, getSkill]
}