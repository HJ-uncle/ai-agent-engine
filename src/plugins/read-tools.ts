import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { AgentContext, JSONSchema, ToolResult } from '../core/agent-context/types.js'
import { getToolOutputLimit } from '../core/agent-loop/tool-output-limit.js'
import { PluginService, validatePluginId } from './service.js'
import { getPluginTemplate, listPluginTemplates, PLUGIN_TEMPLATE_PROTOCOL } from './templates.js'
import { PLUGIN_CONTRIBUTION_CATALOGUE } from './contributions.js'

const sections = ['overview', 'metadata', 'manifest', 'files', 'file', 'protocol', 'contributions', 'templates'] as const
export const pluginReadProperties: Record<string, JSONSchema> = {
  section: { type: 'string', enum: [...sections], description: '默认返回可容纳的完整结果或紧凑目录。manifest/metadata/files/protocol/contributions/templates 返回精确 JSON 文本页；file 返回原始源码页。' },
  file: { type: 'string', minLength: 1, maxLength: 300, description: 'section:file 的包内文件名，例如 main.mjs、ui/index.html；必须来自文件目录，不能读取本机其他路径。单独传 file 时自动使用 section:file。' },
  protocol: { type: 'string', enum: Object.keys(PLUGIN_TEMPLATE_PROTOCOL), description: 'section:protocol 的单个字段，例如 uiBridge、uiTheme、download、artifacts；省略则读取整个协议。单独传 protocol 时自动使用 section:protocol。' },
  offset: { type: 'integer', minimum: 0, description: '从上一页 nextOffset 继续；位置和 totalChars 均为 UTF-16 字符数，不是字节数。顺序拼接 content 后，json 页再 JSON.parse。' },
  maxChars: { type: 'integer', minimum: 1, maximum: 1000000, description: '期望读取的原文字符数上限；宿主还会按本次工具输出预算自动缩小，保证返回 JSON 不被截断。' },
  revision: { oneOf: [{ type: 'integer', minimum: 1 }, { type: 'string', minLength: 1, maxLength: 80 }], description: '续读必须沿用返回值。plugin_get 使用当前整数 revision，版本变化会报错；模板使用 sha256 标识，防止跨模板更新拼接。' },
}

const inputSchema = z.object({ id: z.string().max(100).optional(), section: z.enum(sections).optional(), file: z.string().min(1).max(300).optional(),
  protocol: z.string().min(1).max(100).optional(), offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  maxChars: z.number().int().min(1).max(1000000).optional(), revision: z.union([z.number().int().positive(), z.string().min(1).max(80)]).optional() }).strict()
type ReadInput = z.infer<typeof inputSchema>
type Revision = number | string
interface Source {
  id?: string
  revision: Revision
  full: unknown
  metadata: Record<string, unknown>
  files?: Record<string, string>
  manifest?: unknown
  templates?: ReturnType<typeof listPluginTemplates>
}
class ReadError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}
const fail = (code: string, message: string): never => { throw new ReadError(code, message) }
const json = (value: unknown): string => JSON.stringify(value)
// ReAct reserves this literal outside JSON for subagent receipts. Escaping one
// underscore keeps arbitrary source text from being mistaken for that suffix.
const receipt = (value: unknown): string => json(value).replaceAll('__SUBAGENT_META__', '\\u005f_SUBAGENT_META__')
const limitFor = (ctx: AgentContext): number => Math.max(1, Math.floor(getToolOutputLimit(ctx.toolProfile, ctx)))
const success = (output: string): ToolResult => ({ success: true, output })

/** Even authorization/validation/budget failures must survive ReAct as valid JSON. */
export function pluginReadFailure(error: unknown, ctx: AgentContext): ToolResult {
  const limit = limitFor(ctx), message = error instanceof Error ? error.message : String(error)
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'PLUGIN_READ_ERROR'
  const candidates = [receipt({ error: { code, message } }), receipt({ error: { code } }), receipt({ error: 'budget' }), 'false', '0']
  const output = candidates.find(value => value.length <= limit)!
  return { success: false, output, error: message, metadata: { code } }
}

