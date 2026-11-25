import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { PluginError, type PluginManifest, type PluginRunResult } from './types.js'
import { pluginCapabilityIdSchema, type PluginCapabilityId } from './capabilities.js'
import { PluginService } from './service.js'
import { ModelsStore } from '../storage/sqlite/models.js'
import { resolveModelConfig, createAdapterFromResolved } from '../core/llm-adapter/resolve-model.js'
import { loadDbCapabilityOverrides, resolveCapabilities } from '../core/model-capabilities/index.js'
import type { LLMResponse, LLMStreamChunk } from '../core/llm-adapter/types.js'
import { createConversationHistory } from '../storage/conversation/factory.js'
import { publicSessionHistoryMessages } from '../api/http/history-projection.js'
import { skillsRegistry } from '../skills/skills-registry.js'
import { getSkillContent } from '../skills/external-loader.js'
import { workspaceManager } from '../workspace/index.js'
import { withFileLocks } from '../shared/file-version.js'
import { listKnowledgeBases, getDocument, searchChunks, addDocument, updateDocument } from '../storage/knowledge/kb-repo.js'
import { listServers } from '../storage/mcp/mcp-config.js'
import { HTTPMCPClient } from '../tools/mcp/client.js'
import { extensionPolicy } from '../security/tool-policy.js'
import type { AgentContext, Message } from '../core/agent-context/types.js'
import type { WorkspaceBindingSnapshot } from '../workspace/manager.js'
import { noCapabilityArgs, PLUGIN_AGENT_CAPABILITY_METHODS as capabilityMethods } from './capability-contract.js'
import { awaitPluginStream, pluginStreamError, type PluginStreamListener } from './capability-stream-types.js'

/** Captured only by host dispatchers. Never accepted in plugin JSON or HTTP bodies. */
export interface PluginExecutionContext {
  onEvent?: PluginStreamListener
  childAgent?: boolean
  workspaceContext?: Pick<AgentContext, 'tenantId' | 'sessionId' | 'workspacePaths' | 'cwd' | 'projectRoot' | 'scratchDir' | 'executionOwner' | 'runId' | 'rootRunId' | 'turnId' | 'parentSessionId'>
  workspaceBinding?: Readonly<WorkspaceBindingSnapshot>
  browserAuthority?: AgentContext['browserAuthority']
  browserPrincipal?: AgentContext['browserPrincipal']
  controllerSubject?: import('../core/collaboration/controller-origin.js').ControllerSubject
}

function assertPluginResponseFormat(text: string, responseFormat: 'text' | 'json' | undefined): void {
  if (responseFormat !== 'json') return
  try {
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('JSON object required')
  } catch {
    throw new PluginError('PLUGIN_AI_FORMAT', '模型未返回有效 JSON 对象，请重试或改用 responseFormat=text', 502)
  }
}

function pluginWorkspacePath(root: string, input: string): string {
  if (input.includes('\0') || /%(?:2e|2f|5c)/i.test(input)) throw new PluginError('PLUGIN_PATH', '工作区路径无效', 403)
  const absolute = path.resolve(root, input), relative = path.relative(root, absolute)
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep))
    throw new PluginError('PLUGIN_PATH', '插件只能访问当前绑定工作区', 403)
  let current = root
  for (const part of ['', ...relative.split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part)
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new PluginError('PLUGIN_PATH', '插件工作区路径不能通过符号链接或联接点', 403) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  return absolute
}

