import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { PluginError } from './types.js'
import type { PluginCapabilityId } from './capabilities.js'
import { assertCapability, invokePluginCapability, type CapabilityAccess, type CapabilityCall, type PluginExecutionContext } from './capability-runtime.js'
import { createAgentContext } from '../core/agent-context/factory.js'
import type { AgentContext } from '../core/agent-context/types.js'
import { createConversationHistory } from '../storage/conversation/factory.js'
import { ReActStrategy } from '../core/agent-loop/react.js'
import { getSubagentRunner } from '../core/subagent/runner.js'
import { isTerminalRun, type SubagentRunView } from '../core/subagent/types.js'
import { resolveModelConfig, createAdapterFromResolved } from '../core/llm-adapter/resolve-model.js'
import { ModelsStore } from '../storage/sqlite/models.js'
import { logger } from '../observability/index.js'
import { clearSecurityMode, getSecurityMode, setSecurityMode } from '../security/policy-engine.js'
import { workspaceManager } from '../workspace/index.js'
import { pluginAgentArgumentError, pluginAgentRunArgsSchema, pluginAgentToolsArgsSchema, type PluginAgentConfiguration } from './capability-contract.js'
import { assertPluginAgentMountScope, preparePluginAgentMounts, resolvePluginAgentConfiguration } from './agent-configuration.js'
import type { PluginStreamEvent } from './capability-stream-types.js'
import { createPluginAgentToolRegistry, disablePluginAgentTools, type PluginAgentToolInfo } from './agent-tool-registry.js'
import { emitPluginArtifacts } from './artifacts.js'
import { authorizePluginContinuationUpdate } from '../core/subagent/plugin-continuation.js'
import { createPluginAgentRoot, executePluginAgentRoot, ownedPluginRoot, assertPluginAgentController, cancelInactivePluginRoot, cancelParkedPluginRoots } from './agent-execution-root.js'
import { rootRunStore, type RootPending, type RootRun } from '../storage/root-runs/index.js'
import { publicPending } from '../core/stream-pipeline/public-pending.js'

const active = new Map<string, { tenantId: string; pluginId: string; scope: string; controller: AbortController; completion?: Promise<unknown> }>()
const responses = new Map<string, Promise<unknown>>()
function scopeFor(tenantId: string, pluginId: string, sessionId: string): string {
  return 'plugin-agent-' + createHash('sha256').update(JSON.stringify([tenantId, pluginId, sessionId])).digest('hex').slice(0, 40)
}
async function present(run: SubagentRunView, pluginId: string, sessionId: string) {
  const header = await getSubagentRunner().store.getRunHeader(run.tenantId, run.runId, true)
  const root = header?.continuation?.pluginRootRunId ? await rootRunStore.get(run.tenantId, header.continuation.pluginRootRunId) : undefined
  return { runId: run.runId, childSessionId: run.childSessionId, pluginId, sessionId, status: run.status === 'blocked' && (root?.status === 'cancelled' || root?.status === 'interrupted') ? root.status : run.status, description: run.description,
    pending: root?.status === 'waiting' && header?.continuation?.pluginRootAttemptId === root.attemptId ? root.pending.filter(pending => pending.status === 'pending').map(publicPending) : [],
    modelId: run.modelId, createdAt: run.createdAt, updatedAt: run.updatedAt, result: run.resultSummary ?? run.partialOutput ?? '',
    usage: run.usage, toolCount: run.toolCount, ...(run.error ? { error: { code: run.error.code, message: 'Agent 任务未完成，请查看任务状态或重试。' } } : {}) }
}
async function current(access: CapabilityAccess, capability: PluginCapabilityId = 'agents.manage'): Promise<CapabilityAccess> {
  if (!access.refresh) throw new PluginError('PLUGIN_AUTHORITY', 'Agent 需要可实时校验的插件授权', 403)
  const next = await access.refresh()
  assertCapability(next, capability, access.revision)
  return next
}

function assertMountGrants(access: CapabilityAccess, configuration: PluginAgentConfiguration): void {
  if (configuration.skillIds?.length) assertCapability(access, 'skills.read', access.revision)
  if (configuration.mcpServerIds?.length) {
    assertCapability(access, 'mcp.read', access.revision)
    assertCapability(access, 'mcp.invoke', access.revision)
  }
}