function validateInput(raw: unknown): ReadInput {
  const input = inputSchema.parse(raw ?? {})
  if (input.file !== undefined && input.protocol !== undefined) fail('PLUGIN_READ_ARGUMENT', 'file 与 protocol 不能同时指定')
  if (input.file !== undefined && input.section !== undefined && input.section !== 'file') fail('PLUGIN_READ_ARGUMENT', 'file 仅用于 section:file')
  if (input.protocol !== undefined && input.section !== undefined && input.section !== 'protocol') fail('PLUGIN_READ_ARGUMENT', 'protocol 仅用于 section:protocol')
  return input
}

function readableSections(source: Source): string[] {
  return ['overview', 'metadata', ...(source.manifest ? ['manifest', 'files', 'file'] : []), 'protocol', 'contributions', ...(source.templates ? ['templates'] : [])]
}
function directory(source: Source): Array<{ file: string; totalChars: number }> {
  return Object.keys(source.files ?? {}).sort().map(file => ({ file, totalChars: source.files![file].length }))
}
function overview(source: Source, ctx: AgentContext): ToolResult {
  const limit = limitFor(ctx)
  const files = directory(source), templates = source.templates?.map(({ id, name }) => ({ id, name })) ?? []
  const base = { mode: 'overview', ...(source.id ? { id: source.id } : {}), revision: source.revision, sections: readableSections(source),
    read: { section: source.files ? 'file' : 'protocol', ...(source.files ? { file: files[0]?.file ?? 'main.mjs' } : { protocol: 'uiBridge' }), offset: 0, revision: source.revision },
    note: '按 section 读取；连续拼接 content，沿用 revision 和 nextOffset。manifest 为精确 JSON，file 为原始源码。' }
  const value = { ...base, fileCount: files.length, fileListComplete: true, files, ...(source.templates ? { templateCount: templates.length, templateListComplete: true, templates } : {}),
    protocolFields: Object.keys(PLUGIN_TEMPLATE_PROTOCOL) }
  // Remove only catalogue rows, never clip strings/JSON or hide a nonempty
  // catalogue without indicating that the dedicated section remains readable.
  while (receipt(value).length > limit && value.files.length) { value.files.pop(); value.fileListComplete = false }
  while (receipt(value).length > limit && value.templates?.length) { value.templates.pop(); value.templateListComplete = false }
  if (receipt(value).length <= limit) return success(receipt(value))
  const compact = { mode: 'overview', ...(source.id ? { id: source.id } : {}), revision: source.revision, sections: readableSections(source),
    fileCount: directory(source).length, ...(source.templates ? { templateCount: source.templates.length } : {}),
    read: 'section:file + file; section:protocol + protocol; offset=nextOffset; pin revision' }
  if (receipt(compact).length <= limit) return success(receipt(compact))
  return pluginReadFailure(new ReadError('PLUGIN_READ_BUDGET_TOO_SMALL', `工具输出预算 ${limit} 字符不足以显示读取目录；请使用独立工具调用或提高本次读取预算（至少 ${receipt(compact).length} 字符）。`), ctx)
}

function boundary(text: string, at: number): boolean {
  return at > 0 && at < text.length && /[\uD800-\uDBFF]/.test(text[at - 1]) && /[\uDC00-\uDFFF]/.test(text[at])
}
function textPage(source: Source, input: ReadInput, section: string, text: string, format: 'text' | 'json', ctx: AgentContext): ToolResult {
  const limit = limitFor(ctx), offset = input.offset ?? 0
  if (offset > text.length || boundary(text, offset)) fail('PLUGIN_READ_OFFSET', 'offset 超出内容范围或位于 Unicode 字符中间；请使用上一页 nextOffset')
  const make = (end: number) => ({ ...(source.id ? { id: source.id } : {}), revision: source.revision, section,
    ...(input.file ? { file: input.file } : {}), ...(input.protocol ? { protocol: input.protocol } : {}),
    format, offset, nextOffset: end < text.length ? end : null, totalChars: text.length, content: text.slice(offset, end) })
  let low = offset, high = Math.min(text.length, offset + (input.maxChars ?? text.length)), end = offset
  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2)
    if (receipt(make(middle)).length <= limit) { end = middle; low = middle + 1 } else high = middle - 1
  }
  if (boundary(text, end)) end--
  if ((end === offset && offset < text.length) || receipt(make(end)).length > limit) {
    return pluginReadFailure(new ReadError('PLUGIN_READ_BUDGET_TOO_SMALL', `工具输出预算 ${limit} 字符或 maxChars 太小，无法容纳分页回执与下一个完整字符；请使用独立工具调用或增大 maxChars。`), ctx)
  }
  return success(receipt(make(end)))
}