export const capabilityCallSchema = z.object({
  capability: pluginCapabilityIdSchema, method: z.string().min(1).max(40), args: z.record(z.unknown()).default({}),
  sessionId: z.string().min(1).max(256).optional(), expectedRevision: z.number().int().positive(),
}).strict()
export type CapabilityCall = z.infer<typeof capabilityCallSchema>
export function publishedCapabilityDispatcher(service: PluginService, tenantId: string, id: string, revision: number, sessionId?: string, execution?: PluginExecutionContext) {
  return async (raw: { capability: string; method: string; args: Record<string, unknown> }, signal: AbortSignal, onEvent?: PluginStreamListener) => {
    const call = capabilityCallSchema.parse({ ...raw, expectedRevision: revision, sessionId })
    if (call.method === 'stream') return streamPluginCapability(await publishedCapabilityAccess(service, tenantId, id, revision), tenantId, call, onEvent ?? (() => undefined), signal, execution)
    return invokePluginCapability(await publishedCapabilityAccess(service, tenantId, id, revision), tenantId, call, signal, execution)
  }
}
export interface CapabilityAccess {
  runtimeRoot?: string
  id: string; revision: number; manifest: PluginManifest; grants: readonly PluginCapabilityId[]
  agentDisabledTools?: readonly string[]
  refresh?(): Promise<CapabilityAccess>
  getSettings(): Promise<Record<string, unknown>>
  setSettings(value: Record<string, unknown>): Promise<Record<string, unknown>>
  /** Host-bound execution of a tool in this exact plugin revision; never accepts another plugin/path. */
  invokeTool?(tool: string, args: Record<string, unknown>, signal: AbortSignal | undefined, execution: PluginExecutionContext): Promise<PluginRunResult>
}
export async function publishedCapabilityAccess(service: PluginService, tenantId: string, id: string, revision: number): Promise<CapabilityAccess> {
  const record = await service.get(tenantId, id)
  if (!record.enabled || record.publishedRevision !== revision) throw new PluginError('PLUGIN_STALE', '插件版本已变更或停用，请重新打开插件', 409)
  const snapshot = await service.snapshot(tenantId, id, revision)
  const access: CapabilityAccess = { runtimeRoot: service.rootDir, id, revision, manifest: snapshot.manifest, grants: record.permissionRevision === revision ? record.permissionGrants ?? [] : [], agentDisabledTools: record.agentDisabledTools ?? [],
    refresh: async () => {
      const current = await service.get(tenantId, id)
      if (!current.enabled || current.publishedRevision !== revision) throw new PluginError('PLUGIN_STALE', '插件版本已变更或停用，请重新打开插件', 409)
      // Published revisions are immutable; live authorization only needs the record,
      // not another read/hash of every source file for every streamed token.
      return { ...access, grants: current.permissionRevision === revision ? current.permissionGrants ?? [] : [], agentDisabledTools: current.agentDisabledTools ?? [] }
    },
    getSettings: () => service.getSettings(tenantId, id), setSettings: value => service.setSettings(tenantId, id, value),
    invokeTool: async (tool, args, signal, execution) => {
      const live = await publishedCapabilityAccess(service, tenantId, id, revision)
      assertCapability(live, 'agents.manage', revision)
      const ctx = execution.workspaceContext
      if (!ctx || ctx.tenantId !== tenantId || !ctx.sessionId) throw new PluginError('PLUGIN_AUTHORITY', '插件工具需要宿主绑定会话', 403)
      const denied = extensionPolicy(ctx)
      if (denied) throw new PluginError('PLUGIN_FORBIDDEN', denied.output, 403)
      workspaceManager.bindingReadGuard(ctx, execution.workspaceBinding).assertCurrent()
      const { runPlugin } = await import('./runtime.js')
      // The published revision includes its validated installed dependencies.
      // Copying only source files would silently drop node_modules.
      return runPlugin(snapshot, tool, args, { signal, tenantId,
        hostContext: { sessionId: ctx.sessionId, workspacePath: execution.workspaceBinding?.root },
        capability: publishedCapabilityDispatcher(service, tenantId, id, revision, ctx.sessionId, { ...execution, childAgent: true }) })
    } }
  return access
}
export function assertCapability(access: CapabilityAccess, capability: PluginCapabilityId, revision: number): void {
  if (access.revision !== revision) throw new PluginError('PLUGIN_STALE', '插件源码已变化，请刷新页面', 409)
  if (!access.manifest.permissions?.requested.includes(capability) || !access.grants.includes(capability))
    throw new PluginError('PLUGIN_PERMISSION', `此插件尚未获准使用 ${capability}，请在插件权限中开启`, 403)
}
/** One dispatcher for installed pages and local source previews. Authority never comes from args. */
export async function invokePluginCapability(access: CapabilityAccess, tenantId: string, call: CapabilityCall, signal?: AbortSignal, execution?: PluginExecutionContext): Promise<unknown> {
  assertCapability(access, call.capability, call.expectedRevision)
  if (execution?.childAgent && call.capability === 'agents.manage' && (call.method === 'run' || call.method === 'stream')) throw new PluginError('PLUGIN_AGENT_RECURSION', '子代理不能通过插件递归启动 Agent', 403)
  const combined = signal ?? new AbortController().signal
  combined.throwIfAborted()
  const result = await awaitPluginStream(dispatch(access, tenantId, call, combined, execution), combined)
  combined.throwIfAborted()
  return result
}

