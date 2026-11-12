import type { Tool } from '../core/agent-context/types.js'
import { PluginService } from './service.js'
import { runPlugin } from './runtime.js'
import { PluginError, type PluginRecord } from './types.js'
import { normalizeAllowedTools } from '../tools/tool-profile.js'
import { parsePluginToolkit } from '../tools/toolkits.js'
import { extensionPolicy } from '../security/tool-policy.js'
import { emitPluginArtifacts } from './artifacts.js'
import { trustPluginTool } from './identity.js'
import { describePluginRecord, pluginToolkitId, pluginToolName, type DescribedPluginRecord } from './metadata.js'

export { pluginToolkitId, pluginToolName } from './metadata.js'
export function pluginSummary(record: PluginRecord): Omit<DescribedPluginRecord, 'files'> {
  const { files: _files, ...summary } = describePluginRecord(record)
  return summary
}

/** Configuration metadata only: no executable Tool objects and no implicit runtime registration. */
export async function pluginToolDefinitions(tenantId: string, ceiling?: readonly string[] | null, service = new PluginService()): Promise<Array<Pick<Tool, 'name' | 'displayName' | 'description' | 'parameters' | 'source' | 'outputSchema'>>> {
  const allowed = normalizeAllowedTools(ceiling)
  const records = await service.list(tenantId)
  const definitions = await Promise.all(records.filter(record => record.publishedRevision).map(async record => {
    // Disabled published versions remain configurable; actual invocation still requires enabled=true.
    const snapshot = await service.snapshot(tenantId, record.id, record.publishedRevision!, { allowDraft: true })
    return snapshot.manifest.tools.map(spec => ({
      name: pluginToolName(record.id, spec.name), displayName: snapshot.manifest.name + ' · ' + spec.name,
      description: spec.description + ' [' + snapshot.manifest.name + ' v' + snapshot.manifest.version + ', revision ' + snapshot.revision + ']',
      parameters: spec.inputSchema, source: 'plugin' as const,
    })).filter(tool => !allowed || allowed.includes(tool.name))
  }))
  return definitions.flat()
}

export async function pluginCatalogue(tenantId: string, ceilings: Array<readonly string[] | null | undefined> = [], service = new PluginService()) {
  const records = await service.list(tenantId)
  return Promise.all(records.filter(record => record.publishedRevision).map(async record => {
    const published = await service.snapshot(tenantId, record.id, record.publishedRevision!, { allowDraft: true })
    const toolNames = published.manifest.tools.map(tool => pluginToolName(record.id, tool.name))
    const denied = ceilings.some(ceiling => { const allowed = normalizeAllowedTools(ceiling); return allowed && toolNames.some(name => !allowed.includes(name)) })
    const reason = !record.enabled ? '插件已停用' : denied ? '当前 Agent 的工具白名单不允许此插件' : undefined
    const selectionId = pluginToolkitId(record.id, record.publishedRevision!)
    return { id: selectionId, selectionId, name: published.manifest.name, description: published.manifest.description,
      toolNames, globalToolNames: toolNames,
      toolNameMap: Object.fromEntries(published.manifest.tools.map(tool => [tool.name, pluginToolName(record.id, tool.name)])),
      available: !reason, ...(reason ? { reason } : {}) }
  }))
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
            const result = await runPlugin(sealed, spec.name, args, { signal: ctx.signal, tenantId })
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