async function prepareAgentTools(access: CapabilityAccess, tenantId: string, sessionId: string | undefined,
  configuration: PluginAgentConfiguration, workspaceRoot: string, liveAccess: () => Promise<CapabilityAccess>,
  execution?: PluginExecutionContext, signal?: AbortSignal, discovery = false) {
  const invokeHost = async (capability: PluginCapabilityId, method: string, input: Record<string, unknown>, callSignal?: AbortSignal) => {
    const live = await liveAccess(); assertMountGrants(live, configuration)
    return invokePluginCapability(live, tenantId, { capability, method, args: input, sessionId, expectedRevision: access.revision }, callSignal,
      { ...execution, childAgent: true })
  }
  const guard = async (name: string, ctx: AgentContext) => {
    const live = await liveAccess(); assertMountGrants(live, configuration)
    if (configuration.disabledTools?.includes(name) || live.agentDisabledTools?.includes(name))
      throw new PluginError('PLUGIN_AGENT_TOOL_DISABLED', '此工具已被用户禁用', 403)
    if (sessionId) setSecurityMode(tenantId, ctx.sessionId, getSecurityMode(tenantId, sessionId))
    return live
  }
  const built = await createPluginAgentToolRegistry({ access, tenantId, sessionId: sessionId ?? 'plugin-tool-catalogue', workspaceRoot,
    configuration, discovery, signal, beforeLocalTool: async (name, ctx) => { await guard(name, ctx) },
    beforePlatformTool: async (name, ctx) => {
      assertCapability(await guard(name, ctx), 'engine.tools', access.revision)
    } })
  const tools = built.registry
  const mounts = await preparePluginAgentMounts(configuration, invokeHost, signal)
  const invokeScoped = async (capability: PluginCapabilityId, method: string, input: Record<string, unknown>, callSignal?: AbortSignal) => {
    assertPluginAgentMountScope(configuration, capability, method, input)
    return invokeHost(capability, method, input, callSignal)
  }
  const toolFailure = (error: unknown) => ({ success: false,
    output: error instanceof z.ZodError ? pluginAgentArgumentError(error) : error instanceof PluginError ? error.message : '宿主能力调用失败',
    error: 'PLUGIN_AGENT_TOOL_FAILED' })
  for (const mounted of mounts.mcpTools) tools.register({ name: mounted.registrationName, source: 'mcp',
    description: `${mounted.serverId} / ${mounted.name}: ${mounted.description}`, parameters: mounted.inputSchema,
    async execute(raw, ctx) {
      try {
        return { success: true, output: JSON.stringify(await invokeScoped('mcp.invoke', 'call',
          { serverId: mounted.serverId, tool: mounted.name, arguments: z.record(z.unknown()).parse(raw) }, ctx.signal)) }
      } catch (error) { return toolFailure(error) }
    } })
  for (const custom of configuration.customTools ?? []) {
    if (built.hasName(custom.name) || custom.name.startsWith('ae_'))
      throw new PluginError('PLUGIN_AGENT_TOOL_COLLISION', '自定义工具名称与现有工具冲突，请更换名称')
    const spec = access.manifest.tools.find(tool => tool.name === custom.tool)
    if (!spec) throw new PluginError('PLUGIN_AGENT_TOOL_NOT_FOUND', '自定义工具必须引用当前插件清单中声明的工具')
    tools.register({ name: custom.name, source: 'plugin', description: spec.description, parameters: spec.inputSchema,
      async execute(raw, ctx) {
        try {
          const live = await liveAccess(); assertCapability(live, 'agents.manage', access.revision)
          if (!live.invokeTool) throw new PluginError('PLUGIN_AUTHORITY', '当前入口无法执行插件工具', 403)
          const result = await live.invokeTool(custom.tool, z.record(z.unknown()).parse(raw), ctx.signal, { ...execution, childAgent: true })
          const written = await emitPluginArtifacts(result.artifacts, ctx)
          if (!written.success) return written
          return { success: true, output: JSON.stringify({ result: result.result, artifacts: JSON.parse(written.output) }), changes: written.changes,
            metadata: { plugin: { id: access.id, revision: access.revision }, durationMs: result.durationMs } }
        } catch (error) { return toolFailure(error) }
      } })
  }
  const platformNames = new Set(built.catalogue.map(tool => tool.name))
  const definitions: PluginAgentToolInfo[] = [...built.catalogue, ...tools.list().filter(tool => !platformNames.has(tool.name)).map(tool => ({ ...tool, enabled: true, available: true }))]
  for (const tool of definitions) {
    const customUnavailable = tool.source === 'plugin' && (!access.invokeTool || !access.grants.includes('agents.manage'))
    if (customUnavailable) {
      tool.enabled = false; tool.available = false
      tool.reason = '当前入口无法执行插件工具'
      tools.unregister(tool.name)
    }
  }
  const catalogue = disablePluginAgentTools(tools, definitions, [...access.agentDisabledTools ?? [], ...configuration.disabledTools ?? []])
  return { tools, catalogue, skillPrompt: mounts.skillPrompt }
}

