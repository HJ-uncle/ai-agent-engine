/**
 * 统一工具注册工厂
 *
 * 所有路由（chat / messages / tools）都通过此函数创建一致的 ToolRegistry。
 * 新增或移除工具只需修改这一处。
 */
import { ToolRegistry } from '../core/tool-registry/index.js'
import type { Tool, AgentContext } from '../core/agent-context/index.js'
import { trustBuiltinTool } from '../security/tool-policy.js'
import { isCodeProfileTool, normalizeAllowedTools, normalizeToolName, type ToolProfile } from './tool-profile.js'
import { registerBuiltinSkills, skillsRegistry } from '../skills/index.js'
import {
  listFilesTool,
  deleteFileTool,
  createDirTool,
  readFileTool,
  writeFileTool,
  editFileTool,
} from './file/index.js'
import { cmdTool, commandJobTools } from './cmd/index.js'
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
import { createAgentTools } from './agent/index.js'
import type { InlineAgent } from './agent/index.js'
import { lspDiagnoseTool } from './lsp/index.js'
import { codegraphTool } from './codegraph/index.js'
import type { ExternalSkill } from '../skills/external-loader.js'
import {
  resolveDefaultAllowedTools,
  runOSMSelfCheck,
  logOSMSelfCheck,
  resolveOSMMode,
  OSM_MODE_CONFIG,
  isOsmSkillVisible,
} from '../core/osm.js'
import { logger } from '../observability/index.js'

