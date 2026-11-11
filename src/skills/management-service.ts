import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { AuthContext } from '../auth/types.js'
import { workspaceManager } from '../workspace/index.js'
import { projectDataPath } from '../core/project-storage.js'
import { throwIfAborted } from '../core/utils/abort.js'
import { canonicalFilePathSync, hashFileContent, withFileLocks } from '../shared/file-version.js'
import { globalSkillsRoot, resolveSkillsRoot, type SkillScope } from './import-pipeline.js'
import { projectSkillRoots, withProjectSkillDeletion } from './project-skills.js'
import { skillsRegistry } from './skills-registry.js'

const MAX_CONTENT_BYTES = 512 * 1024
const MAX_FILES = 1000
const MAX_TREE_BYTES = 50 * 1024 * 1024
export const skillScopeSchema = z.enum(['project', 'global'])
export const skillKeySchema = z.string().min(1).max(256)
export const skillHashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
export const skillContentSchema = z.string().min(1).max(100_000).refine(value => value.trim().length > 0, '技能正文不能为空')
export const skillCreateSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,119}$/),
  description: z.string().trim().min(1).max(500).refine(value => !/[\r\n]/.test(value), '描述必须为单行'),
  content: skillContentSchema,
  scope: skillScopeSchema.default('project'),
}).strict()

