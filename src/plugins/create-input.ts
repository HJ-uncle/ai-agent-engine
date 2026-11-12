import { z } from 'zod'
import { getPluginTemplate, listPluginTemplates } from './templates.js'
import { validatePluginId, validatePluginInput } from './service.js'
import { PluginError, type CreatePluginInput } from './types.js'

const templateSelection = z.object({
  templateId: z.string().min(1).max(64),
  id: z.unknown(),
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().min(1).max(2000).optional(),
}).strict()

/** Resolve templates before approval; the durable operation contains source, never a recipe. */
export function resolvePluginCreateInput(raw: unknown): CreatePluginInput {
  const input = z.record(z.unknown()).parse(raw)
  if (!Object.hasOwn(input, 'templateId')) {
    if (['id', 'name', 'description'].some(key => Object.hasOwn(input, key))) {
      throw new PluginError('PLUGIN_CREATE_INPUT', 'id/name/description 仅用于模板创建；请提供 templateId 和 id，或仅提交完整 manifest/files')
    }
    return validatePluginInput(input as unknown as CreatePluginInput)
  }
  if (Object.hasOwn(input, 'manifest') || Object.hasOwn(input, 'files')) {
    throw new PluginError('PLUGIN_CREATE_INPUT', '模板创建与 manifest/files 源码创建互斥；提供 templateId、id 和可选 name/description 即可，不要同时传源码')
  }
  const selected = templateSelection.parse(input)
  const id = validatePluginId(selected.id)
  if (!listPluginTemplates().some(template => template.id === selected.templateId)) {
    throw new PluginError('PLUGIN_TEMPLATE_NOT_FOUND', 'templateId: 插件模板不存在；请用 plugin_get_template 查询可用模板，不能使用路径或未知模板', 404)
  }
  const template = getPluginTemplate(selected.templateId)
  const manifest = {
    ...template.manifest,
    id,
    ...(selected.name === undefined ? {} : { name: selected.name }),
    ...(selected.description === undefined ? {} : { description: selected.description }),
  }
  const files = { ...template.files }
  // Only project metadata changes. Keep the tested entry, business cases and
  // independent runner byte-for-byte identical to the host's trusted template.
  files['aether-plugin.json'] = JSON.stringify(manifest, null, 2) + '\n'
  if (files['package.json']) {
    const pkg = JSON.parse(files['package.json']) as Record<string, unknown>
    files['package.json'] = JSON.stringify({ ...pkg, name: id }, null, 2) + '\n'
  }
  if (files['README.md']) {
    const sections = files['README.md'].split('\n\n')
    sections[0] = '# ' + manifest.name
    if (selected.description !== undefined) sections[1] = manifest.description
    files['README.md'] = sections.join('\n\n')
  }
  return validatePluginInput({ manifest, files })
}