/** The management page can inspect real definitions without starting a model or creating a session. */
export async function discoverPluginAgentTools(access: CapabilityAccess, tenantId: string, input: PluginAgentConfiguration = {}, execution?: PluginExecutionContext, management = false, signal?: AbortSignal) {
  const configuration = resolvePluginAgentConfiguration(pluginAgentToolsArgsSchema.parse(input))
  const sessionId = execution?.workspaceContext?.sessionId
  const bound = sessionId ? workspaceManager.bindingReadGuard(execution!.workspaceContext!, execution?.workspaceBinding) : undefined
  const liveAccess = async () => { signal?.throwIfAborted(); bound?.assertCurrent(); const live = management ? await access.refresh?.() ?? access : await current(access, 'agents.read'); bound?.assertCurrent(); signal?.throwIfAborted(); return live }
  const live = await liveAccess(); assertMountGrants(live, configuration)
  const result = await prepareAgentTools(live, tenantId, sessionId, configuration, bound?.snapshot.root ?? process.cwd(), liveAccess,
    bound ? { ...execution, workspaceBinding: bound.snapshot } : execution, signal, true)
  return { tools: result.catalogue }
}

/** Real persisted SubagentRunner + ReAct execution, with only the plugin's live host grants as tools. */
async function invokeAgentOperation(access: CapabilityAccess, tenantId: string, call: CapabilityCall, signal?: AbortSignal, execution?: PluginExecutionContext,
  response?: { requestId: string; toolCallId: string; output: string }): Promise<unknown> {
  if (call.capability === 'agents.read' && call.method === 'tools') return discoverPluginAgentTools(access, tenantId, call.args,
    call.sessionId ? { ...execution, workspaceContext: execution?.workspaceContext ?? { tenantId, sessionId: call.sessionId } } : execution, false, signal)
  if (!call.sessionId) throw new PluginError('PLUGIN_SESSION_REQUIRED', '请从会话打开插件以运行 Agent', 409)
  const sessionId = call.sessionId, scope = scopeFor(tenantId, access.id, sessionId), runner = getSubagentRunner()
  const owned = async (runId: string) => {
    const run = await runner.store.getRunView(tenantId, runId)
    if (!run || run.parentSessionId !== scope || run.rootSessionId !== sessionId || run.agentId !== access.id)
      throw new PluginError('PLUGIN_AGENT_NOT_FOUND', '此 Agent 任务不属于当前插件与会话', 404)
    return run
  }
  if (call.capability === 'agents.read' && call.method === 'list') {
    const args = z.object({ cursor: z.string().max(4096).optional(), limit: z.number().int().min(1).max(50).optional() }).strict().parse(call.args)
    const page = await runner.store.listRunViewsPage(tenantId, scope, args)
    return { runs: await Promise.all(page.runs.map(run => present(run, access.id, sessionId))), nextCursor: page.nextCursor ?? null }
  }
  if (call.method === 'status' && call.capability === 'agents.read') {
    const args = z.object({ runId: z.string().uuid() }).strict().parse(call.args)
    return present(await owned(args.runId), access.id, sessionId)
  }
  if (call.method === 'cancel' && call.capability === 'agents.manage') {
    const args = z.object({ runId: z.string().uuid() }).strict().parse(call.args)
    const cancelled = await owned(args.runId)
    const handle = active.get(args.runId)
    handle?.controller.abort()
    await runner.cancel(tenantId, args.runId, 'plugin_user_cancelled')
    const header = await runner.store.getRunHeader(tenantId, cancelled.runId, true)
    if (header?.continuation?.pluginRootRunId) {
      await ownedPluginRoot(access, tenantId, sessionId, cancelled.childSessionId, header.continuation.pluginRootRunId)
      await cancelInactivePluginRoot(tenantId, header.continuation.pluginRootRunId, 'plugin_user_cancelled')
    }
    return present(await owned(args.runId), access.id, sessionId)
  }
  if (!['run', 'stream'].includes(call.method) || call.capability !== 'agents.manage') throw new PluginError('PLUGIN_METHOD', '此 Agent 方法不存在', 404)
  const streaming = call.method === 'stream'
  if (streaming && !execution?.onEvent) throw new PluginError('PLUGIN_STREAM_REQUIRED', '请通过流式宿主接口启动 Agent', 400)
  if (execution?.childAgent) throw new PluginError('PLUGIN_AGENT_RECURSION', '子代理不能通过插件递归启动 Agent', 403)
  const workspaceContext = execution?.workspaceContext ?? { tenantId, sessionId }
  const workspace = workspaceManager.bindingReadGuard(workspaceContext, execution?.workspaceBinding)
  const assertWorkspace = () => {
    try { workspace.assertCurrent() }
    catch { throw new PluginError('PLUGIN_AGENT_WORKSPACE', 'Agent 运行期间工作区已变化，请恢复原工作区或重新发起任务', 409) }
  }
  const liveAccess = async () => { assertWorkspace(); const live = await current(access); assertWorkspace(); return live }
  const args = pluginAgentRunArgsSchema.parse(call.args)
  await liveAccess(); signal?.throwIfAborted()
  const model = (await new ModelsStore().getModels(tenantId)).find(model => model.isEnabled && (model.id === args.modelId || model.modelId === args.modelId))
  if (!model) throw new PluginError('PLUGIN_MODEL', '所选模型未配置或未启用', 404)
  const previous = args.resumeRunId ? await owned(args.resumeRunId) : undefined
  if (previous && !isTerminalRun(previous.status)) throw new PluginError('PLUGIN_AGENT_BUSY', '此 Agent 仍在运行，请完成或取消后继续', 409)
  const priorHeader = previous ? await runner.store.getRunHeader(tenantId, previous.runId, true) : undefined
  const priorRoot = priorHeader?.continuation?.pluginRootRunId
    ? await ownedPluginRoot(access, tenantId, sessionId, previous!.childSessionId, priorHeader.continuation.pluginRootRunId) : undefined
  if (response && (!priorRoot || !previous)) throw new PluginError('PLUGIN_AGENT_NOT_FOUND', '找不到待回复的 Agent 执行', 404)
  if (!response && priorRoot && ['running', 'waiting'].includes(priorRoot.status))
    throw new PluginError('PLUGIN_AGENT_PENDING', '请先回答或取消此 Agent 等待中的请求', 409)
  if (priorHeader && priorHeader.continuation?.projectRoot !== workspace.snapshot.root)
    throw new PluginError('PLUGIN_AGENT_WORKSPACE', '原 Agent 工作区与当前绑定不同，请恢复原工作区后继续', 409)
  const configuration = resolvePluginAgentConfiguration({ identity: args.identity, systemPrompt: args.systemPrompt,
    skillIds: args.skillIds, mcpServerIds: args.mcpServerIds, disabledTools: args.disabledTools, customTools: args.customTools }, priorHeader?.continuation?.pluginAgent, Boolean(previous))
  const priorParameters = priorHeader?.continuation?.pluginAgentParameters
  const parameters = {
    thinking: args.thinking ?? priorParameters?.thinking,
    // An explicit Off also clears an inherited effort. Supplying both fields
    // in the same call remains invalid below, matching ai.run semantics.
    reasoningEffort: args.thinking === false ? args.reasoningEffort : args.reasoningEffort ?? priorParameters?.reasoningEffort,
    temperature: args.temperature ?? priorParameters?.temperature,
    maxTokens: args.maxTokens ?? priorParameters?.maxTokens,
  }
  if (parameters.thinking === false && parameters.reasoningEffort !== undefined)
    throw new PluginError('PLUGIN_ARGUMENTS', 'thinking=false 时不能同时指定 reasoningEffort', 400)
  const pluginAgentParameters = Object.fromEntries(Object.entries(parameters).filter(([, value]) => value !== undefined)) as typeof parameters
  assertMountGrants(await liveAccess(), configuration)
  const { tools, skillPrompt } = await prepareAgentTools(await liveAccess(), tenantId, sessionId, configuration, workspace.snapshot.root,
    liveAccess, { ...execution, childAgent: true, workspaceContext, workspaceBinding: workspace.snapshot }, signal)
  const runId = randomUUID(), controller = new AbortController(), childSessionId = previous?.childSessionId ?? randomUUID()
  let streamFailure: PluginError | undefined
  const emit = async (event: PluginStreamEvent) => {
    if (!streaming) return
    try {
      signal?.throwIfAborted()
      assertMountGrants(await liveAccess(), configuration)
      await execution!.onEvent!(event)
    } catch (error) {
      controller.abort()
      streamFailure = error instanceof PluginError ? error : new PluginError('PLUGIN_STREAM_CLOSED', '插件流连接已关闭', 499)
      throw streamFailure
    }
  }
  const scratchRoot = path.resolve(path.dirname(path.resolve(process.env.DATA_DIR ?? './data/agent.db')), 'plugin-agent-workspaces', createHash('sha256').update(tenantId).digest('hex').slice(0, 16))
  const systemPrompt = [
    '你是插件中的执行 Agent。使用提供的文件、命令、交互与计划、搜索、子代理、Skill 工具完成任务，完成后给出结果和验证证据。遵循每个工具的真实参数定义。平台 SDK 接口供插件代码调用，不自动成为你的工具；不要猜测 ae_* 工具名。',
    configuration.identity?.name ? `身份名称：${configuration.identity.name}` : '',
    configuration.identity?.description ? `身份职责：${configuration.identity.description}` : '',
    configuration.systemPrompt ?? '', skillPrompt ? `以下是此 Agent 显式挂载的技能说明：\n${skillPrompt}` : '',
    '只使用明确授权工具；权限不够时说明缺少的能力，不得尝试其他文件、命令、数据库或网络通道。可以使用已开放的子代理工具并行完成独立任务，负责检查与汇总结果。',
  ].filter(Boolean).join('\n\n')
  let admitted!: () => void
  const admission = new Promise<void>(resolve => { admitted = resolve })
  const parent = createAgentContext({ tenantId, sessionId: scope, rootSessionId: sessionId, conversationId: runId,
    scratchDir: path.join(scratchRoot, scope), tools, history: createConversationHistory(), logger, signal: controller.signal,
    workspacePaths: [workspace.snapshot.root], projectRoot: workspace.snapshot.root, cwd: workspace.snapshot.root, toolProfile: 'general',
    subagentEventVersion: 2, emitSubagentEvent: () => { admitted() } })
  const parentMessageId = 'plugin-request-' + runId
  // The child archive owns the complete task and its compactable conversation.
  // The parent log keeps only a bounded admission pointer, never copies large prompts.
  await parent.history.append({ id: parentMessageId, role: 'user', content: args.description ?? args.task.slice(0, 100), createdAt: Date.now(), tokens: 0,
    metadata: { conversationId: runId, childSessionId, pluginId: access.id, boundSessionId: sessionId, pluginRevision: access.revision } }, parent)
  const handle: { tenantId: string; pluginId: string; scope: string; controller: AbortController; completion?: Promise<unknown> } = { tenantId, pluginId: access.id, scope, controller }
  await liveAccess(); signal?.throwIfAborted()
  let rootRun: RootRun, resumedPending: RootPending | undefined
  if (response) {
    await assertPluginAgentController(tenantId, priorRoot!, execution, priorHeader?.continuation?.pluginRootAttemptId)
    const pending = priorRoot!.pending.find(item => item.requestId === response.requestId && item.toolCallId === response.toolCallId)
    if (!pending) throw new PluginError('PLUGIN_AGENT_PENDING', '此待回复请求不存在', 404)
    const answered = await rootRunStore.answer(tenantId, childSessionId, priorRoot!.runId, response.requestId, response.toolCallId, pending.toolName, response.output, signal)
    if (answered.duplicate) {
      const db = await rootRunStore.admissionDatabase()
      const match = (await db.execute({ sql: "SELECT run_id FROM subagent_records WHERE tenant_id=? AND json_extract(record,'$.parentSessionId')=? AND json_extract(record,'$.continuation.pluginRootRunId')=? AND json_extract(record,'$.continuation.pluginResponseRequestId')=? ORDER BY json_extract(record,'$.createdAt') DESC LIMIT 1",
        args: [tenantId, scope, priorRoot!.runId, response.requestId] })).rows[0]
      if (!match) {
        if (priorRoot!.status === 'running') await rootRunStore.update(tenantId, priorRoot!.runId, { status: 'interrupted', stopReason: 'plugin_response_admission_interrupted' }, priorRoot!.attemptId)
        throw new PluginError('PLUGIN_AGENT_RESPONSE_INTERRUPTED', '答复已保存，但继续执行被中断；请通过 Agent 继续任务重新发起执行', 409)
      }
      // A later answer can advance this same root. Reconcile its current outer
      // attempt, never a subsequent independent task in the shared child session.
      const latest = (await db.execute({ sql: "SELECT run_id FROM subagent_records WHERE tenant_id=? AND json_extract(record,'$.parentSessionId')=? AND json_extract(record,'$.continuation.pluginRootRunId')=? AND json_extract(record,'$.continuation.pluginRootAttemptId')=? ORDER BY json_extract(record,'$.createdAt') DESC LIMIT 1",
        args: [tenantId, scope, priorRoot!.runId, priorRoot!.attemptId] })).rows[0]
      const existing = await owned(String(latest?.run_id ?? match.run_id))
      if (streaming) await emit({ type: 'started', runId: existing.runId, childSessionId: existing.childSessionId, model: existing.modelId })
      if (active.get(existing.runId)?.completion && streaming) await active.get(existing.runId)!.completion
      const value = await present(await owned(existing.runId), access.id, sessionId)
      if (streaming) {
        signal?.throwIfAborted()
        if (value.status === 'blocked') for (const pending of value.pending) await emit({ type: 'pending', runId: value.runId, childSessionId: value.childSessionId, pending })
        else if (value.status !== 'succeeded') throw new PluginError(value.status === 'cancelled' ? 'PLUGIN_CANCELLED' : 'PLUGIN_AGENT_FAILED', 'Agent 任务未完成，请查看任务状态或重试', value.status === 'cancelled' ? 408 : 502)
      }
      return value
    }
    rootRun = answered.run; resumedPending = answered.pending
  } else rootRun = await createPluginAgentRoot(access, tenantId, childSessionId, sessionId, model.id, workspace.snapshot.root, args.task, signal)
  const rootAttemptId = (await rootRunStore.get(tenantId, rootRun.runId))!.attemptId
  const abortStream = () => controller.abort(signal?.reason)
  if (streaming) { signal?.addEventListener('abort', abortStream, { once: true }); if (signal?.aborted) abortStream() }
  active.set(runId, handle)
  let checking = false
  const watchdog = setInterval(() => {
    if (checking || controller.signal.aborted) return
    checking = true
    void liveAccess().then(live => assertMountGrants(live, configuration)).catch(error => controller.abort(error)).finally(() => { checking = false })
  }, 500)
  watchdog.unref?.()
  const completion = runner.run(authorizePluginContinuationUpdate({ runId, childSessionId, tenantId, rootSessionId: sessionId, parentSessionId: scope, parentConversationId: runId,
    parentMessageId, parentToolCallId: 'plugin-' + runId, task: args.task, description: args.description ?? args.task.slice(0, 100), modelId: model.modelId,
    agentId: access.id, agentName: configuration.identity?.name ?? access.manifest.name, resumeFromRunId: previous?.runId,
    continuation: { pluginAgent: configuration, pluginAgentParameters, pluginRootRunId: rootRun.runId, pluginRootAttemptId: rootAttemptId, pluginResponseRequestId: response?.requestId, readOnly: !access.grants.some(grant => grant.endsWith('.write') || grant === 'mcp.invoke' || grant === 'engine.tools') && !configuration.customTools?.length, systemPrompt, toolNames: tools.list().map(tool => tool.name), workspacePaths: [workspace.snapshot.root], projectRoot: workspace.snapshot.root },
  }), parent, async ({ snapshot, signal: taskSignal, observer, onRequestAttempt, requestBudget }) => {
    await liveAccess()
    const resolved = await resolveModelConfig({ tenantId, model: model.id, overrides: {
      thinkingEnabled: parameters.thinking,
      reasoningEffort: parameters.reasoningEffort,
    } })
    await emit({ type: 'started', runId, childSessionId: snapshot.childSessionId, model: resolved.model })
    setSecurityMode(tenantId, snapshot.childSessionId, getSecurityMode(tenantId, sessionId))
    try {
      let terminalFailure = false
      const child = createAgentContext({ tenantId, sessionId: snapshot.childSessionId, rootSessionId: snapshot.childSessionId,
        conversationId: rootRun.turnId, scratchDir: path.join(scratchRoot, snapshot.childSessionId), tools, history: createConversationHistory(), logger,
        browserAuthority: execution?.browserAuthority, browserPrincipal: execution?.browserPrincipal,
        resourceScope: { skills: configuration.skillIds ?? [], mcpServers: configuration.mcpServerIds ?? [], knowledgeBases: [] }, memoryScope: 'off',
        workspacePaths: [workspace.snapshot.root], projectRoot: workspace.snapshot.root, cwd: workspace.snapshot.root, toolProfile: 'general',
        signal: taskSignal, runObserver: { ...observer,
          onOutcome: async outcome => { terminalFailure ||= outcome.status !== 'succeeded'; await observer.onOutcome?.(outcome) },
          onToolStart: async tool => { await observer.onToolStart?.(tool); await emit({ type: 'tool-start', runId, toolName: tool.name, toolCallId: tool.toolCallId }) },
          onToolEnd: async tool => { await observer.onToolEnd?.(tool); await emit({ type: 'tool-end', runId, toolName: tool.name, toolCallId: tool.toolCallId, success: tool.success, durationMs: tool.durationMs }) },
        }, requestBudget, modelName: resolved.model, modelCaps: resolved.capabilities, resolvedModel: resolved,
        onRequestAttempt: async event => { if (event.type === 'start') assertMountGrants(await liveAccess(), configuration); await onRequestAttempt(event) },
      })
      const strategy = new ReActStrategy(createAdapterFromResolved(resolved), { systemPrompt, maxIterations: Infinity, finalizeOnLimit: true,
        maxOutputTokens: parameters.maxTokens, temperature: parameters.temperature,
        thinkingEnabled: resolved.thinkingEnabled, reasoningEffort: resolved.reasoningEffort, thinkingConfig: resolved.thinkingConfig, responseThinkingField: resolved.responseThinkingField })
      await executePluginAgentRoot({ root: rootRun, context: child, access, boundSessionId: sessionId, workspaceContext,
        workspace: workspace.snapshot, execution, resumedPending,
        onPending: pending => emit({ type: 'pending', runId, childSessionId: snapshot.childSessionId, pending }),
        run: async context => { for await (const chunk of strategy.run(resumedPending ? null : args.task, context)) {
        // ReAct emits public text as plain chunks and reasoning/internal frames with NUL prefixes.
        // Tool lifecycle comes from the actual observer, not unvalidated model tool-call fragments.
        // ReAct's post-failure notices can contain private provider diagnostics. The
        // stream reports a sanitized terminal error instead of forwarding those notices.
        if (!terminalFailure && chunk && !chunk.startsWith('\x00')) await emit({ type: 'text-delta', text: chunk, runId })
      } } })
    } finally { clearSecurityMode(tenantId, snapshot.childSessionId) }
  }).finally(async () => {
    clearInterval(watchdog); active.delete(runId); if (streaming) signal?.removeEventListener('abort', abortStream)
    const pending = await rootRunStore.get(tenantId, rootRun.runId)
    if (pending?.status === 'running') await cancelInactivePluginRoot(tenantId, rootRun.runId, 'plugin_execution_not_started')
  })
  handle.completion = completion
  void completion.catch(() => undefined)
  if (streaming) { await completion; signal?.throwIfAborted() }
  else await Promise.race([admission, completion])
  const finished = await owned(runId)
  if (streaming) {
    if (streamFailure) throw streamFailure
    if (finished.status !== 'succeeded' && !(finished.status === 'blocked' && (await rootRunStore.get(tenantId, rootRun.runId))?.status === 'waiting')) throw new PluginError(finished.status === 'cancelled' ? 'PLUGIN_CANCELLED' : 'PLUGIN_AGENT_FAILED',
      finished.status === 'cancelled' ? 'Agent 任务已取消' : 'Agent 任务未完成，请查看任务状态或重试', finished.status === 'cancelled' ? 408 : 502)
  }
  return present(finished, access.id, sessionId)
}

