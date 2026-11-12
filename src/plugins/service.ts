import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { compilePluginSchema } from './schema.js'
import { withFileLocks } from '../shared/file-version.js'
import { PluginError, type CreatePluginInput, type PluginManifest, type PluginRecord, type PluginSnapshot, type UpdatePluginInput } from './types.js'
import { describePluginRecord, type DescribedPluginRecord } from './metadata.js'
import { pluginContributionsSchema } from './contributions.js'

const MAX_FILES = 100, MAX_FILE_BYTES = 1024 * 1024, MAX_SOURCE_BYTES = 8 * 1024 * 1024
const MAX_INSTALLED_FILES = 20_000, MAX_INSTALLED_BYTES = 128 * 1024 * 1024
const allowedExtensions = new Set(['.mjs', '.js', '.cjs', '.json', '.md', '.txt', '.svg', '.html', '.css', '.yaml', '.yml', '.csv'])
const forbiddenSegments = new Set(['node_modules', '.git', '.staging', '.versions', '__proto__', 'prototype', 'constructor'])
const idRule = '插件 ID 使用 1–48 位小写字母、数字和单连字符（-），首尾为字母或数字；不能使用下划线或连续连字符，例如 currency-converter'
const pluginIdSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/, idRule)
const manifestSchema = z.object({
  apiVersion: z.literal(1), id: pluginIdSchema,
  name: z.string().trim().min(1).max(120), version: z.string().trim().min(1).max(64),
  description: z.string().trim().min(1).max(2000), runtime: z.literal('node'),
  tools: z.array(z.object({ name: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/, '本地工具名使用 1–32 位小写字母、数字和下划线（_），首位为字母，例如 convert_currency；不要填写 plugin_ 前缀或连字符'),
    description: z.string().trim().min(1).max(4000), inputSchema: z.record(z.unknown()),
    entry: z.string().max(300), }).strict()).min(1).max(32),
  contributes: pluginContributionsSchema.optional(),
}).strict()

