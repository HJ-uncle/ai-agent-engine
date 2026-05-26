/**
 * 统一工具注册工厂
 *
 * 所有路由（chat / messages / tools）都通过此函数创建一致的 ToolRegistry。
 * 新增或移除工具只需修改这一处。
 */
import { ToolRegistry } from '../core/tool-registry/index.js'
import { registerBuiltinSkills, skillsRegistry } from '../skills/index.js'
import {
  listFilesTool,
  deleteFileTool,
  createDirTool,
  readFileTool,
  writeFileTool,
} from './file/index.js'
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
import { resolveDefaultAllowedTools, runSuperpowerSelfCheck, logSuperpowerSelfCheck } from '../core/superpower.js'
import { logger } from '../observability/index.js'

export interface RegistryFactoryOptions {
  /** 允许的 skill 列表，undefined = 全部，[] = 全部，传入列表则过滤 */
  allowedSkills?: string[] | null
  /** 允许的系统工具列表，undefined = 全部，[] = 全部，传入列表则只注册指定的工具 */
  allowedTools?: string[] | null
  /**
   * 客户端透传的内联 Skill 列表（请求级；典型场景：桌面客户端把
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
   *     端启动的 stdio 子进程 agent-engine 接不到）
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
  externalSkills: ExternalSkill[]
  toolCategories: ToolCategories
}> {
  const registry = new ToolRegistry()

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

  // ── Superpower 默认工具过滤（优先于技能合并）────────────────────────────
  // 当调用方没有显式指定 allowedTools 时，根据 superpower 开关决定默认工具集：
  //   ON  → 全量工具（undefined，走现有全注册逻辑）
  //   OFF → 仅核心工具（安全省 token）
  let effectiveAllowedTools = resolveDefaultAllowedTools(opts.allowedTools)

  // 计算 effectiveAllowedTools：如果选择了自定义技能，自动添加技能工具
  //
  // ⚠️ 修复一个隐藏已久的 bug：以前当 effectiveAllowedTools === undefined 时
  //   会被错误地赋值为 `[...skillToolNames]`，导致"全量工具"被收窄为"仅 skill 三件套"。
  //   实际含义：undefined = 全量（shouldRegister 对所有工具返回 true），
  //   skill 工具本身已经在全量集合内，无需显式列出。继续保持 undefined 即可。
  //   这一 bug 在 superpower ON + 选了外部 skill 的场景下最明显：
  //   承诺"全量工具可用"但 Agent 突然失去了 run_command / web_fetch 等能力。
  if (hasExternalSkill) {
    if (effectiveAllowedTools === undefined || effectiveAllowedTools === null) {
      // 保持 undefined：全量工具已经包含 skill 工具，无需窄化
      // (prev bug: effectiveAllowedTools = [...skillToolNames])
    } else if (effectiveAllowedTools.length > 0) {
      effectiveAllowedTools = [...new Set([...effectiveAllowedTools, ...skillToolNames])]
    }
    // effectiveAllowedTools.length === 0 → 调用方显式要求"无工具"，保持空数组
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

  // 2. 文件工具（read_file / write_file / list_files / delete_file / create_dir）
  // 支持格式：JSON, CSV, XLSX, XLS, PDF, DOC, DOCX, 代码, 文本
  const fileTools = [
    readFileTool,
    writeFileTool,
    listFilesTool,
    deleteFileTool,
    createDirTool,
  ]
  fileTools.forEach(t => {
    if (shouldRegister(t.name)) registerBuiltin(t)
  })

  // 3. 命令行工具
  if (shouldRegister('run_command')) registerBuiltin(cmdTool)

  // 4. 向用户提问工具 - 始终注册，交互需要
  registerBuiltin(askUserTool)

  // 5. 记忆工具（remember / recall / search_memory / list_memories / forget）
  createMemoryTools().forEach(t => {
    if (shouldRegister(t.name)) registerBuiltin(t)
  })

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
  todoTools.forEach(t => {
    if (shouldRegister(t.name)) registerBuiltin(t)
  })

  // 9. 定时任务工具（cron_list / cron_create / cron_update / cron_delete）
  cronTools.forEach(t => {
    if (shouldRegister(t.name)) registerBuiltin(t)
  })

  // 10. 后台任务控制工具（task_list / task_cancel / task_status）
  taskControlTools.forEach(t => {
    if (shouldRegister(t.name)) registerBuiltin(t)
  })

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
  agentTools.forEach(t => {
    if (shouldRegister(t.name)) registerBuiltin(t)
  })

  // 18. 代码诊断工具（LSP：tsc + eslint），用于 AI 自动检查/修复代码
  if (shouldRegister('code_diagnose')) registerBuiltin(lspDiagnoseTool)

  // ── Superpower 自检 ────────────────────────────────────────────────────
  // 验证 CORE 工具名与 registry 实际注册保持一致，避免 OFF 模式下 Agent
  // 因工具名变更而"静默失去能力"。只在注册最多的完整场景（allowedTools
  // 为 undefined，即本次 registry 理论上应包含所有内置工具）触发。
  if (effectiveAllowedTools === undefined) {
    const result = runSuperpowerSelfCheck(registry)
    logSuperpowerSelfCheck(logger, result)
  }

  const toolCategories: ToolCategories = { builtinTools, mcpTools, skillTools }
  return { registry, externalSkills, toolCategories }
}
