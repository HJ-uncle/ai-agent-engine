/** Template identity is independent of a child session and its individual runs. */
export const BUILTIN_AGENT_ROLES = ['research', 'executor', 'general'] as const
export type BuiltinAgentRole = typeof BUILTIN_AGENT_ROLES[number]

export interface BuiltinAgentTemplate {
  readonly id: BuiltinAgentRole
  readonly version: number
  readonly name: string
  readonly description: string
  readonly readOnly: boolean
  readonly systemPrompt: string
}

export const BUILTIN_AGENT_TEMPLATES: Readonly<Record<BuiltinAgentRole, BuiltinAgentTemplate>> = Object.freeze({
  research: Object.freeze({
    id: 'research', version: 1, name: '调研', readOnly: true,
    description: '阅读、检索和分析，返回文字结论与证据，不执行命令或修改文件。',
    systemPrompt: '你的职责是调研：阅读、检索、分析和核对证据。不要执行命令或脚本，不修改用户文件，不生成交付文件，也不创建或更新项目索引。直接返回文字结论、证据定位和未核实事项。需要运行验证或制作产物时向主 Agent 说明，由主 Agent 分配执行工作。引擎保存历史和会话计划不属于用户文件产出。',
  }),
  executor: Object.freeze({
    id: 'executor', version: 1, name: '执行', readOnly: false,
    description: '完成开发、验证、办公及附件制作，也可负责集成其他实例的成果。',
    systemPrompt: '你的职责是完成分配的实际工作：编写代码、运行适当验证、制作文档或其他已授权产物。遵守任务给定的文件责任范围，保留其他代理和用户的修改；共享文件有冲突时先协调，不静默覆盖。可以承担主 Agent 指定的集成任务，核对各组件接口和验证结果。产物必须真实存在，返回文件路径、用途、已执行验证和未完成事项；最终交付由主 Agent 验收登记。',
  }),
  general: Object.freeze({
    id: 'general', version: 1, name: '通用', readOnly: false,
    description: '处理混合职责和特殊任务，在当前授权范围内调查并执行。',
    systemPrompt: '你的职责是处理混合或特殊任务，根据需求进行调查、执行和验证。你只能使用当前提供且已授权的能力，不得借通用角色绕过限制或扩大任务范围。与同伴协调共享文件，完成后返回具体结果、证据、产物路径和未完成事项。最终交付由主 Agent 验收登记。',
  }),
})

export function isBuiltinAgentRole(value: unknown): value is BuiltinAgentRole {
  return typeof value === 'string' && (BUILTIN_AGENT_ROLES as readonly string[]).includes(value)
}
