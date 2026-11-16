import type { AgentContext, Tool } from '../core/agent-context/types.js'
import { PluginService } from './service.js'
import { runPlugin } from './runtime.js'
import { PluginError, type PluginRecord } from './types.js'
import { normalizeAllowedTools } from '../tools/tool-profile.js'
import { parsePluginToolkit } from '../tools/toolkits.js'
import { extensionPolicy } from '../security/tool-policy.js'
import { emitPluginArtifacts } from './artifacts.js'
import { publishedCapabilityDispatcher } from './capability-runtime.js'
import { workspaceManager } from '../workspace/index.js'
import { trustPluginTool } from './identity.js'
import { describePluginRecord, pluginToolkitId, pluginToolName, type DescribedPluginRecord } from './metadata.js'
import { serviceForOwner } from '../core/collaboration/execution-owner.js'
import { controllerSubject, ensureControllerSchema, type ControllerSubject } from '../core/collaboration/controller-origin.js'

export { pluginToolkitId, pluginToolName } from './metadata.js'
/** A selected plugin may inherit its current host controller, never manufacture one. */
async function inheritedController(ctx: AgentContext): Promise<ControllerSubject | undefined> {
  if (!ctx.executionOwner || !ctx.browserAuthority || !ctx.browserPrincipal) return undefined
  const authority = ctx.browserAuthority, method = ctx.browserPrincipal.method
  if (authority.kind === 'account' && method === 'none') return undefined
  const subject = controllerSubject(authority, authority.kind === 'instance' ? 'local-instance' : method as 'jwt' | 'api-key' | 'session')
  const service = serviceForOwner(ctx.executionOwner)
  service.assertDispatch(ctx.executionOwner)
  const binding = service.collaboration.executionBinding(service.producerForExecution(ctx.executionOwner))
  await ensureControllerSchema(service.db)
  const row = (await service.db.execute({ sql: `SELECT subject_key,subject_kind,auth_method FROM collaboration_controller_roots
    WHERE tenant_id=? AND root_run_id=? AND root_attempt_id=? AND root_session_id=?`,
    args: [binding.tenantId, binding.rootRunId, binding.rootAttemptId, binding.rootSessionId] })).rows[0]
  if (!row) return undefined
  if (row.subject_key !== subject.key || row.subject_kind !== subject.kind || row.auth_method !== subject.method)
    throw new PluginError('PLUGIN_AGENT_CONTROLLER', '当前宿主身份与会话控制者不一致', 403)
  return subject
}
export function pluginSummary(record: PluginRecord): Omit<DescribedPluginRecord, 'files'> {
  const { files: _files, ...summary } = describePluginRecord(record)
  return summary
}

/** Configuration metadata only: no executable Tool objects and no implicit runtime registration. */
export async function pluginToolDefinitions(tenantId: string, ceiling?: readonly string[] | null, service = new PluginService()): Promise<Array<Pick<Tool, 'name' | 'displayName' | 'description' | 'parameters' | 'source' | 'outputSchema'>>> {
  const allowed = normalizeAllowedTools(ceiling)
  const records = await service.listPublishedMetadata(tenantId)
  const definitions = records.map(record => {
    // Disabled published versions remain configurable; actual invocation still requires enabled=true.
    return record.manifest.tools.map(spec => ({
      name: pluginToolName(record.id, spec.name), displayName: record.manifest.name + ' · ' + spec.name,
      description: spec.description + ' [' + record.manifest.name + ' v' + record.manifest.version + ', revision ' + record.revision + ']',
      parameters: spec.inputSchema, source: 'plugin' as const,
    })).filter(tool => !allowed || allowed.includes(tool.name))
  })
  return definitions.flat()
}

