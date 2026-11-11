import type { ToolProfile } from './tool-profile.js'
import { normalizeAllowedTools } from './tool-profile.js'

/** Product selections map to trusted builtins, never client-supplied implementations. */
export const AGENT_MANAGEMENT_TOOLS = [
  'agent_list', 'agent_get', 'agent_create', 'agent_update', 'agent_delete',
] as const
export const SKILL_MANAGEMENT_TOOLS = ['skill_list', 'skill_get', 'skill_create', 'skill_update', 'skill_set_enabled', 'skill_delete'] as const
export const KNOWLEDGE_MANAGEMENT_TOOLS = ['knowledge_list', 'knowledge_get', 'knowledge_create', 'knowledge_update', 'knowledge_delete',
  'knowledge_documents', 'knowledge_document_get', 'knowledge_import', 'knowledge_document_update', 'knowledge_document_delete', 'knowledge_search'] as const
export const AUTOMATION_TOOLS = ['cron_capabilities', 'cron_list', 'cron_preview', 'cron_create', 'cron_update', 'cron_delete'] as const
export const TOOLKIT_CATALOGUE = [
  { id: 'agent-management', name: 'Agent 管理', description: '创建和管理 Agent', toolNames: AGENT_MANAGEMENT_TOOLS },
  { id: 'skill-management', name: '技能管理', description: '保存和管理工作方法', toolNames: SKILL_MANAGEMENT_TOOLS },
  { id: 'knowledge-management', name: '知识库管理', description: '整理资料与检索知识', toolNames: KNOWLEDGE_MANAGEMENT_TOOLS },
  { id: 'automation', name: '自动化', description: '安排和管理定时任务', toolNames: AUTOMATION_TOOLS },
] as const
export const TOOLKIT_IDS = TOOLKIT_CATALOGUE.map(toolkit => toolkit.id)
export type ToolkitId = typeof TOOLKIT_IDS[number]
const managementNames: ReadonlySet<string> = new Set(AGENT_MANAGEMENT_TOOLS)
export const MANAGEMENT_TOOL_NAMES: ReadonlySet<string> = new Set(TOOLKIT_CATALOGUE.flatMap(toolkit => [...toolkit.toolNames]))

export function isAgentManagementTool(name: string): boolean { return managementNames.has(name) }

export function normalizeToolkits(raw: unknown, profile: ToolProfile = 'general'): ToolkitId[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw) || raw.length > TOOLKIT_IDS.length || new Set(raw).size !== raw.length || raw.some(id => !TOOLKIT_IDS.includes(id as ToolkitId)))
    throw Object.assign(new Error(`toolkits 必须为已知工具包 ID 的数组：${TOOLKIT_IDS.join(', ')}`), { statusCode: 400 })
  if (profile !== 'general' && raw.length)
    throw Object.assign(new Error('管理工具包仅适用于 Work 模式，Code 模式不可启用'), { statusCode: 400 })
  // Registry/schema order is independent of the order of UI selections.
  return TOOLKIT_IDS.filter(id => raw.includes(id))
}

export function toolkitToolNames(toolkits: readonly ToolkitId[]): readonly string[] {
  return [...new Set(TOOLKIT_CATALOGUE.filter(toolkit => toolkits.includes(toolkit.id)).flatMap(toolkit => [...toolkit.toolNames]))]
}

/** Selection may lift a default-off exposure, never an explicit permission ceiling. */
export function assertToolkitPermissions(toolkits: readonly ToolkitId[], ...ceilings: Array<readonly string[] | null | undefined>): void {
  const required = toolkitToolNames(toolkits)
  for (const ceiling of ceilings) {
    const allowed = normalizeAllowedTools(ceiling)
    if (!allowed) continue
    const denied = required.filter(name => !allowed.includes(name))
    if (denied.length) throw Object.assign(new Error(`当前 Agent 或请求工具白名单不允许启用所选工具包：${denied.join(', ')}`), { statusCode: 403 })
  }
}
