import fs from 'node:fs'
import path from 'node:path'
import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invokePluginCapability, publishedCapabilityAccess, streamPluginCapability, type CapabilityAccess } from '../capability-runtime.js'
import { closePluginAgents, discoverPluginAgentTools, respondPluginAgent, cancelPluginAgents } from '../agent-capability.js'
import { rootRunStore } from '../../storage/root-runs/index.js'
import { controllerSubject } from '../../core/collaboration/controller-origin.js'
import { SQLiteAgentStore } from '../../storage/agent/index.js'
import { browserBridge } from '../../tools/browser/browser-bridge.js'
import { getPluginTemplate } from '../templates.js'
import { initDb, closeDb } from '../../storage/sqlite/db.js'
import { getSubagentRunner } from '../../core/subagent/runner.js'
import type { LLMAdapterOptions, LLMStreamChunk } from '../../core/llm-adapter/types.js'
import type { Message } from '../../core/agent-context/types.js'
import type { AgentContext } from '../../core/agent-context/types.js'
import type { PluginCapabilityId } from '../capabilities.js'
import { createPluginProject } from '../project.js'
import { closeDevPlugin, devCapabilityAccess, openDevPlugin, setDevPluginPermissionGrants } from '../dev-session.js'
import { WorkspaceManager, workspaceManager } from '../../workspace/index.js'
import { createSelectedPluginTools } from '../catalogue.js'
import { PluginService } from '../service.js'
import { pluginToolkitId } from '../metadata.js'
import { PluginLifecycleRuntime } from '../lifecycle-runtime.js'
import { skillsRegistry } from '../../skills/skills-registry.js'
import { auditLogStore } from '../../security/audit-log.js'
import type { PluginStreamEvent } from '../capability-stream-types.js'
import { policyEngine } from '../../security/policy-engine.js'
import { getGlobalToolPool, setGlobalToolPoolLimit } from '../../core/utils/concurrency-pool.js'
import { createToolRegistry } from '../../tools/registry-factory.js'