export interface PreparedPluginDependencies { directory: string }
function fail(code: string, message: string, status = 400): never { throw new PluginError(code, message, status) }
function object(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)) }
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) => object(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
}
function digest(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex') }
function issuePath(root: string, parts: Array<string | number>): string {
  return root + parts.map(part => typeof part === 'number' ? `[${part}]` : '.' + part).join('')
}
function manifestIssue(issue: z.ZodIssue): string {
  const field = issuePath('manifest', issue.path)
  if (issue.code === 'unrecognized_keys') return `${field}: 不支持字段 ${issue.keys.join(', ')}；请按 plugin_get_template 返回的清单结构填写`
  if (issue.path.length === 1 && issue.path[0] === 'id') return `${field}: ${idRule}`
  if (issue.path.at(-1) === 'inputSchema') return `${field}: 需要 JSON Schema 对象，例如 {type:"object",properties:{amount:{type:"number"}},required:["amount"]}`
  if (issue.path.at(-1) === 'apiVersion') return `${field}: 当前必须为数字 1`
  if (issue.path.at(-1) === 'runtime') return `${field}: 当前必须为字符串 "node"`
  return `${field}: ${issue.message === 'Required' ? '缺少必填字段，请参考 plugin_get_template 返回的完整清单' : issue.message}`
}
export function validatePluginId(value: unknown, field = 'id'): string {
  const parsed = pluginIdSchema.safeParse(value)
  if (!parsed.success || parsed.data.includes('--')) fail('PLUGIN_ID', `${field}: ${idRule}`)
  return parsed.data
}
export function validatePluginPath(file: string): string {
  if (!file || file.length > 300 || file.includes('\\') || file.includes('\0') || path.posix.isAbsolute(file) || /^[a-z]:/i.test(file) || file.includes(':')) fail('PLUGIN_PATH', '插件文件必须使用安全的相对路径')
  const segments = file.split('/')
  if (segments.some(part => !part || part === '.' || part === '..' || part.endsWith('.') || part.endsWith(' ') || forbiddenSegments.has(part.toLowerCase()) || /[<>"|?*\x00-\x1f]/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) fail('PLUGIN_PATH', '插件文件路径包含保留名称或目录穿越')
  return file
}
export function validatePluginInput(input: CreatePluginInput): CreatePluginInput {
  const parsed = manifestSchema.safeParse(input?.manifest)
  if (!parsed.success) fail('PLUGIN_MANIFEST', parsed.error.issues.slice(0, 5).map(manifestIssue).join('\n'))
  const manifest = parsed.data as PluginManifest
  if (manifest.id.includes('--')) fail('PLUGIN_ID', `manifest.id: ${idRule}`)
  if (new Set(manifest.tools.map(tool => tool.name)).size !== manifest.tools.length) fail('PLUGIN_MANIFEST', 'manifest.tools: 本地工具名称重复；请为每个工具指定唯一 name')
  if (!object(input.files) || !Object.keys(input.files).length || Object.keys(input.files).length > MAX_FILES) fail('PLUGIN_FILES', `files: 需要 1-${MAX_FILES} 个相对路径到完整 UTF-8 源码的映射；已有本地工程可用 plugin_import_preview({type:"local",path}) 导入`)
  const names = new Set<string>(); let total = 0
  for (const [file, content] of Object.entries(input.files)) {
    const field = `files[${JSON.stringify(file)}]`
    try { validatePluginPath(file) } catch (error) { if (error instanceof PluginError) fail(error.code, `${field}: ${error.message}；请使用包内相对路径，例如 tools/convert.mjs`); throw error }
    if (!allowedExtensions.has(path.posix.extname(file).toLowerCase()) || typeof content !== 'string' || content.includes('\0')) fail('PLUGIN_FILES', `${field}: 需要受支持文件类型的 UTF-8 文本（按扩展名判断），不能传对象、数组或二进制内容`)
    if (names.has(file.toLowerCase())) fail('PLUGIN_FILES', `${field}: 文件路径大小写冲突；请保留一个唯一拼写`)
    names.add(file.toLowerCase())
    const bytes = Buffer.byteLength(content)
    total += bytes
    if (bytes > MAX_FILE_BYTES || total > MAX_SOURCE_BYTES) fail('PLUGIN_LIMIT', `${field}: 插件源码超过单文件 1 MiB 或合计 8 MiB 限制；请拆分或减少文件内容`)
  }
  for (const [index, tool] of manifest.tools.entries()) {
    const field = `manifest.tools[${index}]`
    if (`plugin_${manifest.id.replace(/-/g, '_')}_${tool.name}`.length > 64) fail('PLUGIN_MANIFEST', `${field}.name: 全局工具名超过 64 字符；请缩短 manifest.id 或本地工具 name，ID 的连字符会转换为下划线`)
    try { validatePluginPath(tool.entry) } catch (error) { if (error instanceof PluginError) fail(error.code, `${field}.entry: ${error.message}；请指向 files 中的相对 .mjs 路径`); throw error }
    if (!tool.entry.endsWith('.mjs') || !Object.hasOwn(input.files, tool.entry)) fail('PLUGIN_ENTRY', `${field}.entry: ${JSON.stringify(tool.entry)} 必须指向 files 中已有的 .mjs 文件；请同时提交入口源码`)
    try { compilePluginSchema(tool.inputSchema) } catch (error) { if (error instanceof PluginError) fail(error.code, `${field}.inputSchema: ${error.message}`); throw error }
  }
  const contributions = manifest.contributes
  if (contributions) {
    const pages = new Set((contributions.pages ?? []).map(page => page.id)), tools = new Set(manifest.tools.map(tool => tool.name))
    for (const [name, entries] of Object.entries(contributions)) {
      if (new Set(entries.map(entry => entry.id)).size !== entries.length) fail('PLUGIN_MANIFEST', `manifest.contributes.${name}: 标识重复`)
    }
    const assertTool = (name: string | undefined): void => { if (name && !tools.has(name)) fail('PLUGIN_MANIFEST', `manifest.contributes: 工具 ${name} 不存在`) }
    for (const page of contributions.pages ?? []) {
      if (page.kind === 'tool') assertTool(page.tool)
      else {
        validatePluginPath(page.entry)
        if (!page.entry.endsWith('.html') || typeof input.files[page.entry] !== 'string' || Buffer.byteLength(input.files[page.entry]) > 512 * 1024)
          fail('PLUGIN_MANIFEST', 'manifest.contributes.pages: webview entry 必须是包内不超过 512 KiB 的自包含 HTML')
        if (new Set(page.tools).size !== page.tools.length) fail('PLUGIN_MANIFEST', 'manifest.contributes.pages: tools 不可重复')
        page.tools.forEach(assertTool)
      }
    }
    for (const target of [...contributions.navigation ?? [], ...contributions.workspaceTabs ?? [], ...contributions.services ?? []]) {
      if (target.page && !pages.has(target.page)) fail('PLUGIN_MANIFEST', `manifest.contributes: 页面 ${target.page} 不存在`)
    }
    for (const entry of contributions.services ?? []) {
      assertTool(entry.tool); assertTool(entry.stopTool); assertTool(entry.statusTool)
      if (entry.args && Buffer.byteLength(JSON.stringify(entry.args)) > 64 * 1024) fail('PLUGIN_MANIFEST', 'manifest.contributes.services: 默认参数超过 64 KiB')
    }
  }
  // Management APIs edit the validated manifest. Keep its project-file mirror in
  // sync so exporting an edited template cannot silently restore an older one.
  const files = structuredClone(input.files)
  if (Object.hasOwn(files, 'aether-plugin.json')) files['aether-plugin.json'] = JSON.stringify(manifest, null, 2) + '\n'
  if (input.source !== undefined && (!object(input.source) || Buffer.byteLength(canonical(input.source)) > 32 * 1024)) fail('PLUGIN_SOURCE', '无效的插件来源信息')
  return { manifest, files, ...(input.source === undefined ? {} : { source: structuredClone(input.source) }) }
}
function contained(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)
}
function noLinks(file: string): void {
  const absolute = path.resolve(file); const root = path.parse(absolute).root
  let current = root
  for (const part of path.relative(root, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    try { if (fs.lstatSync(current).isSymbolicLink()) fail('PLUGIN_LINK', '插件存储不接受符号链接或目录联接', 403) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
}
function readJson<T>(file: string): T {
  noLinks(file)
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES * 3) fail('PLUGIN_STORAGE', '插件记录无效或过大')
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T
}
function atomicJson(file: string, value: unknown): void {
  noLinks(file)
  const temporary = file + '.' + randomUUID() + '.tmp'
  try { fs.writeFileSync(temporary, JSON.stringify(value), { flag: 'wx' }); fs.renameSync(temporary, file) }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary) }
}
/** Hash actual executable bytes, including installed dependencies, rather than their package names. */
function tree(directory: string): { hash: string; files: number; bytes: number } {
  noLinks(directory)
  const hash = createHash('sha256'); let files = 0, bytes = 0
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const file = path.join(current, entry.name)
      if (entry.isSymbolicLink()) fail('PLUGIN_LINK', '插件包中不允许符号链接', 403)
      if (entry.isDirectory()) { walk(file); continue }
      if (!entry.isFile()) fail('PLUGIN_FILES', '插件包只接受普通文件')
      const stat = fs.statSync(file); bytes += stat.size; files++
      if (files > MAX_INSTALLED_FILES || bytes > MAX_INSTALLED_BYTES || stat.size > 16 * 1024 * 1024) fail('PLUGIN_LIMIT', '插件依赖超过安装大小限制')
      const relative = path.relative(directory, file).replace(/\\/g, '/')
      hash.update(JSON.stringify([relative, stat.size])); hash.update(fs.readFileSync(file))
    }
  }
  walk(directory)
  return { hash: `sha256:${hash.digest('hex')}`, files, bytes }
}

export class PluginService {
  readonly rootDir: string
  readonly root: string
  constructor(root?: string) {
    this.rootDir = path.resolve(root ?? path.join(path.dirname(path.resolve(process.env.DATA_DIR ?? './data/agent.db')), 'plugins'))
    this.root = this.rootDir
  }
  private tenant(tenantId: string): string {
    if (typeof tenantId !== 'string' || !tenantId.trim() || tenantId.length > 256) fail('PLUGIN_TENANT', '无效租户')
    const directory = path.join(this.rootDir, `tenant-${digest(tenantId)}`)
    noLinks(directory); return directory
  }
  private directory(tenantId: string, id: string): string {
    return path.join(this.tenant(tenantId), validatePluginId(id))
  }
  private record(tenantId: string, id: string): PluginRecord {
    const directory = this.directory(tenantId, id), file = path.join(directory, 'record.json')
    if (!fs.existsSync(file)) fail('PLUGIN_NOT_FOUND', '插件不存在', 404)
    const record = readJson<PluginRecord>(file)
    if (record.id !== id || !Number.isSafeInteger(record.revision) || record.revision < 1) fail('PLUGIN_STORAGE', '插件记录损坏')
    return record
  }
  async list(tenantId: string): Promise<DescribedPluginRecord[]> {
    const directory = this.tenant(tenantId)
    if (!fs.existsSync(directory)) return []
    return fs.readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(entry => describePluginRecord(this.record(tenantId, entry.name))).sort((a, b) => b.updatedAt - a.updatedAt)
  }
  async get(tenantId: string, id: string): Promise<DescribedPluginRecord> { return describePluginRecord(this.record(tenantId, id)) }
  private createRevision(directory: string, input: CreatePluginInput, revision: number, dependencies?: PreparedPluginDependencies): { hash: string; createdAt: number } {
    noLinks(directory)
    const revisions = path.join(directory, 'revisions'), target = path.join(revisions, String(revision))
    fs.mkdirSync(revisions, { recursive: true })
    const staging = path.join(revisions, '.staging-' + randomUUID())
    fs.mkdirSync(staging)
    try {
      const filesDirectory = path.join(staging, 'files'); fs.mkdirSync(filesDirectory)
      for (const [relative, content] of Object.entries(input.files)) {
        const file = path.join(filesDirectory, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content, { flag: 'wx' })
      }
      if (dependencies) {
        const prepared = path.resolve(dependencies.directory)
        noLinks(prepared)
        const modules = path.join(prepared, 'node_modules'), lockfile = path.join(prepared, 'package-lock.json')
        if (!fs.existsSync(modules) || !fs.existsSync(lockfile)) fail('PLUGIN_DEPENDENCIES', '依赖安装目录缺少 node_modules 或 package-lock.json')
        tree(modules); noLinks(lockfile)
        if (!fs.lstatSync(lockfile).isFile() || fs.statSync(lockfile).size > 4 * 1024 * 1024) fail('PLUGIN_DEPENDENCIES', '依赖锁文件无效')
        fs.cpSync(modules, path.join(filesDirectory, 'node_modules'), { recursive: true, dereference: false, errorOnExist: true, force: false })
        if (Object.hasOwn(input.files, 'package-lock.json') && fs.readFileSync(lockfile, 'utf8') !== input.files['package-lock.json']) fail('PLUGIN_DEPENDENCIES', '依赖锁文件与源码记录不一致')
        fs.copyFileSync(lockfile, path.join(filesDirectory, 'package-lock.json'))
      }
      const installed = tree(filesDirectory), createdAt = Date.now()
      const hash = `sha256:${digest(canonical({ manifest: input.manifest, treeHash: installed.hash }))}`
      atomicJson(path.join(staging, 'snapshot.json'), { manifest: input.manifest, files: input.files, revision, hash, treeHash: installed.hash })
      noLinks(target)
      if (fs.existsSync(target)) fail('PLUGIN_REVISION', '插件版本已存在', 409)
      fs.renameSync(staging, target)
      return { hash, createdAt }
    } finally {
      if (fs.existsSync(staging)) { if (!contained(revisions, staging)) fail('PLUGIN_PATH', '无效临时目录'); fs.rmSync(staging, { recursive: true, force: true }) }
    }
  }
  async create(tenantId: string, raw: CreatePluginInput, dependencies?: PreparedPluginDependencies): Promise<DescribedPluginRecord> {
    const input = validatePluginInput(raw), directory = this.directory(tenantId, input.manifest.id)
    return withFileLocks([path.join(directory, 'record.json')], async () => {
      noLinks(directory)
      if (fs.existsSync(directory)) fail('PLUGIN_EXISTS', 'manifest.id: 插件 ID 已存在；请先 plugin_get 读取并用 plugin_update 编辑，或选择新的插件 ID', 409)
      fs.mkdirSync(directory, { recursive: true })
      try {
        const installed = this.createRevision(directory, input, 1, dependencies)
        const record: PluginRecord = { id: input.manifest.id, name: input.manifest.name, description: input.manifest.description,
          enabled: false, revision: 1, manifest: input.manifest, files: input.files, revisions: [{ revision: 1, ...installed }],
          ...(input.source === undefined ? {} : { source: input.source }), createdAt: installed.createdAt, updatedAt: installed.createdAt }
        atomicJson(path.join(directory, 'record.json'), record)
        return describePluginRecord(record)
      } catch (error) { noLinks(directory); if (contained(this.tenant(tenantId), directory)) fs.rmSync(directory, { recursive: true, force: true }); throw error }
    })
  }
  async update(tenantId: string, id: string, raw: UpdatePluginInput, dependencies?: PreparedPluginDependencies): Promise<DescribedPluginRecord> {
    const input = validatePluginInput(raw)
    if (input.manifest.id !== id) fail('PLUGIN_ID', 'manifest.id: 编辑不能改变插件 ID；请沿用 plugin_get 返回的 id，新插件应使用 plugin_create')
    const directory = this.directory(tenantId, id)
    return withFileLocks([path.join(directory, 'record.json')], async () => {
      const previous = this.record(tenantId, id)
      if (raw.expectedRevision !== previous.revision) fail('PLUGIN_CONFLICT', '插件草稿已更新，请重新读取后编辑', 409)
      const previousSnapshot = this.readSnapshot(tenantId, id, previous.revision)
      if (!dependencies && fs.existsSync(path.join(previousSnapshot.directory, 'node_modules'))) {
        if (input.files['package.json'] !== previous.files['package.json']) fail('PLUGIN_DEPENDENCIES', '依赖配置已变化，请重新导入并安装依赖')
        dependencies = { directory: previousSnapshot.directory }
      }
      const revisions = path.join(directory, 'revisions')
      const revision = Math.max(previous.revision, ...fs.readdirSync(revisions).filter(name => /^\d+$/.test(name)).map(Number)) + 1
      const installed = this.createRevision(directory, input, revision, dependencies)
      const record: PluginRecord = { ...previous, name: input.manifest.name, description: input.manifest.description,
        manifest: input.manifest, files: input.files, revision, revisions: [...previous.revisions, { revision, ...installed }],
        ...(input.source === undefined ? {} : { source: input.source }), updatedAt: installed.createdAt }
      atomicJson(path.join(directory, 'record.json'), record); return describePluginRecord(record)
    })
  }
  async publish(tenantId: string, id: string, expectedRevision: number): Promise<DescribedPluginRecord> {
    return this.change(tenantId, id, async record => {
      if (expectedRevision !== record.revision) fail('PLUGIN_CONFLICT', '插件草稿已变化，请重新检查后发布', 409)
      this.readSnapshot(tenantId, id, record.revision)
      return { ...record, publishedRevision: record.revision, enabled: true,
        revisions: record.revisions.map(item => item.revision === record.revision ? { ...item, publishedAt: item.publishedAt ?? Date.now() } : item) }
    })
  }
  async setEnabled(tenantId: string, id: string, enabled: boolean, expectedRevision?: number): Promise<DescribedPluginRecord> {
    if (typeof enabled !== 'boolean') fail('PLUGIN_ENABLED', 'enabled 必须为布尔值')
    return this.change(tenantId, id, async record => {
      if (expectedRevision !== undefined && expectedRevision !== record.revision) fail('PLUGIN_CONFLICT', '插件版本已变化，请重新检查后操作', 409)
      if (enabled && !record.publishedRevision) fail('PLUGIN_UNPUBLISHED', '请先发布插件再启用')
      if (enabled) this.readSnapshot(tenantId, id, record.publishedRevision!)
      return { ...record, enabled }
    })
  }
  private async change(tenantId: string, id: string, action: (record: PluginRecord) => Promise<PluginRecord>): Promise<DescribedPluginRecord> {
    const directory = this.directory(tenantId, id)
    return withFileLocks([path.join(directory, 'record.json')], async () => {
      const next = await action(this.record(tenantId, id)); next.updatedAt = Date.now()
      atomicJson(path.join(directory, 'record.json'), next); return describePluginRecord(next)
    })
  }
  async remove(tenantId: string, id: string, expectedRevision?: number): Promise<void> {
    const directory = this.directory(tenantId, id)
    await withFileLocks([path.join(directory, 'record.json')], async () => {
      const record = this.record(tenantId, id)
      if (expectedRevision !== undefined && expectedRevision !== record.revision) fail('PLUGIN_CONFLICT', '插件版本已变化，请重新检查后删除', 409)
      noLinks(directory)
      if (!contained(this.tenant(tenantId), directory)) fail('PLUGIN_PATH', '插件目录越界')
      fs.rmSync(directory, { recursive: true, force: false })
    })
  }
  private readSnapshot(tenantId: string, id: string, revision: number): PluginSnapshot {
    const record = this.record(tenantId, id)
    if (!Number.isSafeInteger(revision) || revision < 1 || !record.revisions.some(item => item.revision === revision)) fail('PLUGIN_REVISION', '插件版本不存在', 404)
    const revisionDirectory = path.join(this.directory(tenantId, id), 'revisions', String(revision)), directory = path.join(revisionDirectory, 'files')
    const saved = readJson<{ manifest: PluginManifest; files: Record<string, string>; hash: string; treeHash: string; revision: number }>(path.join(revisionDirectory, 'snapshot.json'))
    const installed = tree(directory), hash = `sha256:${digest(canonical({ manifest: saved.manifest, treeHash: installed.hash }))}`
    if (saved.revision !== revision || saved.manifest.id !== id || installed.hash !== saved.treeHash || hash !== saved.hash || record.revisions.find(item => item.revision === revision)?.hash !== hash) fail('PLUGIN_TAMPERED', '插件版本内容已变化，拒绝执行', 409)
    saved.manifest.tools.forEach(tool => compilePluginSchema(tool.inputSchema))
    return { id, tenantId, manifest: saved.manifest, files: saved.files, directory, hash, revision }
  }
  async snapshot(tenantId: string, id: string, revision: number, options: { allowDraft?: boolean } = {}): Promise<PluginSnapshot> {
    const record = this.record(tenantId, id)
    if (!options.allowDraft && (!record.enabled || !record.revisions.find(item => item.revision === revision)?.publishedAt)) fail('PLUGIN_DISABLED', '插件未启用或该版本尚未发布', 409)
    return this.readSnapshot(tenantId, id, revision)
  }
}

export const pluginService = new PluginService()