export interface RegistryFactoryOptions {
  securityContext?: Pick<AgentContext, 'tenantId' | 'sessionId' | 'toolProfile'>
  /** Project root used to resolve project-scoped MCP configuration. */
  workspaceRoot?: string
  /** general preserves service capabilities; code selects the IDE's executable programming tools. */
  toolProfile?: ToolProfile
  /** Explicit memory extension for a conversation, independent of the programming profile. */
  memoryScope?: import('../storage/memory/settings.js').MemoryMode
  /** 允许的 skill 列表，undefined = 全部，[] = 全部，传入列表则过滤 */
  allowedSkills?: string[] | null
  /** undefined/null 使用 profile 默认集；[] 显式禁用；列表只能缩窄。general 保留原有始终注册的基础工具例外。 */
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
   *   - 支持 stdio / http / sse / streamableHttp；stdio 子进程由引擎
   *     按本次请求临时启动，不写入配置文件。
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
    disabledTools?: string[]
  }>
  /**
   * 客户端透传的内联 Agent 列表（请求级；用户端把用户 agent 列表随请求下发）。
   *
   * 行为：
   *   - agent_list / agent_get 工具合并本地 DB agents 与 inlineAgents 一起返回
   *   - 本地 DB agent 优先（按 id 去重）
   *   - inline agents 为只读，不参与写操作（agent_create 等仍写本地 DB）
   */
  inlineAgents?: InlineAgent[]
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
  const profile = opts.toolProfile ?? 'general'
  const explicitAllowedTools = normalizeAllowedTools(opts.allowedTools)
  const memoryTools = createMemoryTools()
  const memoryEnabled = opts.memoryScope !== 'off' && (profile !== 'code' || opts.memoryScope !== undefined)
  const memoryImplementations = new Set(memoryTools)
  const registry = new ToolRegistry(profile === 'code' ? (tool) =>
    (isCodeProfileTool(tool as Tool & { source?: string }) || (memoryEnabled && memoryImplementations.has(tool))) &&
    (explicitAllowedTools === undefined || explicitAllowedTools.includes(tool.name))
    : undefined)

  // ── Tool category tracking ────────────────────────────────────────────
  const builtinTools: string[] = []
  const skillTools: string[] = []

  /** Helper: register a tool into the registry and track it as builtin */
  const registerBuiltin = (tool: Tool) => {
    const readOnly = [readFileTool, listFilesTool, globTool, grepTool, getCurrentContextTool,
      ...commandJobTools.filter(candidate => candidate.name === 'command_output')].includes(tool)
    const mode = subagentTools.includes(tool) ? 'subagent' : readOnly ? 'readonly' : 'serial'
    registry.register(trustBuiltinTool(tool, mode))
    if (registry.has(tool.name)) builtinTools.push(tool.name)
  }

  // 技能工具名称（需要随自定义技能自动添加）
  const skillToolNames = ['list_skills', 'get_skill', 'run_skill_script']
  // 获取所有自定义技能名称/ID（含本地 SKILLS_ROOT 与客户端透传的 inlineSkills）
  // 注意：allowedSkills 白名单里可能是 skill 目录名/ID，也可能是显示名。
  // 为支持两种匹配方式，这里同时收集 name 和 id。
  const externalSkillNames = skillsRegistry.getSkills(opts.workspaceRoot).map(s => s.name)
  const inlineSkillNamesAndIds = Array.isArray(opts.inlineSkills)
    ? opts.inlineSkills.filter(s => s && s.name).flatMap(s => s.id ? [s.name, s.id] : [s.name])
    : []
  const allSkillNames = [...externalSkillNames, ...inlineSkillNamesAndIds]
  // 检查是否选择了自定义技能（本地或客户端 inline）
  // allowedSkills 元素可能是 skill name 或 skill id，两者都需要匹配
  const hasExternalSkill = opts.allowedSkills && opts.allowedSkills.length > 0 &&
    opts.allowedSkills.some(s => allSkillNames.includes(s))

  // ── Superpower 默认工具过滤（优先于技能合并）────────────────────────────
  // 当调用方没有显式指定 allowedTools 时，根据 superpower 开关决定默认工具集：
  //   ON  → 全量工具（undefined，走现有全注册逻辑）
  //   OFF → 仅核心工具（安全省 token）
  // Code capabilities are independent of OSM; an explicit list may only narrow the profile.
  let effectiveAllowedTools = profile === 'code'
    ? explicitAllowedTools
    : normalizeAllowedTools(resolveDefaultAllowedTools(opts.allowedTools))

  // 计算 effectiveAllowedTools：如果选择了自定义技能，自动添加技能工具
  //
  // ⚠️ 修复一个隐藏已久的 bug：以前当 effectiveAllowedTools === undefined 时
  //   会被错误地赋值为 `[...skillToolNames]`，导致"全量工具"被收窄为"仅 skill 三件套"。
  //   实际含义：undefined = 全量（shouldRegister 对所有工具返回 true），
  //   skill 工具本身已经在全量集合内，无需显式列出。继续保持 undefined 即可。
  //   这一 bug 在 superpower ON + 选了外部 skill 的场景下最明显：
  //   承诺"全量工具可用"但 Agent 突然失去了 run_command / web_fetch 等能力。
  if (profile === 'general' && hasExternalSkill) {
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
    return effectiveAllowedTools.includes(normalizeToolName(toolName))
  }

  // 1. General utility skills retain their old behavior; code's registration guard excludes them.
  registerBuiltinSkills(registry)
  skillTools.push(...registry.list().map(tool => tool.name))

  // 2. 文件工具（read_file / write_file / edit_file / list_files / delete_file / create_dir）
  // 支持格式：JSON, CSV, XLSX, XLS, PDF, DOC, DOCX, 代码, 文本
  const fileTools = [
    readFileTool,
    writeFileTool,
    editFileTool,
    listFilesTool,
    deleteFileTool,
    createDirTool,
  ]
  fileTools.forEach(t => {
    if (shouldRegister(t.name)) registerBuiltin(t)
  })

  // 3. 命令行工具
  if (shouldRegister(cmdTool.name)) registerBuiltin(cmdTool)
  commandJobTools.forEach(tool => { if (shouldRegister(tool.name)) registerBuiltin(tool) })

  // 4. 向用户提问工具 - 始终注册，交互需要
  registerBuiltin(askUserTool)

  // Only these builtin implementations may extend the code profile, not an extension with the same name.
  if (memoryEnabled) memoryTools.forEach(t => {
    if (shouldRegister(t.name)) registerBuiltin(t)
  })

  // 6. 外部 Skill 工具（按 allowedSkills 过滤；合并 inlineSkills）
  let externalSkills = skillsRegistry.getSkills(opts.workspaceRoot)

  // ── OSM 方法论 过滤 ──────────────────────────────────────────
  // methodology / max 档以外，隐藏所有方法论技能（os-* 系列），
  // 避免在 Balanced/Off 模式下干扰 Agent 或浪费 Token。
  // 使用 isOsmSkillVisible() 精确匹配，不依赖命名约定。
  const mode = resolveOSMMode()
  const osmHiddenSkills: string[] = []
  if (!OSM_MODE_CONFIG[mode].methodology) {
    externalSkills = externalSkills.filter(s => {
      if (isOsmSkillVisible(s.name, mode)) return true
      osmHiddenSkills.push(s.name)
      return false
    })
  }

  // ── 合并客户端透传的 inline skill ────────────────────────────────────────
  // 策略：本地 SKILLS_ROOT 已有的 name 优先（保留 .skill 包的真实文件实现），
  // 仅当本地没有同名 skill 时才把 inline 版本追加进去（虚拟 skill，仅做能力可见）。
  if (Array.isArray(opts.inlineSkills) && opts.inlineSkills.length > 0) {
    const existingNames = new Set(externalSkills.map(s => s.name.toLowerCase()))
    const inlineSkillsAsExternal: ExternalSkill[] = opts.inlineSkills
      .filter(s => s && s.name && !existingNames.has(s.name.toLowerCase()))
      .map((s, i) => ({
        id: s.id,  // 保留客户端 ID，供 allowedSkills 按 ID 匹配
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
    // allowedSkills 可能是 skill name 或 skill id（客户端传的是目录名/ID），两者都接受
    externalSkills = externalSkills.filter((s) =>
      opts.allowedSkills!.includes(s.name) || (s.id != null && opts.allowedSkills!.includes(s.id))
    )
  }

  createSkillTools(externalSkills, { osmMode: mode, hiddenSkills: osmHiddenSkills }).forEach((tool) => {
    registry.register(trustBuiltinTool(tool, 'readonly'))
    if (registry.has(tool.name)) skillTools.push(tool.name)
  })
  if (shouldRegister('run_skill_script')) {
    registry.register(runSkillScriptTool)
    if (registry.has(runSkillScriptTool.name)) skillTools.push(runSkillScriptTool.name)
  }

  // 7. 搜索工具（glob / grep）
  if (shouldRegister(globTool.name)) registerBuiltin(globTool)
  if (shouldRegister(grepTool.name)) registerBuiltin(grepTool)

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
    (name: string) => (profile !== 'code' || isCodeProfileTool({ name })) &&
      (explicitAllowedTools === undefined || explicitAllowedTools.includes(name)),
    opts.inlineMcpServers,
    opts.securityContext,
    opts.workspaceRoot
  )

  // 17. Agent 系统工具 - 按 allowedTools 过滤；注入 inlineAgents 供查询
  createAgentTools(opts.inlineAgents ?? []).forEach(t => {
    if (shouldRegister(t.name)) registerBuiltin(t)
  })

  // 18. 代码诊断工具（LSP：tsc + eslint），用于 AI 自动检查/修复代码
  if (shouldRegister('code_diagnose')) registerBuiltin(lspDiagnoseTool)

  // 19. 代码图查询工具（codegraph：只读查询符号/调用关系/影响面；索引缺失仅提示）
  if (shouldRegister('codegraph')) registerBuiltin(codegraphTool)

  // ── Superpower 自检 ────────────────────────────────────────────────────
  // 验证 CORE 工具名与 registry 实际注册保持一致，避免 OFF 模式下 Agent
  // 因工具名变更而"静默失去能力"。只在注册最多的完整场景（allowedTools
  // 为 undefined，即本次 registry 理论上应包含所有内置工具）触发。
  if (profile === 'general' && effectiveAllowedTools === undefined) {
    const result = runOSMSelfCheck(registry)
    logOSMSelfCheck(logger, result)
  }

  // Classify the actual registry, including skipped dynamic registrations and name collisions.
  const registeredNames = registry.list().map(tool => tool.name)
  const skillNames = new Set(skillTools)
  const builtinNames = new Set(builtinTools)
  const mcpNames = new Set(mcpTools.filter(name => !skillNames.has(name) && !builtinNames.has(name)))
  const toolCategories: ToolCategories = {
    builtinTools: registeredNames.filter(name => !skillNames.has(name) && !mcpNames.has(name)),
    mcpTools: registeredNames.filter(name => mcpNames.has(name)),
    skillTools: registeredNames.filter(name => skillNames.has(name)),
  }
  return { registry, externalSkills, toolCategories }
}
