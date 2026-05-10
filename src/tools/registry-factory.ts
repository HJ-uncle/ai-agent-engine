/**
 * 统一工具注册工厂
 *
 * 所有路由（chat / messages / tools）都通过此函数创建一致的 ToolRegistry。
 * 新增或移除工具只需修改这一处。
 */
import { ToolRegistry } from '../core/tool-registry/index.js'
import { SQLiteMemoryStore } from '../storage/memory-store/index.js'
import { registerBuiltinSkills, skillsRegistry } from '../skills/index.js'
import { fileTools, smartReadFileTool } from './file/index.js'
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
import { lspDiagnoseTool } from './lsp/index.js'
import type { ExternalSkill } from '../skills/external-loader.js'

export interface RegistryFactoryOptions {
  /** 允许的 skill 列表，undefined = 全部，[] = 全部，传入列表则过滤 */
  allowedSkills?: string[] | null
  /** 允许的系统工具列表，undefined = 全部，[] = 全部，传入列表则只注册指定的工具 */
  allowedTools?: string[] | null
  /**
   * 客户端透传的内联 Skill 列表（请求级；典型场景：wuzu 桌面客户端把
   * 本地安装的 skill 在 chat 请求时一同下发）
   *
   * 行为：
   *   - 转换为 ExternalSkill 后追加到 externalSkills 列表
   *   - 与 SKILLS_ROOT 已有的 skill 按 name 去重（已有的优先，避免覆盖文件实现）
   *   - inlineSkill 没有真实 skillMdPath，调用 run_skill_script 会失败
   *     （Phase B 仅做"能力可见"，工具实际执行待 Phase C 实现）
   */
  inlineSkills?: Array<{
    id: string
    name: string
    description?: string
    promptContent?: string
    version?: string
  }>
  /**
   * 客户端透传的内联 MCP server 配置（请求级临时挂载）
   *
   * 行为：
   *   - 仅支持 http / sse / streamableHttp 三种远程协议（stdio 跳过——
   *     wuzu 端启动的 stdio 子进程 agent-engine 接不到）
   *   - 在 mcp loader 已注册的 server 之外追加这些 inline server
   *   - 连接失败的 inline server 仅 warn，不阻断 chat 流程
   */
  inlineMcpServers?: Array<{
    id: string
    name: string
    transportType: 'stdio' | 'sse' | 'http' | 'streamableHttp'
    command?: string
    args?: string[]
    env?: Record<string, string>
    url?: string
    headers?: Record<string, string>
  }>
}

/**
 * 创建并返回一个已注册所有内置工具的 ToolRegistry。
 * 同时返回 skillsPrompt（供 system prompt 使用）和实际注册的 skills 列表。
 */
export interface ToolCategories {
  builtinTools: string[]
  mcpTools: string[]
  skillTools: string[]
}

