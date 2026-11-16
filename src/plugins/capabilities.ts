import { z } from 'zod'
import type { JSONSchema } from '../core/agent-context/types.js'

/**
 * Capabilities exposed to plugin authors are a discovery contract, not an
 * execution shortcut. Every capability starts denied and is granted per
 * plugin by the user. The actual implementation remains behind the existing
 * engine tools and workspace guards.
 */
export const PLUGIN_CAPABILITY_IDS = [
  'models.read',
  'ai.run',
  'skills.read',
  'agents.read',
  'agents.manage',
  'engine.tools',
  'workspace.read',
  'workspace.write',
  'knowledge.read',
  'knowledge.write',
  'mcp.read',
  'mcp.invoke',
  'settings.read',
  'settings.write',
  'session.read',
  'ui.dialogs', 'ui.notifications', 'ui.clipboard', 'ui.editor', 'ui.composer', 'events.subscribe', 'background.run',
] as const

export type PluginCapabilityId = typeof PLUGIN_CAPABILITY_IDS[number]

export interface PluginCapabilityDescriptor {
  id: PluginCapabilityId
  title: string
  description: string
  category: 'ai' | 'skills' | 'agents' | 'workspace' | 'knowledge' | 'mcp' | 'settings' | 'session' | 'ui' | 'events' | 'background'
  access: 'read' | 'write' | 'execute'
  defaultGranted: false
  bridge: string[]
}

export const PLUGIN_CAPABILITIES: readonly PluginCapabilityDescriptor[] = Object.freeze([
  { id: 'models.read', title: '查看可用模型', description: '列出平台已启用模型，不提供密钥或连接凭据。', category: 'ai', access: 'read', defaultGranted: false, bridge: ['$AE.models.list'] },
  { id: 'ai.run', title: '调用平台 AI', description: '使用已配置模型分析插件提供的内容，支持流式输出，调用产生正常模型费用。', category: 'ai', access: 'execute', defaultGranted: false, bridge: ['$AE.ai.run', '$AE.ai.stream'] },
  { id: 'skills.read', title: '读取本地 Skills', description: '列出当前可用技能并读取已授权技能说明；不授予技能脚本执行权限。', category: 'skills', access: 'read', defaultGranted: false, bridge: ['$' + 'AE.skills.list', '$' + 'AE.skills.get'] },
  { id: 'agents.read', title: '查看 Agent', description: '查看当前 Agent、子 Agent 状态与实际工具清单。', category: 'agents', access: 'read', defaultGranted: false, bridge: ['$' + 'AE.agents.list', '$' + 'AE.agents.status', '$AE.agents.tools'] },
  { id: 'agents.manage', title: '管理 Agent', description: '在当前会话范围启动、流式运行或取消 Agent 任务；任务使用平台执行与安全策略。', category: 'agents', access: 'execute', defaultGranted: false, bridge: ['$' + 'AE.agents.run', '$' + 'AE.agents.stream', '$' + 'AE.agents.cancel'] },
  { id: 'engine.tools', title: '使用基础 Agent 工具', description: '向插件 Agent 提供文件、命令、交互与计划、搜索、子代理和 Skill 六类工具，沿用当前会话的安全策略；可单独禁用工具。', category: 'agents', access: 'execute', defaultGranted: false, bridge: ['$AE.agents.tools', '$AE.agents.run', '$AE.agents.stream'] },
  { id: 'workspace.read', title: '读取工作区', description: '只读取当前会话已绑定工作区内的目录、文本和元数据。', category: 'workspace', access: 'read', defaultGranted: false, bridge: ['$' + 'AE.workspace.list', '$' + 'AE.workspace.read'] },
  { id: 'workspace.write', title: '修改工作区', description: '在当前会话已绑定工作区内创建或修改文件。', category: 'workspace', access: 'write', defaultGranted: false, bridge: ['$' + 'AE.workspace.write'] },
  { id: 'knowledge.read', title: '读取知识库', description: '读取已授权知识库的目录和检索结果，不包含凭据。', category: 'knowledge', access: 'read', defaultGranted: false, bridge: ['$' + 'AE.knowledge.list', '$' + 'AE.knowledge.search', '$' + 'AE.knowledge.get'] },
  { id: 'knowledge.write', title: '写入知识库', description: '在用户指定知识库中创建或更新内容。', category: 'knowledge', access: 'write', defaultGranted: false, bridge: ['$' + 'AE.knowledge.create', '$' + 'AE.knowledge.update'] },
  { id: 'mcp.read', title: '查看 MCP 服务', description: '查看已启用的 MCP 服务与工具参数定义，不提供连接凭据。', category: 'mcp', access: 'read', defaultGranted: false, bridge: ['$' + 'AE.mcp.list', '$' + 'AE.mcp.tools'] },
  { id: 'mcp.invoke', title: '调用 MCP 服务', description: '调用用户已启用的 MCP 工具；不会自动获得新的服务器或网络权限。', category: 'mcp', access: 'execute', defaultGranted: false, bridge: ['$' + 'AE.mcp.call'] },
  { id: 'settings.read', title: '读取插件设置', description: '读取此插件自己的持久设置。', category: 'settings', access: 'read', defaultGranted: false, bridge: ['$' + 'AE.settings.get'] },
  { id: 'settings.write', title: '修改插件设置', description: '保存此插件自己的设置；不包含平台模型凭据或全局安全设置。', category: 'settings', access: 'write', defaultGranted: false, bridge: ['$' + 'AE.settings.set'] },
  { id: 'session.read', title: '读取当前会话', description: '读取宿主绑定的当前会话消息和附件信息，支持按消息 ID 选择。', category: 'session', access: 'read', defaultGranted: false, bridge: ['$' + 'AE.session.messages'] },
  { id: 'ui.dialogs', title: '显示对话框', description: '通过宿主显示消息或确认窗口。', category: 'ui', access: 'execute', defaultGranted: false, bridge: ['$AE.ui.dialog'] },
  { id: 'ui.notifications', title: '发送应用通知', description: '显示此插件的应用内通知，并请求系统通知。', category: 'ui', access: 'execute', defaultGranted: false, bridge: ['$AE.ui.notify'] },
  { id: 'ui.clipboard', title: '访问剪贴板', description: '通过宿主读取或写入系统文本剪贴板。', category: 'ui', access: 'write', defaultGranted: false, bridge: ['$AE.ui.clipboard'] },
  { id: 'ui.editor', title: '操作编辑器', description: '读取已接入的代码预览及选择，并定位行列；当前只读预览不支持替换选区。', category: 'ui', access: 'write', defaultGranted: false, bridge: ['$AE.ui.editor'] },
  { id: 'ui.composer', title: '操作输入框', description: '读取或修改当前会话输入框文本。', category: 'ui', access: 'write', defaultGranted: false, bridge: ['$AE.ui.composer'] },
  { id: 'events.subscribe', title: '订阅生命周期事件', description: '接收宿主会话、消息、工作区和编辑器事件，并执行声明的钩子。', category: 'events', access: 'execute', defaultGranted: false, bridge: ['$AE.events.subscribe', 'contributes.hooks'] },
  { id: 'background.run', title: '运行后台任务', description: '引擎运行期间执行持久定时任务；关闭窗口后可继续，完全退出后下次恢复。', category: 'background', access: 'execute', defaultGranted: false, bridge: ['contributes.background'] },
])

