import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { AgentContext, ToolResult } from '../core/agent-context/types.js'
import { getToolOutputLimit } from '../core/agent-loop/tool-output-limit.js'
import { describePluginRecord } from './metadata.js'
import type { PluginManifest, PluginRecord } from './types.js'

const compactActions = new Set(['plugin_create', 'plugin_update', 'plugin_import_install', 'plugin_publish', 'plugin_set_enabled'])
const json = (value: unknown): string => JSON.stringify(value).replaceAll('__SUBAGENT_META__', '\\u005f_SUBAGENT_META__')
const limitFor = (ctx: AgentContext): number => Math.max(1, Math.floor(getToolOutputLimit(ctx.toolProfile, ctx)))
const fingerprint = (content: string) => ({ bytes: Buffer.byteLength(content, 'utf8'), sha256: createHash('sha256').update(content, 'utf8').digest('hex') })
type FileChange = { path: string; change: 'added' | 'modified' | 'deleted'; before?: ReturnType<typeof fingerprint>; after?: ReturnType<typeof fingerprint> }
interface Project { manifest: PluginManifest; files: Record<string, string> }

/** Compare resolved snapshots, not the caller's merge recipe or list of submitted files. */
export function pluginFileChanges(before: Record<string, string>, after: Record<string, string>): FileChange[] {
  const changes: FileChange[] = []
  for (const file of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const had = Object.hasOwn(before, file), has = Object.hasOwn(after, file)
    if (had && has && before[file] === after[file]) continue
    changes.push({ path: file, change: !had ? 'added' : !has ? 'deleted' : 'modified',
      ...(had ? { before: fingerprint(before[file]) } : {}), ...(has ? { after: fingerprint(after[file]) } : {}) })
  }
  return changes
}

/** The generic approval wrapper pretty-prints this value. Budget the actual reason, not compact JSON. */
export function pluginMutationPreview(action: string, title: string, input: Record<string, unknown>, previous: PluginRecord | undefined,
  project: Project | undefined, ctx: AgentContext): unknown | undefined {
  // Import approvals already contain only the immutable job ID, true source and
  // dependency requirements. Retain that review rather than omit provenance.
  if (!compactActions.has(action) || action === 'plugin_import_install') return undefined
  const current = project?.manifest ?? previous?.manifest
  const pluginId = current?.id ?? input.id
  const base = { action, id: pluginId, ...(current ? { name: current.name, version: current.version } : {}),
    ...(previous ? { expectedRevision: previous.revision } : {}),
    ...(action === 'plugin_set_enabled' ? { enabled: input.enabled } : {}),
    ...(action === 'plugin_import_install' ? { jobId: input.jobId } : {}) }
  const changes = project ? pluginFileChanges(previous?.files ?? {}, project.files) : []
  const counts = { added: changes.filter(change => change.change === 'added').length,
    modified: changes.filter(change => change.change === 'modified').length, deleted: changes.filter(change => change.change === 'deleted').length }
  const summary = project && current ? {
    manifest: { ...(previous ? { before: fingerprint(JSON.stringify(previous.manifest)) } : {}), after: fingerprint(JSON.stringify(project.manifest)),
      changedFields: [...new Set([...Object.keys(previous?.manifest ?? {}), ...Object.keys(current)])]
        .filter(key => !previous || !isDeepStrictEqual(previous.manifest[key as keyof PluginManifest], current[key as keyof PluginManifest])) },
    fileCount: Object.keys(project.files).length, totalBytes: Object.values(project.files).reduce((total, source) => total + Buffer.byteLength(source, 'utf8'), 0),
    changes: counts, changedFileCount: changes.length, fileListComplete: true, omittedFileChanges: 0, files: changes,
  } : {}
  const value: Record<string, unknown> = { ...base, ...summary }
  const size = (preview: unknown) => Buffer.byteLength(`${title}确认\n\n${JSON.stringify(preview, null, 2)}\n\n确认后执行以上操作。`, 'utf8')
  // Leave room for the upstream security-policy prefix (currently about 72 bytes).
  // The approval's complete pretty JSON, wrapper and prefix remain below 4 KiB.
  const limit = Math.max(1, Math.min(4000, limitFor(ctx)) - 128)
  while (size(value) > limit && changes.length) {
    changes.pop(); value.fileListComplete = false; value.omittedFileChanges = Number(value.omittedFileChanges) + 1
  }
  if (size(value) <= limit) return value
  const reduced = { ...base, ...(project ? { changes: counts, changedFileCount: counts.added + counts.modified + counts.deleted,
    fileListComplete: false, omittedFileChanges: counts.added + counts.modified + counts.deleted } : {}),
    note: '预览预算有限；完整已校验源码快照保留在待批准操作中，批准后只应用该快照。' }
  if (size(reduced) <= limit) return reduced
  const minimal = { action, id: pluginId, ...(previous ? { expectedRevision: previous.revision } : {}),
    ...(project ? { changes: counts, changedFileCount: counts.added + counts.modified + counts.deleted,
      fileListComplete: false, omittedFileChanges: counts.added + counts.modified + counts.deleted } : {}) }
  // The wrapper's fixed confirmation text itself may exceed a tiny per-call allowance.
  // Keep the preview valid JSON and retain all approval bytes independently of it.
  return size(minimal) <= limit ? minimal : { ...minimal, previewOmitted: true }
}

/** Write receipts never echo executable source, input schemas, revision history, or large descriptions. */
export function pluginMutationResult(action: string, record: PluginRecord, ctx: AgentContext): ToolResult {
  if (!compactActions.has(action)) throw new Error('Unsupported compact plugin mutation result')
  const metadata = describePluginRecord(record)
  const read = { tool: 'plugin_get', args: { id: record.id, section: 'metadata', revision: record.revision } }
  const core = { id: record.id, revision: record.revision, hash: record.revisions.find(item => item.revision === record.revision)?.hash ?? null,
    enabled: record.enabled, publishedRevision: record.publishedRevision ?? null, selectionId: metadata.selectionId,
    publishedSelectionId: metadata.publishedSelectionId }
  const full = { ...core, name: record.name, version: record.manifest.version, globalToolNames: metadata.globalToolNames,
    toolNameMap: metadata.toolNameMap, toolNamesComplete: true, read }
  const reduced = { ...core, toolNamesComplete: false, read }
  const candidates = [full, reduced, { id: record.id, revision: record.revision, applied: true, toolNamesComplete: false, read },
    { id: record.id, applied: true, read: 'plugin_get section:metadata' }, { applied: true, read }, { applied: true }, 1]
  const limit = limitFor(ctx), output = candidates.map(json).find(value => value.length <= limit)!
  return { success: true, output, metadata: { pluginMutation: { id: record.id, revision: record.revision,
    compact: true, toolNamesComplete: output === json(full), read } } }
}

export const hasCompactPluginMutationResult = (action: string): boolean => compactActions.has(action)