/** Streams one bounded operation, with live grants and exactly one terminal event. */
export async function streamPluginCapability(access: CapabilityAccess, tenantId: string, call: CapabilityCall, onEvent: PluginStreamListener, signal?: AbortSignal, execution?: PluginExecutionContext): Promise<unknown> {
  const controller = new AbortController()
  const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])])
  let closed = false, terminalAttempted = false
  let lastValidatedAt = 0, validated = false, validation: Promise<void> | undefined
  const current = async (force = false) => {
    combined.throwIfAborted()
    if (validation) return validation
    if (!force && validated && Date.now() - lastValidatedAt < 500) return
    const pending = (async () => {
      const live = access.refresh ? await awaitPluginStream(access.refresh(), combined) : access
      if (live.id !== access.id) throw new PluginError('PLUGIN_AUTHORITY', '插件调用上下文已变化', 403)
      assertCapability(live, call.capability, call.expectedRevision)
      combined.throwIfAborted()
      lastValidatedAt = Date.now(); validated = true
    })()
    validation = pending
    try { await pending }
    catch (error) { controller.abort(pluginStreamError(error, combined)); throw error }
    finally { if (validation === pending) validation = undefined }
  }
  const emit: PluginStreamListener = async event => {
    if (closed) throw new PluginError('PLUGIN_STREAM_CLOSED', '流式调用已经结束', 409)
    await current(event.type === 'complete')
    if (event.type === 'complete' || event.type === 'error') terminalAttempted = true
    try { await awaitPluginStream(onEvent(event), combined) }
    catch { if (combined.aborted) throw pluginStreamError(undefined, combined); throw new PluginError('PLUGIN_STREAM_RECEIVER', '流式接收方处理失败', 502) }
  }
  const watchdog = setInterval(() => {
    if (closed || terminalAttempted) return
    void current(true).catch(error => controller.abort(pluginStreamError(error, combined)))
  }, 500)
  watchdog.unref()
  try {
    if (call.method !== 'stream' || !['ai.run', 'agents.manage'].includes(call.capability)) throw new PluginError('PLUGIN_METHOD', '此能力不支持流式调用', 404)
    await current(true)
    const result = await invokePluginCapability(access, tenantId, call, combined, { ...execution, onEvent: emit })
    await emit({ type: 'complete', result })
    return result
  } catch (error) {
    const safe = pluginStreamError(error, combined)
    // Report failures when the receiver is still connected; disconnected Node/HTTP
    // listeners may reject, but can never turn an interrupted stream into success.
    if (!terminalAttempted && !signal?.aborted) {
      terminalAttempted = true
      try { await awaitPluginStream(onEvent({ type: 'error', error: { code: safe.code, message: safe.message } }), signal ?? new AbortController().signal) } catch { /* disconnected receiver */ }
    }
    throw safe
  } finally { closed = true; clearInterval(watchdog); controller.abort() }
}
async function dispatch(access: CapabilityAccess, tenantId: string, call: CapabilityCall, signal: AbortSignal, execution?: PluginExecutionContext): Promise<unknown> {
  const { args, capability, method } = call
  const context = () => {
    if (!call.sessionId) throw new PluginError('PLUGIN_SESSION_REQUIRED', '请从会话打开插件以使用此能力', 409)
    if (execution?.workspaceContext) {
      if (execution.workspaceContext.tenantId !== tenantId || execution.workspaceContext.sessionId !== call.sessionId) throw new PluginError('PLUGIN_AUTHORITY', '插件调用上下文不匹配', 403)
      return execution.workspaceContext
    }
    return { tenantId, sessionId: call.sessionId }
  }
  const project = () => workspaceManager.bindingReadGuard(context(), execution?.workspaceBinding).snapshot.root
  if (method === 'host.authorize' && (capability.startsWith('ui.') || capability === 'events.subscribe')) {
    noCapabilityArgs.parse(args)
    return { authorized: true }
  }
  switch (`${capability}:${method}`) {
    case 'events.subscribe:poll':
      return (await import('./lifecycle-runtime.js')).pollPluginHostEvents(access, tenantId, call.sessionId, args)
    case 'agents.read:list': case 'agents.read:status': case 'agents.read:tools': case 'agents.manage:run': case 'agents.manage:stream': case 'agents.manage:cancel':
      return (await import('./agent-capability.js')).invokeAgentCapability(access, tenantId, call, signal, execution)
    case 'models.read:list': {
      capabilityMethods['models.read'].list.parse(args)
      const models = (await new ModelsStore().getModels(tenantId)).filter(model => model.isEnabled)
      return { models: await Promise.all(models.map(async model => {
        const capabilities = resolveCapabilities({ model: model.modelId, provider: model.provider, baseUrl: model.baseUrl,
          apiFormat: model.apiFormat, dbOverrides: model.capabilities ?? await loadDbCapabilityOverrides(model.modelId) })
        return { id: model.id, modelId: model.modelId, name: model.displayName || model.modelId, provider: model.provider,
          capabilities: Object.fromEntries((['vision', 'thinking', 'toolCalling', 'jsonMode', 'streamUsage', 'contextWindow'] as const)
            .filter(key => capabilities[key] !== undefined).map(key => [key, capabilities[key]])) }
      })) }
    }
    case 'ai.run:run': case 'ai.run:stream': {
      const input = capabilityMethods['ai.run'].run.parse(args)
      if (input.thinking === false && input.reasoningEffort !== undefined) {
        throw new PluginError('PLUGIN_ARGUMENTS', 'thinking=false 时不能同时指定 reasoningEffort', 400)
      }
      const model = (await new ModelsStore().getModels(tenantId)).find(model => model.isEnabled && (model.id === input.modelId || model.modelId === input.modelId))
      if (!model) throw new PluginError('PLUGIN_MODEL', '所选模型未配置或未启用', 404)
      const messages: Message[] = [...input.messages ?? [], ...(input.prompt ? [{ role: 'user' as const, content: input.prompt }] : [])]
      if (!messages.length) throw new PluginError('PLUGIN_ARGUMENTS', '请提供 prompt 或 messages')
      let result: LLMResponse
      let publicStreamError = false
      try {
        // Use the same tenant-aware configuration and request settings as the
        // Agent loop. A bare adapter loses saved thinking/capability settings;
        // the Anthropic gateway then silently defaults to a 4096-token output.
        const modelOverrides = input.thinking !== undefined || input.reasoningEffort !== undefined
          ? { ...(input.thinking !== undefined ? { thinkingEnabled: input.thinking } : {}),
              ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}) }
          : undefined
        const resolved = await resolveModelConfig({ tenantId, model: model.id, ...(modelOverrides ? { overrides: modelOverrides } : {}) })
        const adapter = createAdapterFromResolved(resolved)
        if (method === 'stream') {
          publicStreamError = true
          // No tool schema is passed to a single AI completion. Provider reasoning
          // is intentionally discarded, including reasoning-only terminal output.
          const listener = execution?.onEvent
          if (!listener) throw new PluginError('PLUGIN_METHOD', '流式调用需要事件接收方', 400)
          await listener({ type: 'started', model: resolved.model })
          let chunks: AsyncIterator<LLMStreamChunk>
          try {
            chunks = adapter.stream(messages, { model: resolved.model, systemPrompt: input.systemPrompt,
              maxTokens: input.maxTokens, unboundedOutput: input.maxTokens === undefined, contextWindow: resolved.capabilities.contextWindow,
              thinkingEnabled: resolved.thinkingEnabled, reasoningEffort: resolved.reasoningEffort,
              thinkingConfig: resolved.thinkingConfig, responseThinkingField: resolved.responseThinkingField,
              temperature: input.temperature, responseFormat: input.responseFormat, includeStreamUsage: true, signal })[Symbol.asyncIterator]()
          } catch { throw new PluginError('PLUGIN_AI_FAILED', '平台模型调用失败，请检查模型配置后重试', 502) }
          let content = '', done = false, finishReason: LLMResponse['finishReason'] | undefined
          let actualModel = resolved.model, promptTokens: number | undefined, completionTokens: number | undefined
          let toolCalls = false
          try {
            while (true) {
              let next: IteratorResult<LLMStreamChunk>
              try { next = await awaitPluginStream(chunks.next(), signal) }
              catch { if (signal.aborted) throw pluginStreamError(undefined, signal); throw new PluginError('PLUGIN_AI_FAILED', '平台模型调用失败，请检查模型配置后重试', 502) }
              if (next.done) break
              const chunk = next.value
              if (done && (chunk.content || chunk.toolCalls?.length)) throw new PluginError('PLUGIN_AI_INCOMPLETE', '模型在结束后继续返回内容，请重试', 502)
              if (chunk.content) {
                content += chunk.content
                await listener({ type: 'text-delta', text: chunk.content })
              }
              if (chunk.model) actualModel = chunk.model
              if (chunk.promptTokens !== undefined) promptTokens = chunk.promptTokens
              if (chunk.completionTokens !== undefined) completionTokens = chunk.completionTokens
              if (chunk.toolCalls?.length) toolCalls = true
              if (chunk.done) { done = true; if (chunk.finishReason) finishReason = chunk.finishReason }
            }
          } finally {
            // A disconnected provider must not block cancellation on iterator cleanup.
            if (chunks.return) void Promise.resolve(chunks.return()).catch(() => undefined)
          }
          signal.throwIfAborted()
          if (finishReason === 'length') throw new PluginError('PLUGIN_AI_OUTPUT_LIMIT', '模型输出达到上限，结果尚未完成；请提高 maxTokens 或缩小分析内容后重试', 502)
          if (!done || finishReason !== 'stop' || toolCalls) throw new PluginError('PLUGIN_AI_INCOMPLETE', '模型流未完整结束，请重试', 502)
          if (!content.trim()) throw new PluginError('PLUGIN_AI_EMPTY', '模型未返回可见正文，请调整模型配置或缩小分析内容后重试', 502)
          assertPluginResponseFormat(content, input.responseFormat)
          return { text: content, model: actualModel, usage: { inputTokens: promptTokens, outputTokens: completionTokens } }
        }
        result = await adapter.complete(messages, { model: resolved.model, systemPrompt: input.systemPrompt,
          maxTokens: input.maxTokens, unboundedOutput: input.maxTokens === undefined, contextWindow: resolved.capabilities.contextWindow,
          thinkingEnabled: resolved.thinkingEnabled, reasoningEffort: resolved.reasoningEffort,
          thinkingConfig: resolved.thinkingConfig, responseThinkingField: resolved.responseThinkingField,
           temperature: input.temperature, responseFormat: input.responseFormat, signal })
      } catch (error) {
        if (signal.aborted) throw new PluginError('PLUGIN_CANCELLED', 'AI 调用已取消或超时', 408)
        if (publicStreamError && error instanceof PluginError) throw error
        // Provider errors can contain authorization headers or connection details.
        throw new PluginError('PLUGIN_AI_FAILED', '平台模型调用失败，请检查模型配置后重试', 502)
      }
      if (signal.aborted) throw new PluginError('PLUGIN_CANCELLED', 'AI 调用已取消或超时', 408)
      // Never expose private reasoning as the result or present a truncated
      // report as completed. These fixed errors cannot contain provider secrets.
      if (result.finishReason === 'length') throw new PluginError('PLUGIN_AI_OUTPUT_LIMIT', '模型输出达到上限，结果尚未完成；请提高 maxTokens 或缩小分析内容后重试', 502)
      if (result.finishReason !== 'stop' || result.toolCalls?.length) throw new PluginError('PLUGIN_AI_INCOMPLETE', '模型未返回完整结果，请重试', 502)
      if (!result.content?.trim()) throw new PluginError('PLUGIN_AI_EMPTY', '模型未返回可见正文，请调整模型配置或缩小分析内容后重试', 502)
      assertPluginResponseFormat(result.content, input.responseFormat)
      return { text: result.content, model: result.model || model.modelId, usage: { inputTokens: result.promptTokens, outputTokens: result.completionTokens } }
    }
    case 'session.read:messages': {
      const input = capabilityMethods['session.read'].messages.parse(args)
      const ctx = context(), history = createConversationHistory()
      if (input.ids) {
        const found = await Promise.all(input.ids.map(id => history.getMessageById(id, tenantId, ctx.sessionId)))
        const messages = await publicSessionHistoryMessages(tenantId, found.filter((message): message is NonNullable<typeof message> => message !== null))
        return { messages, total: messages.length, nextOffset: null }
      }
      const archive = history.getArchive ? await history.getArchive(ctx, { offset: input.offset, limit: input.limit }) : undefined
      const all = archive ? undefined : await history.getFullHistory(ctx)
      const messages = await publicSessionHistoryMessages(tenantId, archive?.messages ?? all!.slice(input.offset, input.offset + input.limit))
      const total = archive?.totalMessageCount ?? all?.length ?? messages.length
      return { messages, total, nextOffset: input.offset + messages.length < total ? input.offset + messages.length : null, revision: archive?.archiveRevision }
    }
    case 'skills.read:list': {
      capabilityMethods['skills.read'].list.parse(args)
      return { skills: skillsRegistry.getSkills(call.sessionId ? project() : undefined).map(skill => ({ id: skill.id || skill.name, name: skill.name, description: skill.description, scope: skill.scope, builtin: skill.builtin })) }
    }
    case 'skills.read:get': {
      const input = capabilityMethods['skills.read'].get.parse(args)
      const skills = skillsRegistry.getSkills(call.sessionId ? project() : undefined)
      const skill = skills.find(skill => (skill.id || skill.name) === input.id)
      if (!skill) throw new PluginError('PLUGIN_NOT_FOUND', '技能不存在或未启用', 404)
      const content = getSkillContent(skills, skill.name)
      if (content === null) throw new PluginError('PLUGIN_NOT_FOUND', '技能内容不可读取，请检查本地技能文件', 404)
      return { id: input.id, name: skill.name, content }
    }
    case 'workspace.read:list':
    case 'workspace.read:read':
    case 'workspace.write:write': {
      const input = method === 'write' ? capabilityMethods['workspace.write'].write.parse(args)
        : capabilityMethods['workspace.read'][method as 'list' | 'read'].parse(args)
      const ctx = context()
      return workspaceManager.withBindingLease(ctx, execution?.workspaceBinding, async lease => {
        const file = pluginWorkspacePath(lease.snapshot.root, input.path)
        signal.throwIfAborted(); lease.assertCurrent()
        if (method === 'list') return { entries: fs.readdirSync(file, { withFileTypes: true }).map(item => ({ name: item.name, type: item.isSymbolicLink() ? 'link' : item.isDirectory() ? 'directory' : 'file', path: path.relative(lease.snapshot.root, path.join(file, item.name)).replace(/\\/g, '/') })) }
        if (method === 'read') {
          const stat = fs.statSync(file)
          if (!stat.isFile()) throw new PluginError('PLUGIN_FILE', '只能读取普通文件')
          return { path: input.path, content: fs.readFileSync(file, 'utf8'), size: stat.size }
        }
        return withFileLocks([file], async () => {
          signal.throwIfAborted(); lease.assertCurrent()
          const checked = pluginWorkspacePath(lease.snapshot.root, input.path)
          fs.mkdirSync(path.dirname(checked), { recursive: true })
          fs.writeFileSync(checked, z.string().parse(args.content))
          return { path: input.path, written: true }
        })
      }, 5_000)
    }
    case 'knowledge.read:list': capabilityMethods['knowledge.read'].list.parse(args); return { bases: await listKnowledgeBases(tenantId) }
    case 'knowledge.read:get': return getDocument(tenantId, capabilityMethods['knowledge.read'].get.parse(args).id)
    case 'knowledge.read:search': {
      const input = capabilityMethods['knowledge.read'].search.parse(args)
      return { results: await searchChunks(tenantId, input.query, input.limit, input.knowledgeBaseIds) }
    }
    case 'knowledge.write:create': {
      const input = capabilityMethods['knowledge.write'].create.parse(args)
      return addDocument(tenantId, input.filename, 'text/plain', input.content, input.knowledgeBaseId, { signal })
    }
    case 'knowledge.write:update': {
      const input = capabilityMethods['knowledge.write'].update.parse(args)
      return updateDocument(tenantId, input.id, { content: input.content }, input.expectedRevision, signal)
    }
    case 'settings.read:get': capabilityMethods['settings.read'].get.parse(args); return access.getSettings()
    case 'settings.write:set': return access.setSettings(capabilityMethods['settings.write'].set.parse(args).value)
    case 'mcp.read:list': {
      capabilityMethods['mcp.read'].list.parse(args)
      return { servers: listServers(project()).filter(server => server.enabled).map(server => ({ id: server.id, name: server.name, description: server.description })) }
    }
    case 'mcp.read:tools': {
      const input = capabilityMethods['mcp.read'].tools.parse(args)
      const ctx = context(), denied = extensionPolicy(ctx)
      if (denied) throw new PluginError('PLUGIN_FORBIDDEN', denied.output, 403)
      const server = listServers(project()).find(server => server.enabled && server.id === input.serverId)
      if (!server) throw new PluginError('PLUGIN_FORBIDDEN', 'MCP 服务未启用', 403)
      const client = new HTTPMCPClient(server, ctx)
      try { return { tools: (await client.listTools(signal)).filter(tool => !server.disabledTools?.includes(tool.name)).map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })) } }
      catch { throw new PluginError('PLUGIN_MCP_FAILED', 'MCP 工具列表读取失败，请检查服务状态', 502) }
      finally { await client.disconnect().catch(() => undefined) }
    }
    case 'mcp.invoke:call': {
      const input = capabilityMethods['mcp.invoke'].call.parse(args)
      const ctx = context(), denied = extensionPolicy(ctx)
      if (denied) throw new PluginError('PLUGIN_FORBIDDEN', denied.output, 403)
      const server = listServers(project()).find(server => server.enabled && server.id === input.serverId)
      if (!server || server.disabledTools?.includes(input.tool)) throw new PluginError('PLUGIN_FORBIDDEN', 'MCP 服务或工具未启用', 403)
      const client = new HTTPMCPClient(server, ctx)
      try { return { output: await client.callTool(input.tool, input.arguments, signal) } }
      catch { throw new PluginError('PLUGIN_MCP_FAILED', 'MCP 调用失败，请检查服务状态', 502) }
      finally { await client.disconnect().catch(() => undefined) }
    }
    default: throw new PluginError('PLUGIN_METHOD', '此宿主方法不存在', 404)
  }
}
