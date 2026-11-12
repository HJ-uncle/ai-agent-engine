import type { ToolProfile } from './tool-profile.js'
import { normalizeAllowedTools } from './tool-profile.js'

/** Product selections map to trusted builtins, never client-supplied implementations. */
export const AGENT_MANAGEMENT_TOOLS = [
  'agent_list', 'agent_get', 'agent_create', 'agent_update', 'agent_delete',
] as const
export const SKILL_MANAGEMENT_TOOLS = ['skill_list', 'skill_get', 'skill_create', 'skill_update', 'skill_set_enabled', 'skill_delete'] as const
export const KNOWLEDGE_READ_TOOLS = ['knowledge_list', 'knowledge_get', 'knowledge_documents', 'knowledge_document_get', 'knowledge_search'] as const
export const KNOWLEDGE_MANAGEMENT_TOOLS = ['knowledge_list', 'knowledge_get', 'knowledge_create', 'knowledge_update', 'knowledge_delete',
  'knowledge_documents', 'knowledge_document_get', 'knowledge_import', 'knowledge_document_update', 'knowledge_document_delete', 'knowledge_search'] as const
export const AUTOMATION_TOOLS = ['cron_capabilities', 'cron_list', 'cron_preview', 'cron_create', 'cron_update', 'cron_delete'] as const
export const MCP_MANAGEMENT_TOOLS = ['mcp_server_list', 'mcp_server_get', 'mcp_server_create', 'mcp_server_update', 'mcp_server_set_enabled', 'mcp_server_delete', 'mcp_server_test'] as const
export const PLUGIN_MANAGEMENT_TOOLS = ['plugin_get_template', 'plugin_list', 'plugin_get', 'plugin_create', 'plugin_update', 'plugin_publish', 'plugin_set_enabled', 'plugin_delete', 'plugin_test', 'plugin_import_preview', 'plugin_import_install'] as const
export const TOOLKIT_CATALOGUE = [
  { id: 'agent-management', name: 'Agent 管理', description: '创建和管理 Agent', toolNames: AGENT_MANAGEMENT_TOOLS },
  { id: 'skill-management', name: 'Skill 管理', description: '保存和管理工作方法', toolNames: SKILL_MANAGEMENT_TOOLS },
  { id: 'knowledge-management', name: '知识库管理', description: '整理资料与检索知识', toolNames: KNOWLEDGE_MANAGEMENT_TOOLS },
  { id: 'automation', name: '自动化', description: '安排和管理定时任务', toolNames: AUTOMATION_TOOLS },
  { id: 'plugin-management', name: '插件管理', description: '创建、编辑、导入和测试插件', toolNames: PLUGIN_MANAGEMENT_TOOLS },
  { id: 'mcp-management', name: 'MCP 管理', description: '配置和测试 MCP 服务', toolNames: MCP_MANAGEMENT_TOOLS },
] as const
export const TOOLKIT_IDS = TOOLKIT_CATALOGUE.map(toolkit => toolkit.id)
export type BuiltinToolkitId = typeof TOOLKIT_IDS[number]
export type ToolkitId = BuiltinToolkitId | `plugin-${string}--r${number}`
export function parsePluginToolkit(id: string): { id: string; revision: number } | undefined {
  const match = /^plugin-([a-z0-9][a-z0-9-]{0,47})--r([1-9][0-9]{0,8})$/.exec(id)
  return match ? { id: match[1], revision: Number(match[2]) } : undefined
}
const managementNames: ReadonlySet<string> = new Set(AGENT_MANAGEMENT_TOOLS)
export const MANAGEMENT_TOOL_NAMES: ReadonlySet<string> = new Set(TOOLKIT_CATALOGUE.flatMap(toolkit => [...toolkit.toolNames]))

export function isAgentManagementTool(name: string): boolean { return managementNames.has(name) }

export function normalizeToolkits(raw: unknown, profile: ToolProfile = 'general'): ToolkitId[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw) || raw.length > 32 || new Set(raw).size !== raw.length || raw.some(id => typeof id !== 'string' || (!TOOLKIT_IDS.includes(id as BuiltinToolkitId) && !parsePluginToolkit(id))))
    throw Object.assign(new Error(`toolkits 必须为已知工具包 ID 的数组：${TOOLKIT_IDS.join(', ')}`), { statusCode: 400 })
  if (profile !== 'general' && raw.length)
    throw Object.assign(new Error('管理工具包仅适用于 Work 模式，Code 模式不可启用'), { statusCode: 400 })
  const plugins = raw.flatMap(id => { const plugin = parsePluginToolkit(id); return plugin ? [plugin.id] : [] })
  if (new Set(plugins).size !== plugins.length) throw Object.assign(new Error('同一插件只能选择一个发布版本'), { statusCode: 400 })
  // Registry/schema order is independent of the order of UI selections.
  return [...TOOLKIT_IDS.filter(id => raw.includes(id)), ...raw.filter(id => parsePluginToolkit(id)).sort()] as ToolkitId[]
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
