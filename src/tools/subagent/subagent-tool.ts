import type { Tool, AgentContext, ToolResult, IToolRegistry } from '../../core/agent-context/index.js'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs'
import { ReActStrategy } from '../../core/agent-loop/react.js'
import { createAgentContext } from '../../core/agent-context/factory.js'
import { createConversationHistory } from '../../storage/conversation/factory.js'
import { resolveModelConfig, createAdapterFromResolved } from '../../core/llm-adapter/resolve-model.js'
import { getSubagentRunner } from '../../core/subagent/runner.js'
import { hasSubagentTaskContent } from '../../core/subagent/task-content.js'
import { isTerminalRun, outcomeText, type SubagentContinuationProfile } from '../../core/subagent/types.js'
import { SQLiteAgentStore } from '../../storage/agent/index.js'
import { searchChunks } from '../../storage/knowledge/kb-repo.js'
import { getProjectContextBlock } from '../../core/project-context.js'
import { getSecurityMode, setSecurityMode, clearSecurityMode } from '../../security/policy-engine.js'
import { skillsRegistry, buildSkillsSystemPrompt } from '../../skills/index.js'
import { resolveOSMMode, OSM_MODE_CONFIG } from '../../core/osm.js'
import { CODE_AGENT_HANDOFF_PROMPT } from '../../core/code-agent-prompt.js'
import { normalizeAllowedTools } from '../tool-profile.js'
import { REMOVED_TOOL_NAMES } from '../tool-exposure.js'
import { compactBuiltinToolDefinition } from '../model-tool-definitions.js'
import { loadModelTools, selectRequestTools } from '../model-tool-loading.js'
import { throwIfAborted } from '../../core/utils/abort.js'
import { ToolRegistry } from '../../core/tool-registry/index.js'
import { trustBuiltinTool } from '../../security/tool-policy.js'
import { todoTools } from '../todo/todo-tool.js'
import { officeInspectTool } from '../office/index.js'
import { installProductionCollaborationBoundary } from '../../core/collaboration/production-boundary.js'
import { BUILTIN_AGENT_ROLES, BUILTIN_AGENT_TEMPLATES, isBuiltinAgentRole } from '../../core/subagent/builtin-roles.js'
import { workspaceManager } from '../../workspace/index.js'
import { captureSubagentWorkspace, continuationWorkspacePaths, subagentWorkspaceMatches } from './workspace-scope.js'
import { withReadonlyCodegraph } from '../codegraph/codegraph-readonly.js'
import { buildOfficeExecutionPrompt } from '../../core/office-prompt.js'

/**
 * Subagent 工具
 *
 * 创建一个子代理来执行特定任务，支持自定义系统提示词与模型。
 * 子代理会在独立的会话中运行，完成后返回结果。
 *
 * 可选 `role` 参数（方法论模式下推荐使用）：
 *   - `implementer`          — 执行 TDD 实现
 *   - `spec-reviewer`        — 对照 spec 审查实现
 *   - `code-quality-reviewer`— 代码质量审查
 * 设置 role 时会自动加载 `SKILLs/os-subagent-driven-dev/<role>-prompt.md`
 * 作为默认系统提示词基底；调用方如另外给了 `systemPrompt` 则 append 到其后。
 */
export const ROLE_VALUES = ['implementer', 'spec-reviewer', 'code-quality-reviewer'] as const
export type SubagentRole = typeof ROLE_VALUES[number]

const ROLE_SKILL_DIR = 'os-subagent-driven-dev'

/**
 * 根据 role 名加载对应的 prompt 模板。
 * 定位路径：skillsRegistry 中 `os-subagent-driven-dev` 技能 SKILL.md
 *           所在目录下的 `<role>-prompt.md`。
 * 找不到时返回 null（调用方会 warn + 回退默认行为）。
 */
export function __loadRoleTemplateForTests(role: SubagentRole): string | null {
  return loadRoleTemplate(role)
}

