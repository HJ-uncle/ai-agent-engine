import { createHash } from 'node:crypto'
import type { AgentContext, IToolRegistry } from './agent-context/types.js'
import { getSecurityMode } from '../security/policy-engine.js'
import { effectiveMemoryScopes } from '../middleware/memory/policy.js'
import { normalizeClientCapabilities } from './client-capabilities.js'
import { workbenchBridge } from '../tools/workbench/bridge.js'
import { browserExecutionIdentity } from './browser-execution.js'
import { workspaceManager } from '../workspace/index.js'

export type RegisteredTool = ReturnType<IToolRegistry['list']>[number]
export function toolSource(tool: RegisteredTool): 'builtin' | 'mcp' | 'skill' {
  return tool.source === 'mcp' || tool.name.startsWith('mcp_') ? 'mcp' : tool.source === 'skill' ? 'skill' : 'builtin'
}

export function buildRuntimeCapabilities(ctx: AgentContext, workspacePaths = workspaceManager.getPaths(ctx), tools: readonly RegisteredTool[] = ctx.tools.list()) {
  const names = new Set(tools.map(tool => tool.name))
  const securityMode = getSecurityMode(ctx.tenantId, ctx.sessionId)
  const catalogue = tools.map(tool => ({ name: tool.name, source: toolSource(tool) }))
  const registryVersion = createHash('sha256').update(JSON.stringify(tools.map(tool => ({
    name: tool.name, source: toolSource(tool), description: tool.description, parameters: tool.parameters, outputSchema: tool.outputSchema,
  })).sort((a, b) => a.name.localeCompare(b.name)))).digest('hex').slice(0, 20)
  const client = normalizeClientCapabilities(ctx.clientCapabilities)
  const workbench = names.has('workbench_context') || names.has('workbench_open') ? workbenchBridge.status(ctx) : undefined
  const workbenchExecutionBound = Boolean(browserExecutionIdentity(ctx))
  const now = new Date()
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const date = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-')
  return {
    version: 1 as const, registryVersion, profile: ctx.toolProfile ?? 'general',
    clock: { currentTime: now.toISOString(), date, timezone, utcOffsetMinutes: -now.getTimezoneOffset(), scope: 'engine-runtime' },
    environment: { platform: process.platform, arch: process.arch,
      node: { version: process.version, executable: process.execPath, scope: 'engine-runtime' },
      commandExecution: names.has('execute_cmd') ? 'program-and-args' : 'unavailable',
      shell: 'not-probed', workspacePaths, primaryWorkspace: workspacePaths[0], cwd: workspacePaths[0] },
    permissions: { securityMode, memoryScopes: effectiveMemoryScopes(ctx),
      extensionExecution: securityMode === 'safe' ? 'blocked-uncontained-side-effects' : 'checked-at-invocation',
      note: '注册、客户端声明和工作区路径不授予执行权限；运行时策略与真实回执为准。' },
    tools: catalogue,
    discovery: { browser: names.has('browser_tabs') ? { status: 'requires-host-check', probe: 'browser_tabs' } : { status: 'not-registered' },
      office: names.has('office_environment') ? { status: 'probe-on-demand', probe: 'office_environment' } : { status: 'not-registered' },
      workbench: workbench ? { status: workbench.connected ? workbenchExecutionBound ? 'connected' : 'requires-run' : 'disconnected',
        executionBound: workbenchExecutionBound, actions: workbench.actions,
        ...(names.has('workbench_context') ? { probe: 'workbench_context' } : {}), checkedAt: now.getTime(), recheckAtInvocation: true } : { status: 'not-registered' } },
    client: client ? { ...client, evidence: 'client-declared-not-execution-confirmed' } : { status: 'not-declared' },
  }
}

export function buildRuntimeCapabilitiesPrompt(ctx: AgentContext, tools: readonly RegisteredTool[] = ctx.tools.list()): string {
  const snapshot = buildRuntimeCapabilities(ctx, undefined, tools)
  const client = normalizeClientCapabilities(ctx.clientCapabilities)
  const scopes = snapshot.permissions.memoryScopes
  const sessionMemory = scopes.includes('session')
  const globalMemory = scopes.includes('global')
  // Tool registration alone does not explain the scope to a model describing
  // its abilities. Use the same resolved policy as reads/writes, even if empty.
  const memoryPolicy = globalMemory
    ? sessionMemory
      ? '本次会话记忆与全局记忆均已启用：可参考当前会话和全局记忆；新增记忆默认只写入当前会话，不自动提升为跨会话记忆。'
      : '本次仅启用全局记忆：可在不同会话中参考全局记忆，新增记忆写入全局；会话记忆未启用。'
    : sessionMemory
      ? '本次仅启用会话记忆：仅在当前会话内保存和参考记忆。全局记忆未启用，不得声称能跨会话记住偏好或决策。'
      : '本次长期记忆未启用：不得声称会保存、自动记住或跨会话记住偏好或决策。'
  // Schemas already travel in the request's tools field. Keep only facts that
  // schemas cannot provide; first workspace is the actual relative-path root.
  const compact = {
    profile: snapshot.profile, registryVersion: snapshot.registryVersion, toolCount: tools.length,
    clock: { currentTime: snapshot.clock.currentTime, date: snapshot.clock.date, timezone: snapshot.clock.timezone, utcOffsetMinutes: snapshot.clock.utcOffsetMinutes },
    environment: { platform: snapshot.environment.platform, arch: snapshot.environment.arch,
      node: { version: snapshot.environment.node.version, executable: snapshot.environment.node.executable },
      workspacePaths: snapshot.environment.workspacePaths, shell: snapshot.environment.shell },
    permissions: { securityMode: snapshot.permissions.securityMode, memoryScopes: snapshot.permissions.memoryScopes,
      extensionExecution: snapshot.permissions.extensionExecution },
    ...(client ? { client } : {}),
  }
  return '\n\n## 本次模型请求环境\n每请求更新；完整工具说明/参数见本次工具定义，不另行查询。工作区首项是相对路径与命令默认目录。时间、平台、Node 属引擎宿主；不推断客户端、shell、PATH 或办公依赖。client 仅为客户端声明，不授予权限或证明执行；动态状态查本次对应工具，以运行时策略和回执为准。\n'
    + JSON.stringify(compact)
    + '\n\n### 当前记忆能力（内部执行状态）\n' + memoryPolicy
    + '\n这段仅用于约束执行和判断能力，不是必答章节；除非用户询问记忆或当前任务确实依赖记忆范围，不主动说明这些设置。不把已注册的记忆工具等同于全局记忆已开启。聊天历史与长期记忆独立；记忆开关不删除聊天历史。没有成功写入回执，不声称已经记住。'
}
