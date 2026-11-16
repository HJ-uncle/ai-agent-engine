import { ToolRegistry } from '../core/tool-registry/index.js'
import type { AgentContext, IToolRegistry, Message, Tool, ToolResult } from '../core/agent-context/types.js'
import { ToolNotFoundError } from '../core/agent-context/types.js'
import { createToolRegistry } from '../tools/registry-factory.js'
import { PluginError } from './types.js'
import type { PluginAgentConfiguration } from './capability-contract.js'
import type { CapabilityAccess } from './capability-runtime.js'
import { bindPluginAgentRegistryAuthority } from './agent-registry-authority.js'

/** Plugin Agents have a focused builtin surface, independent of the main chat profile. */
export const PLUGIN_AGENT_BUILTIN_GROUPS = {
  files: ['read_file', 'write_file', 'edit_file', 'list_files', 'delete_file', 'create_dir'],
  commands: ['execute_cmd', 'command_output', 'cancel_command'],
  interaction: ['ask_user', 'plan_update', 'load_tools'],
  search: ['glob', 'grep', 'web_fetch', 'http_request', 'search_history', 'code_diagnose', 'codegraph'],
  subagents: ['subagent', 'subagent_start', 'subagent_send', 'subagent_wait', 'subagent_cancel',
    'subagent_participants', 'subagent_inbox', 'subagent_read_result', 'subagent_directory', 'subagent_followup', 'subagent_request_input'],
  skills: ['list_skills', 'get_skill', 'run_skill_script'],
} as const
export const PLUGIN_AGENT_BUILTIN_TOOLS: ReadonlySet<string> = new Set(Object.values(PLUGIN_AGENT_BUILTIN_GROUPS).flat())

function denied(error: unknown): ToolResult {
  return { success: false, output: error instanceof PluginError ? error.message : '工具授权校验失败', error: 'PLUGIN_AGENT_TOOL_FORBIDDEN' }
}

type Definition = ReturnType<IToolRegistry['list']>[number]
export interface PluginAgentToolInfo extends Definition { enabled: boolean; available: boolean; reason?: string }

/** Keep each real registry's implementations, trust identities, native preflight and model loading. */
class PluginAgentToolRegistry implements IToolRegistry {
  constructor(private readonly platform: ToolRegistry | undefined, private readonly local: ToolRegistry,
    private readonly skills: NonNullable<IToolRegistry['skillsForPrompt']>) {}
  register(tool: Tool): void {
    if (this.has(tool.name)) throw new PluginError('PLUGIN_AGENT_TOOL_COLLISION', 'Agent 工具名称重复，请为自定义工具使用不同名称')
    this.local.register(tool)
  }
  unregister(name: string): void { this.local.unregister(name); this.platform?.unregister(name) }
  has(name: string): boolean { return this.local.has(name) || Boolean(this.platform?.has(name)) }
  private owner(name: string): ToolRegistry {
    if (this.local.has(name)) return this.local
    if (this.platform?.has(name)) return this.platform
    throw new ToolNotFoundError(name)
  }
  list(): Definition[] { return [...this.platform?.list() ?? [], ...this.local.list()] }
  listForModel(): Definition[] { return [...this.platform?.listForModel() ?? [], ...this.local.listForModel()] }
  listForRequest(history: readonly Message[] = []): Definition[] { return [...this.platform?.listForRequest(history) ?? [], ...this.local.listForRequest(history)] }
  skillsForPrompt() { return this.skills() }
  hasModelToolLoader(): boolean { return this.platform?.hasModelToolLoader() ?? false }
  modelToolLoadingCandidates(): string[] { return this.platform?.modelToolLoadingCandidates() ?? [] }
  loadForModel(names: readonly string[]): string[] {
    if (names.some(name => !this.has(name))) throw new PluginError('PLUGIN_AGENT_TOOL_DISABLED', '所选工具未启用或不可用')
    const platformNames = names.filter(name => this.platform?.has(name))
    if (platformNames.length) this.platform!.loadForModel(platformNames)
    return [...names]
  }
  modelToolRegistrationVersion(name: string): number | undefined { return this.has(name) ? this.owner(name).modelToolRegistrationVersion(name) : undefined }
  supportsHistoryProjection(name: string): boolean { return this.platform?.has(name) ? this.platform.supportsHistoryProjection(name) : false }
  supportsOfficeEvidence(name: string): boolean { return this.platform?.has(name) ? this.platform.supportsOfficeEvidence(name) : false }
  supportsScreenshotEvidence(name: string): boolean { return this.platform?.has(name) ? this.platform.supportsScreenshotEvidence(name) : false }
  execute(name: string, args: unknown, ctx: AgentContext): Promise<ToolResult> { return this.owner(name).execute(name, args, ctx) }
  preflight(name: string, args: unknown, ctx: AgentContext): Promise<ToolResult | undefined> { return this.owner(name).preflight(name, args, ctx) }
  executionMode(name: string, args?: unknown) { return this.has(name) ? this.owner(name).executionMode(name, args) : 'serial' as const }
}

