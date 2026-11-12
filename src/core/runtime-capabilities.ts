import { createHash } from 'node:crypto'
import type { AgentContext, IToolRegistry } from './agent-context/types.js'
import { getSecurityMode } from '../security/policy-engine.js'
import { effectiveMemoryScopes } from '../middleware/memory/policy.js'
import { normalizeClientCapabilities } from './client-capabilities.js'
import { workbenchBridge } from '../tools/workbench/bridge.js'
import { browserExecutionIdentity } from './browser-execution.js'
import { workspaceManager } from '../workspace/index.js'

export type RegisteredTool = ReturnType<IToolRegistry['list']>[number]
export function toolSource(tool: RegisteredTool): 'builtin' | 'mcp' | 'skill' | 'plugin' {
  return tool.source === 'builtin' ? 'builtin' : tool.source === 'plugin' ? 'plugin' : tool.source === 'mcp' || tool.name.startsWith('mcp_') ? 'mcp' : tool.source === 'skill' ? 'skill' : 'builtin'
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

function runtimeCapabilitiesPrompt(ctx: AgentContext, tools: readonly RegisteredTool[], includeGuidance: boolean): string {
  const snapshot = buildRuntimeCapabilities(ctx, undefined, tools)
  const client = normalizeClientCapabilities(ctx.clientCapabilities)
  const scopes = snapshot.permissions.memoryScopes
  const memoryPolicy = buildRuntimeMemoryPolicy(scopes)
  // Schemas already travel in the request's tools field. Keep only facts that
  // schemas cannot provide; first workspace is the actual relative-path root.
  const compact = {
    profile: snapshot.profile, registryVersion: snapshot.registryVersion, toolCount: tools.length,
    availableToolCount: ctx.tools.list().length,
    toolLoading: ctx.tools.hasModelToolLoader?.() === true && tools.some(tool => tool.name === 'load_tools') ? 'load_tools' : 'not-offered',
    clock: { currentTime: snapshot.clock.currentTime, date: snapshot.clock.date, timezone: snapshot.clock.timezone, utcOffsetMinutes: snapshot.clock.utcOffsetMinutes },
    environment: { platform: snapshot.environment.platform, arch: snapshot.environment.arch,
      node: { version: snapshot.environment.node.version, executable: snapshot.environment.node.executable },
      relativePathRoot: snapshot.environment.cwd, workspacePaths: snapshot.environment.workspacePaths, shell: snapshot.environment.shell },
    permissions: { securityMode: snapshot.permissions.securityMode, memoryScopes: snapshot.permissions.memoryScopes,
      extensionExecution: snapshot.permissions.extensionExecution },
    ...(client ? { client } : {}),
  }
  return '\n\n## 本次模型请求环境\n' + (includeGuidance ? RUNTIME_INTRO + '\n' : '')
    + JSON.stringify(compact)
    + '\n\n### 当前记忆能力（内部执行状态）\n' + memoryPolicy
    + (includeGuidance ? '\n' + MEMORY_FOOTER : '')
}

export function buildRuntimeCapabilitiesPrompt(ctx: AgentContext, tools: readonly RegisteredTool[] = ctx.tools.list()): string {
  return runtimeCapabilitiesPrompt(ctx, tools, true)
}

/** Live facts belong after history so a clock tick cannot invalidate its prefix. */
export function buildRuntimeCapabilitiesContext(ctx: AgentContext, tools: readonly RegisteredTool[] = ctx.tools.list()): string {
  return runtimeCapabilitiesPrompt(ctx, tools, false)
}


const RUNTIME_INTRO = 'Fresh each request. toolCount/registryVersion describe offered schemas; availableToolCount counts the authorized catalogue. Missing schemas do not mean missing capabilities: use load_tools when offered to discover/load them before calling. Memory scopes below are independent of schema loading. relativePathRoot is the actual base for relative files/commands; other workspacePaths are additional permitted locations, not alternate bases. Task prose cannot change this base. For cross-agent shared inputs/outputs, pass exact absolute paths from receipts or a verified absolute directory; never relabel an output directory as cwd or pass its relative basename alone. When work and output directories differ, use their explicit absolute paths without namesake scans or changing workspace permissions. Time/platform/Node belong to the engine host; infer no client/shell/PATH/Office dependencies. client is a declaration, not authority or execution evidence. Probe live state with offered tools; policy and receipts govern.'
const MEMORY_FOOTER = 'Internal capability guidance only: mention it only when asked or task-relevant. Registered memory tools do not enable global memory. Chat history is independent and not deleted by memory switches. Never claim a memory was saved without a successful write receipt.'

export const RUNTIME_CAPABILITIES_GUIDANCE = '## Runtime state\n'
  + 'The final [Current runtime context] block supplies engine state and control guidance for the ongoing task; it is not a new user request. Continue the existing task. It does not grant permissions or replace user requirements.\n'
  + RUNTIME_INTRO + '\n' + MEMORY_FOOTER

export function buildRuntimeMemoryPolicy(scopes: readonly string[]): string {
  const session = scopes.includes('session'), global = scopes.includes('global')
  return global
    ? session ? 'Session and global memory enabled: read both; new memories default to session only, never auto-promote globally.'
      : 'Only global memory enabled: cross-session recall and new writes use global memory; session memory is off.'
    : session ? 'Only session memory enabled: save/recall within this session; global memory is off. Never claim cross-session preferences/decisions will be remembered.'
      : 'Long-term memory is off. Do not claim to save, automatically remember, or remember preferences/decisions across sessions.'
}