export async function createToolRegistry(opts: RegistryFactoryOptions = {}): Promise<{
  registry: ToolRegistry
  memory: SQLiteMemoryStore
  externalSkills: ExternalSkill[]
  toolCategories: ToolCategories
}> {
  const registry = new ToolRegistry()
  const memory = new SQLiteMemoryStore()

  // ── Tool category tracking ────────────────────────────────────────────
  const builtinTools: string[] = []
  const skillTools: string[] = []

  /** Helper: register a tool into the registry and track it as builtin */
  const registerBuiltin = (t: { name: string; [k: string]: any }) => {
    registry.register(t as any)
    builtinTools.push(t.name)
  }

  // 技能工具名称（需要随自定义技能自动添加）
  const skillToolNames = ['list_skills', 'get_skill', 'run_skill_script']
  // 获取所有自定义技能名称（含本地 SKILLS_ROOT 与客户端透传的 inlineSkills）
  const externalSkillNames = skillsRegistry.getSkills().map(s => s.name)
  const inlineSkillNames = Array.isArray(opts.inlineSkills)
    ? opts.inlineSkills.filter(s => s && s.name).map(s => s.name)
    : []
  const allSkillNames = [...externalSkillNames, ...inlineSkillNames]
  // 检查是否选择了自定义技能（本地或客户端 inline）
  const hasExternalSkill = opts.allowedSkills && opts.allowedSkills.length > 0 &&
    opts.allowedSkills.some(s => allSkillNames.includes(s))

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
    // undefined / null = 未配置，加载全部工具
    if (effectiveAllowedTools === undefined || effectiveAllowedTools === null) return true
    // 空数组 = Agent 明确设置了"不允许任何工具"，禁用全部
    if (effectiveAllowedTools.length === 0) return false
    return effectiveAllowedTools.includes(toolName)
  }

  // 1. 内置 Skill（list_skills / get_skill）- 始终注册，AI 需要知道自己有哪些技能
  registerBuiltinSkills(registry)
  // list_skills / get_skill are skill-infrastructure tools → track as skill
  skillTools.push('list_skills', 'get_skill')

  // 2. 文件工具（smart_read 万能读取 / read_file 原始读取 / write_file / list_files / delete_file / create_dir）
  //    smart_read 已内置图片识别，无需单独注册 read_image
  if (shouldRegister('smart_read')) registerBuiltin(smartReadFileTool)
  if (shouldRegister('read_file')) fileTools.filter(t => t.name === 'read_file').forEach((t) => registerBuiltin(t))
  if (shouldRegister('write_file')) fileTools.filter(t => t.name === 'write_file').forEach((t) => registerBuiltin(t))
  if (shouldRegister('list_files')) fileTools.filter(t => t.name === 'list_files').forEach((t) => registerBuiltin(t))
  if (shouldRegister('delete_file')) fileTools.filter(t => t.name === 'delete_file').forEach((t) => registerBuiltin(t))
  if (shouldRegister('create_dir')) fileTools.filter(t => t.name === 'create_dir').forEach((t) => registerBuiltin(t))

  // 3. 命令行工具
  if (shouldRegister('run_command')) registerBuiltin(cmdTool)

  // 4. 向用户提问工具 - 始终注册，交互需要
  registerBuiltin(askUserTool)

  // 5. 记忆工具（remember / recall / search_memory）
  if (shouldRegister('remember')) createMemoryTools(memory).filter(t => t.name === 'remember').forEach((t) => registerBuiltin(t))
  if (shouldRegister('recall')) createMemoryTools(memory).filter(t => t.name === 'recall').forEach((t) => registerBuiltin(t))
  if (shouldRegister('search_memory')) createMemoryTools(memory).filter(t => t.name === 'search_memory').forEach((t) => registerBuiltin(t))

  // 6. 外部 Skill 工具（按 allowedSkills 过滤；合并 inlineSkills）
  let externalSkills = skillsRegistry.getSkills()
  // ── 合并客户端透传的 inline skill ────────────────────────────────────────
  // 策略：本地 SKILLS_ROOT 已有的 name 优先（保留 .skill 包的真实文件实现），
  // 仅当本地没有同名 skill 时才把 inline 版本追加进去（虚拟 skill，仅做能力可见）。
  if (Array.isArray(opts.inlineSkills) && opts.inlineSkills.length > 0) {
    const existingNames = new Set(externalSkills.map(s => s.name.toLowerCase()))
    const inlineSkillsAsExternal: ExternalSkill[] = opts.inlineSkills
      .filter(s => s && s.name && !existingNames.has(s.name.toLowerCase()))
      .map((s, i) => ({
        name: s.name,
        description: s.description ?? `Skill: ${s.name}${s.version ? ` (v${s.version})` : ''}`,
        skillMdPath: '', // 无本地文件，依赖 inlineContent
        order: 1000 + i, // 排在本地 skill 之后
        enabled: true,
        inlineContent: s.promptContent
      }))
    if (inlineSkillsAsExternal.length > 0) {
      externalSkills = [...externalSkills, ...inlineSkillsAsExternal]
    }
  }
  if (opts.allowedSkills && opts.allowedSkills.length > 0) {
    externalSkills = externalSkills.filter((s) => opts.allowedSkills!.includes(s.name))
  }

  createSkillTools(externalSkills).forEach((t) => { registry.register(t); skillTools.push(t.name) })
  if (shouldRegister('run_skill_script')) { registry.register(runSkillScriptTool); skillTools.push(runSkillScriptTool.name) }

  // 7. 搜索工具（glob / grep）
  if (shouldRegister('glob')) registerBuiltin(globTool)
  if (shouldRegister('grep')) registerBuiltin(grepTool)

  // 8. 待办任务工具（todo_list / todo_create / todo_update / todo_delete）
  if (shouldRegister('todo_list')) todoTools.filter(t => t.name === 'todo_list').forEach((t) => registerBuiltin(t))
  if (shouldRegister('todo_create')) todoTools.filter(t => t.name === 'todo_create').forEach((t) => registerBuiltin(t))
  if (shouldRegister('todo_update')) todoTools.filter(t => t.name === 'todo_update').forEach((t) => registerBuiltin(t))
  if (shouldRegister('todo_delete')) todoTools.filter(t => t.name === 'todo_delete').forEach((t) => registerBuiltin(t))

  // 9. 定时任务工具（cron_list / cron_create / cron_update / cron_delete）
  if (shouldRegister('cron_list')) cronTools.filter(t => t.name === 'cron_list').forEach((t) => registerBuiltin(t))
  if (shouldRegister('cron_create')) cronTools.filter(t => t.name === 'cron_create').forEach((t) => registerBuiltin(t))
  if (shouldRegister('cron_update')) cronTools.filter(t => t.name === 'cron_update').forEach((t) => registerBuiltin(t))
  if (shouldRegister('cron_delete')) cronTools.filter(t => t.name === 'cron_delete').forEach((t) => registerBuiltin(t))

  // 10. 后台任务控制工具（task_list / task_cancel / task_status）
  if (shouldRegister('task_list')) taskControlTools.filter(t => t.name === 'task_list').forEach((t) => registerBuiltin(t))
  if (shouldRegister('task_cancel')) taskControlTools.filter(t => t.name === 'task_cancel').forEach((t) => registerBuiltin(t))
  if (shouldRegister('task_status')) taskControlTools.filter(t => t.name === 'task_status').forEach((t) => registerBuiltin(t))

  // 11. Subagent 工具
  if (shouldRegister('subagent')) subagentTools.forEach((t) => registerBuiltin(t))

  // 12. Web 获取工具
  if (shouldRegister('web_fetch')) registerBuiltin(webFetchTool)

  // 13. HTTP 请求工具
  if (shouldRegister('http_request')) registerBuiltin(httpRequestTool)

  // 14. 获取当前上下文工具
  if (shouldRegister('get_current_context')) registerBuiltin(getCurrentContextTool)

  // 15. 安装包工具
  if (shouldRegister('install_package')) registerBuiltin(installPackageTool)
  if (shouldRegister('list_packages')) registerBuiltin(listPackagesTool)

  // 16. MCP 工具（动态加载）- 按名称过滤；合并 inlineMcpServers
  const mcpTools = await registerMCPTools(
    registry,
    opts.allowedTools ? (name: string) => opts.allowedTools!.includes(name) : undefined,
    opts.inlineMcpServers
  )

  // 17. Agent 系统工具 - 按 allowedTools 过滤
  if (shouldRegister('agent_list')) agentTools.filter(t => t.name === 'agent_list').forEach((t) => registerBuiltin(t))
  if (shouldRegister('agent_get')) agentTools.filter(t => t.name === 'agent_get').forEach((t) => registerBuiltin(t))
  if (shouldRegister('agent_create')) agentTools.filter(t => t.name === 'agent_create').forEach((t) => registerBuiltin(t))
  if (shouldRegister('agent_do_create')) agentTools.filter(t => t.name === 'agent_do_create').forEach((t) => registerBuiltin(t))
  if (shouldRegister('agent_update')) agentTools.filter(t => t.name === 'agent_update').forEach((t) => registerBuiltin(t))
  if (shouldRegister('agent_do_update')) agentTools.filter(t => t.name === 'agent_do_update').forEach((t) => registerBuiltin(t))
  if (shouldRegister('agent_delete')) agentTools.filter(t => t.name === 'agent_delete').forEach((t) => registerBuiltin(t))
  if (shouldRegister('agent_do_delete')) agentTools.filter(t => t.name === 'agent_do_delete').forEach((t) => registerBuiltin(t))

  // 18. 代码诊断工具（LSP：tsc + eslint），用于 AI 自动检查/修复代码
  if (shouldRegister('code_diagnose')) registerBuiltin(lspDiagnoseTool)

  const toolCategories: ToolCategories = { builtinTools, mcpTools, skillTools }
  return { registry, memory, externalSkills, toolCategories }
}