/** Reuse real platform implementations, admitting only the six plugin builtin groups. */
export async function createPluginAgentToolRegistry(options: {
  access: CapabilityAccess; tenantId: string; sessionId: string; workspaceRoot: string; configuration: PluginAgentConfiguration;
  discovery?: boolean; signal?: AbortSignal; beforePlatformTool: (name: string, ctx: AgentContext) => Promise<void>;
  beforeLocalTool: (name: string, ctx: AgentContext) => Promise<void>;
}) {
  const { access, configuration } = options
  const allowed = access.manifest.permissions?.requested.includes('engine.tools') && access.grants.includes('engine.tools')
  const base = allowed || options.discovery || configuration.customTools?.length ? await createToolRegistry({ toolProfile: 'general', ownedCollaboration: true, workspaceRoot: options.workspaceRoot,
    securityContext: { tenantId: options.tenantId, sessionId: options.sessionId, toolProfile: 'general' },
    // Use the complete explicitly selected catalogue independently of OSM's main-chat defaults.
    // Registry model exposure remains lazy; this does not load every schema into the first request.
    toolExposure: 'catalogue',
    allowedTools: [...PLUGIN_AGENT_BUILTIN_TOOLS],
    allowedSkills: access.grants.includes('skills.read') ? configuration.skillIds ?? [] : [], strictSkillBindings: true,
    // Explicit MCP mounts use the live SDK dispatcher, separately from builtins.
    allowedMcpServers: [],
    memoryScope: 'off', signal: options.signal }) : undefined
  // Factory-owned control tools may bypass a normal Agent allowlist. A plugin's
  // public builtin surface remains exact, including discovery and load_tools.
  for (const tool of base?.registry.list() ?? []) if (!PLUGIN_AGENT_BUILTIN_TOOLS.has(tool.name)) base!.registry.unregister(tool.name)
  const catalogue = base?.registry.list().map(tool => ({ ...tool, source: tool.source === 'skill' || tool.source === 'mcp' || tool.source === 'plugin' ? tool.source : 'engine', enabled: Boolean(allowed), available: Boolean(allowed),
    ...(!allowed ? { reason: '需要 engine.tools 授权' } : {}) })) ?? []
  // A name stays reserved even when the current OSM/profile hides its builtin.
  // Catalogue construction only reads definitions, with no external discovery.
  const reserved = configuration.customTools?.length ? (await createToolRegistry({ toolProfile: 'general', toolExposure: 'catalogue',
    workspaceRoot: options.workspaceRoot, allowedSkills: [], strictSkillBindings: true, allowedMcpServers: [], memoryScope: 'off', signal: options.signal })).registry : undefined
  if (base && allowed) {
    // execute() calls this hook again after waiting for the ordinary tool pool.
    // The original Tool objects and their WeakMap trust identities stay untouched.
    const original = base.registry.preflight.bind(base.registry)
    base.registry.preflight = async (name, args, ctx) => {
      try { await options.beforePlatformTool(name, ctx) } catch (error) { return denied(error) }
      return original(name, args, ctx)
    }
  }
  const local = new ToolRegistry(), originalLocal = local.preflight.bind(local)
  local.preflight = async (name, args, ctx) => {
    try { await options.beforeLocalTool(name, ctx) } catch (error) { return denied(error) }
    return originalLocal(name, args, ctx)
  }
  const registry = new PluginAgentToolRegistry(allowed ? base?.registry : undefined, local, () => base?.externalSkills ?? [])
  bindPluginAgentRegistryAuthority(registry, async (name, ctx) => {
    if (!registry.has(name)) throw new PluginError('PLUGIN_AGENT_TOOL_DISABLED', '此工具不在插件 Agent 的授权范围内', 403)
    if (base?.registry.has(name)) await options.beforePlatformTool(name, ctx)
    else await options.beforeLocalTool(name, ctx)
  })
  return { registry, catalogue,
    hasName: (name: string) => Boolean(base?.registry.has(name)) || Boolean(reserved?.has(name)) || registry.has(name) }
}

export function disablePluginAgentTools(registry: IToolRegistry, definitions: PluginAgentToolInfo[], disabledTools: readonly string[] = []): PluginAgentToolInfo[] {
  const disabled = new Set(disabledTools)
  for (const name of disabled) registry.unregister(name)
  return definitions.map(tool => disabled.has(tool.name) ? { ...tool, enabled: false, reason: '已由用户禁用' } : tool)
}