export async function pluginCatalogue(tenantId: string, ceilings: Array<readonly string[] | null | undefined> = [], service = new PluginService()) {
  const records = await service.listPublishedMetadata(tenantId)
  return records.map(record => {
    const toolNames = record.manifest.tools.map(tool => pluginToolName(record.id, tool.name))
    const denied = ceilings.some(ceiling => { const allowed = normalizeAllowedTools(ceiling); return allowed && toolNames.some(name => !allowed.includes(name)) })
    const reason = !record.enabled ? '插件已停用' : denied ? '当前 Agent 的工具白名单不允许此插件' : undefined
    const selectionId = pluginToolkitId(record.id, record.revision)
    return { id: selectionId, selectionId, name: record.manifest.name, description: record.manifest.description,
      toolNames, globalToolNames: toolNames,
      toolNameMap: Object.fromEntries(record.manifest.tools.map(tool => [tool.name, pluginToolName(record.id, tool.name)])),
      available: !reason, ...(reason ? { reason } : {}) }
  })
}

/** Every selected ID contains an immutable revision, including parked runs and child registries. */
export async function createSelectedPluginTools(tenantId: string, selections: readonly string[],
  ceilings: Array<readonly string[] | null | undefined> = [], service = new PluginService()): Promise<Tool[]> {
  const tools: Tool[] = []
  for (const selection of selections) {
    const selected = parsePluginToolkit(selection)
    if (!selected) continue
    const record = await service.get(tenantId, selected.id)
    if (!record.enabled || !record.revisions.some(revision => revision.revision === selected.revision && revision.publishedAt))
      throw new PluginError('PLUGIN_NOT_AVAILABLE', '所选插件版本未发布或已停用，请重新选择插件', 409)
    const snapshot = await service.snapshot(tenantId, selected.id, selected.revision)
    for (const spec of snapshot.manifest.tools) {
      const name = pluginToolName(selected.id, spec.name)
      for (const ceiling of ceilings) {
        const allowed = normalizeAllowedTools(ceiling)
        if (allowed && !allowed.includes(name)) throw new PluginError('PLUGIN_FORBIDDEN', `工具白名单不允许 ${name}`, 403)
      }
      tools.push(trustPluginTool<Tool>({ name, displayName: `${snapshot.manifest.name} · ${spec.name}`, source: 'plugin',
        description: `${spec.description} [${snapshot.manifest.name} v${snapshot.manifest.version}, revision ${snapshot.revision}]`,
        parameters: spec.inputSchema,
        async execute(args, ctx) {
          const denied = extensionPolicy(ctx)
          if (denied) return denied
          try {
            if (ctx.tenantId !== tenantId) throw new PluginError('PLUGIN_FORBIDDEN', '插件租户不匹配', 403)
            if (!(await service.get(tenantId, selected.id)).enabled) throw new PluginError('PLUGIN_DISABLED', '插件已停用', 409)
            // Revalidate sealed bytes; the registered schema and revision never follow a new publication.
            const sealed = await service.snapshot(tenantId, selected.id, selected.revision)
            const hostController = await inheritedController(ctx)
            const result = await runPlugin(sealed, spec.name, args, { signal: ctx.signal, tenantId,
              hostContext: { sessionId: ctx.sessionId, workspacePath: ctx.projectRoot },
              capability: publishedCapabilityDispatcher(service, tenantId, selected.id, selected.revision, ctx.sessionId,
                { childAgent: Boolean(ctx.parentSessionId), workspaceContext: ctx, workspaceBinding: workspaceManager.getBindingSnapshot(ctx),
                  browserAuthority: ctx.browserAuthority, browserPrincipal: ctx.browserPrincipal, controllerSubject: hostController }) })
            const written = await emitPluginArtifacts(result.artifacts, ctx)
            if (!written.success) return written
            return { success: true, output: JSON.stringify({ result: result.result, artifacts: JSON.parse(written.output) }), changes: written.changes,
              metadata: { plugin: { id: selected.id, revision: selected.revision, hash: sealed.hash }, durationMs: result.durationMs } }
          } catch (error) {
            return { success: false, output: error instanceof Error ? error.message : String(error), status: ctx.signal?.aborted ? 'cancelled' : 'failed' }
          }
        },
      }, { tenantId, id: selected.id, revision: selected.revision, hash: snapshot.hash }))
    }
  }
  return tools
}