function loadRoleTemplate(role: SubagentRole): string | null {
  const bundleSkill = skillsRegistry.getSkills().find(
    (s) => s.name.toLowerCase() === ROLE_SKILL_DIR.toLowerCase() ||
      (s.skillMdPath && path.basename(path.dirname(s.skillMdPath)).toLowerCase() === ROLE_SKILL_DIR),
  )
  if (!bundleSkill || !bundleSkill.skillMdPath) return null
  const promptPath = path.join(path.dirname(bundleSkill.skillMdPath), `${role}-prompt.md`)
  try {
    if (!fs.existsSync(promptPath)) return null
    const raw = fs.readFileSync(promptPath, 'utf-8')
    return raw.trim() ? raw : null
  } catch {
    return null
  }
}

/** Only known read operations belong to research roles; arbitrary MCP/script tools may mutate external state. */
const RESEARCH_TOOLS = new Set([
  'load_tools',
  'read_file', 'smart_read', 'list_files', 'glob', 'grep', 'web_fetch',
  'list_skills', 'get_skill', 'codegraph', 'search_history', 'workbench_context',
  'browser_tabs', 'browser_snapshot', 'browser_screenshot', 'browser_console', 'browser_network', 'browser_network_request',
  'todo_list', 'todo_create', 'todo_update', 'todo_delete', 'plan_update',
  'recall', 'search_memory', 'list_memories',
  'subagent_send', 'subagent_participants', 'subagent_inbox', 'subagent_directory', 'subagent_request_input', 'subagent_read_result',
])

const RECURSIVE_TOOLS = new Set(['subagent', 'subagent_start', 'subagent_followup', 'spawn_agent', 'start_agent'])
const ROOT_ONLY_TOOLS = new Set(['ask_user', 'deliver_files', 'collaborator_dispatch'])
const READONLY_CODEGRAPH_ACTIONS = ['status', 'search', 'callers', 'callees', 'impact', 'files'] as const

function readonlyActionDenied(name: string, args: unknown): ToolResult | undefined {
  if (name !== 'codegraph') return undefined
  const action = args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>).action : undefined
  if (typeof action === 'string' && (READONLY_CODEGRAPH_ACTIONS as readonly string[]).includes(action)) return undefined
  return { success: false, output: '只读调研仅允许查询已有代码图，不能创建或更新索引。请向主 Agent 说明需要的执行工作。',
    metadata: { blocked: true, code: 'TOOL_ACTION_NOT_ALLOWED' } }
}

function readonlyChildTool(parent: IToolRegistry, name: string): boolean {
  if (name === 'load_tools') return parent.hasModelToolLoader?.() === true
  // Environment discovery starts Python/PowerShell probes, so only document
  // inspection belongs to a research role that promises no command execution.
  return RESEARCH_TOOLS.has(name) || name === officeInspectTool.name
    && parent.executionMode?.(name, {}) === 'readonly'
}

