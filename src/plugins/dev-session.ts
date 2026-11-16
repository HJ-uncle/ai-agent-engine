import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { readPluginProject } from './project.js'
import { runPlugin } from './runtime.js'
import { PluginError, type PluginManifest, type PluginRunResult, type PluginSnapshot } from './types.js'
import { pluginApplicationExamples, pluginApplicationExecutionPolicy, type PluginApplication } from './application.js'
import { pluginCapabilityIdSchema, type PluginCapabilityId } from './capabilities.js'
import { withTemporaryPluginSnapshot } from './temporary-snapshot.js'
import { assertCapability, capabilityCallSchema, invokePluginCapability, streamPluginCapability, type CapabilityAccess, type CapabilityCall, type PluginExecutionContext } from './capability-runtime.js'
import type { PluginStreamListener } from './capability-stream-types.js'
import { workspaceManager } from '../workspace/index.js'
import type { PluginHostContext } from './host-context.js'
import { extensionPolicy } from '../security/tool-policy.js'

export interface DevPluginSessionView {
  devSessionId: string; path: string; manifest: PluginManifest; hash: string; revision: number
  watch: boolean; updatedAt: number; permissionGrants: PluginCapabilityId[]; lastError?: string
  agentDisabledTools: string[]
}
export interface DevPluginSessionResponse { session: DevPluginSessionView; examples: PluginApplication['examples']; application: PluginApplication }
interface DevPluginSession extends DevPluginSessionView {
  tenantId: string; watcher?: fs.FSWatcher; timer?: ReturnType<typeof setTimeout>
  abort: AbortController; invocations: Set<Promise<unknown>>
  settings: Record<string, unknown>
}
export interface DevPluginRevision { revision: number; hash: string }
const sessions = new Map<string, DevPluginSession>()
const rootAllowed = (root: string): boolean => {
  const explicit = process.env.AETHER_DEV_PLUGIN_ROOTS ?? process.env.AETHER_ALLOWED_WORKSPACE_ROOTS
  // The API already requires the signed-in administrator of this exact local
  // desktop instance. An unspecified operator policy must not silently restrict
  // the user's picker to the packaged engine's installation directory.
  if (explicit === undefined) return true
  const configured = explicit
    .split(path.delimiter).map(item => item.trim()).filter(Boolean).map(item => path.resolve(item))
  return configured.some(base => { const relative = path.relative(base, root); return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)) })
}
function noLinks(target: string): void {
  const absolute = path.resolve(target), root = path.parse(absolute).root
  let current = root
  for (const part of path.relative(root, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new PluginError('PLUGIN_LINK', '开发插件路径不能包含符号链接或目录联接', 403)
  }
}
function digest(project: { manifest: PluginManifest; files: Record<string, string> }): string {
  const hash = createHash('sha256'); hash.update(JSON.stringify(project.manifest))
  for (const name of Object.keys(project.files).sort()) { hash.update(name); hash.update(project.files[name]) }
  return 'sha256:' + hash.digest('hex')
}
function readProject(root: string): { manifest: PluginManifest; files: Record<string, string>; hash: string } {
  const absolute = path.resolve(root); noLinks(absolute)
  if (!rootAllowed(absolute)) throw new PluginError('PLUGIN_DEV_ROOT', '开发插件目录不在允许的本地开发根目录内', 403)
  const project = readPluginProject(absolute)
  return { ...project, hash: digest(project) }
}
function ownedSession(tenantId: string, id: string): DevPluginSession {
  const session = sessions.get(id)
  if (!session || session.tenantId !== tenantId) throw new PluginError('PLUGIN_DEV_SESSION', '开发插件会话不存在或已关闭', 404)
  return session
}
function view(session: DevPluginSession): DevPluginSessionView {
  const { tenantId: _tenantId, watcher: _watcher, timer: _timer, abort: _abort, invocations: _invocations, settings: _settings, ...safe } = session
  return structuredClone(safe)
}
function assertRevision(session: DevPluginSession, expected: DevPluginRevision, hash: string): void {
  if (hash !== session.hash || session.revision !== expected.revision || session.hash !== expected.hash)
    throw new PluginError('PLUGIN_DEV_CHANGED', '本地插件源码已变化，请刷新开发预览后重试', 409)
}
function response(session: DevPluginSession, project: { manifest: PluginManifest; files: Record<string, string> }): DevPluginSessionResponse {
  const examples = pluginApplicationExamples(project)
  const uiDocuments = Object.fromEntries((project.manifest.contributes?.pages ?? []).flatMap(page => page.kind !== 'tool' ? [[page.id, project.files[page.entry]]] : []))
  return { session: view(session), examples, application: { id: project.manifest.id, name: project.manifest.name, description: project.manifest.description,
    manifest: project.manifest, revision: session.revision, hash: session.hash, examples, execution: pluginApplicationExecutionPolicy(),
    ...(Object.keys(uiDocuments).length ? { uiDocuments } : {}) } }
}
export function openDevPlugin(tenantId: string, directory: string, watch = false): DevPluginSessionResponse {
  const root = path.resolve(directory), project = readProject(root), devSessionId = randomUUID()
  const session: DevPluginSession = { tenantId, devSessionId, path: root, manifest: project.manifest, hash: project.hash, revision: 1,
    watch: Boolean(watch), updatedAt: Date.now(), permissionGrants: [], agentDisabledTools: [], abort: new AbortController(), invocations: new Set(), settings: {} }
  if (watch) {
    session.watcher = fs.watch(root, { recursive: true }, () => {
      clearTimeout(session.timer)
      session.timer = setTimeout(() => {
        if (!sessions.has(devSessionId)) return
        try { refreshDevPlugin(tenantId, devSessionId) } catch (error) { session.lastError = error instanceof Error ? error.message : String(error) }
      }, 150)
      session.timer.unref()
    })
    session.watcher.on('error', error => { session.lastError = error.message; session.watcher?.close(); session.watch = false })
  }
  sessions.set(devSessionId, session)
  return response(session, project)
}
export function getDevPlugin(tenantId: string, devSessionId: string): DevPluginSessionView { return view(ownedSession(tenantId, devSessionId)) }
export function refreshDevPlugin(tenantId: string, devSessionId: string): DevPluginSessionResponse {
  const session = ownedSession(tenantId, devSessionId), project = readProject(session.path)
  if (project.hash !== session.hash) {
    session.permissionGrants = project.manifest.id === session.manifest.id
      ? session.permissionGrants.filter(grant => project.manifest.permissions?.requested.includes(grant)) : []
    session.manifest = project.manifest; session.hash = project.hash; session.revision++
  }
  session.updatedAt = Date.now(); delete session.lastError
  return response(session, project)
}
/** Every SDK operation revalidates source identity and the tenant's current grants. */
export function resolveDevPluginAccess(tenantId: string, devSessionId: string, expected: DevPluginRevision): DevPluginSessionView {
  const session = ownedSession(tenantId, devSessionId), project = readProject(session.path)
  assertRevision(session, expected, project.hash)
  return view(session)
}
export function setDevPluginPermissionGrants(tenantId: string, devSessionId: string, grants: PluginCapabilityId[], expected: DevPluginRevision): DevPluginSessionView {
  resolveDevPluginAccess(tenantId, devSessionId, expected)
  const session = ownedSession(tenantId, devSessionId), requested = session.manifest.permissions?.requested ?? []
  if (grants.length > requested.length || new Set(grants).size !== grants.length || grants.some(grant => !pluginCapabilityIdSchema.safeParse(grant).success || !requested.includes(grant)))
    throw new PluginError('PLUGIN_PERMISSIONS', '只能授予当前开发修订已声明的权限')
  session.permissionGrants = [...grants]; session.updatedAt = Date.now()
  return view(session)
}
/** Only the user-facing management route changes this; plugin settings cannot grant tools back. */
export function setDevPluginAgentDisabledTools(tenantId: string, devSessionId: string, tools: string[], expected: DevPluginRevision): DevPluginSessionView {
  resolveDevPluginAccess(tenantId, devSessionId, expected)
  if (!Array.isArray(tools) || tools.some(tool => typeof tool !== 'string' || !tool)) throw new PluginError('PLUGIN_ARGUMENTS', '禁用工具需要非空名称列表')
  const session = ownedSession(tenantId, devSessionId)
  session.agentDisabledTools = [...new Set(tools)]; session.updatedAt = Date.now()
  return view(session)
}
export function devCapabilityAccess(tenantId: string, devSessionId: string, expected: DevPluginRevision): CapabilityAccess {
  const current = resolveDevPluginAccess(tenantId, devSessionId, expected)
  return { id: 'dev:' + devSessionId, revision: current.revision, manifest: current.manifest, grants: current.permissionGrants, agentDisabledTools: current.agentDisabledTools,
    refresh: async () => devCapabilityAccess(tenantId, devSessionId, expected),
    getSettings: async () => { resolveDevPluginAccess(tenantId, devSessionId, expected); return structuredClone(ownedSession(tenantId, devSessionId).settings) },
    setSettings: async value => {
      resolveDevPluginAccess(tenantId, devSessionId, expected)
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new PluginError('PLUGIN_SETTINGS', '插件设置必须为 JSON 对象')
      ownedSession(tenantId, devSessionId).settings = structuredClone(value)
      return structuredClone(value)
    },
    invokeTool: async (tool, args, signal, execution) => {
      const live = devCapabilityAccess(tenantId, devSessionId, expected)
      assertCapability(live, 'agents.manage', expected.revision)
      const ctx = execution.workspaceContext
      if (!ctx || ctx.tenantId !== tenantId || !ctx.sessionId) throw new PluginError('PLUGIN_AUTHORITY', '插件工具需要宿主绑定会话', 403)
      workspaceManager.bindingReadGuard(ctx, execution.workspaceBinding).assertCurrent()
      return invokeDevPlugin(tenantId, devSessionId, tool, args, expected, signal, ctx.sessionId, undefined, { ...execution, childAgent: true })
    } }
}
export async function invokeDevPluginCapability(tenantId: string, devSessionId: string, expected: DevPluginRevision, call: CapabilityCall, signal?: AbortSignal, execution?: PluginExecutionContext): Promise<unknown> {
  const session = ownedSession(tenantId, devSessionId)
  const invocation = invokePluginCapability(devCapabilityAccess(tenantId, devSessionId, expected), tenantId, call,
    signal ? AbortSignal.any([signal, session.abort.signal]) : session.abort.signal, execution)
  session.invocations.add(invocation)
  try { return await invocation } finally { session.invocations.delete(invocation) }
}
export async function streamDevPluginCapability(tenantId: string, devSessionId: string, expected: DevPluginRevision, call: CapabilityCall, onEvent: PluginStreamListener, signal?: AbortSignal, execution?: PluginExecutionContext): Promise<unknown> {
  const session = ownedSession(tenantId, devSessionId)
  const invocation = streamPluginCapability(devCapabilityAccess(tenantId, devSessionId, expected), tenantId, call, onEvent,
    signal ? AbortSignal.any([signal, session.abort.signal]) : session.abort.signal, execution)
  session.invocations.add(invocation)
  try { return await invocation } finally { session.invocations.delete(invocation) }
}
export async function invokeDevPlugin(tenantId: string, devSessionId: string, tool: string, args: Record<string, unknown>, expected: DevPluginRevision, signal?: AbortSignal, sessionId?: string, hostContext?: PluginHostContext, parentExecution?: PluginExecutionContext): Promise<PluginRunResult & { plugin: { id: string; revision: number; hash: string } }> {
  const session = ownedSession(tenantId, devSessionId), denial = parentExecution?.workspaceContext ? extensionPolicy(parentExecution.workspaceContext) : undefined
  const policy = parentExecution?.workspaceContext ? { allowed: !denial, reason: denial?.output } : pluginApplicationExecutionPolicy()
  if (!policy.allowed) throw new PluginError('PLUGIN_FORBIDDEN', policy.reason!, 403)
  const project = readProject(session.path)
  assertRevision(session, expected, project.hash)
  const snapshot: PluginSnapshot = { ...project, id: project.manifest.id, tenantId, directory: session.path, revision: session.revision }
  const context = parentExecution?.workspaceContext ?? (sessionId ? { tenantId, sessionId } : undefined)
  const executionContext = context ? { ...parentExecution, workspaceContext: context, workspaceBinding: parentExecution?.workspaceBinding ?? workspaceManager.getBindingSnapshot(context) } : undefined
  const execution = withTemporaryPluginSnapshot(snapshot, sealed => runPlugin(sealed, tool, args, {
    signal: signal ? AbortSignal.any([signal, session.abort.signal]) : session.abort.signal, tenantId,
    hostContext: { ...hostContext, sessionId, workspacePath: executionContext?.workspaceBinding.root }, capability: (raw, abort, onEvent) => {
      const call = capabilityCallSchema.parse({ ...raw, sessionId, expectedRevision: expected.revision })
      return call.method === 'stream'
        ? streamDevPluginCapability(tenantId, devSessionId, expected, call, onEvent ?? (() => undefined), abort, executionContext)
        : invokeDevPluginCapability(tenantId, devSessionId, expected, call, abort, executionContext)
    },
  }))
  session.invocations.add(execution)
  try { return { ...await execution, plugin: { id: snapshot.id, revision: snapshot.revision, hash: snapshot.hash } } }
  finally { session.invocations.delete(execution) }
}
export async function closeDevPlugin(tenantId: string, devSessionId: string): Promise<void> {
  const session = ownedSession(tenantId, devSessionId)
  sessions.delete(devSessionId); clearTimeout(session.timer); session.watcher?.close(); session.abort.abort()
  const { cancelPluginAgents } = await import('./agent-capability.js')
  await Promise.allSettled([...session.invocations, cancelPluginAgents(tenantId, 'dev:' + devSessionId)])
  // Join an admission that raced the close before it returned its run handle.
  await cancelPluginAgents(tenantId, 'dev:' + devSessionId)
}
export async function closeAllDevPlugins(): Promise<void> { await Promise.allSettled([...sessions.values()].map(session => closeDevPlugin(session.tenantId, session.devSessionId))) }