function readSource(source: Source, input: ReadInput, ctx: AgentContext): ToolResult {
  if ((input.offset ?? 0) > 0 && input.revision === undefined) fail('PLUGIN_READ_REVISION_REQUIRED', 'offset 大于 0 的续读必须携带上一页 revision，防止拼接不同版本')
  if (input.revision !== undefined && input.revision !== source.revision) fail('PLUGIN_READ_REVISION_CHANGED', '插件或模板版本已变化；请重新读取目录并从 offset:0 开始，不能拼接不同 revision 的内容')
  const explicit = input.section !== undefined || input.file !== undefined || input.protocol !== undefined || input.offset !== undefined || input.maxChars !== undefined
  if (!explicit && receipt(source.full).length <= limitFor(ctx)) return success(receipt(source.full))
  const section = input.section ?? (input.file !== undefined ? 'file' : input.protocol !== undefined ? 'protocol' : 'overview')
  if (!readableSections(source).includes(section)) fail('PLUGIN_READ_SECTION', '此读取对象不支持该 section；请先读取目录')
  if (section === 'overview') {
    if (input.offset) fail('PLUGIN_READ_ARGUMENT', 'overview 是目录，不支持 offset；请指定文件或其他 section 后分页')
    return overview(source, ctx)
  }
  let value: unknown, format: 'text' | 'json' = 'json'
  switch (section) {
    case 'metadata': value = source.metadata; break
    case 'manifest': value = source.manifest; break
    case 'files': value = directory(source); break
    case 'templates': value = source.templates; break
    case 'contributions': value = PLUGIN_CONTRIBUTION_CATALOGUE; break
    case 'file':
      if (!input.file || !source.files || !Object.hasOwn(source.files, input.file)) fail('PLUGIN_READ_FILE_NOT_FOUND', '插件文件不存在；请先通过 section:files 读取包内文件清单')
      value = source.files![input.file!]; format = 'text'; break
    case 'protocol':
      if (input.protocol !== undefined) {
        if (!Object.hasOwn(PLUGIN_TEMPLATE_PROTOCOL, input.protocol)) fail('PLUGIN_READ_PROTOCOL', '协议字段不存在；请省略 protocol 读取完整协议')
        value = PLUGIN_TEMPLATE_PROTOCOL[input.protocol as keyof typeof PLUGIN_TEMPLATE_PROTOCOL]
        if (typeof value === 'string') format = 'text'
      } else value = PLUGIN_TEMPLATE_PROTOCOL
      break
  }
  return textPage(source, input, section, format === 'text' ? value as string : json(value), format, ctx)
}

export async function readManagedPlugin(service: PluginService, raw: unknown, ctx: AgentContext): Promise<ToolResult> {
  const input = validateInput(raw), record = await service.get(ctx.tenantId, validatePluginId(input.id))
  const { files, manifest, ...metadata } = record
  return readSource({ id: record.id, revision: record.revision, full: record, metadata, files, manifest }, input, ctx)
}
export function readPluginTemplate(raw: unknown, ctx: AgentContext): ToolResult {
  const input = validateInput(raw), template = input.id === undefined ? undefined : getPluginTemplate(input.id)
  const templates = listPluginTemplates(), full = template ? { template } : { templates, protocol: PLUGIN_TEMPLATE_PROTOCOL, contributions: PLUGIN_CONTRIBUTION_CATALOGUE }
  const revision = 'sha256:' + createHash('sha256').update(json(full)).digest('hex')
  return readSource({ ...(template ? { id: template.id, files: template.files, manifest: template.manifest } : { templates }), revision, full,
    metadata: template ? { id: template.id, name: template.name, description: template.description, version: template.manifest.version } : { templateCount: templates.length, protocolFields: Object.keys(PLUGIN_TEMPLATE_PROTOCOL) } }, input, ctx)
}
