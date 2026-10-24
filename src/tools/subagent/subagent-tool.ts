import type { Tool, AgentContext, ToolResult, IToolRegistry } from '../../core/agent-context/index.js'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs'
import { ReActStrategy } from '../../core/agent-loop/react.js'
import { createAgentContext } from '../../core/agent-context/factory.js'
import { createConversationHistory } from '../../storage/conversation/factory.js'
import { resolveModelConfig, createAdapterFromResolved } from '../../core/llm-adapter/resolve-model.js'
import { getSubagentRunner } from '../../core/subagent/runner.js'
import { isTerminalRun, outcomeText, type SubagentContinuationProfile } from '../../core/subagent/types.js'
import { SQLiteAgentStore } from '../../storage/agent/index.js'
import { searchChunks } from '../../storage/knowledge/kb-repo.js'
import { getProjectContextBlock } from '../../core/project-context.js'
import { getSecurityMode, setSecurityMode, clearSecurityMode } from '../../security/policy-engine.js'
import { skillsRegistry, buildSkillsSystemPrompt } from '../../skills/index.js'
import { resolveOSMMode, OSM_MODE_CONFIG } from '../../core/osm.js'
import { CODE_AGENT_HANDOFF_PROMPT } from '../../core/code-agent-prompt.js'
import { normalizeAllowedTools } from '../tool-profile.js'
import { throwIfAborted } from '../../core/utils/abort.js'
import { ToolRegistry } from '../../core/tool-registry/index.js'
import { trustBuiltinTool } from '../../security/tool-policy.js'
import { todoTools } from '../todo/todo-tool.js'
import { officeEnvironmentTool } from '../office/environment.js'
import { officeInspectTool } from '../office/index.js'
import { installProductionCollaborationBoundary } from '../../core/collaboration/production-boundary.js'

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
  'read_file', 'smart_read', 'list_files', 'glob', 'glob_search', 'grep', 'grep_search',
  'list_skills', 'get_skill', 'codegraph', 'get_current_context', 'search_history',
  'browser_tabs', 'browser_snapshot', 'browser_screenshot', 'browser_console', 'browser_network', 'browser_network_request',
  'todo_list', 'todo_create', 'todo_update', 'todo_delete', 'plan_update',
  'recall', 'search_memory', 'list_memories',
  'subagent_send', 'subagent_participants', 'subagent_inbox',
])

const RECURSIVE_TOOLS = new Set(['subagent', 'subagent_start', 'spawn_agent', 'start_agent'])

function readonlyChildTool(parent: IToolRegistry, name: string): boolean {
  return RESEARCH_TOOLS.has(name) || (name === officeEnvironmentTool.name || name === officeInspectTool.name)
    && parent.executionMode?.(name, {}) === 'readonly'
}

