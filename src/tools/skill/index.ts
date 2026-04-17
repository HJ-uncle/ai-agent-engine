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

/**
 * 创建技能相关工具，注入已加载的 skills 列表
 */
export function createSkillTools(skills: ExternalSkill[]): Tool[] {
  const listSkills: Tool = {
    name: 'list_skills',
    description: 'List all available skills with their names and descriptions.',
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

  const getSkill: Tool = {
    name: 'get_skill',
    description:
      'Get the full instructions (SKILL.md content) for a specific skill by name. ' +
      'Call this before executing any skill to understand its exact usage.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'The exact name of the skill (as shown in list_skills).',
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