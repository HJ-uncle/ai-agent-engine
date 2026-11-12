import type { PluginRecord } from './types.js'

export function pluginToolkitId(id: string, revision: number): `plugin-${string}--r${number}` { return `plugin-${id}--r${revision}` }
export function pluginToolName(id: string, name: string): string { return `plugin_${id.replace(/-/g, '_')}_${name}` }

export interface PluginInvocationMetadata {
  /** Names and mapping describe this record's current manifest, including an unpublished draft. */
  globalToolNames: string[]
  toolNameMap: Record<string, string>
  /** Only a published current revision can be selected with these current tool definitions. */
  selectionId: string | null
  publishedSelectionId: string | null
  invocationNote: string
}
export type DescribedPluginRecord = PluginRecord & PluginInvocationMetadata

/** Derived response metadata is not persisted in the source/version record. */
export function describePluginRecord(record: PluginRecord): DescribedPluginRecord {
  const toolNameMap = Object.fromEntries(record.manifest.tools.map(tool => [tool.name, pluginToolName(record.id, tool.name)]))
  const published = record.revisions.some(revision => revision.revision === record.revision && revision.publishedAt !== undefined)
  return { ...record, globalToolNames: Object.values(toolNameMap), toolNameMap,
    selectionId: published ? pluginToolkitId(record.id, record.revision) : null,
    publishedSelectionId: record.publishedRevision ? pluginToolkitId(record.id, record.publishedRevision) : null,
    invocationNote: '发布后可从插件列表打开操作页，按工具参数字段直接使用；发布不会自动把工具加入当前聊天请求范围。当前管理会话使用 plugin_test 验收；用户通过 @ 选择已发布的 selectionId 后，后续请求才能调用 globalToolNames。load_tools 只加载当前授权范围内已有的工具，不能增加插件权限。' }
}