export function createSubagentToolRegistry(parent: IToolRegistry, readOnly: boolean): IToolRegistry {
  // The child owns a session-local plan even when a legacy parent lacks this
  // builtin. Never delegate its reserved identity to a parent extension.
  const internalPlan = new ToolRegistry()
  for (const tool of todoTools) if (tool.name === 'plan_update') internalPlan.register(trustBuiltinTool(tool))
  const catalog = () => [...parent.list().filter(tool => tool.name !== 'plan_update'), ...internalPlan.list()]
  // list() contains public definitions, so implementation identity is unavailable;
  // only the parent's trusted readonly policy admits this diagnostic to research.
  const names = new Set(catalog().filter((tool) => !RECURSIVE_TOOLS.has(tool.name) && tool.name !== 'ask_user'
    && (!readOnly || readonlyChildTool(parent, tool.name))).map((tool) => tool.name))
  const owner = (name: string) => name === 'plan_update' ? internalPlan : parent
  return {
    register: () => { throw new Error('Child tool capability snapshot is immutable') },
    unregister: (name) => { names.delete(name) },
    has: (name) => names.has(name),
    list: () => catalog().filter((tool) => names.has(tool.name)),
    preflight: async (name, args, ctx) => {
      if (!names.has(name)) return { success: false, output: `子代理不允许使用工具 ${name}。`, metadata: { blocked: true, code: 'TOOL_NOT_ALLOWED' } }
      return owner(name).preflight?.(name, args, ctx)
    },
    executionMode: (name, args) => names.has(name) ? owner(name).executionMode?.(name, args) ?? 'serial' : 'serial',
    execute: async (name, args, ctx) => {
      if (!names.has(name)) return { success: false, output: `子代理不允许使用工具 ${name}。`, metadata: { blocked: true, code: 'TOOL_NOT_ALLOWED' } }
      // Reuse the resolved parent implementations, including inline skill/MCP resources, without broadening capabilities.
      return owner(name).execute(name, args, ctx)
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
  description: '创建子代理，agentId 可选择已配置的自定义 Agent（角色、模型和绑定资源）；resumeRunId 继续同一子代理上下文。task 必须自包含，写清项目路径、目标、范围与期望输出。未指定 Agent 默认只读；工具权限仍受父任务限制，用户明确委派的同一 Agent 保留其已授权范围。子代理没有提问或审批通道。',
  parameters: {
    type: 'object',
    properties: {
      task: { type: 'string' },
      agentId: { type: 'string', description: '自定义 Agent 的精确 ID，可通过 agent_list/agent_get 查询。继承该 Agent 的模型、系统提示及资源绑定。' },
      resumeRunId: { type: 'string', description: '继续已完成子代理的 runId；复用同一 childSession 历史，不能并发续跑或改变原角色/权限。' },
      description: { type: 'string', description: '简短任务标题' },
      systemPrompt: { type: 'string' },
      model: { type: 'string' },
      role: { type: 'string', enum: [...ROLE_VALUES] },
      access: { type: 'string', enum: ['read-only', 'inherit'], description: '默认read-only；implementer默认inherit，始终受父工具权限限制' },
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
    if (!task) return { success: false, output: 'subagent: task 参数为空。请传入完整任务描述。' }
    if (args.role !== undefined && !ROLE_VALUES.includes(args.role as SubagentRole)) return { success: false, output: `subagent: 未知 role '${String(args.role)}'，可选值为 ${ROLE_VALUES.join(' / ')}` }
    if (args.access !== undefined && args.access !== 'read-only' && args.access !== 'inherit') return { success: false, output: 'subagent: access 必须为 read-only 或 inherit。' }
    const runner = getSubagentRunner()
    const resumeRunId = typeof args.resumeRunId === 'string' ? args.resumeRunId.trim() : undefined
    if (args.resumeRunId !== undefined && !resumeRunId) return { success: false, output: 'subagent: resumeRunId 必须是非空字符串。' }
    const prior = resumeRunId ? await runner.store.getRunHeader(ctx.tenantId, resumeRunId, true) : null
    if (resumeRunId && (!prior || prior.parentSessionId !== ctx.sessionId || prior.rootSessionId !== (ctx.rootSessionId ?? ctx.sessionId))) return { success: false, output: '子代理不属于当前父任务，不能继续。' }
    if (prior && (!isTerminalRun(prior.status) || !prior.continuation)) return { success: false, output: !isTerminalRun(prior.status) ? '子代理仍在运行，请完成或停止后再继续。' : '旧子代理未保存续跑权限，无法安全恢复。' }
    const saved = prior?.continuation
    const agentId = typeof args.agentId === 'string' ? args.agentId.trim() : undefined
    if (args.agentId !== undefined && !agentId) return { success: false, output: 'subagent: agentId 必须是非空字符串。' }
    if (saved && agentId !== undefined && agentId !== saved.agent?.id) return { success: false, output: '继续子代理不能更换原 Agent。请为新 Agent 创建子代理。' }
    const configuredAgent = saved?.agent ?? options.agent ?? (agentId ? await new SQLiteAgentStore().getById(agentId, ctx.tenantId) : undefined)
    if (agentId && !configuredAgent) return { success: false, output: '指定的 Agent 不存在或不属于当前账户，未执行子代理。' }
    const userDelegated = saved?.userDelegated ?? options.userDelegated === true
    const allowedRoots = (ctx.workspacePaths ?? []).map(root => path.resolve(root))
    if (saved?.workspacePaths.some(root => !allowedRoots.includes(path.resolve(root)))) return { success: false, output: '原子代理工作区不在当前父任务授权范围内，请恢复原工作区后继续。' }
    if (saved && ((args.role !== undefined && args.role !== saved.role) || args.systemPrompt !== undefined || (args.access !== undefined && (args.access === 'read-only') !== saved.readOnly))) return { success: false, output: '继续子代理不能修改原角色、系统提示或访问权限；如需新角色请创建新子代理。' }
    const role = (saved?.role ?? args.role) as SubagentRole | undefined
    const reviewer = role === 'spec-reviewer' || role === 'code-quality-reviewer'
    const readOnly = saved?.readOnly ?? (reviewer || (args.access ? args.access === 'read-only' : !configuredAgent && role !== 'implementer'))
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
      '你是一个独立子代理，保留此前上下文并执行最新用户消息里的任务。工作目录与项目根以执行上下文为准。',
      readOnly ? '这是只读调研任务。仅使用提供的只读与任务管理工具。' : '只能使用本次明确提供的工具目录，遵守继承的工作区、安全模式和授权边界。',
      '你没有子代理递归、提问或审批通道。需要授权时如实说明，禁止假报完成。',
      '最终结果必须用文本给出结论、证据和文件定位，不要仅写文件或复述过程。',
      '按请求深度收敛：概览只看入口与少量关键文件；优先搜索再按行范围读取，不要批量全文读取。证据足够就回答；同一工具错误不要原样重试。遇到取消、请求预算、上下文容量或无进展保护时如实说明未核实范围；不要自行制造步数上限。',
      configuredAgent ? `你是用户配置的 Agent「${configuredAgent.name}」。${configuredAgent.description ?? ''}` : undefined,
      configuredAgent?.systemPrompt,
      ctx.toolProfile === 'code' ? CODE_AGENT_HANDOFF_PROMPT : undefined,
      rolePrompt,
      taskText ? suppliedPrompt : undefined,
    ].filter(Boolean).join('\n\n')
    const inheritedTools = createSubagentToolRegistry(ctx.tools, readOnly)
    const plannedToolNames = configuredAgent
      ? [...new Set([...(normalizeAllowedTools(configuredAgent.allowedTools) ?? []).filter(name => !RECURSIVE_TOOLS.has(name) && name !== 'ask_user'
        && (!readOnly || readonlyChildTool(ctx.tools, name)) && (userDelegated || ctx.tools.has(name))), 'plan_update'])]
      : inheritedTools.list().map(tool => tool.name)
    const continuation: SubagentContinuationProfile = saved ?? {
      role, readOnly, systemPrompt, userDelegated,
      ...(configuredAgent ? { agent: { id: configuredAgent.id, name: configuredAgent.name, description: configuredAgent.description,
        systemPrompt: configuredAgent.systemPrompt, model: configuredAgent.model, temperature: configuredAgent.temperature,
        skills: [...configuredAgent.skills], mcpServers: [...configuredAgent.mcpServers],
        knowledgeBases: [...configuredAgent.knowledgeBases], allowedTools: [...configuredAgent.allowedTools] } } : {}),
      toolNames: plannedToolNames, workspacePaths: [...(ctx.workspacePaths ?? [])], projectRoot: ctx.projectRoot, cwd: ctx.cwd,
    }
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
          toolProfile: ctx.toolProfile,
          securityContext: { tenantId: ctx.tenantId, sessionId: snapshot.childSessionId, toolProfile: ctx.toolProfile },
          workspaceRoot: continuation.projectRoot ?? continuation.workspacePaths[0],
          memoryScope: ctx.memoryScope,
        memoryScopes: ctx.memoryScopes,
          allowedSkills: selectedSkills,
          strictSkillBindings: true,
          // MCP stdio initialization may itself execute code. Safe mode must not
          // start an extension merely to discover a tool that would later be denied.
          allowedMcpServers: safeMode ? [] : selectedMcp,
          allowedTools: continuation.toolNames,
        })
        childTools = createSubagentToolRegistry(prepared.registry, readOnly)
        if (!userDelegated) for (const tool of childTools.list()) if (tool.name !== 'plan_update' && !ctx.tools.has(tool.name)) childTools.unregister(tool.name)
        resourcePrompt = buildSkillsSystemPrompt(prepared.externalSkills)
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
        executionOwner,
        browserAuthority: ctx.browserAuthority,
        browserPrincipal: ctx.browserPrincipal,
        sessionId: snapshot.childSessionId,
        tenantId: ctx.tenantId,
        workspacePaths: continuation.workspacePaths,
        projectRoot: continuation.projectRoot ?? continuation.workspacePaths[0],
        cwd: continuation.cwd ?? continuation.projectRoot ?? continuation.workspacePaths[0],
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
          systemPrompt: [systemPrompt, resourcePrompt, '项目根目录：' + child.projectRoot, '当前工作目录：' + child.cwd, projectContext].filter(Boolean).join('\n\n'),
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
