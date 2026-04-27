/**
 * 统一工具注册工厂
 *
 * 所有路由（chat / messages / tools）都通过此函数创建一致的 ToolRegistry。
 * 新增或移除工具只需修改这一处。
 */
import { ToolRegistry } from '../core/tool-registry/index.js'
import { SQLiteMemoryStore } from '../storage/memory-store/index.js'
import { registerBuiltinSkills, skillsRegistry } from '../skills/index.js'
import { fileTools } from './file/index.js'
import { cmdTool } from './cmd/index.js'
import { askUserTool } from './ask-user/index.js'
import { createMemoryTools } from './memory/index.js'
import { registerMCPTools } from './mcp/loader.js'
import { createSkillTools, runSkillScriptTool } from './skill/index.js'
import { globTool } from './search/glob-tool.js'
import { grepTool } from './search/grep-tool.js'
import { todoTools } from './todo/todo-tool.js'
import { cronTools } from './cron/cron-tool.js'
import { taskControlTools } from './task/task-tool.js'
import { subagentTools } from './subagent/index.js'
import { webFetchTool } from './web-fetch/index.js'
import { httpRequestTool } from './http-request/index.js'
import { getCurrentContextTool } from './get-context/index.js'
import { installPackageTool, listPackagesTool } from './install-package/install-package-tool.js'
import { agentTools } from './agent/index.js'
import type { ExternalSkill } from '../skills/external-loader.js'

export interface RegistryFactoryOptions {
  /** 允许的 skill 列表，undefined = 全部，[] = 全部，传入列表则过滤 */
  allowedSkills?: string[] | null
  /** 允许的系统工具列表，undefined = 全部，[] = 全部，传入列表则只注册指定的工具 */
  allowedTools?: string[] | null
}

/**
 * 创建并返回一个已注册所有内置工具的 ToolRegistry。
 * 同时返回 skillsPrompt（供 system prompt 使用）和实际注册的 skills 列表。
 */