export const pluginCapabilityIdSchema = z.enum(PLUGIN_CAPABILITY_IDS)
export const pluginPermissionsSchema = z.object({
  requested: z.array(pluginCapabilityIdSchema).max(PLUGIN_CAPABILITIES.length).default([]),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.requested).size !== value.requested.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['requested'], message: '权限请求不能重复' })
})

export const PLUGIN_CAPABILITY_JSON_SCHEMA: JSONSchema = {
  type: 'object', additionalProperties: false, required: ['requested'], properties: {
    requested: { type: 'array', maxItems: PLUGIN_CAPABILITIES.length, uniqueItems: true, items: { type: 'string', enum: [...PLUGIN_CAPABILITY_IDS] } },
  },
}

export const PLUGIN_CAPABILITY_CATALOGUE = Object.freeze({
  apiVersion: 1,
  defaultPolicy: 'deny',
  rule: '宿主 SDK 仅执行已声明且用户已授权给当前版本的能力。停用、版本不匹配或撤销会阻止后续调用。Node 工具是本机代码，不是操作系统沙箱；这些开关控制宿主 SDK，不约束 Node 自身的系统权限。',
  capabilities: PLUGIN_CAPABILITIES,
  permissionsSchema: PLUGIN_CAPABILITY_JSON_SCHEMA,
})

export function normalizePluginCapabilityRequests(value: unknown): PluginCapabilityId[] {
  const parsed = pluginPermissionsSchema.parse(value ?? {})
  return [...new Set(parsed.requested)]
}