const mocks = vi.hoisted(() => ({ stream: vi.fn(), complete: vi.fn(), models: vi.fn() }))
vi.mock('../../storage/sqlite/models.js', () => ({ ModelsStore: class { getModels = mocks.models } }))
vi.mock('../../core/llm-adapter/resolve-model.js', () => ({
  resolveModelConfig: async ({ overrides }: { overrides?: { thinkingEnabled?: boolean; reasoningEffort?: 'low' | 'medium' | 'high' } } = {}) => ({
    model: 'fixture-model', provider: 'fixture', capabilities: { contextWindow: 32768, maxOutputTokens: 4096 },
    thinkingEnabled: overrides?.thinkingEnabled, reasoningEffort: overrides?.reasoningEffort,
    thinkingConfig: overrides?.thinkingEnabled === false ? null : undefined,
  }),
  createAdapterFromResolved: () => ({ model: 'fixture-model', provider: 'fixture', stream: mocks.stream, complete: mocks.complete, countTokens: () => 10 }),
}))
const fixtures = path.resolve('.e2e-tmp/plugin-agent-capability')
const expectedBuiltins = [
  'read_file', 'write_file', 'edit_file', 'list_files', 'delete_file', 'create_dir',
  'execute_cmd', 'command_output', 'wait_command', 'wait_commands', 'cancel_command', 'ask_user', 'plan_update', 'load_tools',
  'glob', 'grep', 'web_fetch', 'http_request', 'search_history', 'code_diagnose', 'codegraph',
  'subagent', 'subagent_start', 'subagent_send', 'subagent_wait', 'subagent_cancel', 'subagent_participants',
  'subagent_inbox', 'subagent_read_result', 'subagent_directory', 'subagent_followup', 'subagent_request_input',
  'list_skills', 'get_skill', 'run_skill_script',
].sort()
let root: string, grants: PluginCapabilityId[], access: CapabilityAccess, settings: Record<string, unknown>
let server: ReturnType<typeof Fastify> | undefined
beforeEach(async () => {
  fs.mkdirSync(fixtures, { recursive: true }); root = fs.mkdtempSync(path.join(fixtures, 'case-'))
  vi.stubEnv('DATA_DIR', path.join(root, 'state', 'agent.db')); vi.stubEnv('OSM_MODE', 'off'); vi.stubEnv('HISTORY_BACKEND', 'jsonl'); vi.stubEnv('AUTH_ENABLED', 'false')
  vi.stubEnv('DEFAULT_SECURITY_MODE', 'standard'); vi.stubEnv('WORKSPACE_ROOT', path.join(root, 'workspace'))
  vi.stubEnv('MCP_CONFIG_PATH', path.join(root, 'mcp.json')); vi.stubEnv('AETHER_GLOBAL_DIR', path.join(root, 'global'))
  await initDb()
  grants = ['agents.read', 'agents.manage', 'settings.read']; settings = { rubric: 'accuracy' }
  const manifest = getPluginTemplate('json-tool').manifest; manifest.permissions = { requested: [...grants] }
  access = { id: manifest.id, revision: 1, manifest, grants, getSettings: async () => settings, setSettings: async value => { settings = value; return value },
    refresh: async () => ({ ...access, grants: [...grants] }) }
  mocks.models.mockResolvedValue([{ id: 'fixture', modelId: 'fixture-model', provider: 'fixture', isEnabled: true }])
  mocks.stream.mockReset()
})
afterEach(async () => {
  await closePluginAgents(); await server?.close(); server = undefined; await closeDb(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.clearAllMocks()
  if (path.dirname(root) !== fixtures || fs.lstatSync(root).isSymbolicLink()) throw new Error('Unsafe plugin agent test cleanup')
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  if (!fs.readdirSync(fixtures).length) fs.rmdirSync(fixtures)
})
const call = (capability: 'agents.read' | 'agents.manage', method: string, args: Record<string, unknown>, own = access, sessionId = 'bound-session') =>
  invokePluginCapability(own, 'tenant', { capability, method, args, sessionId, expectedRevision: 1 }) as Promise<Record<string, unknown>>
async function finish(runId: string, own = access) {
  let value: Record<string, unknown> = {}
  await vi.waitFor(async () => { value = await call('agents.read', 'status', { runId }, own); expect(['succeeded', 'failed', 'cancelled']).toContain(value.status) }, { timeout: 5000 })
  return value
}
function explicitSettingsReader() {
  access.manifest.tools.push({ name: 'read_settings', description: 'Read this plugin settings', entry: 'main.mjs', inputSchema: { type: 'object', properties: {}, additionalProperties: false } })
  access.invokeTool = async (_tool, _args, signal, execution) => ({
    result: await invokePluginCapability(await access.refresh!(), 'tenant', { capability: 'settings.read', method: 'get', args: {}, expectedRevision: 1 }, signal, execution),
    artifacts: [], stderr: '', durationMs: 0,
  })
  return { customTools: [{ name: 'read_settings', tool: 'read_settings' }] }
}
describe('plugin Agents use the production execution loop', () => {
  it('does not add browser tools even when a trusted browser host is connected', async () => {
    vi.stubEnv('OSM_MODE', 'balanced')
    grants.push('engine.tools'); access.manifest.permissions!.requested.push('engine.tools')
    const authority = { kind: 'account' as const, tenantId: 'tenant', userId: 'plugin-browser-user' }
    const principal = { tenantId: 'tenant', userId: authority.userId, method: 'jwt' as const }
    const host = browserBridge.hostDemands.register(authority)
    let requests = 0
    mocks.stream.mockImplementation(async function* (messages: Message[], options: LLMAdapterOptions): AsyncGenerator<LLMStreamChunk> {
      if (requests++ === 0) {
        yield { done: true, finishReason: 'tool_calls', toolCalls: [{ id: 'load-native-browser', name: 'load_tools', args: JSON.stringify({ names: ['browser_tabs'] }), index: 0 }] }
      } else if (requests === 2) {
        expect(JSON.stringify(messages.filter(message => message.role === 'tool'))).toContain('未启用或不可用')
        expect(options.tools?.some(tool => tool.name === 'browser_tabs')).toBe(false)
        yield { done: true, finishReason: 'tool_calls', toolCalls: [{ id: 'plugin-real-browser-tabs', name: 'browser_tabs', args: '{}', index: 0 }] }
      } else {
        yield { done: true, content: '当前插件 Agent 没有浏览器工具。', finishReason: 'stop' }
      }
    })
    try {
      const result = await streamPluginCapability(access, 'tenant', { capability: 'agents.manage', method: 'stream', sessionId: 'bound-session', expectedRevision: 1,
        args: { modelId: 'fixture', task: '读取内置浏览器标签' } }, () => undefined, undefined,
      { browserAuthority: authority, browserPrincipal: principal, controllerSubject: controllerSubject(authority, 'jwt'), workspaceContext: { tenantId: 'tenant', sessionId: 'bound-session' } }) as any
      expect(result.status).toBe('succeeded')
      const run = await getSubagentRunner().store.getRun('tenant', result.runId)
      expect(run?.toolCalls.every(tool => tool.status === 'failed')).toBe(true)
      await expect(browserBridge.hostDemands.poll(authority, host.hostId, host.hostToken, AbortSignal.abort())).resolves.toEqual([])
      expect((await discoverPluginAgentTools(access, 'tenant')).tools.some(tool => tool.name.startsWith('browser_'))).toBe(false)
    } finally { browserBridge.hostDemands.unregister(authority, host.hostId, host.hostToken) }
  })
  it.each(['jsonl', 'sqlite'])('runs a real native child from an authenticated independent root in the bound workspace: %s', async backend => {
    vi.stubEnv('HISTORY_BACKEND', backend)
    vi.stubEnv('OSM_MODE', 'balanced')
    vi.stubEnv('AUTH_ENABLED', 'true')
    grants.push('engine.tools'); access.manifest.permissions!.requested.push('engine.tools')
    const parentWorkspace = workspaceManager.getBindingSnapshot({ tenantId: 'tenant', sessionId: 'bound-session' }).root
    const selected = path.join(path.dirname(parentWorkspace), 'selected-project')
    fs.mkdirSync(selected, { recursive: true }); workspaceManager.bindSnapshot({ tenantId: 'tenant', sessionId: 'bound-session' }, selected)
    let childRequests = 0, parentRequests = 0, parentFeedback = ''
    mocks.stream.mockImplementation(async function* (messages: Message[]): AsyncGenerator<LLMStreamChunk> {
      const child = messages.some(message => message.role === 'user' && String(message.content).includes('NATIVE_CHILD_ONLY'))
      if (child) {
        if (childRequests++ === 0) yield { done: true, finishReason: 'tool_calls', toolCalls: [{ id: 'child-native-write', name: 'write_file', args: JSON.stringify({ path: 'native-child.txt', content: 'CHILD-OWNED-WRITE' }), index: 0 }] }
        else yield { done: true, content: '子代理已写入并完成。', finishReason: 'stop' }
      } else if (parentRequests++ === 0) yield { done: true, finishReason: 'tool_calls', toolCalls: [{ id: 'root-native-child', name: 'subagent_start', args: JSON.stringify({ task: 'NATIVE_CHILD_ONLY', builtinRole: 'executor' }), index: 0 }] }
      else if (parentRequests === 2) { const admission = JSON.parse(String(messages.find(message => message.role === 'tool' && message.toolName === 'subagent_start')!.content)); yield { done: true, finishReason: 'tool_calls', toolCalls: [{ id: 'wait-native-child', name: 'subagent_wait', args: JSON.stringify({ runId: admission.runId, timeoutMs: 10000 }), index: 0 }] } }
      else { parentFeedback = JSON.stringify(messages.filter(message => message.role === 'tool')); yield { done: true, content: '主 Agent 已验收子代理结果。', finishReason: 'stop' } }
    })
    const start = await call('agents.manage', 'run', { modelId: 'fixture', task: '测试真实子代理执行' })
    expect((await finish(String(start.runId))).status).toBe('succeeded')
    const dispatch = await getSubagentRunner().store.getRun('tenant', String(start.runId))
    expect(childRequests, parentFeedback).toBe(2)
    expect(fs.readFileSync(path.join(selected, 'native-child.txt'), 'utf8')).toBe('CHILD-OWNED-WRITE')
    const children = await getSubagentRunner().store.listRunViewsPage('tenant', String(start.childSessionId), {})
    expect(children.runs).toHaveLength(1); expect(children.runs[0].status).toBe('succeeded')
    const header = await getSubagentRunner().store.getRunHeader('tenant', String(start.runId), true)
    const root = await rootRunStore.get('tenant', header!.continuation!.pluginRootRunId!)
    expect(root).toMatchObject({ sessionId: start.childSessionId, status: 'succeeded' })
    expect(root!.request.pluginAgentOwner).toMatchObject({ pluginId: access.id, boundSessionId: 'bound-session', revision: 1 })
    expect(childRequests).toBe(2)
  })
  it('keeps live tool toggles on configured native children that build their own registry', async () => {
    vi.stubEnv('OSM_MODE', 'balanced')
    grants.push('engine.tools'); access.manifest.permissions!.requested.push('engine.tools')
    const configured = await new SQLiteAgentStore().create('tenant', { name: 'Configured child fixture', skills: [], mcpServers: [], knowledgeBases: [], allowedTools: ['write_file', 'office_document', 'browser_open', 'agent_create'], model: 'fixture-model' })
    const workspace = workspaceManager.getBindingSnapshot({ tenantId: 'tenant', sessionId: 'bound-session' }).root
    let childRequests = 0, parentRequests = 0
    let childReceipts: Message[] = []
    mocks.stream.mockImplementation(async function* (messages: Message[], options: LLMAdapterOptions): AsyncGenerator<LLMStreamChunk> {
      const child = messages.some(message => message.role === 'user' && String(message.content).includes('CONFIGURED_CHILD_ONLY'))
      if (child) {
        expect(options.tools?.some(tool => ['office_document', 'browser_open', 'agent_create'].includes(tool.name))).toBe(false)
        if (childRequests++ === 0) {
          access.agentDisabledTools = ['write_file', 'plan_update']
          yield { done: true, finishReason: 'tool_calls', toolCalls: [
            { id: 'configured-write', name: 'write_file', args: JSON.stringify({ path: 'forbidden-child.txt', content: 'BAD' }), index: 0 },
            { id: 'configured-removed-tool', name: 'office_document', args: '{}', index: 1 },
          ] }
        } else {
          childReceipts = messages.filter(message => message.role === 'tool')
          expect(JSON.stringify(messages.filter(message => message.role === 'tool'))).toContain('已被用户禁用')
          yield { done: true, content: '用户已关闭写入。', finishReason: 'stop' }
        }
      } else if (parentRequests++ === 0) yield { done: true, finishReason: 'tool_calls', toolCalls: [{ id: 'configured-child', name: 'subagent_start', args: JSON.stringify({ task: 'CONFIGURED_CHILD_ONLY', agentId: configured.id }), index: 0 }] }
      else if (parentRequests === 2) { const admission = JSON.parse(String(messages.find(message => message.role === 'tool' && message.toolName === 'subagent_start')!.content)); yield { done: true, finishReason: 'tool_calls', toolCalls: [{ id: 'wait-configured-child', name: 'subagent_wait', args: JSON.stringify({ runId: admission.runId, timeoutMs: 10000 }), index: 0 }] } }
      else yield { done: true, content: '已遵守用户工具配置。', finishReason: 'stop' }
    })
    const start = await call('agents.manage', 'run', { modelId: 'fixture', task: '测试配置 Agent 工具权限' })
    expect((await finish(String(start.runId))).status).toBe('succeeded')
    const dispatch = await getSubagentRunner().store.getRun('tenant', String(start.runId))
    expect(dispatch!.toolCalls[0], JSON.stringify(dispatch!.toolCalls[0])).toMatchObject({ status: 'succeeded' })
    expect(fs.existsSync(path.join(workspace, 'forbidden-child.txt'))).toBe(false)
    expect(childRequests).toBe(2)
    const children = await getSubagentRunner().store.listRunViewsPage('tenant', String(start.childSessionId), {})
    expect(children.runs[0].status).toBe('succeeded')
    expect(childReceipts.find(message => message.toolCallId === 'configured-removed-tool')?.metadata).toMatchObject({ success: false, status: 'failed' })
    expect(childReceipts.find(message => message.toolCallId === 'configured-write')?.metadata).toMatchObject({ success: false })
  })
  it.each(['jsonl', 'sqlite'])('parks a real question and resumes only the same user, plugin, revision and binding; duplicate answers do not rerun: %s', async backend => {
    vi.stubEnv('HISTORY_BACKEND', backend)
    grants.push('engine.tools'); access.manifest.permissions!.requested.push('engine.tools')
    const events: PluginStreamEvent[] = []
    const subject = controllerSubject({ kind: 'account', tenantId: 'tenant', userId: 'alice' }, 'jwt')
    const execution = { workspaceContext: { tenantId: 'tenant', sessionId: 'bound-session' }, controllerSubject: subject }
    let requests = 0
    mocks.stream.mockImplementation(async function* (messages: Message[]): AsyncGenerator<LLMStreamChunk> {
      if (requests++ === 0) yield { done: true, finishReason: 'tool_calls', toolCalls: [{ id: 'real-question', name: 'ask_user', args: JSON.stringify({ question: '使用哪种格式？', options: [{ label: 'HTML' }, { label: 'PDF' }] }), index: 0 }] }
      else {
        expect(JSON.stringify(messages)).toContain('HTML')
        yield { done: true, content: '已按选择生成 HTML 方案。', finishReason: 'stop' }
      }
    })
    const first = await streamPluginCapability(access, 'tenant', { capability: 'agents.manage', method: 'stream', sessionId: 'bound-session', expectedRevision: 1,
      args: { modelId: 'fixture', task: '请用户选择后继续' } }, event => { events.push(event) }, undefined, execution) as any
    expect(first.status).toBe('blocked'); expect(first.pending).toHaveLength(1)
    expect(events.find(event => event.type === 'pending')).toMatchObject({ runId: first.runId, childSessionId: first.childSessionId, pending: { kind: 'ask', toolCallId: 'real-question' } })
    expect(JSON.stringify(events)).not.toContain('pendingAction')
    const reply = { runId: first.runId, requestId: first.pending[0].requestId, toolCallId: first.pending[0].toolCallId, output: 'HTML' }
    await expect(respondPluginAgent(access, 'tenant', reply, { ...execution, controllerSubject: controllerSubject({ kind: 'account', tenantId: 'tenant', userId: 'bob' }, 'jwt') })).rejects.toMatchObject({ code: 'PLUGIN_AGENT_CONTROLLER' })
    await expect(respondPluginAgent(access, 'tenant', reply, { ...execution, workspaceContext: { tenantId: 'tenant', sessionId: 'other-session' } })).rejects.toMatchObject({ code: 'PLUGIN_AGENT_NOT_FOUND' })
    await expect(respondPluginAgent({ ...access, id: 'another-plugin' }, 'tenant', reply, execution)).rejects.toMatchObject({ code: 'PLUGIN_AGENT_NOT_FOUND' })
    await expect(call('agents.manage', 'run', { modelId: 'fixture', task: '绕过问题', resumeRunId: first.runId })).rejects.toMatchObject({ code: 'PLUGIN_AGENT_PENDING' })
    await closeDb(); await initDb()
    const nextEvents: PluginStreamEvent[] = []
    const [result, concurrent] = await Promise.all([
      respondPluginAgent(access, 'tenant', reply, { ...execution, onEvent: event => { nextEvents.push(event) } }),
      respondPluginAgent(access, 'tenant', reply, { ...execution, onEvent: () => undefined }),
    ]) as any[]
    expect(concurrent.runId).toBe(result.runId)
    expect(result).toMatchObject({ status: 'succeeded', childSessionId: first.childSessionId, pending: [] })
    expect(result.runId).not.toBe(first.runId); expect(nextEvents[0]).toMatchObject({ type: 'started', runId: result.runId })
    const duplicate = await respondPluginAgent(access, 'tenant', reply, { ...execution, onEvent: () => undefined }) as any
    expect(duplicate.runId).toBe(result.runId); expect(requests).toBe(2)
  })
  it('persists parked cancellation when the plugin is disabled', async () => {
    grants.push('engine.tools'); access.manifest.permissions!.requested.push('engine.tools')
    mocks.stream.mockImplementation(async function* (): AsyncGenerator<LLMStreamChunk> {
      yield { done: true, finishReason: 'tool_calls', toolCalls: [{ id: 'cancel-question', name: 'ask_user', args: JSON.stringify({ question: '格式？', options: [{ label: 'HTML' }, { label: 'PDF' }] }), index: 0 }] }
    })
    const first = await streamPluginCapability(access, 'tenant', { capability: 'agents.manage', method: 'stream', sessionId: 'bound-session', expectedRevision: 1,
      args: { modelId: 'fixture', task: '等待用户选择' } }, () => undefined) as any
    expect(first.status).toBe('blocked')
    await cancelPluginAgents('tenant', access.id)
    expect(await call('agents.read', 'status', { runId: first.runId })).toMatchObject({ status: 'cancelled', pending: [] })
  })
  it('allows a pending event consumer to cancel its own Agent without waiting on itself', async () => {
    grants.push('engine.tools'); access.manifest.permissions!.requested.push('engine.tools')
    mocks.stream.mockImplementation(async function* (): AsyncGenerator<LLMStreamChunk> {
      yield { done: true, finishReason: 'tool_calls', toolCalls: [{ id: 'cancel-in-listener', name: 'ask_user', args: JSON.stringify({ question: '继续？', options: [{ label: '继续' }, { label: '停止' }] }), index: 0 }] }
    })
    let runId = ''
    await expect(streamPluginCapability(access, 'tenant', { capability: 'agents.manage', method: 'stream', sessionId: 'bound-session', expectedRevision: 1,
      args: { modelId: 'fixture', task: '等待用户输入' } }, async event => {
        if (event.type === 'started') runId = event.runId!
        if (event.type === 'pending') await call('agents.manage', 'cancel', { runId })
      })).rejects.toMatchObject({ code: 'PLUGIN_CANCELLED' })
    expect((await finish(runId)).status).toBe('cancelled')
  })
  it('makes an answered but unadmitted continuation recoverable instead of permanently waiting', async () => {
    grants.push('engine.tools'); access.manifest.permissions!.requested.push('engine.tools')
    const execution = { workspaceContext: { tenantId: 'tenant', sessionId: 'bound-session' }, controllerSubject: controllerSubject({ kind: 'account', tenantId: 'tenant', userId: 'alice' }, 'jwt') }
    let requests = 0
    mocks.stream.mockImplementation(async function* (): AsyncGenerator<LLMStreamChunk> {
      if (requests++ === 0) yield { done: true, finishReason: 'tool_calls', toolCalls: [{ id: 'admission-gap-question', name: 'ask_user', args: JSON.stringify({ question: '格式？', options: [{ label: 'HTML' }, { label: 'PDF' }] }), index: 0 }] }
      else yield { done: true, content: '已按新的继续指令处理。', finishReason: 'stop' }
    })
    const first = await streamPluginCapability(access, 'tenant', { capability: 'agents.manage', method: 'stream', sessionId: 'bound-session', expectedRevision: 1,
      args: { modelId: 'fixture', task: '等待选择' } }, () => undefined, undefined, execution) as any
    const header = await getSubagentRunner().store.getRunHeader('tenant', first.runId, true)
    const pending = first.pending[0], rootId = header!.continuation!.pluginRootRunId!
    // Simulate a crash after the durable answer commit but before outer runner admission.
    await rootRunStore.answer('tenant', first.childSessionId, rootId, pending.requestId, pending.toolCallId, pending.toolName, 'HTML')
    await expect(respondPluginAgent(access, 'tenant', { runId: first.runId, requestId: pending.requestId, toolCallId: pending.toolCallId, output: 'HTML' }, execution))
      .rejects.toMatchObject({ code: 'PLUGIN_AGENT_RESPONSE_INTERRUPTED' })
    expect((await rootRunStore.get('tenant', rootId))?.status).toBe('interrupted')
    const resumed = await call('agents.manage', 'run', { modelId: 'fixture', task: '按 HTML 继续完成任务', resumeRunId: first.runId })
    expect(resumed.childSessionId).toBe(first.childSessionId)
    expect((await finish(String(resumed.runId))).status).toBe('succeeded')
    expect(requests).toBe(2)
  })
  it.each(['approved', 'rejected'])('resumes the native sealed command only after a real host response: %s', async decision => {
    vi.stubEnv('OSM_MODE', 'balanced')
    grants.push('engine.tools'); access.manifest.permissions!.requested.push('engine.tools')
    await policyEngine.upsertRule({ name: 'isolated approval fixture', command: path.basename(process.execPath), action: 'deny', priority: -10000, enabled: true, description: 'Fixture only' })
    const workspace = workspaceManager.getBindingSnapshot({ tenantId: 'tenant', sessionId: 'bound-session' }).root
    fs.mkdirSync(workspace, { recursive: true })
    const sentinel = path.join(workspace, `approved-command-${decision}-${path.basename(root)}.txt`)
    const execution = { workspaceContext: { tenantId: 'tenant', sessionId: 'bound-session' }, controllerSubject: controllerSubject({ kind: 'account', tenantId: 'tenant', userId: 'alice' }, 'jwt') }
    let requests = 0
    mocks.stream.mockImplementation(async function* (): AsyncGenerator<LLMStreamChunk> {
      if (requests++ === 0) yield { done: true, finishReason: 'tool_calls', toolCalls: [{ id: 'sealed-command', name: 'execute_cmd', args: JSON.stringify({ command: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(sentinel)},'HOST-APPROVED')`] }), index: 0 }] }
      else yield { done: true, content: '已处理用户决定。', finishReason: 'stop' }
    })
    const events: PluginStreamEvent[] = []
    const first = await streamPluginCapability(access, 'tenant', { capability: 'agents.manage', method: 'stream', sessionId: 'bound-session', expectedRevision: 1,
      args: { modelId: 'fixture', task: '需要用户允许的命令' } }, event => { events.push(event) }, undefined, execution) as any
    expect(first.status).toBe('blocked'); expect(fs.existsSync(sentinel)).toBe(false)
    expect(JSON.stringify(events)).not.toContain('pendingAction')
    const result = await respondPluginAgent(access, 'tenant', { runId: first.runId, requestId: first.pending[0].requestId,
      toolCallId: first.pending[0].toolCallId, output: decision }, { ...execution, onEvent: () => undefined }) as any
    expect(result.status).toBe('succeeded')
    expect(fs.existsSync(sentinel)).toBe(decision === 'approved')
    if (decision === 'approved') expect(fs.readFileSync(sentinel, 'utf8')).toBe('HOST-APPROVED')
    expect(requests).toBe(2)
  })
  it('cancels a silent resumed model when its plugin permission is revoked', async () => {
    grants.push('engine.tools'); access.manifest.permissions!.requested.push('engine.tools')
    const execution = { workspaceContext: { tenantId: 'tenant', sessionId: 'bound-session' }, controllerSubject: controllerSubject({ kind: 'account', tenantId: 'tenant', userId: 'alice' }, 'jwt') }
    let requests = 0, resumed = false
    mocks.stream.mockImplementation(async function* (_messages: Message[], options: LLMAdapterOptions): AsyncGenerator<LLMStreamChunk> {
      if (requests++ === 0) { yield { done: true, finishReason: 'tool_calls', toolCalls: [{ id: 'silent-resume-question', name: 'ask_user', args: JSON.stringify({ question: '格式？', options: [{ label: 'HTML' }, { label: 'PDF' }] }), index: 0 }] }; return }
      resumed = true
      await new Promise<void>((_resolve, reject) => { const abort = () => reject(options.signal?.reason ?? new Error('aborted')); options.signal?.addEventListener('abort', abort, { once: true }); if (options.signal?.aborted) abort() })
    })
    const first = await streamPluginCapability(access, 'tenant', { capability: 'agents.manage', method: 'stream', sessionId: 'bound-session', expectedRevision: 1,
      args: { modelId: 'fixture', task: '等待选择后继续执行' } }, () => undefined, undefined, execution) as any
    let latestRunId = ''
    const reply = respondPluginAgent(access, 'tenant', { runId: first.runId, requestId: first.pending[0].requestId, toolCallId: first.pending[0].toolCallId, output: 'HTML' },
      { ...execution, onEvent: event => { if (event.type === 'started') latestRunId = event.runId! } })
    void reply.catch(() => undefined)
    await vi.waitFor(() => expect(resumed).toBe(true))
    grants.splice(grants.indexOf('agents.manage'), 1)
    await expect(reply).rejects.toMatchObject({ code: 'PLUGIN_CANCELLED' })
    expect((await getSubagentRunner().store.getRunView('tenant', latestRunId))?.status).toBe('cancelled')
    const header = await getSubagentRunner().store.getRunHeader('tenant', latestRunId, true)
    expect((await rootRunStore.get('tenant', header!.continuation!.pluginRootRunId!))?.status).toBe('cancelled')
  })
  it('admits more than four Agent streams using the real runner pool without a plugin-only cap', async () => {
    const configuration = explicitSettingsReader()
    let started = 0, releaseModels!: () => void, releaseTools!: () => void
    const modelsReady = new Promise<void>(resolve => { releaseModels = resolve })
    const toolsReady = new Promise<void>(resolve => { releaseTools = resolve })
    const readSettings = vi.fn(async () => { await toolsReady; return settings })
    access.getSettings = readSettings
    mocks.stream.mockImplementation(async function* (messages: Message[]): AsyncGenerator<LLMStreamChunk> {
      if (messages.some(message => message.role === 'tool')) {
        yield { done: true, content: 'Settings reviewed.', finishReason: 'stop' }
        return
      }
      const index = ++started
      if (started === 4) releaseModels()
      await modelsReady
      yield { done: true, finishReason: 'tool_calls', toolCalls: [{ id: `parallel-settings-${index}`, name: 'read_settings', args: '{}', index: 0 }] }
    })
    const streamEvents: PluginStreamEvent[][] = Array.from({ length: 6 }, () => [])
    const streams = streamEvents.map((events, index) => streamPluginCapability(access, 'tenant', {
      capability: 'agents.manage', method: 'stream', args: { modelId: 'fixture', task: `Review settings ${index + 1}.`, ...configuration },
      sessionId: 'bound-session', expectedRevision: 1,
    }, event => { events.push(event) }))
    const completion = Promise.all(streams)
    void completion.catch(() => undefined)
    const settingsCall = { capability: 'settings.read' as const, method: 'get', args: {}, expectedRevision: 1 }
    try {
      // The barrier keeps all four outer requests admitted before any nested tool starts.
      await vi.waitFor(() => expect(started).toBeGreaterThanOrEqual(4), { timeout: 5000 })
      await vi.waitFor(() => expect(readSettings.mock.calls.length).toBeGreaterThanOrEqual(4), { timeout: 5000 })
      expect(streamEvents.every(events => !events.some(event => event.type === 'complete'))).toBe(true)
      const ordinary = invokePluginCapability(access, 'tenant', settingsCall)
      const nested = invokePluginCapability(access, 'tenant', settingsCall, undefined, { childAgent: true })
      releaseTools()
      await expect(ordinary).resolves.toEqual(settings)
      await expect(nested).resolves.toEqual(settings)
      const results = await completion
      for (const [index, result] of results.entries()) {
        expect(result).toMatchObject({ status: 'succeeded', toolCount: 1 })
        expect(streamEvents[index].filter(event => event.type === 'tool-end')).toEqual([
          expect.objectContaining({ toolName: 'read_settings', success: true }),
        ])
        expect(streamEvents[index].at(-1)).toMatchObject({ type: 'complete', result: { status: 'succeeded' } })
      }
      // Completion releases both scopes; a new external request and a nested tool can run.
      await expect(invokePluginCapability(access, 'tenant', settingsCall)).resolves.toEqual(settings)
      await expect(invokePluginCapability(access, 'tenant', settingsCall, undefined, { childAgent: true })).resolves.toEqual(settings)
    } finally {
      releaseModels(); releaseTools()
      await Promise.allSettled(streams)
    }
  }, 15000)
  it('streams every public text chunk and actual tool progress without exposing reasoning or arguments', async () => {
    const configuration = explicitSettingsReader()
    const events: PluginStreamEvent[] = [], longText = '真实流式正文'.repeat(2000)
    let step = 0
    mocks.stream.mockImplementation(async function* (): AsyncGenerator<LLMStreamChunk> {
      if (step++ === 0) {
        yield { done: false, content: '开始检查。', reasoningContent: 'PRIVATE-REASONING' }
        yield { done: true, content: '', finishReason: 'tool_calls', toolCalls: [{ id: 'stream-settings', name: 'read_settings', args: '{}', index: 0 }] }
      } else {
        yield { done: false, content: longText }
        yield { done: true, content: '检查完成。', finishReason: 'stop', promptTokens: 4, completionTokens: 5 }
      }
    })
    const result = await streamPluginCapability(access, 'tenant', { capability: 'agents.manage', method: 'stream',
      args: { modelId: 'fixture', task: '检查插件设置并输出报告。', ...configuration }, sessionId: 'bound-session', expectedRevision: 1 }, event => { events.push(event) }) as Record<string, unknown>
    expect(result.status).toBe('succeeded')
    expect(events[0]).toMatchObject({ type: 'started', runId: result.runId })
    expect(events.filter(event => event.type === 'text-delta').map(event => event.type === 'text-delta' ? event.text : '').join('')).toBe('开始检查。' + longText + '检查完成。')
    expect(events.filter(event => event.type.startsWith('tool-'))).toEqual([
      expect.objectContaining({ type: 'tool-start', toolName: 'read_settings', toolCallId: 'stream-settings' }),
      expect.objectContaining({ type: 'tool-end', toolName: 'read_settings', toolCallId: 'stream-settings', success: true }),
    ])
    expect(JSON.stringify(events)).not.toContain('PRIVATE-REASONING')
    expect(events.filter(event => event.type.startsWith('tool-')).every(event => !('args' in event) && !('output' in event))).toBe(true)
    expect(events.at(-1)).toMatchObject({ type: 'complete', result: { status: 'succeeded' } })
  })
  it('forwards per-call model controls and inherits them on continuation', async () => {
    const requests: LLMAdapterOptions[] = []
    mocks.stream.mockImplementation(async function* (_messages: Message[], options: LLMAdapterOptions): AsyncGenerator<LLMStreamChunk> {
      requests.push(options)
      yield { done: true, content: '参数已应用。', finishReason: 'stop' }
    })
    const first = await call('agents.manage', 'run', {
      modelId: 'fixture', task: '执行一次带参数的 Agent 调用', thinking: true,
      reasoningEffort: 'high', temperature: 0.25, maxTokens: 321,
    })
    expect((await finish(String(first.runId))).status).toBe('succeeded')
    const resumed = await call('agents.manage', 'run', { modelId: 'fixture', task: '续跑并继承参数', resumeRunId: String(first.runId) })
    expect((await finish(String(resumed.runId))).status).toBe('succeeded')
    const disabled = await call('agents.manage', 'run', { modelId: 'fixture', task: '续跑并关闭思考', resumeRunId: String(resumed.runId), thinking: false })
    expect((await finish(String(disabled.runId))).status).toBe('succeeded')
    const streamed = await streamPluginCapability(access, 'tenant', { capability: 'agents.manage', method: 'stream', sessionId: 'bound-session', expectedRevision: 1,
      args: { modelId: 'fixture', task: '验证流式参数', thinking: false, temperature: 0.75, maxTokens: 77 } }, () => undefined) as any
    expect(streamed.status).toBe('succeeded')
    expect(requests).toHaveLength(4)
    expect(requests[0]).toMatchObject({ thinkingEnabled: true, reasoningEffort: 'high', temperature: 0.25, maxTokens: 321 })
    expect(requests[1]).toMatchObject({ thinkingEnabled: true, reasoningEffort: 'high', temperature: 0.25, maxTokens: 321 })
    expect(requests[2]).toMatchObject({ thinkingEnabled: false, reasoningEffort: undefined, temperature: 0.25, maxTokens: 321 })
    expect(requests[3]).toMatchObject({ thinkingEnabled: false, reasoningEffort: undefined, temperature: 0.75, maxTokens: 77 })
  })
  it('cancels and joins a streaming Agent when its consumer aborts', async () => {
    const events: PluginStreamEvent[] = [], controller = new AbortController()
    mocks.stream.mockImplementation(async function* (): AsyncGenerator<LLMStreamChunk> {
      yield { done: false, content: 'First chunk.' }
      yield { done: true, content: 'Must not continue.', finishReason: 'stop' }
    })
    await expect(streamPluginCapability(access, 'tenant', { capability: 'agents.manage', method: 'stream',
      args: { modelId: 'fixture', task: '持续输出。' }, sessionId: 'bound-session', expectedRevision: 1 }, event => {
      events.push(event); if (event.type === 'text-delta') controller.abort()
    }, controller.signal)).rejects.toMatchObject({ code: 'PLUGIN_CANCELLED' })
    const started = events.find(event => event.type === 'started')
    expect(started).toBeDefined()
    expect((await finish(String(started && 'runId' in started ? started.runId : ''))).status).toBe('cancelled')
    expect(events.some(event => event.type === 'complete')).toBe(false)
    expect(JSON.stringify(events)).not.toContain('Must not continue.')
  })
  it.each(['failed', 'cancelled'] as const)('reports an Agent %s terminal as an error rather than successful stream completion', async terminal => {
    const events: PluginStreamEvent[] = []
    mocks.stream.mockImplementation(async function* (): AsyncGenerator<LLMStreamChunk> {
      if (terminal === 'failed') throw new Error('PRIVATE-PROVIDER-FAILURE')
      yield { done: true, content: 'Must not complete.', finishReason: 'stop' }
    })
    await expect(streamPluginCapability(access, 'tenant', { capability: 'agents.manage', method: 'stream',
      args: { modelId: 'fixture', task: '测试终态。' }, sessionId: 'bound-session', expectedRevision: 1 }, async event => {
      events.push(event)
      if (terminal === 'cancelled' && event.type === 'started') await call('agents.manage', 'cancel', { runId: event.runId })
    })).rejects.toMatchObject({ code: terminal === 'cancelled' ? 'PLUGIN_CANCELLED' : 'PLUGIN_AGENT_FAILED' })
    expect(events.some(event => event.type === 'complete')).toBe(false)
    expect(events.at(-1)).toMatchObject({ type: 'error' })
    expect(JSON.stringify(events)).not.toContain('PRIVATE-PROVIDER-FAILURE')
  })
  it('stops streaming when a mounted Skill grant is revoked between chunks', async () => {
    grants.push('skills.read'); access.manifest.permissions!.requested.push('skills.read')
    vi.spyOn(skillsRegistry, 'getSkills').mockReturnValue([{ id: 'review', name: 'Review', description: 'Review', skillMdPath: '', order: 0, enabled: true, inlineContent: 'Use evidence.' }])
    const events: PluginStreamEvent[] = []
    mocks.stream.mockImplementation(async function* (): AsyncGenerator<LLMStreamChunk> {
      yield { done: false, content: 'Before revoke.' }
      yield { done: true, content: 'After revoke.', finishReason: 'stop' }
    })
    await expect(streamPluginCapability(access, 'tenant', { capability: 'agents.manage', method: 'stream',
      args: { modelId: 'fixture', task: '检查授权。', skillIds: ['review'] }, sessionId: 'bound-session', expectedRevision: 1 }, event => {
      events.push(event)
      if (event.type === 'text-delta') grants.splice(grants.indexOf('skills.read'), 1)
    })).rejects.toMatchObject({ code: 'PLUGIN_PERMISSION' })
    expect(events.some(event => event.type === 'complete')).toBe(false)
    expect(JSON.stringify(events)).not.toContain('After revoke.')
  })
  it.each([false, true])('mounts chosen Skills and MCP schemas without generic SDK wrappers, preserving configuration on resume (engine.tools=%s)', async engineTools => {
    vi.stubEnv('DEFAULT_SECURITY_MODE', 'full-access')
    vi.spyOn(auditLogStore, 'append').mockResolvedValue()
    grants.push('skills.read', 'mcp.read', 'mcp.invoke'); access.manifest.permissions!.requested.push('skills.read', 'mcp.read', 'mcp.invoke')
    if (engineTools) { grants.push('engine.tools'); access.manifest.permissions!.requested.push('engine.tools') }
    vi.spyOn(skillsRegistry, 'getSkills').mockReturnValue([
      { id: 'selected-skill', name: 'Selected skill', description: 'Review', skillMdPath: '', order: 0, enabled: true, inlineContent: 'MOUNTED-SKILL-GUIDE' },
      { id: 'other-skill', name: 'Other skill', description: 'Other', skillMdPath: '', order: 1, enabled: true, inlineContent: 'UNSELECTED-SKILL-GUIDE' },
    ])
    let definitions = [
      { name: 'echo', description: 'Echo text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } },
      { name: 'disabled', description: 'Disabled tool', inputSchema: { type: 'object' } },
    ]
    const requests: unknown[] = []; server = Fastify()
    server.post('/rpc', async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as { id?: string | number; method: string; params?: unknown }
      if (body.id === undefined) return reply.code(202).send()
      if (body.method === 'initialize') return { jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } }
      if (body.method === 'tools/list') return { jsonrpc: '2.0', id: body.id, result: { tools: definitions } }
      requests.push(body.params)
      return { jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'MCP-MOUNT-RESULT' }] } }
    })
    const base = await server.listen({ host: '127.0.0.1', port: 0 })
    const configured = { name: 'Fixture MCP', enabled: true, transportType: 'streamableHttp', url: base + '/rpc', disabledTools: ['disabled'] }
    fs.writeFileSync(path.join(root, 'mcp.json'), JSON.stringify({ mcpServers: { selected: configured, other: configured } }))
    let step = 0, initialPrompt = '', mountedName = '', addedName = ''
    mocks.stream.mockImplementation(async function* (messages: Message[], options: LLMAdapterOptions): AsyncGenerator<LLMStreamChunk> {
      expect(options.systemPrompt).toContain('质量审查员')
      expect(options.systemPrompt).toContain('负责验证真实证据')
      expect(options.systemPrompt).toContain('MOUNTED-SKILL-GUIDE')
      expect(options.systemPrompt).not.toContain('UNSELECTED-SKILL-GUIDE')
      const mounted = options.tools?.filter(tool => /^ae_mcp_[0-9a-f]{12}_/.test(tool.name)) ?? []
      expect(options.tools?.some(tool => ['ae_skills_read', 'ae_mcp_read', 'ae_mcp_invoke', 'ae_settings_read'].includes(tool.name))).toBe(false)
      expect(mounted).toHaveLength(step >= 3 ? 2 : 1)
      expect(mounted[0].parameters).toMatchObject({ type: 'object', properties: { text: { type: 'string' } }, required: ['text'] })
      mountedName ||= mounted[0].name
      initialPrompt ||= options.systemPrompt ?? ''
      expect(options.systemPrompt).toBe(initialPrompt)
      const turn = step++
      if (turn === 0) yield { done: true, content: '', finishReason: 'tool_calls', toolCalls: [
        { id: 'outside-skill', name: 'ae_skills_read', args: JSON.stringify({ method: 'get', args: { id: 'other-skill' } }), index: 0 },
        { id: 'outside-server', name: 'ae_mcp_invoke', args: JSON.stringify({ method: 'call', args: { serverId: 'other', tool: 'echo', arguments: { text: 'wrong' } } }), index: 1 },
      ] }
      else if (turn === 1) {
        expect(requests).toEqual([])
        yield { done: true, content: '', finishReason: 'tool_calls', toolCalls: [{ id: 'mounted-call', name: mountedName, args: JSON.stringify({ text: 'hello' }), index: 0 }] }
      } else if (turn === 3) {
        addedName = mounted.find(tool => tool.name.endsWith('_added'))!.name
        yield { done: true, content: '', finishReason: 'tool_calls', toolCalls: [{ id: 'resume-mounted-call', name: addedName, args: '{}', index: 0 }] }
      } else {
        const lastOutput = String(messages.filter(message => message.role === 'tool').at(-1)?.content)
        if (turn === 2) expect(lastOutput).toContain('MCP-MOUNT-RESULT')
        if (turn === 4) expect(lastOutput).toContain('MCP-MOUNT-RESULT')
        yield { done: true, content: '挂载工具验证完成。', finishReason: 'stop' }
      }
    })
    const configuration = { identity: { name: '质量审查员', description: '负责验证真实证据' }, systemPrompt: '只依据事实给出结论。', skillIds: ['selected-skill'], mcpServerIds: ['selected'] }
    const start = await call('agents.manage', 'run', { modelId: 'fixture', task: '验证挂载。', ...configuration })
    expect((await finish(String(start.runId))).status).toBe('succeeded')
    expect(requests).toEqual([{ name: 'echo', arguments: { text: 'hello' } }])
    expect((await getSubagentRunner().store.getRunHeader('tenant', String(start.runId), true))?.continuation?.pluginAgent).toEqual(configuration)
    definitions.push({ name: 'added', description: 'New tool', inputSchema: { type: 'object' } })
    const resumed = await call('agents.manage', 'run', { modelId: 'fixture', task: '继续', resumeRunId: start.runId })
    expect(resumed.childSessionId).toBe(start.childSessionId)
    expect((await finish(String(resumed.runId))).status).toBe('succeeded')
    expect(requests).toEqual([{ name: 'echo', arguments: { text: 'hello' } }, { name: 'added', arguments: {} }])
    grants.splice(grants.indexOf('skills.read'), 1)
    await expect(call('agents.manage', 'run', { modelId: 'fixture', task: '继续', resumeRunId: resumed.runId })).rejects.toMatchObject({ code: 'PLUGIN_PERMISSION' })
    grants.push('skills.read')
    definitions = definitions.filter(tool => tool.name !== 'echo')
    mocks.stream.mockImplementation(async function* (_messages: Message[], options: LLMAdapterOptions): AsyncGenerator<LLMStreamChunk> {
      expect(options.systemPrompt).toContain('另一个身份')
      expect(options.systemPrompt).toContain('负责验证真实证据')
      expect(options.systemPrompt).toContain('新的检查规则')
      expect(options.systemPrompt).not.toContain('MOUNTED-SKILL-GUIDE')
      expect(options.tools?.some(tool => tool.name === mountedName)).toBe(false)
      expect(options.tools?.some(tool => tool.name === addedName)).toBe(false)
      yield { done: true, content: '新配置已生效。', finishReason: 'stop' }
    })
    const updated = await call('agents.manage', 'run', { modelId: 'fixture', task: '继续', resumeRunId: resumed.runId,
      identity: { name: '另一个身份' }, systemPrompt: '新的检查规则', skillIds: [], disabledTools: [addedName] })
    expect((await finish(String(updated.runId))).status).toBe('succeeded')
    expect(updated.childSessionId).toBe(start.childSessionId)
    expect((await getSubagentRunner().store.getRunHeader('tenant', String(updated.runId), true))?.continuation?.pluginAgent)
      .toMatchObject({ identity: { name: '另一个身份', description: '负责验证真实证据' }, skillIds: [], mcpServerIds: ['selected'] })
  })
  it('requires current grants before admitting explicit mounts and never silently removes them on resume', async () => {
    await expect(call('agents.manage', 'run', { modelId: 'fixture', task: '挂载技能。', skillIds: ['selected-skill'] })).rejects.toMatchObject({ code: 'PLUGIN_PERMISSION' })
    await expect(call('agents.manage', 'run', { modelId: 'fixture', task: '挂载 MCP。', mcpServerIds: ['selected'] })).rejects.toMatchObject({ code: 'PLUGIN_PERMISSION' })
    expect(mocks.stream).not.toHaveBeenCalled()
  })
  it('emits Agent lifecycle events from the actual execution source with the bound session', async () => {
    const runtime = new PluginLifecycleRuntime(new PluginService(path.join(root, 'plugins')))
    await runtime.start()
    try {
      mocks.stream.mockImplementation(async function* (): AsyncGenerator<LLMStreamChunk> { yield { done: true, content: 'Completed.', finishReason: 'stop', promptTokens: 10, completionTokens: 2 } })
      const start = await call('agents.manage', 'run', { modelId: 'fixture', task: 'Finish this task.' })
      await finish(String(start.runId))
      await vi.waitFor(() => expect(runtime.poll('tenant', 'bound-session').events.map(event => event.type)).toEqual(['agent.started', 'agent.completed']))
      expect(runtime.poll('tenant', 'different').events).toEqual([])
      expect(runtime.poll('tenant', 'bound-session').events[0].payload).toMatchObject({ runId: start.runId, agentId: access.id, kind: 'subagent' })
    } finally { await runtime.stop() }
  })
  it('rejects a nested Agent from an actual child-owned Node plugin tool', async () => {
    const service = new PluginService(path.join(root, 'plugins')), template = getPluginTemplate('json-tool')
    template.manifest.permissions = { requested: ['agents.manage'] }
    template.files['main.mjs'] = `for await(const c of process.stdin){};console.log(JSON.stringify({result:await $AE.agents.run({modelId:'fixture',task:'recursive'})}))`
    await service.create('tenant', template); await service.publish('tenant', template.manifest.id, 1)
    await service.setPermissionGrants('tenant', template.manifest.id, ['agents.manage'], 1)
    const tools = await createSelectedPluginTools('tenant', [pluginToolkitId(template.manifest.id, 1)], [], service)
    const result = await tools[0].execute({ text: 'x' }, { tenantId: 'tenant', sessionId: 'child-session', parentSessionId: 'bound-session', cwd: root, projectRoot: root } as AgentContext)
    expect(result.success).toBe(false); expect(result.output).toContain('子代理不能通过插件递归启动 Agent')
    expect(mocks.stream).not.toHaveBeenCalled()
  })
  it('rejects a workspace switch during model generation before any write is dispatched', async () => {
    vi.stubEnv('AETHER_ALLOWED_WORKSPACE_ROOTS', root)
    const manager = new WorkspaceManager(path.join(root, 'workspace'))
    vi.spyOn(workspaceManager, 'getBindingSnapshot').mockImplementation(ctx => manager.getBindingSnapshot(ctx))
    const first = path.join(root, 'first'), second = path.join(root, 'second')
    fs.mkdirSync(first); fs.mkdirSync(second)
    const bound = { tenantId: 'tenant', sessionId: 'bound-session' }
    manager.bind(bound, first)
    grants.push('engine.tools'); access.manifest.permissions!.requested.push('engine.tools')
    let step = 0
    mocks.stream.mockImplementation(async function* (): AsyncGenerator<LLMStreamChunk> {
      if (step++ === 0) {
        manager.bind(bound, second)
        yield { done: true, content: '', finishReason: 'tool_calls', toolCalls: [{ id: 'write-after-switch', name: 'write_file', args: JSON.stringify({ path: 'wrong.txt', content: 'A task data' }), index: 0 }] }
      } else yield { done: true, content: '工作区已变化，停止写入。', finishReason: 'stop' }
    })
    const start = await call('agents.manage', 'run', { modelId: 'fixture', task: '在当前工作区写入文件。' })
    await finish(String(start.runId))
    expect(fs.existsSync(path.join(first, 'wrong.txt'))).toBe(false); expect(fs.existsSync(path.join(second, 'wrong.txt'))).toBe(false)
    expect((await getSubagentRunner().store.getRun('tenant', String(start.runId)))?.toolCalls.some(tool => tool.status === 'succeeded')).toBe(false)
    await expect(call('agents.manage', 'run', { modelId: 'fixture', task: '继续', resumeRunId: start.runId })).rejects.toMatchObject({ code: 'PLUGIN_AGENT_WORKSPACE' })
  })
  it('executes an explicit custom tool through ReAct, persists evidence and resumes the same child context', async () => {
    const configuration = explicitSettingsReader()
    let step = 0
    mocks.stream.mockImplementation(async function* (_messages: Message[], options: LLMAdapterOptions): AsyncGenerator<LLMStreamChunk> {
      expect(options.tools?.map(tool => tool.name)).toEqual(['read_settings'])
      if (step++ === 0) yield { done: true, content: '', finishReason: 'tool_calls', promptTokens: 2, completionTokens: 1,
        toolCalls: [{ id: 'settings-call', name: 'read_settings', args: '{}', index: 0 }] }
      else yield { done: true, content: '已按 accuracy 完成检查。', finishReason: 'stop', promptTokens: 3, completionTokens: 4 }
    })
    const start = await call('agents.manage', 'run', { modelId: 'fixture', task: '读取插件设置后完成质量检查。', ...configuration })
    const finished = await finish(String(start.runId))
    expect(finished).toMatchObject({ status: 'succeeded', toolCount: 1, result: '已按 accuracy 完成检查。', sessionId: 'bound-session' })
    const persisted = await getSubagentRunner().store.getRun('tenant', String(start.runId))
    expect(persisted?.toolCalls[0]).toMatchObject({ name: 'read_settings', status: 'succeeded' })
    expect(persisted?.toolCalls[0].output).toContain('accuracy')
    await closePluginAgents(); await closeDb(); await initDb()
    expect((await call('agents.read', 'status', { runId: start.runId })).status).toBe('succeeded')
    // A resumed child retains explicit tools; adding SDK grants does not invent more model tools.
    grants.push('settings.write'); access.manifest.permissions!.requested.push('settings.write')
    const resumed = await call('agents.manage', 'run', { modelId: 'fixture', task: '继续总结。', resumeRunId: start.runId })
    expect(resumed.childSessionId).toBe(start.childSessionId); expect(resumed.runId).not.toBe(start.runId)
    expect((await finish(String(resumed.runId))).status).toBe('succeeded')
    const other = { ...access, id: 'other-plugin' }
    await expect(call('agents.read', 'status', { runId: start.runId }, other)).rejects.toMatchObject({ statusCode: 404 })
    await expect(call('agents.manage', 'cancel', { runId: start.runId }, access, 'other-session')).rejects.toMatchObject({ statusCode: 404 })
  })
  it('gives a real ReAct turn enough safe feedback to correct native file arguments', async () => {
    grants.push('engine.tools'); access.manifest.permissions!.requested.push('engine.tools')
    const workspace = workspaceManager.getBindingSnapshot({ tenantId: 'tenant', sessionId: 'bound-session' }).root
    const rejectedValue = 'SECRET-ARGUMENT-MUST-NOT-APPEAR-IN-FEEDBACK'
    let step = 0
    mocks.stream.mockImplementation(async function* (messages: Message[], options: LLMAdapterOptions): AsyncGenerator<LLMStreamChunk> {
      expect(options.tools?.some(tool => tool.name === 'write_file')).toBe(true)
      const turn = step++
      if (turn === 0) {
        yield { done: true, content: '', finishReason: 'tool_calls', toolCalls: [{ id: 'invalid-write', name: 'write_file', args: JSON.stringify({ path: [rejectedValue], data: 'completeness' }), index: 0 }] }
      } else if (turn === 1) {
        const feedback = String(messages.filter(message => message.role === 'tool').at(-1)?.content)
        expect(feedback).toContain('path')
        expect(feedback).not.toContain(rejectedValue)
        expect(fs.existsSync(path.join(workspace, 'corrected.txt'))).toBe(false)
        yield { done: true, content: '', finishReason: 'tool_calls', toolCalls: [{ id: 'corrected-write', name: 'write_file', args: JSON.stringify({ path: 'corrected.txt', data: 'completeness' }), index: 0 }] }
      } else {
        expect(fs.readFileSync(path.join(workspace, 'corrected.txt'), 'utf8')).toBe('completeness')
        yield { done: true, content: '已修正参数并保存完整性检查设置。', finishReason: 'stop' }
      }
    })
    const start = await call('agents.manage', 'run', { modelId: 'fixture', task: '生成检查文件。' })
    expect(await finish(String(start.runId))).toMatchObject({ status: 'succeeded', toolCount: 2, result: '已修正参数并保存完整性检查设置。' })
    const persisted = await getSubagentRunner().store.getRun('tenant', String(start.runId))
    expect(persisted?.toolCalls.map(tool => tool.status)).toEqual(['failed', 'succeeded'])
    expect(persisted?.toolCalls[0].output).not.toContain(rejectedValue)
  })
  it('does not turn SDK grants into automatic Agent tools, while the SDK remains available', async () => {
    const read = vi.spyOn(access, 'getSettings')
    let step = 0
    let receipt: Message | undefined
    mocks.stream.mockImplementation(async function* (messages: Message[], options: LLMAdapterOptions): AsyncGenerator<LLMStreamChunk> {
      expect(options.tools?.some(tool => tool.name === 'ae_settings_read')).toBe(false)
      if (step++ === 0) yield { done: true, content: '', finishReason: 'tool_calls', toolCalls: [{ id: 'removed-wrapper', name: 'ae_settings_read', args: JSON.stringify({ method: 'get', args: {} }), index: 0 }] }
      else { receipt = messages.find(message => message.role === 'tool' && message.toolCallId === 'removed-wrapper'); yield { done: true, content: '此工具不可用。', finishReason: 'stop' } }
    })
    const start = await call('agents.manage', 'run', { modelId: 'fixture', task: '检查不可用方法。' })
    await finish(String(start.runId))
    expect(read).not.toHaveBeenCalled()
    expect(receipt?.metadata).toMatchObject({ success: false, status: 'failed' })
    await expect(invokePluginCapability(access, 'tenant', { capability: 'settings.read', method: 'get', args: {}, expectedRevision: 1 })).resolves.toEqual(settings)
    expect(read).toHaveBeenCalledTimes(1)
  })
  it('checks live grants again before every Agent tool', async () => {
    const configuration = explicitSettingsReader()
    let step = 0
    mocks.stream.mockImplementation(async function* (): AsyncGenerator<LLMStreamChunk> {
      if (step++ === 0) {
        grants = ['agents.read', 'agents.manage']
        yield { done: true, content: '', finishReason: 'tool_calls', toolCalls: [{ id: 'revoked', name: 'read_settings', args: '{}', index: 0 }] }
      } else yield { done: true, content: '缺少 settings.read 权限。', finishReason: 'stop' }
    })
    const start = await call('agents.manage', 'run', { modelId: 'fixture', task: '检查设置', ...configuration })
    await finish(String(start.runId))
    const persisted = await getSubagentRunner().store.getRun('tenant', String(start.runId))
    expect(persisted?.toolCalls[0]).toMatchObject({ status: 'failed' }); expect(persisted?.toolCalls[0].output).toContain('尚未获准')
  })
  it('cancels the actual pending model operation and joins it on shutdown', async () => {
    mocks.stream.mockImplementation(async function* (_messages: Message[], options: LLMAdapterOptions): AsyncGenerator<LLMStreamChunk> {
      await new Promise<void>((resolve, reject) => {
        if (options.signal?.aborted) reject(new Error('cancelled'))
        else options.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
      })
      yield { done: true, content: 'unreachable' }
    })
    const start = await call('agents.manage', 'run', { modelId: 'fixture', task: '长时间任务' })
    await vi.waitFor(() => expect(mocks.stream).toHaveBeenCalled())
    await call('agents.manage', 'cancel', { runId: start.runId })
    expect((await finish(String(start.runId))).status).toBe('cancelled')
  })
  it('closes a development project together with its detached Agent execution', async () => {
    const directory = path.join(root, 'project'); createPluginProject(directory, 'json-tool', 'dev-agent')
    const file = path.join(directory, 'aether-plugin.json'), manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
    manifest.permissions = { requested: ['agents.read', 'agents.manage'] }; fs.writeFileSync(file, JSON.stringify(manifest))
    vi.stubEnv('AETHER_DEV_PLUGIN_ROOTS', root)
    const session = openDevPlugin('tenant', directory).session
    setDevPluginPermissionGrants('tenant', session.devSessionId, ['agents.read', 'agents.manage'], session)
    mocks.stream.mockImplementation(async function* (_messages: Message[], options: LLMAdapterOptions): AsyncGenerator<LLMStreamChunk> {
      await new Promise<void>((_resolve, reject) => {
        if (options.signal?.aborted) reject(new Error('cancelled'))
        else options.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
      })
      yield { done: true, content: 'unreachable' }
    })
    const start = await call('agents.manage', 'run', { modelId: 'fixture', task: '开发中的长任务' }, devCapabilityAccess('tenant', session.devSessionId, session))
    await vi.waitFor(() => expect(mocks.stream).toHaveBeenCalled())
    await closeDevPlugin('tenant', session.devSessionId)
    expect((await getSubagentRunner().store.getRunView('tenant', String(start.runId)))?.status).toBe('cancelled')
  })
  it.each(['off', 'balanced'])('discovers exactly the six builtin groups and keeps main-chat tools unchanged (OSM=%s)', async osm => {
    vi.stubEnv('OSM_MODE', osm)
    const denied = await discoverPluginAgentTools(access, 'tenant')
    expect(denied.tools.map(tool => tool.name).sort()).toEqual(expectedBuiltins)
    expect(denied.tools.every(tool => !tool.available && !tool.enabled)).toBe(true)
    expect(denied.tools.find(tool => tool.name === 'execute_cmd')).toMatchObject({ source: 'engine', available: false, enabled: false })
    grants.push('engine.tools'); access.manifest.permissions!.requested.push('engine.tools')
    access.agentDisabledTools = ['write_file']
    const result = await discoverPluginAgentTools(access, 'tenant', { disabledTools: ['delete_file'] })
    expect(result.tools.map(tool => tool.name).sort()).toEqual(expectedBuiltins)
    expect(result.tools.every(tool => ['engine', 'skill'].includes(String(tool.source)))).toBe(true)
    expect(result.tools.find(tool => tool.name === 'execute_cmd')).toMatchObject({ source: 'engine', enabled: true, available: true,
      parameters: { type: 'object', properties: { command: { type: 'string' } } } })
    for (const name of ['write_file', 'delete_file']) expect(result.tools.find(tool => tool.name === name)).toMatchObject({ available: true, enabled: false })
    expect(result.tools.find(tool => tool.name === 'subagent_start')).toMatchObject({ available: true, enabled: true })
    for (const removed of ['browser_open', 'office_document', 'task_list', 'todo_list', 'agent_create', 'knowledge_search', 'memory_read', 'ae_settings_read'])
      expect(result.tools.some(tool => tool.name === removed), removed).toBe(false)
    expect(mocks.models).not.toHaveBeenCalled(); expect(mocks.stream).not.toHaveBeenCalled()
    expect((await call('agents.read', 'list', {})).runs).toEqual([])
    const management = await discoverPluginAgentTools({ ...access, grants: [], refresh: undefined }, 'tenant', {}, undefined, true)
    expect(management.tools.find(tool => tool.name === 'read_file')).toMatchObject({ available: false, enabled: false })
    const main = await createToolRegistry({ toolProfile: 'general', toolExposure: 'catalogue', workspaceRoot: root,
      allowedSkills: [], strictSkillBindings: true, allowedMcpServers: [], memoryScope: 'off' })
    for (const retained of ['browser_open', 'office_document', 'todo_list', 'task_list', 'agent_create']) expect(main.registry.has(retained), retained).toBe(true)
  })
  it('executes the actual native file tools in the bound workspace and blocks disabled names', async () => {
    vi.stubEnv('OSM_MODE', 'balanced')
    grants.push('engine.tools'); access.manifest.permissions!.requested.push('engine.tools')
    const workspace = workspaceManager.getBindingSnapshot({ tenantId: 'tenant', sessionId: 'bound-session' }).root
    fs.mkdirSync(workspace, { recursive: true }); fs.writeFileSync(path.join(workspace, 'source.txt'), 'NATIVE-SOURCE')
    let step = 0
    mocks.stream.mockImplementation(async function* (messages: Message[], options: LLMAdapterOptions): AsyncGenerator<LLMStreamChunk> {
      expect(options.tools?.some(tool => tool.name === 'read_file')).toBe(true)
      expect(options.tools?.some(tool => tool.name === 'execute_cmd')).toBe(false)
      if (step++ === 0) yield { done: true, finishReason: 'tool_calls', toolCalls: [{ id: 'native-read', name: 'read_file', args: JSON.stringify({ path: 'source.txt' }), index: 0 }] }
      else if (step === 2) {
        expect(String(messages.filter(message => message.role === 'tool').at(-1)?.content)).toContain('NATIVE-SOURCE')
        yield { done: true, finishReason: 'tool_calls', toolCalls: [{ id: 'native-write', name: 'write_file', args: JSON.stringify({ path: 'native-result.txt', content: 'ACTUAL-NATIVE-RESULT' }), index: 0 }] }
      } else yield { done: true, content: '原生工具已完成。', finishReason: 'stop' }
    })
    const run = await call('agents.manage', 'run', { modelId: 'fixture', task: '读取后生成文件', disabledTools: ['execute_cmd'] })
    expect((await finish(String(run.runId))).status).toBe('succeeded')
    expect(fs.readFileSync(path.join(workspace, 'native-result.txt'), 'utf8')).toBe('ACTUAL-NATIVE-RESULT')
    expect((await getSubagentRunner().store.getRun('tenant', String(run.runId)))?.toolCalls.map(tool => [tool.name, tool.status]))
      .toEqual([['read_file', 'succeeded'], ['write_file', 'succeeded']])
  })
  it('starts with eighteen core definitions and loads an admitted tool without advertising removed capabilities or Office guidance', async () => {
    grants.push('engine.tools'); access.manifest.permissions!.requested.push('engine.tools')
    const workspace = workspaceManager.getBindingSnapshot({ tenantId: 'tenant', sessionId: 'bound-session' }).root
    let step = 0
    mocks.stream.mockImplementation(async function* (_messages: Message[], options: LLMAdapterOptions): AsyncGenerator<LLMStreamChunk> {
      const names = options.tools?.map(tool => tool.name).sort()
      const loader = options.tools?.find(tool => tool.name === 'load_tools')
      for (const removed of ['browser_open', 'office_document', 'agent_create', 'todo_list', 'task_list', 'collaborator_dispatch'])
        expect(loader?.description, removed).not.toContain(removed)
      expect(options.systemPrompt).not.toContain('aether-office')
      if (step++ === 0) {
        expect(names).toEqual(['read_file', 'write_file', 'edit_file', 'list_files', 'glob', 'grep', 'execute_cmd', 'command_output',
          'wait_command', 'wait_commands', 'cancel_command', 'plan_update', 'list_skills', 'get_skill', 'ask_user', 'load_tools', 'subagent_directory', 'subagent_start'].sort())
        yield { done: true, finishReason: 'tool_calls', toolCalls: [{ id: 'load-create-dir', name: 'load_tools', args: JSON.stringify({ names: ['create_dir'] }), index: 0 }] }
      } else if (step === 2) {
        expect(names).toContain('create_dir')
        yield { done: true, finishReason: 'tool_calls', toolCalls: [{ id: 'create-loaded-directory', name: 'create_dir', args: JSON.stringify({ path: 'loaded-directory' }), index: 0 }] }
      } else yield { done: true, content: '目录已创建。', finishReason: 'stop' }
    })
    const run = await call('agents.manage', 'run', { modelId: 'fixture', task: '创建目录' })
    expect((await finish(String(run.runId))).status).toBe('succeeded')
    expect(fs.statSync(path.join(workspace, 'loaded-directory')).isDirectory()).toBe(true)
    expect((await getSubagentRunner().store.getRun('tenant', String(run.runId)))?.toolCalls.map(tool => [tool.name, tool.status]))
      .toEqual([['load_tools', 'succeeded'], ['create_dir', 'succeeded']])
  })
  it('rechecks a user tool toggle after model generation and never starts the newly disabled native operation', async () => {
    grants.push('engine.tools'); access.manifest.permissions!.requested.push('engine.tools')
    const workspace = workspaceManager.getBindingSnapshot({ tenantId: 'tenant', sessionId: 'bound-session' }).root
    let step = 0
    mocks.stream.mockImplementation(async function* (messages: Message[]): AsyncGenerator<LLMStreamChunk> {
      if (step++ === 0) {
        access.agentDisabledTools = ['write_file']
        yield { done: true, finishReason: 'tool_calls', toolCalls: [{ id: 'revoked-native-write', name: 'write_file', args: JSON.stringify({ path: 'must-not-exist.txt', content: 'wrong' }), index: 0 }] }
      } else {
        expect(JSON.stringify(messages.filter(message => message.role === 'tool'))).toContain('已被用户禁用')
        yield { done: true, content: '用户已禁用工具。', finishReason: 'stop' }
      }
    })
    const run = await call('agents.manage', 'run', { modelId: 'fixture', task: '写入文件' })
    expect((await finish(String(run.runId))).status).toBe('succeeded')
    expect(fs.existsSync(path.join(workspace, 'must-not-exist.txt'))).toBe(false)
  })
  it('retains the native command preflight and never auto-approves a command requiring confirmation', async () => {
    vi.stubEnv('OSM_MODE', 'balanced')
    grants.push('engine.tools'); access.manifest.permissions!.requested.push('engine.tools')
    await policyEngine.upsertRule({ name: 'isolated fixture requires confirmation', command: path.basename(process.execPath),
      action: 'deny', priority: -10000, enabled: true, description: 'Fixture policy only' })
    const sentinel = path.join(root, 'must-not-execute.txt')
    mocks.stream.mockImplementation(async function* (): AsyncGenerator<LLMStreamChunk> {
      yield { done: true, finishReason: 'tool_calls', toolCalls: [{ id: 'native-command-confirmation', name: 'execute_cmd',
        args: JSON.stringify({ command: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(sentinel)},'unexpected')`] }), index: 0 }] }
    })
    const run = await call('agents.manage', 'run', { modelId: 'fixture', task: '执行一个需要审批的测试命令' })
    await vi.waitFor(async () => expect((await call('agents.read', 'status', { runId: run.runId })).status).toBe('blocked'), { timeout: 5000 })
    expect(fs.existsSync(sentinel)).toBe(false)
    expect(mocks.stream).toHaveBeenCalledTimes(1)
  })
  it('cannot restore disabled or unavailable tools through load_tools or a direct invented call', async () => {
    vi.stubEnv('OSM_MODE', 'balanced')
    grants.push('engine.tools'); access.manifest.permissions!.requested.push('engine.tools')
    access.agentDisabledTools = ['write_file']
    const workspace = workspaceManager.getBindingSnapshot({ tenantId: 'tenant', sessionId: 'bound-session' }).root
    let step = 0
    mocks.stream.mockImplementation(async function* (messages: Message[], options: LLMAdapterOptions): AsyncGenerator<LLMStreamChunk> {
      for (const name of ['write_file', 'browser_open']) expect(options.tools?.some(tool => tool.name === name)).toBe(false)
      if (step++ === 0) yield { done: true, finishReason: 'tool_calls', toolCalls: [{ id: 'bypass-loader', name: 'load_tools',
        args: JSON.stringify({ names: ['write_file', 'browser_open'] }), index: 0 }] }
      else if (step === 2) {
        expect(JSON.stringify(messages.filter(message => message.role === 'tool'))).toContain('未启用或不可用')
        yield { done: true, finishReason: 'tool_calls', toolCalls: [{ id: 'bypass-direct', name: 'write_file',
          args: JSON.stringify({ path: 'bypass.txt', content: 'wrong' }), index: 0 }] }
      } else yield { done: true, content: '不可用工具没有执行。', finishReason: 'stop' }
    })
    const run = await call('agents.manage', 'run', { modelId: 'fixture', task: '验证工具不可恢复' })
    expect((await finish(String(run.runId))).status).toBe('succeeded')
    expect(fs.existsSync(path.join(workspace, 'bypass.txt'))).toBe(false)
    const persisted = await getSubagentRunner().store.getRun('tenant', String(run.runId))
    expect(persisted?.toolCalls.some(tool => tool.status === 'succeeded')).toBe(false)
  })
  it('revalidates native permission after queue admission and before dispatch', async () => {
    grants.push('engine.tools'); access.manifest.permissions!.requested.push('engine.tools')
    const workspace = workspaceManager.getBindingSnapshot({ tenantId: 'tenant', sessionId: 'bound-session' }).root
    let step = 0
    mocks.stream.mockImplementation(async function* (messages: Message[]): AsyncGenerator<LLMStreamChunk> {
      if (step++ === 0) {
        grants.splice(grants.indexOf('engine.tools'), 1)
        yield { done: true, finishReason: 'tool_calls', toolCalls: [{ id: 'revoked-platform-permission', name: 'write_file',
          args: JSON.stringify({ path: 'revoked.txt', content: 'wrong' }), index: 0 }] }
      } else {
        expect(JSON.stringify(messages.filter(message => message.role === 'tool'))).toContain('engine.tools')
        yield { done: true, content: '平台工具权限已撤回。', finishReason: 'stop' }
      }
    })
    const run = await call('agents.manage', 'run', { modelId: 'fixture', task: '验证撤权' })
    await finish(String(run.runId)); expect(fs.existsSync(path.join(workspace, 'revoked.txt'))).toBe(false)
  })
  it('checks a newly disabled tool again after it has waited in the actual global tool pool', async () => {
    grants.push('engine.tools'); access.manifest.permissions!.requested.push('engine.tools')
    const workspace = workspaceManager.getBindingSnapshot({ tenantId: 'tenant', sessionId: 'bound-session' }).root
    const pool = getGlobalToolPool(), originalLimit = pool.size
    let release!: () => void, step = 0
    setGlobalToolPoolLimit(1)
    const occupied = pool(() => new Promise<void>(resolve => { release = resolve }))
    mocks.stream.mockImplementation(async function* (messages: Message[]): AsyncGenerator<LLMStreamChunk> {
      if (step++ === 0) yield { done: true, finishReason: 'tool_calls', toolCalls: [{ id: 'queued-native-write', name: 'write_file',
        args: JSON.stringify({ path: 'queued.txt', content: 'wrong' }), index: 0 }] }
      else {
        expect(JSON.stringify(messages.filter(message => message.role === 'tool'))).toContain('已被用户禁用')
        yield { done: true, content: '队列等待后重新校验成功。', finishReason: 'stop' }
      }
    })
    try {
      const run = await call('agents.manage', 'run', { modelId: 'fixture', task: '排队写入' })
      await vi.waitFor(() => expect(pool.pending).toBeGreaterThan(0))
      access.agentDisabledTools = ['write_file']; release(); await occupied
      expect((await finish(String(run.runId))).status).toBe('succeeded')
      expect(fs.existsSync(path.join(workspace, 'queued.txt'))).toBe(false)
    } finally { release?.(); await occupied; await closePluginAgents(); setGlobalToolPoolLimit(originalLimit) }
  })
  it.each(['published', 'development'] as const)('runs an explicitly injected own-plugin Node tool with the real %s SDK and resumes it', async kind => {
    vi.stubEnv('DEFAULT_SECURITY_MODE', 'full-access')
    const template = getPluginTemplate('json-tool'), permissions: PluginCapabilityId[] = ['agents.manage', 'agents.read', 'workspace.write', 'settings.read']
    template.manifest.permissions = { requested: permissions }
    template.files['main.mjs'] = `let input='';for await(const c of process.stdin) input+=c;
const request=JSON.parse(input), context=await $AE.context();
await $AE.workspace.write({path:'custom-sdk.txt',content:request.args.text});
console.log(JSON.stringify({result:{text:request.args.text,sessionId:context.sessionId},artifacts:[{path:'custom-artifact.txt',content:request.args.text}]}));`
    let own: CapabilityAccess, close: (() => Promise<unknown>) | undefined
    if (kind === 'published') {
      const service = new PluginService(path.join(root, 'plugins'))
      await service.create('tenant', template); await service.publish('tenant', template.manifest.id, 1)
      await service.setPermissionGrants('tenant', template.manifest.id, permissions, 1)
      own = await publishedCapabilityAccess(service, 'tenant', template.manifest.id, 1)
    } else {
      const directory = path.join(root, 'custom-dev'); createPluginProject(directory, 'json-tool', template.manifest.id)
      fs.writeFileSync(path.join(directory, 'aether-plugin.json'), JSON.stringify(template.manifest))
      fs.writeFileSync(path.join(directory, 'main.mjs'), template.files['main.mjs'])
      vi.stubEnv('AETHER_DEV_PLUGIN_ROOTS', root)
      const session = openDevPlugin('tenant', directory).session
      setDevPluginPermissionGrants('tenant', session.devSessionId, permissions, session)
      own = devCapabilityAccess('tenant', session.devSessionId, session)
      close = () => closeDevPlugin('tenant', session.devSessionId)
    }
    try {
      const configuration = { customTools: [{ name: 'format_report', tool: template.manifest.tools[0].name }] }
      const discovery = await discoverPluginAgentTools(own, 'tenant', configuration)
      expect(discovery.tools.find(tool => tool.name === 'format_report')).toMatchObject({ source: 'plugin', enabled: true,
        parameters: template.manifest.tools[0].inputSchema })
      let step = 0
      mocks.stream.mockImplementation(async function* (messages: Message[], options: LLMAdapterOptions): AsyncGenerator<LLMStreamChunk> {
        expect(options.tools?.some(tool => tool.name === 'format_report')).toBe(true)
        if (step++ === 0) yield { done: true, finishReason: 'tool_calls', toolCalls: [{ id: 'custom-report', name: 'format_report', args: JSON.stringify({ text: 'REAL-CUSTOM-TOOL' }), index: 0 }] }
        else {
          expect(JSON.stringify(messages.filter(message => message.role === 'tool'))).toContain('bound-session')
          yield { done: true, content: '自定义 Node 工具已交付。', finishReason: 'stop' }
        }
      })
      const run = await call('agents.manage', 'run', { modelId: 'fixture', task: '调用自定义工具', ...configuration }, own)
      expect((await finish(String(run.runId), own)).status).toBe('succeeded')
      const workspace = workspaceManager.getBindingSnapshot({ tenantId: 'tenant', sessionId: 'bound-session' }).root
      expect(fs.readFileSync(path.join(workspace, 'custom-sdk.txt'), 'utf8')).toBe('REAL-CUSTOM-TOOL')
      expect(fs.readFileSync(path.join(workspace, 'custom-artifact.txt'), 'utf8')).toBe('REAL-CUSTOM-TOOL')
      const resumed = await call('agents.manage', 'run', { modelId: 'fixture', task: '继续复核', resumeRunId: run.runId }, own)
      expect(resumed.childSessionId).toBe(run.childSessionId); expect((await finish(String(resumed.runId), own)).status).toBe('succeeded')
      await expect(call('agents.manage', 'run', { modelId: 'fixture', task: '冲突名称', customTools: [{ name: 'execute_cmd', tool: template.manifest.tools[0].name }] }, own))
        .rejects.toMatchObject({ code: 'PLUGIN_AGENT_TOOL_COLLISION' })
      await expect(call('agents.manage', 'run', { modelId: 'fixture', task: '不存在工具', customTools: [{ name: 'missing', tool: 'other-plugin-tool' }] }, own))
        .rejects.toMatchObject({ code: 'PLUGIN_AGENT_TOOL_NOT_FOUND' })
    } finally { await close?.() }
  })
})