export async function createToolRegistry(opts: RegistryFactoryOptions = {}): Promise<{
  registry: ToolRegistry
  memory: SQLiteMemoryStore
  externalSkills: ExternalSkill[]
}> {
  const registry = new ToolRegistry()
  const memory = new SQLiteMemoryStore()

  // 技能工具名称（需要随自定义技能自动添加）
  const skillToolNames = ['list_skills', 'get_skill', 'run_skill_script']
  // 获取所有自定义技能名称
  const externalSkillNames = skillsRegistry.getSkills().map(s => s.name)
  // 检查是否选择了自定义技能
  const hasExternalSkill = opts.allowedSkills && opts.allowedSkills.length > 0 &&
    opts.allowedSkills.some(s => externalSkillNames.includes(s))

  // 计算 effectiveAllowedTools：如果选择了自定义技能，自动添加技能工具
  let effectiveAllowedTools = opts.allowedTools
  if (hasExternalSkill) {
    if (effectiveAllowedTools === undefined || effectiveAllowedTools === null) {
      effectiveAllowedTools = [...skillToolNames]
    } else if (effectiveAllowedTools.length > 0) {
      effectiveAllowedTools = [...new Set([...effectiveAllowedTools, ...skillToolNames])]
    }
  }

  const shouldRegister = (toolName: string): boolean => {
    if (effectiveAllowedTools === undefined || effectiveAllowedTools === null) return true
    if (effectiveAllowedTools.length === 0) return true
    return effectiveAllowedTools.includes(toolName)
  }

  // 1. 内置 Skill（list_skills / get_skill）- 始终注册，AI 需要知道自己有哪些技能
  registerBuiltinSkills(registry)

  // 2. 文件工具（read_file / write_file / list_files / delete_file / create_dir / read_image）
  if (shouldRegister('read_file')) fileTools.filter(t => t.name === 'read_file').forEach((t) => registry.register(t))
  if (shouldRegister('write_file')) fileTools.filter(t => t.name === 'write_file').forEach((t) => registry.register(t))
  if (shouldRegister('list_files')) fileTools.filter(t => t.name === 'list_files').forEach((t) => registry.register(t))
  if (shouldRegister('delete_file')) fileTools.filter(t => t.name === 'delete_file').forEach((t) => registry.register(t))
  if (shouldRegister('create_dir')) fileTools.filter(t => t.name === 'create_dir').forEach((t) => registry.register(t))
  if (shouldRegister('read_image')) fileTools.filter(t => t.name === 'read_image').forEach((t) => registry.register(t))

  // 3. 命令行工具
  if (shouldRegister('run_command')) registry.register(cmdTool)

  // 4. 向用户提问工具 - 始终注册，交互需要
  registry.register(askUserTool)

  // 5. 记忆工具（remember / recall / search_memory）
  if (shouldRegister('remember')) createMemoryTools(memory).filter(t => t.name === 'remember').forEach((t) => registry.register(t))
  if (shouldRegister('recall')) createMemoryTools(memory).filter(t => t.name === 'recall').forEach((t) => registry.register(t))
  if (shouldRegister('search_memory')) createMemoryTools(memory).filter(t => t.name === 'search_memory').forEach((t) => registry.register(t))

  // 6. 外部 Skill 工具（按 allowedSkills 过滤）
  let externalSkills = skillsRegistry.getSkills()
  if (opts.allowedSkills && opts.allowedSkills.length > 0) {
    externalSkills = externalSkills.filter((s) => opts.allowedSkills!.includes(s.name))
  }

  createSkillTools(externalSkills).forEach((t) => registry.register(t))
  if (shouldRegister('run_skill_script')) registry.register(runSkillScriptTool)

  // 7. 搜索工具（glob / grep）
  if (shouldRegister('glob')) registry.register(globTool)
  if (shouldRegister('grep')) registry.register(grepTool)

  // 8. 待办任务工具（todo_list / todo_create / todo_update / todo_delete）
  if (shouldRegister('todo_list')) todoTools.filter(t => t.name === 'todo_list').forEach((t) => registry.register(t))
  if (shouldRegister('todo_create')) todoTools.filter(t => t.name === 'todo_create').forEach((t) => registry.register(t))
  if (shouldRegister('todo_update')) todoTools.filter(t => t.name === 'todo_update').forEach((t) => registry.register(t))
  if (shouldRegister('todo_delete')) todoTools.filter(t => t.name === 'todo_delete').forEach((t) => registry.register(t))

  // 9. 定时任务工具（cron_list / cron_create / cron_update / cron_delete）
  if (shouldRegister('cron_list')) cronTools.filter(t => t.name === 'cron_list').forEach((t) => registry.register(t))
  if (shouldRegister('cron_create')) cronTools.filter(t => t.name === 'cron_create').forEach((t) => registry.register(t))
  if (shouldRegister('cron_update')) cronTools.filter(t => t.name === 'cron_update').forEach((t) => registry.register(t))
  if (shouldRegister('cron_delete')) cronTools.filter(t => t.name === 'cron_delete').forEach((t) => registry.register(t))

  // 10. 后台任务控制工具（task_list / task_cancel / task_status）
  if (shouldRegister('task_list')) taskControlTools.filter(t => t.name === 'task_list').forEach((t) => registry.register(t))
  if (shouldRegister('task_cancel')) taskControlTools.filter(t => t.name === 'task_cancel').forEach((t) => registry.register(t))
  if (shouldRegister('task_status')) taskControlTools.filter(t => t.name === 'task_status').forEach((t) => registry.register(t))

  // 11. Subagent 工具
  if (shouldRegister('subagent')) subagentTools.forEach((t) => registry.register(t))

  // 12. Web 获取工具
  if (shouldRegister('web_fetch')) registry.register(webFetchTool)

  // 13. HTTP 请求工具
  if (shouldRegister('http_request')) registry.register(httpRequestTool)

  // 14. 获取当前上下文工具
  if (shouldRegister('get_current_context')) registry.register(getCurrentContextTool)

  // 15. 安装包工具
  if (shouldRegister('install_package')) registry.register(installPackageTool)
  if (shouldRegister('list_packages')) registry.register(listPackagesTool)

  // 16. MCP 工具（动态加载）- 按名称过滤
  await registerMCPTools(registry, opts.allowedTools ? (name: string) => opts.allowedTools!.includes(name) : undefined)

  // 17. Agent 系统工具 - 按 allowedTools 过滤
  if (shouldRegister('agent_list')) agentTools.filter(t => t.name === 'agent_list').forEach((t) => registry.register(t))
  if (shouldRegister('agent_get')) agentTools.filter(t => t.name === 'agent_get').forEach((t) => registry.register(t))
  if (shouldRegister('agent_create')) agentTools.filter(t => t.name === 'agent_create').forEach((t) => registry.register(t))
  if (shouldRegister('agent_do_create')) agentTools.filter(t => t.name === 'agent_do_create').forEach((t) => registry.register(t))
  if (shouldRegister('agent_update')) agentTools.filter(t => t.name === 'agent_update').forEach((t) => registry.register(t))
  if (shouldRegister('agent_do_update')) agentTools.filter(t => t.name === 'agent_do_update').forEach((t) => registry.register(t))
  if (shouldRegister('agent_delete')) agentTools.filter(t => t.name === 'agent_delete').forEach((t) => registry.register(t))
  if (shouldRegister('agent_do_delete')) agentTools.filter(t => t.name === 'agent_do_delete').forEach((t) => registry.register(t))

  return { registry, memory, externalSkills }
}