export function invokeAgentCapability(access: CapabilityAccess, tenantId: string, call: CapabilityCall, signal?: AbortSignal, execution?: PluginExecutionContext): Promise<unknown> {
  return invokeAgentOperation(access, tenantId, call, signal, execution)
}

/** Host-only response. It is deliberately absent from plugin SDK/capability routing. */
export async function respondPluginAgent(access: CapabilityAccess, tenantId: string,
  input: { runId: string; requestId: string; toolCallId: string; output: string }, execution?: PluginExecutionContext, signal?: AbortSignal): Promise<unknown> {
  const sessionId = execution?.workspaceContext?.sessionId
  if (!sessionId || execution?.workspaceContext?.tenantId !== tenantId) throw new PluginError('PLUGIN_SESSION_REQUIRED', '请从绑定会话回答此 Agent', 409)
  await current(access)
  const prior = await getSubagentRunner().store.getRunHeader(tenantId, input.runId, true)
  if (!prior || prior.parentSessionId !== scopeFor(tenantId, access.id, sessionId) || prior.rootSessionId !== sessionId || prior.agentId !== access.id)
    throw new PluginError('PLUGIN_AGENT_NOT_FOUND', '此 Agent 任务不属于当前插件与会话', 404)
  if (!prior.continuation?.pluginRootRunId) throw new PluginError('PLUGIN_AGENT_NOT_FOUND', '找不到待回复的 Agent 执行', 404)
  const root = await ownedPluginRoot(access, tenantId, sessionId, prior.childSessionId, prior.continuation.pluginRootRunId)
  await assertPluginAgentController(tenantId, root, execution, prior.continuation.pluginRootAttemptId)
  const key = JSON.stringify([tenantId, access.id, root.runId, input.requestId, input.toolCallId, input.output])
  const inflight = responses.get(key)
  if (inflight) {
    const result = await inflight as Awaited<ReturnType<typeof present>>
    signal?.throwIfAborted()
    if (execution?.onEvent) {
      await execution.onEvent({ type: 'started', runId: result.runId, childSessionId: result.childSessionId, model: result.modelId })
      for (const pending of result.pending) await execution.onEvent({ type: 'pending', runId: result.runId, childSessionId: result.childSessionId, pending })
    }
    return result
  }
  const operation = invokeAgentOperation(access, tenantId, { capability: 'agents.manage', method: execution?.onEvent ? 'stream' : 'run', sessionId,
    expectedRevision: access.revision, args: { modelId: prior.modelId, resumeRunId: prior.runId, task: '继续处理用户答复', description: prior.description } },
  signal, execution, input)
  responses.set(key, operation)
  try { return await operation } finally { if (responses.get(key) === operation) responses.delete(key) }
}

export async function closePluginAgents(): Promise<void> {
  const handles = [...active.values()]
  for (const handle of handles) handle.controller.abort()
  await Promise.allSettled(handles.map(handle => handle.completion))
}
export async function cancelPluginAgents(tenantId: string, pluginId: string): Promise<void> {
  const handles = [...active.values()].filter(handle => handle.tenantId === tenantId && handle.pluginId === pluginId)
  for (const handle of handles) handle.controller.abort()
  await Promise.allSettled(handles.map(handle => handle.completion))
  await cancelParkedPluginRoots(tenantId, pluginId)
}