export function createSubagentToolRegistry(parent: IToolRegistry, readOnly: boolean): IToolRegistry {
  // The child owns a session-local plan even when a legacy parent lacks this
  // builtin. Never delegate its reserved identity to a parent extension.
  const internalPlan = new ToolRegistry()
  for (const tool of todoTools) if (tool.name === 'plan_update') internalPlan.register(trustBuiltinTool(tool), compactBuiltinToolDefinition(tool))
  const catalog = (forModel = false) => [...(forModel ? parent.listForModel?.() ?? parent.list() : parent.list())
    .filter(tool => tool.name !== 'plan_update' && !REMOVED_TOOL_NAMES.has(tool.name)), ...(forModel ? internalPlan.listForModel() : internalPlan.list())]
  // list() contains public definitions, so implementation identity is unavailable;
  // only the parent's trusted readonly policy admits this diagnostic to research.
  const names = new Set(catalog().filter((tool) => !RECURSIVE_TOOLS.has(tool.name) && !ROOT_ONLY_TOOLS.has(tool.name)
    && (!readOnly || readonlyChildTool(parent, tool.name))).map((tool) => tool.name))
  const owner = (name: string) => name === 'plan_update' ? internalPlan : parent
  const loadedModelTools = new Set<string>()
  const registrationVersions = new Map([...names].map(name => [name, owner(name).modelToolRegistrationVersion?.(name)]))
  const invalidatedModelHistory = new Set<string>()
  const allowed = (name: string) => names.has(name) && owner(name).has(name) && (!readOnly || readonlyChildTool(parent, name))
  const synchronizeLoading = () => {
    for (const name of names) {
      const version = owner(name).modelToolRegistrationVersion?.(name)
      if (version !== registrationVersions.get(name)) { loadedModelTools.delete(name); invalidatedModelHistory.add(name) }
      registrationVersions.set(name, version)
    }
  }
  const trustedLoader = () => allowed('load_tools') && parent.hasModelToolLoader?.() === true
  const definitions = (forModel = false) => catalog(forModel).filter((tool) => allowed(tool.name)).map(tool => readOnly && tool.name === 'codegraph' ? {
    ...tool, description: '只读查询已有代码图：索引状态、符号、调用关系、影响面和文件。调研子代理不能创建或更新索引。',
    parameters: { ...tool.parameters, properties: { ...tool.parameters.properties,
      action: { type: 'string', enum: [...READONLY_CODEGRAPH_ACTIONS], description: '仅查询已有索引。' } } },
  } : tool)
  const loadingCandidates = () => { synchronizeLoading(); return (parent.modelToolLoadingCandidates?.() ?? []).filter(allowed) }
  return {
    register: () => { throw new Error('Child tool capability snapshot is immutable') },
    unregister: (name) => { names.delete(name); loadedModelTools.delete(name) },
    has: allowed,
    supportsHistoryProjection: name => allowed(name) && parent.supportsHistoryProjection?.(name) === true,
    skillsForPrompt: () => allowed('get_skill') ? (parent.skillsForPrompt?.() ?? []).filter(skill =>
      !(skill.builtin && skill.name.toLowerCase() === 'aether-office') || allowed('office_document')) : [],
    list: () => definitions(),
    listForModel: () => definitions(true),
    modelToolLoadingCandidates: loadingCandidates,
    hasModelToolLoader: trustedLoader,
    modelToolRegistrationVersion: (name) => allowed(name) ? owner(name).modelToolRegistrationVersion?.(name) : undefined,
    listForRequest: (history) => selectRequestTools(definitions(true), new Set(loadingCandidates()), loadedModelTools, history, trustedLoader(), invalidatedModelHistory),
    loadForModel: (selected) => {
      if (!trustedLoader()) throw new Error('This child has no trusted model tool loader')
      synchronizeLoading()
      return loadModelTools(definitions(true), loadedModelTools, selected)
    },
    preflight: async (name, args, ctx) => {
      if (!allowed(name)) return { success: false, output: `子代理不允许使用工具 ${name}。`, metadata: { blocked: true, code: 'TOOL_NOT_ALLOWED' } }
      const denied = readOnly ? readonlyActionDenied(name, args) : undefined
      if (denied) return denied
      return owner(name).preflight?.(name, args, ctx)
    },
    executionMode: (name, args) => allowed(name) ? owner(name).executionMode?.(name, args) ?? 'serial' : 'serial',
    execute: async (name, args, ctx) => {
      if (!allowed(name)) return { success: false, output: `子代理不允许使用工具 ${name}。`, metadata: { blocked: true, code: 'TOOL_NOT_ALLOWED' } }
      const denied = readOnly ? readonlyActionDenied(name, args) : undefined
      if (denied) return denied
      // Reuse the resolved parent implementations, including inline skill/MCP resources, without broadening capabilities.
      return readOnly && name === 'codegraph'
        ? withReadonlyCodegraph(() => owner(name).execute(name, args, ctx))
        : owner(name).execute(name, args, ctx)
    },
  }
}

export async function cancelSubagent(tenantId: string, sessionId: string, toolCallId: string, reason = 'user_cancelled'): Promise<boolean> {
  const run = await getSubagentRunner().cancelByParentTool(tenantId, sessionId, toolCallId, reason)
  return run?.status === 'cancelling' || run?.status === 'cancelled'
}