export interface SkillManagementContext {
  tenantId: string
  /** Trusted server context or an authorized HTTP workspace selection, never a tool argument. */
  projectRoot?: string
  principal?: Readonly<AuthContext>
  signal?: AbortSignal
}
export class SkillManagementError extends Error {
  constructor(public readonly code: number, message: string) { super(message); this.name = 'SkillManagementError' }
}
export function skillManagementFailure(error: unknown): { code: number; message: string } {
  if (error instanceof z.ZodError) return { code: 40001, message: error.errors[0]?.message ?? error.message }
  if (error instanceof SkillManagementError) return { code: error.code, message: error.message }
  return { code: 50000, message: error instanceof Error ? error.message : String(error) }
}
export function assertSkillManagementAccess(context: SkillManagementContext, scope?: SkillScope): void {
  const principal = context.principal
  if (principal && principal.tenantId !== context.tenantId) throw new SkillManagementError(40300, '技能管理身份与租户不一致')
  const local = process.env.AUTH_ENABLED === 'false' && (!principal || principal.method === 'none')
  if (!local && (!principal || principal.method === 'none' || !principal.roles?.some(role => role === 'admin' || role === 'skill-manager')))
    throw new SkillManagementError(40300, '技能管理需要 admin 或 skill-manager 权限')
  if (scope === 'global' && context.tenantId !== 'default') throw new SkillManagementError(40300, '全局技能是本机共享资源，当前租户只能管理项目技能')
}
function identity(value: string): string { return process.platform === 'win32' ? value.toLowerCase() : value }
export function skillManagementId(file: string): string { return `skill-${createHash('sha256').update(identity(canonicalFilePathSync(file))).digest('hex').slice(0, 32)}` }
function contained(base: string, candidate: string): boolean {
  const relative = path.relative(base, candidate)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))
}
function configuredRoot(root: string): string {
  // Normalize Windows short aliases without following a replaced skill root.
  try { if (fs.lstatSync(root).isSymbolicLink()) throw new SkillManagementError(40300, '技能管理不接受符号链接或目录联接') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  return canonicalFilePathSync(root)
}
/** Reject every symlink/junction below the trusted root, including missing-target links. */
function safePath(anchor: string, candidate: string): string {
  const absolute = path.resolve(candidate)
  if (!contained(anchor, absolute)) throw new SkillManagementError(40300, '技能路径超出已授权目录')
  const parts = path.relative(anchor, absolute).split(path.sep).filter(Boolean)
  let current = anchor
  for (const part of ['', ...parts]) {
    if (part) current = path.join(current, part)
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new SkillManagementError(40300, '技能管理不接受符号链接或目录联接') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  if (identity(canonicalFilePathSync(absolute)) !== identity(absolute)) throw new SkillManagementError(40300, '技能路径实际位置发生变化')
  return absolute
}
function readBytes(file: string, limit = MAX_CONTENT_BYTES): Buffer | null {
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw new SkillManagementError(40001, '技能文件不是普通文件或超过大小限制')
    const descriptor = fs.openSync(file, 'r')
    try {
      const opened = fs.fstatSync(descriptor)
      if (!opened.isFile() || opened.size > limit) throw new SkillManagementError(40001, '技能文件超过大小限制')
      const bounded = Buffer.alloc(opened.size + 1)
      let length = 0
      while (length < bounded.length) {
        const count = fs.readSync(descriptor, bounded, length, bounded.length - length, length)
        if (!count) break
        length += count
      }
      if (length !== opened.size || fs.fstatSync(descriptor).size !== opened.size) throw new SkillManagementError(40900, '技能文件读取期间已变化，请重新读取')
      return bounded.subarray(0, length)
    } finally { fs.closeSync(descriptor) }
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}
function jsonObject(file: string): Record<string, any> {
  const bytes = readBytes(file)
  if (!bytes) return {}
  const parsed: unknown = JSON.parse(bytes.toString('utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new SkillManagementError(40001, '技能配置不是 JSON 对象')
  return parsed as Record<string, any>
}
function frontmatter(content: string): Record<string, string> {
  const block = content.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1]
  return Object.fromEntries((block?.split(/\r?\n/) ?? []).flatMap(line => {
    const match = line.match(/^([\w-]+):\s*(.*)$/)
    return match ? [[match[1], match[2].trim()]] : []
  }))
}
interface Layer { scope: SkillScope; root: string; anchor: string; configPath: string; projectRoot?: string }
export interface ManagedSkill {
  id: string; name: string; description: string; enabled: boolean; scope: SkillScope; dir: string
  content: string; hash: string; files: Array<{ path: string; size: number }>
}
interface ResolvedSkill extends ManagedSkill { layer: Layer; file: string; manifestPath: string; revision: string }
export interface PreparedSkillMutation {
  version: 1; tenantId: string; action: 'create' | 'update' | 'set_enabled' | 'delete'; scope: SkillScope
  projectRoot?: string; root: string; anchor: string; configPath: string; file: string; dir: string; id: string
  name: string; expectedHash: string; revision: string; content?: string; enabled?: boolean; treeHash?: string
  before?: { name: string; description: string; enabled: boolean; hash: string; files: Array<{ path: string; size: number }> }
}
export interface SkillResourceChange { kind: 'skill'; action: PreparedSkillMutation['action']; id: string }

function manifestPath(dir: string): string { return path.join(dir, 'plugin.json') }
function revision(file: string, dir: string, layer: Layer): string {
  return hashFileContent(JSON.stringify([file, hashFileContent(readBytes(file)), hashFileContent(readBytes(manifestPath(dir))),
    hashFileContent(readBytes(safePath(layer.anchor, layer.configPath))),
    hashFileContent(readBytes(safePath(layer.anchor, path.join(layer.root, 'skills.config.json'))))]))
}
function tree(dir: string, anchor: string, includeHash = false): { files: Array<{ path: string; size: number }>; hash: string } {
  const files: Array<{ path: string; size: number }> = [], hashes: string[] = []
  let bytes = 0, entries = 0
  const walk = (current: string, depth: number) => {
    if (depth > 16) throw new SkillManagementError(40001, '技能目录层级过深')
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (++entries > MAX_FILES) throw new SkillManagementError(40001, '技能附件超过管理限制')
      const full = safePath(anchor, path.join(current, entry.name)), stat = fs.lstatSync(full)
      if (stat.isDirectory()) { hashes.push('dir:' + path.relative(dir, full)); walk(full, depth + 1) }
      else {
        if (!stat.isFile() || files.length >= MAX_FILES || (bytes += stat.size) > MAX_TREE_BYTES) throw new SkillManagementError(40001, '技能附件超过管理限制')
        const relative = path.relative(dir, full)
        files.push({ path: relative, size: stat.size })
        if (includeHash) hashes.push(relative + ':' + hashFileContent(readBytes(full, MAX_TREE_BYTES)))
      }
    }
  }
  walk(dir, 0)
  return { files, hash: hashFileContent(JSON.stringify(hashes)) }
}
function atomicWrite(file: string, content: string, expectedHash: string, anchor: string): void {
  safePath(anchor, file)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  safePath(anchor, file)
  const temporary = safePath(anchor, path.join(path.dirname(file), '.skill-write-' + randomUUID() + '.tmp'))
  const oldMode = fs.existsSync(file) ? fs.statSync(file).mode : 0o600
  try {
    const fd = fs.openSync(temporary, 'wx', oldMode)
    try { fs.writeFileSync(fd, content, 'utf8'); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    safePath(anchor, file)
    if (hashFileContent(readBytes(file)) !== expectedHash) throw new SkillManagementError(40900, '技能版本已变化，请重新读取后确认')
    fs.renameSync(temporary, file)
  } finally { fs.rmSync(temporary, { force: true }) }
}

export class SkillManagementService {
  private layers(context: SkillManagementContext, scope?: SkillScope): Layer[] {
    assertSkillManagementAccess(context, scope)
    const layers: Layer[] = []
    if (scope !== 'global') {
      const project = canonicalFilePathSync(workspaceManager.resolveProjectDirectory(context.tenantId, path.resolve(context.projectRoot ?? process.cwd())))
      const roots = !context.projectRoot && process.env.SKILLS_ROOT ? [configuredRoot(resolveSkillsRoot())] : projectSkillRoots(project)
      const writeRoot = context.projectRoot ? projectDataPath(project, 'skills') : configuredRoot(resolveSkillsRoot())
      for (const root of [...new Set(roots.map(root => path.resolve(root)))]) {
        // An explicitly configured deployment root is available only to the
        // local/default operator when no project was explicitly selected.
        if (!contained(project, root) && context.tenantId !== 'default') continue
        const anchor = contained(project, root) ? project : path.dirname(root)
        safePath(anchor, root)
        layers.push({ scope: 'project', root, anchor, projectRoot: project, configPath: path.join(writeRoot, 'skills.config.json') })
      }
    }
    if (scope !== 'project' && context.tenantId === 'default') {
      const root = configuredRoot(globalSkillsRoot()), anchor = path.dirname(root)
      safePath(anchor, root)
      layers.push({ scope: 'global', root, anchor, configPath: path.join(root, 'skills.config.json') })
    }
    return layers
  }

  private scan(context: SkillManagementContext, scope?: SkillScope): ResolvedSkill[] {
    const result: ResolvedSkill[] = [], seen = new Set<string>()
    for (const layer of this.layers(context, scope)) {
      if (!fs.existsSync(layer.root)) continue
      const config = jsonObject(safePath(layer.anchor, layer.configPath))
      const ownConfig = jsonObject(safePath(layer.anchor, path.join(layer.root, 'skills.config.json')))
      const deleted = new Set(Array.isArray(config.deletedLegacySkills) ? config.deletedLegacySkills : [])
      const entries = fs.readdirSync(layer.root, { withFileTypes: true })
      if (entries.length > MAX_FILES) throw new SkillManagementError(40001, '技能目录数量超过管理限制')
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue
        const dir = safePath(layer.anchor, path.join(layer.root, entry.name))
        const plugin = safePath(layer.anchor, manifestPath(dir)), manifest = jsonObject(plugin)
        if (manifest.main !== undefined && typeof manifest.main !== 'string') continue
        const file = safePath(dir, path.resolve(dir, manifest.main ?? 'SKILL.md'))
        const raw = readBytes(file)
        if (!raw) continue
        const content = raw.toString('utf8'), meta = frontmatter(content)
        const name = String(manifest.name ?? meta.name ?? entry.name)
        const key = layer.scope + ':' + name.toLowerCase()
        if (seen.has(key) || layer.scope === 'project' && layer.configPath !== path.join(layer.root, 'skills.config.json') && deleted.has(name.toLowerCase())) continue
        seen.add(key)
        const enabled = config.defaults?.[entry.name]?.enabled ?? ownConfig.defaults?.[entry.name]?.enabled ?? manifest.enabled ?? true
        result.push({ id: skillManagementId(file), name, description: String(manifest.description ?? meta.description ?? `Skill: ${name}`),
          enabled: enabled !== false, scope: layer.scope, dir, content, hash: hashFileContent(raw), files: [],
          layer, file, manifestPath: plugin, revision: revision(file, dir, layer) })
      }
    }
    return result
  }

  list(context: SkillManagementContext, scope?: SkillScope, search?: string): Array<Omit<ManagedSkill, 'content' | 'files'>> {
    return this.scan(context, scope).filter(skill => !search || (skill.name + ' ' + skill.description).toLowerCase().includes(search.toLowerCase()))
      .map(({ id, name, description, enabled, scope, dir, hash }) => ({ id, name, description, enabled, scope, dir, hash }))
  }
  private resolve(context: SkillManagementContext, key: string, scope?: SkillScope): ResolvedSkill {
    const skills = this.scan(context, scope)
    const exact = skills.find(skill => skill.id === key)
    if (exact) return exact
    const matches = skills.filter(skill => skill.name.toLowerCase() === key.toLowerCase() || path.basename(skill.dir).toLowerCase() === key.toLowerCase())
    if (matches.length > 1) throw new SkillManagementError(40900, '同名技能存在于多个作用域，请使用 skill_list 返回的完整 ID')
    if (!matches.length) throw new SkillManagementError(40400, '技能不存在于当前授权目录')
    return matches[0]
  }
  get(context: SkillManagementContext, key: string, scope?: SkillScope): ManagedSkill {
    const skill = this.resolve(context, skillKeySchema.parse(key), scope)
    const { id, name, description, enabled, dir, content, hash } = skill
    return { id, name, description, enabled, scope: skill.scope, dir, content, hash, files: tree(dir, skill.layer.anchor).files }
  }

  prepareCreate(context: SkillManagementContext, raw: unknown): PreparedSkillMutation {
    const input = skillCreateSchema.parse(raw)
    const layer = this.layers(context, input.scope)[0]
    if (!layer) throw new SkillManagementError(40300, '当前作用域不可用')
    const root = layer.scope === 'project' ? path.dirname(layer.configPath) : layer.root
    const dir = safePath(layer.anchor, path.join(root, input.name)), file = path.join(dir, 'SKILL.md')
    if (fs.existsSync(dir)) throw new SkillManagementError(40900, '技能目录已存在；请读取后使用 skill_update')
    const content = `---\nname: ${input.name}\ndescription: ${input.description}\n---\n\n${input.content.trim()}\n`
    return { version: 1, tenantId: context.tenantId, action: 'create', scope: layer.scope, projectRoot: context.projectRoot,
      root, anchor: layer.anchor, configPath: layer.configPath, file, dir, id: skillManagementId(file), name: input.name,
      expectedHash: 'missing', revision: revision(file, dir, layer), content }
  }

  prepareChange(context: SkillManagementContext, action: 'update' | 'set_enabled' | 'delete', raw: unknown): PreparedSkillMutation {
    const common = { id: skillKeySchema, scope: skillScopeSchema.optional() }
    const input: { id: string; scope?: SkillScope; content?: string; expectedHash?: string; enabled?: boolean } = (action === 'update' ? z.object({ ...common, content: skillContentSchema, expectedHash: skillHashSchema }).strict()
      : action === 'set_enabled' ? z.object({ ...common, enabled: z.boolean() }).strict() : z.object(common).strict()).parse(raw)
    const skill = this.resolve(context, input.id, input.scope)
    const content = input.content
    if (input.expectedHash !== undefined && input.expectedHash !== skill.hash) throw new SkillManagementError(40900, '技能版本已变化，请重新读取后编辑')
    if (content !== undefined) {
      const previousName = frontmatter(skill.content).name, nextName = frontmatter(content).name
      if (!nextName || previousName && previousName !== nextName) throw new SkillManagementError(40001, '更新须保留 SKILL.md 的原 name，不支持隐式重命名')
    }
    const snapshot = tree(skill.dir, skill.layer.anchor, action === 'delete')
    return { version: 1, tenantId: context.tenantId, action, scope: skill.scope, projectRoot: context.projectRoot,
      root: skill.layer.root, anchor: skill.layer.anchor, configPath: skill.layer.configPath, file: skill.file, dir: skill.dir,
      id: skill.id, name: skill.name, expectedHash: skill.hash, revision: skill.revision, ...(content !== undefined ? { content } : {}),
      ...('enabled' in input ? { enabled: input.enabled } : {}), ...(action === 'delete' ? { treeHash: snapshot.hash } : {}),
      before: { name: skill.name, description: skill.description, enabled: skill.enabled, hash: skill.hash, files: snapshot.files } }
  }

  async apply(context: SkillManagementContext, operation: PreparedSkillMutation): Promise<{ resourceChange: SkillResourceChange; skill?: ManagedSkill }> {
    throwIfAborted(context.signal)
    assertSkillManagementAccess(context, operation.scope)
    if (operation.version !== 1 || context.tenantId !== operation.tenantId || identity(canonicalFilePathSync(context.projectRoot ?? process.cwd())) !== identity(canonicalFilePathSync(operation.projectRoot ?? process.cwd())))
      throw new SkillManagementError(40300, '待批准技能操作不属于当前租户或工作区')
    const layers = this.layers(context, operation.scope)
    const layer = layers.find(item => identity(item.root) === identity(operation.root))
      ?? layers.find(item => identity(path.dirname(item.configPath)) === identity(operation.root))
    if (!layer || layer.anchor !== operation.anchor || layer.configPath !== operation.configPath || skillManagementId(operation.file) !== operation.id)
      throw new SkillManagementError(40300, '技能授权目录已变化，请重新确认')
    if (identity(path.dirname(operation.dir)) !== identity(operation.root) || operation.action === 'create' && operation.file !== path.join(operation.dir, 'SKILL.md'))
      throw new SkillManagementError(40300, '技能目标不属于冻结的技能目录')
    safePath(layer.anchor, operation.dir); safePath(operation.dir, operation.file)
    return withFileLocks([operation.dir, operation.file, operation.configPath], async () => {
      // The shared file lock may have waited behind another writer after the
      // tool was admitted. A stopped turn must not mutate once that lock opens.
      throwIfAborted(context.signal)
      assertSkillManagementAccess(context, operation.scope)
      safePath(layer.anchor, operation.dir); safePath(operation.dir, operation.file)
      if (revision(operation.file, operation.dir, layer) !== operation.revision) throw new SkillManagementError(40900, '技能或启用配置在等待确认期间已变化')
      if (operation.action === 'create') {
        if (fs.existsSync(operation.dir)) throw new SkillManagementError(40900, '技能目录已存在')
        fs.mkdirSync(operation.dir, { recursive: true })
        try { atomicWrite(operation.file, operation.content!, 'missing', layer.anchor) }
        catch (error) { if (fs.readdirSync(operation.dir).length === 0) fs.rmdirSync(operation.dir); throw error }
      } else {
        const current = this.resolve(context, operation.id, operation.scope)
        if (current.file !== operation.file || current.hash !== operation.expectedHash) throw new SkillManagementError(40900, '技能目标已变化')
        if (operation.action === 'update') atomicWrite(operation.file, operation.content!, operation.expectedHash, layer.anchor)
        else if (operation.action === 'set_enabled') {
          const old = readBytes(operation.configPath), config = jsonObject(operation.configPath)
          if (config.defaults !== undefined && (!config.defaults || typeof config.defaults !== 'object' || Array.isArray(config.defaults))) throw new SkillManagementError(40001, '技能启用配置无效')
          const dirName = path.basename(operation.dir)
          config.defaults = { ...config.defaults, [dirName]: { ...config.defaults?.[dirName], enabled: operation.enabled } }
          atomicWrite(operation.configPath, JSON.stringify(config, null, 2) + '\n', hashFileContent(old), layer.anchor)
        } else {
          if (tree(operation.dir, layer.anchor, true).hash !== operation.treeHash) throw new SkillManagementError(40900, '技能附件在等待确认期间已变化')
          const remove = () => { safePath(layer.anchor, operation.dir); fs.rmSync(operation.dir, { recursive: true, force: false }) }
          if (operation.scope === 'project' && layer.projectRoot && projectSkillRoots(layer.projectRoot).includes(layer.root))
            withProjectSkillDeletion(layer.projectRoot, operation.name, remove)
          else remove()
        }
      }
      skillsRegistry.reload()
      const resourceChange: SkillResourceChange = { kind: 'skill', action: operation.action, id: operation.id }
      return { resourceChange, ...(operation.action === 'delete' ? {} : { skill: this.get(context, operation.id, operation.scope) }) }
    })
  }
}
