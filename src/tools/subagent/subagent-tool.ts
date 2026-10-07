import type { Tool, AgentContext, ToolResult, IToolRegistry } from '../../core/agent-context/index.js'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs'
import { ReActStrategy } from '../../core/agent-loop/react.js'
import { createAgentContext } from '../../core/agent-context/factory.js'
import { createConversationHistory } from '../../storage/conversation/factory.js'
import { resolveModelConfig, createAdapterFromResolved } from '../../core/llm-adapter/resolve-model.js'
import { getSubagentRunner } from '../../core/subagent/runner.js'
import { outcomeText } from '../../core/subagent/types.js'
import { getProjectContextBlock } from '../../core/project-context.js'
import { getSecurityMode, setSecurityMode, clearSecurityMode } from '../../security/policy-engine.js'
import { skillsRegistry } from '../../skills/index.js'
import { resolveOSMMode, OSM_MODE_CONFIG } from '../../core/osm.js'

/**
 * Subagent 工具
 *
 * 创建一个子代理来执行特定任务，支持自定义系统提示词、模型和最大步数。
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
  'list_skills', 'get_skill', 'codegraph', 'get_current_context',
  'todo_list', 'todo_create', 'todo_update', 'todo_delete',
  'recall', 'search_memory', 'list_memories',
])

export function createSubagentToolRegistry(parent: IToolRegistry, readOnly: boolean): IToolRegistry {
  const names = new Set(parent.list().filter((tool) => tool.name !== 'subagent' && tool.name !== 'ask_user' && (!readOnly || RESEARCH_TOOLS.has(tool.name))).map((tool) => tool.name))
  return {
    register: () => { throw new Error('Child tool capability snapshot is immutable') },
    unregister: (name) => { names.delete(name) },
    has: (name) => names.has(name),
    list: () => parent.list().filter((tool) => names.has(tool.name)),
    preflight: async (name, args, ctx) => {
      if (!names.has(name)) return { success: false, output: `子代理不允许使用工具 ${name}。`, metadata: { blocked: true, code: 'TOOL_NOT_ALLOWED' } }
      return parent.preflight?.(name, args, ctx)
    },
    executionMode: (name, args) => names.has(name) ? parent.executionMode?.(name, args) ?? 'serial' : 'serial',
    execute: async (name, args, ctx) => {
      if (!names.has(name)) return { success: false, output: `子代理不允许使用工具 ${name}。`, metadata: { blocked: true, code: 'TOOL_NOT_ALLOWED' } }
      // Reuse the resolved parent implementations, including inline skill/MCP resources, without broadening capabilities.
      return parent.execute(name, args, ctx)
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
  description: '创建子代理执行独立任务。task 必须自包含，写清项目路径、目标、范围与期望输出。默认只读调研；实现类任务使用 implementer 角色或 access=inherit，工具权限仍不超过父任务。子代理没有提问或审批通道。',
  parameters: {
    type: 'object',
    properties: {
      task: { type: 'string' },
      description: { type: 'string', description: '简短任务标题' },
      systemPrompt: { type: 'string' },
      model: { type: 'string' },
      maxSteps: { type: 'integer', minimum: 1, description: '可选。不传则不限制步数，子代理跑到任务完成或 token 预算耗尽为止；传入则作为该子任务的迭代上限。' },
      role: { type: 'string', enum: [...ROLE_VALUES] },
      access: { type: 'string', enum: ['read-only', 'inherit'], description: '默认read-only；implementer默认inherit，始终受父工具权限限制' },
    },
    required: ['task'],
  },
  async execute(rawArgs: unknown, ctx: AgentContext): Promise<ToolResult> {
    const args = rawArgs !== null && typeof rawArgs === 'object' ? rawArgs as Record<string, unknown> : {}
    const taskText = typeof args.task === 'string' ? args.task.trim() : ''
    const suppliedPrompt = typeof args.systemPrompt === 'string' ? args.systemPrompt : undefined
    // Preserve the existing recovery for providers that put the complete task in systemPrompt.
    const task = taskText || suppliedPrompt?.trim() || ''
    if (!task) return { success: false, output: 'subagent: task 参数为空。请传入完整任务描述。' }
    if (args.role !== undefined && !ROLE_VALUES.includes(args.role as SubagentRole)) return { success: false, output: `subagent: 未知 role '${String(args.role)}'，可选值为 ${ROLE_VALUES.join(' / ')}` }
    if (args.access !== undefined && args.access !== 'read-only' && args.access !== 'inherit') return { success: false, output: 'subagent: access 必须为 read-only 或 inherit。' }
    if (args.maxSteps !== undefined && (typeof args.maxSteps !== 'number' || !Number.isInteger(args.maxSteps) || args.maxSteps < 1)) return { success: false, output: 'subagent: maxSteps 必须是大于等于 1 的整数（不传则不限步数）。' }
    const role = args.role as SubagentRole | undefined
    const reviewer = role === 'spec-reviewer' || role === 'code-quality-reviewer'
    const readOnly = reviewer || (args.access ? args.access === 'read-only' : role !== 'implementer')
    // 不传 maxSteps = 不限步数：子代理跑到任务完成或 token 预算耗尽为止。
    // 原来默认 24（后提到 100）会在长调研半途硬截断，把"没查完"包装成"已完成"。
    // 真正需要收口的循环由 requestBudget / token 预算兜底，不靠一个人为步数天花板。
    const maxSteps = typeof args.maxSteps === 'number' ? args.maxSteps : Number.POSITIVE_INFINITY
    const requestedModel = typeof args.model === 'string' && args.model.trim() ? args.model.trim() : ctx.subagentModel || ctx.modelName
    const description = (typeof args.description === 'string' && args.description.trim() ? args.description.trim() : task.replace(/\s+/g, ' ')).slice(0, 100)
    const mode = resolveOSMMode(ctx.logger)
    const rolePrompt = role && OSM_MODE_CONFIG[mode].methodology ? loadRoleTemplate(role) : null
    const systemPrompt = [
      '你是一个独立子代理，只完成首条用户消息里的任务。工作目录与项目根以执行上下文为准。',
      readOnly ? '这是只读调研任务。仅使用提供的只读与任务管理工具。' : '只能在父任务已经允许的工具与权限范围内执行。',
      '你没有子代理递归、提问或审批通道。需要授权时如实说明，禁止假报完成。',
      '最终结果必须用文本给出结论、证据和文件定位，不要仅写文件或复述过程。',
      '按请求深度收敛：概览只看入口与少量关键文件；优先搜索再按行范围读取，不要批量全文读取。证据足够就回答；同一工具错误不要原样重试。接近预算或步数限制时，只总结已有证据并说明未核实范围。',
      rolePrompt,
      taskText ? suppliedPrompt : undefined,
    ].filter(Boolean).join('\n\n')
    const runner = getSubagentRunner()
    const run = await runner.run({
      tenantId: ctx.tenantId,
      rootSessionId: ctx.rootSessionId ?? ctx.sessionId,
      parentSessionId: ctx.sessionId,
      parentConversationId: ctx.conversationId ?? '',
      parentMessageId: ctx.currentMessageId ?? '',
      parentToolCallId: ctx.currentToolCallId ?? `direct-${randomUUID()}`,
      task, description, modelId: requestedModel ?? '',
    }, ctx, async ({ snapshot, signal, observer, onRequestAttempt, requestBudget }) => {
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
        sessionId: snapshot.childSessionId,
        tenantId: ctx.tenantId,
        workspacePaths: ctx.workspacePaths,
        projectRoot: ctx.projectRoot ?? ctx.workspacePaths?.[0],
        cwd: ctx.cwd ?? ctx.projectRoot ?? ctx.workspacePaths?.[0],
        tools: createSubagentToolRegistry(ctx.tools, readOnly),
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
        runObserver: observer,
        onRequestAttempt,
        requestBudget,
      })
      setSecurityMode(ctx.tenantId, child.sessionId, getSecurityMode(ctx.tenantId, ctx.sessionId))
      try {
        const projectContext = getProjectContextBlock(child.projectRoot)
        const strategy = new ReActStrategy(llm, {
          maxIterations: maxSteps,
          finalizeOnLimit: true,
          unboundedCode: ctx.toolProfile === 'code',
          thinkingEnabled: resolved.thinkingEnabled,
          thinkingConfig: resolved.thinkingConfig,
          responseThinkingField: resolved.responseThinkingField,
          systemPrompt: [systemPrompt, '项目根目录：' + child.projectRoot, '当前工作目录：' + child.cwd, projectContext].filter(Boolean).join('\n\n'),
        })
        // run accepts one content value. Status, tools and usage travel through the observer, never text parsing.
        for await (const _chunk of strategy.run(task, child)) { /* parent prose remains separate from child events */ }
      } finally { clearSecurityMode(ctx.tenantId, child.sessionId) }
    })
    return { success: run.status === 'succeeded', output: outcomeText(run), durationMs: run.durationMs, metadata: { subagent: run } }
  },
}