export const subagentTool: Tool = {
  name: 'subagent',
  displayName: '子代理',
  description: '创建子代理，builtinRole 选择调研、执行或通用模板，同模板可创建多个独立实例；agentId 选择已配置的自定义 Agent。优先查看已有子代理并用 resumeRunId 继续合适的上下文（包括已完成或中断的子代理）。task 必须写清项目路径、目标、文件分工与验收。未指定角色或 Agent 默认只读；权限受授权范围限制。子代理没有直接提问或审批通道。',
  parameters: {
    type: 'object',
    properties: {
      task: { type: 'string' },
      builtinRole: { type: 'string', enum: [...BUILTIN_AGENT_ROLES], description: 'research=严格只读调研；executor=实际执行与产物制作；general=综合任务。与 agentId、旧 role 参数互斥；同模板可多次创建独立实例。' },
      agentId: { type: 'string', description: '自定义 Agent 的精确 ID；仅使用用户明确选择或当前已注册发现工具返回的 ID。agent_list/agent_get 只在部分模式提供；未获得真实 ID 时省略，不猜测。继承该 Agent 的模型、系统提示及资源绑定。' },
      resumeRunId: { type: 'string', description: '继续已完成、失败或中断子代理的 runId；复用同一 childSession 历史并创建新一轮执行。不能并发续跑或改变原角色/权限；中断后先核对最后动作。' },
      description: { type: 'string', description: '简短任务标题' },
      systemPrompt: { type: 'string' },
      model: { type: 'string' },
      role: { type: 'string', enum: [...ROLE_VALUES] },
      access: { type: 'string', enum: ['read-only', 'inherit'], description: '调研和审查角色强制read-only；执行、通用、自定义Agent及implementer默认inherit，其余默认read-only。可主动收窄，始终受父工具权限限制。' },
    },
    required: ['task'],
  },
  execute: executeSubagent,
}

export const subagentStartTool: Tool = {
  ...subagentTool, name: 'subagent_start', displayName: '启动子代理',
  description: '异步启动子代理，持久接纳后立即返回 runId 和 childSessionId。启动回执不代表完成；使用 subagent_wait 查看实际终态，subagent_cancel 取消。父任务结束前仍等待真实执行和结果落盘。参数与 subagent 相同；子代理禁止递归启动。',
  execute: (args, ctx) => executeSubagent(args, ctx, { asynchronous: true }),
}

