import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { validatePluginId, validatePluginInput, validatePluginPath } from './service.js'
import { PluginError, type CreatePluginInput, type PluginRecord, type UpdatePluginInput } from './types.js'

const selection = z.object({
  id: z.unknown(),
  expectedRevision: z.number().int().positive(),
  manifest: z.unknown().optional(),
  files: z.unknown(),
  fileMode: z.enum(['replace', 'merge']).optional(),
  deleteFiles: z.array(z.string()).max(100).optional(),
}).strict()

export type ResolvedPluginUpdateInput = UpdatePluginInput & { id: string }

/** Resolve an edit against one revision before approval. The approved input is source, not a merge recipe. */
export function resolvePluginUpdateInput(raw: unknown, record: PluginRecord): ResolvedPluginUpdateInput {
  const input = z.record(z.unknown()).parse(raw)
  const selected = selection.parse(input)
  const id = validatePluginId(selected.id)
  if (id !== record.id) throw new PluginError('PLUGIN_ID', 'id: 编辑目标与读取的插件不一致')
  if (selected.expectedRevision !== record.revision) throw new PluginError('PLUGIN_CONFLICT', '插件版本已变化，请重新读取后编辑', 409)
  if (!Object.hasOwn(input, 'files') || !selected.files || typeof selected.files !== 'object' || Array.isArray(selected.files)) {
    throw new PluginError('PLUGIN_FILES', 'files: 必须提供相对路径到完整 UTF-8 源码的对象；merge 模式仅需包含新增或修改的文件')
  }
  const edits = selected.files as Record<string, unknown>
  const written = new Set<string>()
  for (const [file, content] of Object.entries(edits)) {
    validatePluginPath(file)
    if (typeof content !== 'string') throw new PluginError('PLUGIN_FILES', `files[${JSON.stringify(file)}]: 需要完整 UTF-8 源码字符串`)
    if (written.has(file.toLowerCase())) throw new PluginError('PLUGIN_FILES', `files[${JSON.stringify(file)}]: 文件路径大小写冲突`)
    written.add(file.toLowerCase())
  }
  if ((selected.fileMode ?? 'replace') === 'replace') {
    if (Object.hasOwn(input, 'deleteFiles')) throw new PluginError('PLUGIN_UPDATE_INPUT', 'deleteFiles 仅可用于 fileMode:"merge"；replace 模式请提交完整 manifest/files')
    if (!Object.hasOwn(input, 'manifest')) throw new PluginError('PLUGIN_UPDATE_INPUT', 'manifest: replace 模式必须提交完整清单；仅编辑部分文件请显式使用 fileMode:"merge"')
    const complete = validatePluginInput({ manifest: selected.manifest, files: edits } as CreatePluginInput)
    if (complete.manifest.id !== id) throw new PluginError('PLUGIN_ID', 'manifest.id: 编辑不能改变插件 ID')
    return { id, expectedRevision: selected.expectedRevision, manifest: complete.manifest, files: complete.files }
  }

  const merged = { ...record.files }
  const deleted = new Set<string>()
  for (const file of selected.deleteFiles ?? []) {
    validatePluginPath(file)
    const canonical = file.toLowerCase()
    if (written.has(canonical)) throw new PluginError('PLUGIN_UPDATE_INPUT', `deleteFiles: ${JSON.stringify(file)} 不能同时删除和写入（含大小写相同路径）`)
    if (deleted.has(canonical)) throw new PluginError('PLUGIN_UPDATE_INPUT', `deleteFiles: ${JSON.stringify(file)} 重复删除`)
    if (!Object.hasOwn(record.files, file)) throw new PluginError('PLUGIN_UPDATE_INPUT', `deleteFiles: ${JSON.stringify(file)} 不存在；请使用 plugin_get 返回的完整路径及大小写`)
    deleted.add(canonical)
    delete merged[file]
  }
  for (const [file, content] of Object.entries(edits)) merged[file] = content as string
  const complete = validatePluginInput({ manifest: Object.hasOwn(input, 'manifest') ? selected.manifest : record.manifest, files: merged } as CreatePluginInput)
  if (complete.manifest.id !== id) throw new PluginError('PLUGIN_ID', 'manifest.id: 编辑不能改变插件 ID')
  if (isDeepStrictEqual(complete.manifest, record.manifest) && isDeepStrictEqual(complete.files, record.files)) {
    throw new PluginError('PLUGIN_UPDATE_INPUT', 'merge 没有实际变更；请提供新增/修改文件、有效 deleteFiles 或修改后的 manifest')
  }
  return { id, expectedRevision: selected.expectedRevision, manifest: complete.manifest, files: complete.files }
}