/** The authorization flag is server-owned and never accepted from model tool arguments. */
export async function executeSubagent(rawArgs: unknown, ctx: AgentContext, options: { userDelegated?: boolean; agent?: SubagentContinuationProfile['agent']; asynchronous?: boolean } = {}): Promise<ToolResult> {
    const args = rawArgs !== null && typeof rawArgs === 'object' ? rawArgs as Record<string, unknown> : {}
    const taskText = typeof args.task === 'string' ? args.task.trim() : ''
    const suppliedPrompt = typeof args.systemPrompt === 'string' ? args.systemPrompt : undefined
    // Preserve the existing recovery for providers that put the complete task in systemPrompt.
    const task = taskText || suppliedPrompt?.trim() || ''
    if (!hasSubagentTaskContent(task)) return { success: false, output: 'subagent: task 需要包含实际任务，不能只有空白或标点。请补充要完成的工作。' }
    if (args.builtinRole !== undefined && !isBuiltinAgentRole(args.builtinRole)) return { success: false, output: `subagent: builtinRole 必须为 ${BUILTIN_AGENT_ROLES.join(' / ')}。` }
    if (args.builtinRole !== undefined && (args.agentId !== undefined || options.agent || args.role !== undefined)) return { success: false, output: '内置角色不能与自定义 Agent 或旧 role 同时指定。' }
    if (args.builtinRole === 'research' && args.access === 'inherit') return { success: false, output: '调研角色不能继承写入权限，请使用执行或通用角色创建新的子代理。' }
    if (args.role !== undefined && !ROLE_VALUES.includes(args.role as SubagentRole)) return { success: false, output: `subagent: 未知 role '${String(args.role)}'，可选值为 ${ROLE_VALUES.join(' / ')}` }
    if (args.access !== undefined && args.access !== 'read-only' && args.access !== 'inherit') return { success: false, output: 'subagent: access 必须为 read-only 或 inherit。' }
    const runner = getSubagentRunner()
    const resumeRunId = typeof args.resumeRunId === 'string' ? args.resumeRunId.trim() : undefined
    if (args.resumeRunId !== undefined && !resumeRunId) return { success: false, output: 'subagent: resumeRunId 必须是非空字符串。' }
    const prior = resumeRunId ? await runner.store.getRunHeader(ctx.tenantId, resumeRunId, true) : null
    if (resumeRunId && (!prior || prior.parentSessionId !== ctx.sessionId || prior.rootSessionId !== (ctx.rootSessionId ?? ctx.sessionId))) return { success: false, output: '子代理不属于当前父任务，不能继续。' }
    if (prior && (!isTerminalRun(prior.status) || !prior.continuation)) return { success: false, output: !isTerminalRun(prior.status) ? '子代理仍在运行，请完成或停止后再继续。' : '旧子代理未保存续跑权限，无法安全恢复。' }
    const saved = prior?.continuation
    if (saved && args.builtinRole !== undefined && args.builtinRole !== saved.builtinRole) return { success: false, output: '继续子代理不能修改原内置角色；如需新角色请创建新子代理。' }
    const agentId = typeof args.agentId === 'string' ? args.agentId.trim() : undefined
    if (args.agentId !== undefined && !agentId) return { success: false, output: 'subagent: agentId 必须是非空字符串。' }
    if (saved && agentId !== undefined && agentId !== saved.agent?.id) return { success: false, output: '继续子代理不能更换原 Agent。请为新 Agent 创建子代理。' }
    const configuredAgent = saved?.agent ?? options.agent ?? (agentId ? await new SQLiteAgentStore().getById(agentId, ctx.tenantId) : undefined)
    if (agentId && !configuredAgent) return { success: false, output: '指定的 Agent 不存在或不属于当前账户，未执行子代理。' }
    const userDelegated = saved?.userDelegated ?? options.userDelegated === true
    const workspace = captureSubagentWorkspace(ctx)
    if (saved && !subagentWorkspaceMatches(saved, ctx, workspace)) return { success: false, output: '原子代理工作区不在当前父任务授权范围内，请恢复原工作区后继续。' }
    if (saved && ((args.role !== undefined && args.role !== saved.role) || args.systemPrompt !== undefined || (args.access !== undefined && (args.access === 'read-only') !== saved.readOnly))) return { success: false, output: '继续子代理不能修改原角色、系统提示或访问权限；如需新角色请创建新子代理。' }
    const role = (saved?.role ?? args.role) as SubagentRole | undefined
    const builtinRole = saved?.builtinRole ?? (isBuiltinAgentRole(args.builtinRole) ? args.builtinRole : undefined)
    const builtinTemplate = builtinRole ? BUILTIN_AGENT_TEMPLATES[builtinRole] : undefined
    const reviewer = role === 'spec-reviewer' || role === 'code-quality-reviewer'
    const readOnly = saved?.readOnly ?? (reviewer || builtinTemplate?.readOnly === true || (args.access ? args.access === 'read-only' : builtinTemplate ? false : !configuredAgent && role !== 'implementer'))
    // 子代理没有产品层的探索步数天花板。旧客户端可能仍发送 maxSteps；
    // 兼容时故意忽略它，避免模型或旧 UI 把长任务截断成“达到步骤上限”。
    // 循环只由用户取消、模型/上下文能力、明确的请求预算以及无进展保护收口。
    const maxSteps = Number.POSITIVE_INFINITY
    const requestedModel = typeof args.model === 'string' && args.model.trim() ? args.model.trim()
      : configuredAgent ? prior?.modelId || configuredAgent.model || ctx.subagentModel || ctx.modelName
        : ctx.subagentModel || prior?.modelId || ctx.modelName
    const description = (typeof args.description === 'string' && args.description.trim() ? args.description.trim() : task.replace(/\s+/g, ' ')).slice(0, 100)
    const mode = resolveOSMMode(ctx.logger)
    const rolePrompt = role && OSM_MODE_CONFIG[mode].methodology ? loadRoleTemplate(role) : null
    const systemPrompt = saved?.systemPrompt ?? [
      '你是一个独立子代理，保留此前上下文并执行最新用户消息里的任务。相对路径基于运行环境的relativePathRoot；任务正文所指其他目录仅是输入/输出位置，不能更改此根。跨目录文件用回执绝对路径；若任务已给明确绝对目录与相对文件名，直接组成完整路径，不先按默认根试错或扫描同名文件。',
      readOnly ? '这是只读调研任务。仅使用提供的只读与任务管理工具。' : '只能使用本次明确提供的工具目录，遵守继承的工作区、安全模式和授权边界。',
      '你没有递归创建子代理或直接向用户提问/审批的通道。只有缺少必须由用户提供的信息才用 subagent_request_input 向主 Agent 提交明确问题，说明已完成工作与无法继续的原因，然后暂停本轮。主 Agent 负责 ask_user，收到答案后通过同一 childSession 的 followup 继续你；deliveryUnavailable 表示问题未能投递，不代表用户已经回答。需要授权时如实说明，禁止假报完成。',
      '已完成仅表示上一轮结束：新任务可以在同一上下文继续，先核对当前文件和未完成事项。可使用协作目录和消息工具联系主 Agent 或同伴；queued 只表示接纳，不能当作对方已处理。',
      '共享文件先明确责任范围；不要覆盖用户或同伴的修改。可用 report_artifacts 时，把已完成文件登记为候选成果并向主 Agent 返回 childSessionId/runId/artifactId、用途和验证结果；否则返回真实路径与版本信息。由主 Agent 验收并登记最终交付，不能把创建文件等同于完成交付。',
      '最终结果必须用文本给出结论、证据和文件定位，不要仅写文件或复述过程。',
      '按请求深度收敛：概览只看入口与少量关键文件；优先搜索再按行范围读取，不要批量全文读取。证据足够就回答；同一工具错误不要原样重试。遇到取消、请求预算、上下文容量或无进展保护时如实说明未核实范围；不要自行制造步数上限。',
      configuredAgent ? `你是用户配置的 Agent「${configuredAgent.name}」。${configuredAgent.description ?? ''}` : undefined,
      configuredAgent?.systemPrompt,
      builtinTemplate?.systemPrompt,
      ctx.toolProfile === 'code' ? CODE_AGENT_HANDOFF_PROMPT : undefined,
      rolePrompt,
      taskText ? suppliedPrompt : undefined,
    ].filter(Boolean).join('\n\n')
    const inheritedTools = createSubagentToolRegistry(ctx.tools, readOnly)
    // Lifecycle controls require a real execution owner and confer no file,
    // command or extension access. Freeze them only for newly admitted children.
    const ownedControlNames = ctx.executionOwner ? (await import('./index.js')).ownedCollaborationTools
      .map(tool => tool.name).filter(name => !RECURSIVE_TOOLS.has(name) && !ROOT_ONLY_TOOLS.has(name)
        && (!readOnly || readonlyChildTool(ctx.tools, name))) : []
    const plannedToolNames = configuredAgent
      ? [...new Set([...(normalizeAllowedTools(configuredAgent.allowedTools) ?? []).filter(name => !RECURSIVE_TOOLS.has(name) && !ROOT_ONLY_TOOLS.has(name)
        && (!readOnly || readonlyChildTool(ctx.tools, name)) && (userDelegated || ctx.tools.has(name))), ...ownedControlNames, 'plan_update'])]
      : inheritedTools.list().map(tool => tool.name)
    // An authenticated session's selected workspace comes from its persisted
    // binding. Request paths may be absent or stale after reconnect, so freeze
    // the effective parent directory before constructing a real owned child.
    const ownedWorkingDirectory = !saved ? workspace.snapshot.root : undefined
    const continuation: SubagentContinuationProfile = saved ?? {
      role, readOnly, systemPrompt, userDelegated,
      ...(builtinTemplate ? { builtinRole: builtinTemplate.id, builtinRoleVersion: builtinTemplate.version } : {}),
      ...(configuredAgent ? { agent: { id: configuredAgent.id, name: configuredAgent.name, description: configuredAgent.description,
        systemPrompt: configuredAgent.systemPrompt, model: configuredAgent.model, temperature: configuredAgent.temperature,
        skills: [...configuredAgent.skills], mcpServers: [...configuredAgent.mcpServers],
        knowledgeBases: [...configuredAgent.knowledgeBases], allowedTools: [...configuredAgent.allowedTools] } } : {}),
      toolNames: plannedToolNames, workspacePaths: workspace.roots,
      projectRoot: ownedWorkingDirectory ?? ctx.projectRoot, cwd: ownedWorkingDirectory ?? ctx.cwd,
    }
    workspace.assertCurrent()
    const result = await (options.asynchronous ? runner.start.bind(runner) : runner.run.bind(runner))({
      tenantId: ctx.tenantId,
      rootSessionId: ctx.rootSessionId ?? ctx.sessionId,
      parentSessionId: ctx.sessionId,
      parentConversationId: ctx.conversationId ?? '',
      parentMessageId: ctx.currentMessageId ?? '',
      parentToolCallId: ctx.currentToolCallId ?? `direct-${randomUUID()}`,
      resumeFromRunId: resumeRunId, continuation,
      agentId: continuation.agent?.id, agentName: continuation.agent?.name,
      task, description, modelId: requestedModel ?? '',
    }, ctx, async ({ snapshot, signal, observer, onRequestAttempt, requestBudget, executionOwner }) => {
      workspace.assertCurrent()
      setSecurityMode(ctx.tenantId, snapshot.childSessionId, getSecurityMode(ctx.tenantId, ctx.sessionId))
      try {
      let resourcePrompt = ''
      let childTools = inheritedTools
      if (configuredAgent) {
        // Discovery belongs to the durable child's lifecycle as well, so slow/failing
        // catalogs always have the real Agent identity and a persisted terminal state.
        const { createToolRegistry } = await import('../registry-factory.js')
        const safeMode = getSecurityMode(ctx.tenantId, snapshot.childSessionId) === 'safe'
        const intersect = (selected: readonly string[], ceiling?: readonly string[] | null) =>
          userDelegated || ceiling == null ? [...selected] : selected.filter(value => ceiling.includes(value))
        const selectedSkills = intersect(configuredAgent.skills, ctx.resourceScope?.skills)
        const selectedKnowledge = intersect(configuredAgent.knowledgeBases, ctx.resourceScope?.knowledgeBases)
        const selectedMcp = intersect(configuredAgent.mcpServers, ctx.resourceScope?.mcpServers).filter(id =>
          userDelegated || ctx.tools.list().some(tool => tool.name.startsWith(`mcp_${id}_`) && continuation.toolNames.includes(tool.name)))
        const prepared = await createToolRegistry({
          signal,
          ownedCollaboration: !!executionOwner,
          toolProfile: ctx.toolProfile,
          securityContext: { tenantId: ctx.tenantId, sessionId: snapshot.childSessionId, toolProfile: ctx.toolProfile },
          workspaceRoot: workspace.snapshot.root,
          memoryScope: ctx.memoryScope,
        memoryScopes: ctx.memoryScopes,
          allowedSkills: selectedSkills,
          strictSkillBindings: true,
          // MCP stdio initialization may itself execute code. Safe mode must not
          // start an extension merely to discover a tool that would later be denied.
          allowedMcpServers: safeMode || readOnly ? [] : selectedMcp,
          allowedTools: continuation.toolNames,
        })
        childTools = createSubagentToolRegistry(prepared.registry, readOnly)
        if (!userDelegated) for (const tool of childTools.list()) if (tool.name !== 'plan_update' && !ctx.tools.has(tool.name)
          && !ownedControlNames.includes(tool.name)) childTools.unregister(tool.name)
        if (safeMode && configuredAgent.mcpServers.length) resourcePrompt += '\n\n安全模式下未连接绑定的 MCP 扩展；需要这些能力时如实说明限制。'
        if (selectedKnowledge.length) {
          throwIfAborted(signal)
          const chunks = await searchChunks(ctx.tenantId, task, 3, selectedKnowledge)
          if (chunks.length) resourcePrompt += '\n\n## 绑定知识库参考\n' + chunks.map((chunk, index) => `[${index + 1}] ${chunk.filename}\n${chunk.content}`).join('\n\n')
        }
      }
      // Old continuation snapshots retain business permissions; the newly builtin
      // session plan is available without expanding any file, command or extension access.
      for (const tool of childTools.list()) if (tool.name !== 'plan_update' && !continuation.toolNames.includes(tool.name)) childTools.unregister(tool.name)
      // Assemble the same capability-bound business workflow as the root. These
      // rules are current execution policy, not frozen role customization; resume
      // must pick up fixes without copying a parent's task-specific system text.
      const childSkills = [...(childTools.skillsForPrompt?.() ?? [])]
      const skillsPrompt = buildSkillsSystemPrompt(childSkills)
      const officePrompt = buildOfficeExecutionPrompt(ctx.toolProfile ?? 'general', childTools, childSkills)
      throwIfAborted(signal)
      const resolved = await resolveModelConfig({ tenantId: ctx.tenantId, model: requestedModel, parent: ctx.resolvedModel })
      const llm = createAdapterFromResolved(resolved)
      // 子代理预算 = 父/子模型窗口中已知的较小者；都未知则不注入本地预算（undefined），
      // 避免把"未配置"误当成 0 传给 createAgentContext 反而把子代理卡死。
      const subagentWindow = Math.min(
        ctx.modelCaps?.contextWindow ?? ctx.tokenBudget ?? Number.POSITIVE_INFINITY,
        resolved.capabilities.contextWindow ?? Number.POSITIVE_INFINITY)
      const subagentTokenBudget = ctx.toolProfile === 'code'
        ? undefined
        : Number.isFinite(subagentWindow) ? subagentWindow : undefined
      const child = createAgentContext({
        clientCapabilities: ctx.clientCapabilities,
        executionOwner,
        browserAuthority: ctx.browserAuthority,
        browserPrincipal: ctx.browserPrincipal,
        sessionId: snapshot.childSessionId,
        tenantId: ctx.tenantId,
        workspacePaths: continuation.workspacePaths,
        projectRoot: workspace.snapshot.root,
        cwd: workspace.snapshot.root,
        tools: childTools,
        history: createConversationHistory(),
        logger: ctx.logger.child({ runId: snapshot.runId, subSessionId: snapshot.childSessionId }),
        tokenBudget: subagentTokenBudget,
        signal,
        modelName: resolved.model,
        modelCaps: resolved.capabilities,
        resolvedModel: resolved,
        utilityModel: ctx.utilityModel,
        runId: snapshot.runId,
        rootRunId: ctx.rootRunId,
        turnId: ctx.turnId ?? ctx.parentConversationId ?? ctx.conversationId,
        rootSessionId: snapshot.rootSessionId,
        parentSessionId: snapshot.parentSessionId,
        parentConversationId: snapshot.parentConversationId,
        parentMessageId: snapshot.parentMessageId,
        parentToolCallId: snapshot.parentToolCallId,
        toolProfile: ctx.toolProfile,
        memoryScope: ctx.memoryScope,
          memoryScopes: ctx.memoryScopes,
        runObserver: observer,
        onRequestAttempt,
        requestBudget,
        subagentEventVersion: ctx.subagentEventVersion,
        emitSubagentEvent: ctx.emitSubagentEvent,
      })
      workspace.assertCurrent()
      if (executionOwner) workspaceManager.inheritChildWorkspace(child, ctx, continuationWorkspacePaths(continuation))
        if (child.executionOwner && (ctx.sqliteDelivery || ctx.jsonlDelivery)) installProductionCollaborationBoundary(child)
        const projectContext = getProjectContextBlock(child.projectRoot)
        const strategy = new ReActStrategy(llm, {
          maxIterations: maxSteps,
          temperature: continuation.agent?.temperature,
          finalizeOnLimit: true,
          unboundedCode: ctx.toolProfile === 'code',
          thinkingEnabled: resolved.thinkingEnabled,
          reasoningEffort: resolved.reasoningEffort,
          thinkingConfig: resolved.thinkingConfig,
          responseThinkingField: resolved.responseThinkingField,
          systemPrompt: [systemPrompt, skillsPrompt, resourcePrompt, projectContext, officePrompt].filter(Boolean).join('\n\n'),
        })
        // run accepts one content value. Status, tools and usage travel through the observer, never text parsing.
        for await (const _chunk of strategy.run(task, child)) { /* parent prose remains separate from child events */ }
      } finally { clearSecurityMode(ctx.tenantId, snapshot.childSessionId) }
    })
    if ('completion' in result) {
      const admission = { state: 'admitted', runId: result.runId, childSessionId: result.childSessionId, admittedSeq: result.admittedSeq }
      return { success: true, output: JSON.stringify(admission), metadata: { subagentAdmission: admission } }
    }
    return { success: result.status === 'succeeded', output: outcomeText(result), durationMs: result.durationMs, metadata: { subagent: result } }
}
