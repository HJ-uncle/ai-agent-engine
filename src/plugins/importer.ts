import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { readPluginZip } from './zip.js'
export { readPluginZip } from './zip.js'
import { stopCommandProcessTree } from '../core/command-jobs/process-tree.js'
import { validatePluginInput, type PluginService } from './service.js'
import { PluginError, type PluginManifest, type PluginRecord } from './types.js'

export type PluginImportFormat = 'native' | 'remark'
type ImportOptions = { format?: PluginImportFormat; id?: string; name?: string; subdirectory?: string }
export type PluginImportInput = ImportOptions & (
  | { type: 'local'; path: string }
  | { type: 'zip'; path?: string; base64?: string }
  | { type: 'github'; repository: string; ref?: string }
)
export interface PluginImportFile { path: string; bytes: number; sha256: string }
export interface PluginImportJob {
  jobId: string
  status: 'preparing' | 'prepared' | 'installing' | 'installed' | 'failed' | 'cancelled'
  manifest?: PluginManifest
  source: Record<string, unknown>
  files: PluginImportFile[]
  requirements?: { type: 'npm'; packages: Record<string, string>; scripts: 'disabled' }[]
  pluginId?: string
  failureStage?: 'prepare' | 'install'
  error?: string
  createdAt: number
  updatedAt: number
}

const MAX_ARCHIVE = 32 * 1024 * 1024
const MAX_EXPANDED = 64 * 1024 * 1024
const MAX_SOURCE = 8 * 1024 * 1024
const MAX_FILE = 1024 * 1024
const MAX_FILES = 100
const activeImports = new Map<string, AbortController>()
const committingImports = new Set<string>()
const UTF8 = new TextDecoder('utf-8', { fatal: true })
const digest = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')
const fail = (message: string): never => { throw new PluginError('invalid-import', message) }
function checkAbort(signal?: AbortSignal): void { if (signal?.aborted) throw new PluginError('import-cancelled', 'Plugin import was cancelled', 409) }
function safeName(value: string): string {
  if (typeof value !== 'string' || !value || value.length > 512 || /[\\\u0000-\u001f:]/.test(value) || value.startsWith('/') || value.endsWith('/')) return fail('Invalid plugin file path')
  const parts = value.split('/')
  if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) return fail('Invalid plugin file path')
  return value
}
function excluded(value: string): boolean { return value.split('/').some(part => ['.git', 'node_modules', '.npmrc', '.pnpmfile.cjs'].includes(part.toLowerCase())) }
function subdirectory(value?: string): string { if (value !== undefined && typeof value !== 'string') return fail('Invalid plugin subdirectory'); return value ? safeName(value.replace(/\/$/, '')) + '/' : '' }
function contained(root: string, target: string): boolean { const relative = path.relative(root, target); return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative) }
async function rejectLinks(filename: string): Promise<void> {
  const absolute = path.resolve(filename), root = path.parse(absolute).root
  let current = root
  for (const part of path.relative(root, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    try { if ((await fs.lstat(current)).isSymbolicLink()) return fail('Plugin import paths cannot contain links') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
}
function jsonObject(value: string, label: string): Record<string, any> {
  try { const result = JSON.parse(value); if (!result || typeof result !== 'object' || Array.isArray(result)) return fail(`${label} must be an object`); return result }
  catch { return fail(`${label} is invalid JSON`) }
}

async function boundedFile(filename: string, max = MAX_FILE): Promise<Buffer> {
  await rejectLinks(filename)
  const handle = await fs.open(filename, 'r')
  try { const stat = await handle.stat(); if (!stat.isFile() || stat.size > max) return fail('Plugin file exceeds size limit'); const result = await handle.readFile(); if (result.length > max) return fail('Plugin file exceeds size limit'); return result }
  finally { await handle.close() }
}

async function readDirectory(root: string, signal?: AbortSignal): Promise<Record<string, Uint8Array>> {
  if (typeof root !== 'string' || !path.isAbsolute(root)) return fail('Local plugin directory must be absolute')
  const result: Record<string, Uint8Array> = Object.create(null)
  let total = 0, count = 0
  const visit = async (directory: string, prefix: string): Promise<void> => {
    checkAbort(signal)
    const stat = await fs.lstat(directory)
    if (stat.isSymbolicLink() || !stat.isDirectory()) return fail('Plugin directories cannot be links')
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (++count > 4096) return fail('Plugin source contains too many entries')
      const name = safeName(prefix + entry.name)
      if (excluded(name)) continue
      const filename = path.join(directory, entry.name), entryStat = await fs.lstat(filename)
      if (entryStat.isSymbolicLink()) return fail('Plugin files cannot be links')
      if (entryStat.isDirectory()) await visit(filename, name + '/')
      else {
        if (!entryStat.isFile()) return fail('Plugin source contains unsupported files')
        const bytes = await boundedFile(filename, MAX_SOURCE)
        total += bytes.length
        if (total > MAX_EXPANDED) return fail('Plugin source exceeds 64 MiB')
        result[name] = bytes
      }
    }
  }
  await visit(root, ''); return result
}

async function fetchBounded(url: string, signal: AbortSignal, max = MAX_ARCHIVE): Promise<Buffer> {
  const response = await fetch(url, { signal, redirect: 'error', headers: { 'user-agent': 'Aether-Plugin-Importer', accept: 'application/vnd.github+json' } })
  if (!response.ok) throw new PluginError('import-download-failed', `Plugin download failed (${response.status})`, 502)
  if (Number(response.headers.get('content-length')) > max) return fail('Plugin download exceeds size limit')
  const reader = response.body?.getReader()
  if (!reader) return fail('Plugin download has no body')
  const chunks: Buffer[] = []; let size = 0
  try {
    for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > max) { await reader.cancel(); return fail('Plugin download exceeds size limit') }; chunks.push(Buffer.from(next.value)) }
  } finally { reader.releaseLock() }
  return Buffer.concat(chunks)
}

function githubRepository(value: string): string {
  if (typeof value !== 'string') return fail('GitHub repository must be a string')
  const cleaned = value.replace(/^https:\/\/github\.com\//i, '').replace(/\.git$/, '').replace(/\/$/, '')
  if (!/^[a-z\d][a-z\d_.-]*\/[a-z\d][a-z\d_.-]*$/i.test(cleaned)) return fail('GitHub source must be owner/repository or an HTTPS GitHub repository URL')
  return cleaned
}
function selectFiles(all: Record<string, Uint8Array>, prefix: string): Record<string, Uint8Array> {
  const result: Record<string, Uint8Array> = Object.create(null)
  for (const [name, value] of Object.entries(all)) if (name.startsWith(prefix) && name.length > prefix.length && !excluded(name)) result[safeName(name.slice(prefix.length))] = value
  return result
}
function decodeSources(all: Record<string, Uint8Array>): Record<string, string> {
  const files: Record<string, string> = Object.create(null)
  for (const [name, bytes] of Object.entries(all)) {
    safeName(name)
    if (bytes.length > MAX_FILE) return fail('Plugin file exceeds 1 MiB')
    try { files[name] = UTF8.decode(bytes) } catch { return fail('Plugin sources must be UTF-8 text') }
  }
  if (Object.keys(files).length > MAX_FILES || Object.values(files).reduce((sum, value) => sum + Buffer.byteLength(value), 0) > MAX_SOURCE) return fail('Plugin sources exceed 100 files or 8 MiB')
  return files
}

function prepareRemark(all: Record<string, Uint8Array>, input: ImportOptions): { manifest: PluginManifest; files: Record<string, string>; packages: Record<string, string> } {
  if (!all['package.json'] || !all['index.js']) return fail('Remark adapter requires package.json and an ESM index.js')
  const pkg = jsonObject(UTF8.decode(all['package.json']), 'package.json')
  if (pkg.type !== 'module' || typeof pkg.name !== 'string' || !/^remark-[a-z\d-]+$/.test(pkg.name) || !Array.isArray(pkg.keywords) || !pkg.keywords.includes('remark-plugin')) return fail('Source is not a supported ESM remark plugin')
  const id = input.id ?? pkg.name
  if (!/^[a-z][a-z\d-]{0,63}$/.test(id)) return fail('Invalid imported plugin id')
  const packages: Record<string, string> = {}
  if (Object.keys(pkg.dependencies ?? {}).length > 64) return fail('Remark plugin declares too many direct dependencies')
  for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
    // Registry-only dependency specifications. Local/git specs can smuggle preparation scripts or escape the source directory.
    if (name.length > 214 || !/^(?:@[a-z\d_.-]+\/)?[a-z\d_.-]+$/.test(name) || typeof version !== 'string' || version.length > 128 || !/^[~^<>=*\d\s.|+xX-]+$/.test(version)) return fail('Remark adapter supports registry semver dependencies only')
    packages[name] = version
  }
  Object.assign(packages, { unified: '11.0.5', 'remark-parse': '11.0.0', 'remark-stringify': '11.0.0' })
  const vendor: Record<string, Uint8Array> = Object.create(null)
  for (const [name, bytes] of Object.entries(all)) {
    if (name === 'index.js' || (name.startsWith('lib/') && /\.(?:js|json)$/.test(name))) vendor['vendor/' + name] = bytes
    else if (/^(?:license|licence)(?:\..*)?$/i.test(name)) vendor['vendor/LICENSE.txt'] = bytes
  }
  const files = decodeSources(vendor)
  files['package.json'] = JSON.stringify({ name: `aether-adapter-${id}`, version: '1.0.0', private: true, type: 'module', dependencies: packages }, null, 2) + '\n'
  files['runner.mjs'] = `import { unified } from 'unified'\nimport remarkParse from 'remark-parse'\nimport remarkStringify from 'remark-stringify'\nimport plugin from './vendor/index.js'\nlet raw = ''\nfor await (const chunk of process.stdin) raw += chunk\nconst {args: input} = JSON.parse(raw)\nif (!input || typeof input.markdown !== 'string' || input.markdown.length > 1000000) throw new Error('markdown must be a string of at most 1000000 characters')\nconst processor = unified().use(remarkParse).use(plugin, input.options).use(remarkStringify)\nconst tree = await processor.run(processor.parse(input.markdown))\nprocess.stdout.write(JSON.stringify({result: {markdown: processor.stringify(tree), tree}}) + '\\n')\n`
  return { manifest: { apiVersion: 1, id, name: input.name ?? pkg.name, version: typeof pkg.version === 'string' ? pkg.version : '1.0.0', description: `Markdown processing using the imported ${pkg.name} remark plugin`, runtime: 'node', tools: [{ name: 'process_markdown', description: `Process Markdown with ${pkg.name}; returns serialized Markdown and the syntax tree`, inputSchema: { type: 'object', properties: { markdown: { type: 'string', maxLength: 1000000 }, options: { type: 'object' } }, required: ['markdown'], additionalProperties: false }, entry: 'runner.mjs' }] }, files, packages }
}

export class PluginImporter {
  readonly rootDir: string
  private readonly active = activeImports
  private readonly committing = committingImports
  constructor(private readonly service: PluginService) { this.rootDir = path.join(service.rootDir, 'imports') }
  private directory(tenantId: string, jobId: string): string {
    if (typeof tenantId !== 'string' || !tenantId || tenantId.length > 256 || typeof jobId !== 'string' || !/^[\da-f-]{36}$/.test(jobId)) return fail('Invalid plugin import identity')
    return path.join(this.rootDir, digest(tenantId), jobId)
  }
  private async save(directory: string, job: PluginImportJob): Promise<void> {
    job.updatedAt = Date.now()
    await rejectLinks(directory)
    await fs.mkdir(directory, { recursive: true })
    const temporary = path.join(directory, `job-${randomUUID()}.tmp`)
    await fs.writeFile(temporary, JSON.stringify(job), { flag: 'wx' }); await fs.rename(temporary, path.join(directory, 'job.json'))
  }
  private async cleanup(directory: string): Promise<void> { if (!contained(this.rootDir, directory)) return fail('Invalid import cleanup path'); await rejectLinks(directory); await fs.rm(directory, { recursive: true, force: true }) }
  async getImport(tenantId: string, jobId: string): Promise<PluginImportJob> {
    const directory = this.directory(tenantId, jobId)
    let job: PluginImportJob
    try { job = JSON.parse((await boundedFile(path.join(directory, 'job.json'), 2 * MAX_SOURCE)).toString('utf8')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new PluginError('import-not-found', 'Plugin import not found', 404); throw error }
    if ((job.status === 'preparing' || job.status === 'installing') && !this.active.has(directory)) { job.failureStage = job.status === 'installing' ? 'install' : 'prepare'; job.status = 'failed'; job.error = job.failureStage === 'install' ? 'Import installation was interrupted; retry installation' : 'Import preparation was interrupted; prepare a new import'; await this.save(directory, job) }
    return job
  }
  async cancelImport(tenantId: string, jobId: string): Promise<PluginImportJob> {
    const directory = this.directory(tenantId, jobId), job = await this.getImport(tenantId, jobId)
    if (job.status === 'installed') throw new PluginError('import-already-installed', 'Installed plugins must be removed through plugin management', 409)
    if (this.committing.has(directory)) throw new PluginError('import-committing', 'Plugin import is committing; wait for its result', 409)
    this.active.get(directory)?.abort()
    job.status = 'cancelled'; await this.save(directory, job)
    if (!this.active.has(directory)) { await this.cleanup(path.join(directory, 'source')); await this.cleanup(path.join(directory, 'dependencies')) }
    return job
  }
  async previewImport(tenantId: string, input: PluginImportInput, signal?: AbortSignal): Promise<PluginImportJob> {
    if (!input || typeof input !== 'object' || !['local', 'zip', 'github'].includes(input.type) || (input.format !== undefined && !['native', 'remark'].includes(input.format))) return fail('Unsupported plugin import source or format')
    const job: PluginImportJob = { jobId: randomUUID(), status: 'preparing', source: { type: input.type, format: input.format ?? 'native' }, files: [], createdAt: Date.now(), updatedAt: Date.now() }
    const directory = this.directory(tenantId, job.jobId), controller = new AbortController(), onAbort = (): void => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true }); if (signal?.aborted) controller.abort()
    this.active.set(directory, controller); await this.save(directory, job)
    try {
      checkAbort(controller.signal)
      let all: Record<string, Uint8Array>, prefix = ''
      if (input.type === 'local') { all = await readDirectory(input.path, controller.signal); job.source.path = path.resolve(input.path) }
      else if (input.type === 'zip') {
        if (Boolean(input.path) === Boolean(input.base64)) return fail('Provide exactly one ZIP path or base64 payload')
        let bytes: Buffer
        if (input.path) { if (typeof input.path !== 'string' || !path.isAbsolute(input.path) || (await fs.lstat(input.path)).isSymbolicLink()) return fail('ZIP path must be an absolute regular file'); bytes = await boundedFile(input.path, MAX_ARCHIVE); job.source.path = input.path }
        else { if (typeof input.base64 !== 'string' || input.base64.length > Math.ceil(MAX_ARCHIVE / 3) * 4 || input.base64.length % 4 !== 0 || !/^[A-Za-z\d+/]*={0,2}$/.test(input.base64)) return fail('Invalid ZIP base64 payload'); bytes = Buffer.from(input.base64, 'base64') }
        all = readPluginZip(bytes); job.source.archiveSha256 = digest(bytes)
        if (!all['aether-plugin.json'] && !all['package.json']) { const roots = new Set(Object.keys(all).map(name => name.split('/')[0])); if (roots.size === 1 && Object.keys(all).every(name => name.includes('/'))) prefix = [...roots][0] + '/' }
      } else {
        const repository = githubRepository(input.repository)
        if (input.ref !== undefined && (typeof input.ref !== 'string' || !input.ref || input.ref.length > 200 || /[\u0000-\u001f]/.test(input.ref))) return fail('Invalid GitHub ref')
        const deadline = AbortSignal.any([controller.signal, AbortSignal.timeout(60000)])
        // A supplied full SHA is already immutable. Codeload checks its existence without consuming the public API quota.
        const resolvedCommit = input.ref && /^[\da-f]{40}$/i.test(input.ref) ? input.ref.toLowerCase()
          : jsonObject((await fetchBounded(`https://api.github.com/repos/${repository}/commits/${encodeURIComponent(input.ref ?? 'HEAD')}`, deadline, 2 * 1024 * 1024)).toString('utf8'), 'GitHub commit response').sha
        if (typeof resolvedCommit !== 'string' || !/^[\da-f]{40}$/.test(resolvedCommit)) return fail('GitHub did not return an immutable commit')
        const bytes = await fetchBounded(`https://codeload.github.com/${repository}/zip/${resolvedCommit}`, deadline)
        all = readPluginZip(bytes); const first = Object.keys(all)[0]; if (!first?.includes('/')) return fail('Invalid GitHub source archive'); prefix = first.slice(0, first.indexOf('/') + 1)
        job.source = { ...job.source, repository, url: `https://github.com/${repository}`, requestedRef: input.ref ?? 'HEAD', resolvedCommit, archiveSha256: digest(bytes) }
      }
      prefix += subdirectory(input.subdirectory)
      all = selectFiles(all, prefix); if (!Object.keys(all).length) return fail('Plugin import directory is empty')
      if (input.subdirectory) job.source.subdirectory = input.subdirectory
      let files: Record<string, string>, manifest: PluginManifest
      if (input.format === 'remark') { const adapted = prepareRemark(all, input); files = adapted.files; manifest = adapted.manifest; job.source.adapter = 'remark-v1'; job.requirements = [{ type: 'npm', packages: adapted.packages, scripts: 'disabled' }] }
      else {
        if (!all['aether-plugin.json']) return fail('Native plugin source requires aether-plugin.json; select a supported adapter for another plugin format')
        manifest = jsonObject(UTF8.decode(all['aether-plugin.json']), 'aether-plugin.json') as PluginManifest
        delete all['aether-plugin.json']; files = decodeSources(all)
        if (files['package.json']) { const pkg = jsonObject(files['package.json'], 'package.json'); if (Object.keys(pkg.dependencies ?? {}).length || Object.keys(pkg.optionalDependencies ?? {}).length) return fail('Native plugin dependencies are not installed automatically; use self-contained sources') }
      }
      // Share validation with manual CRUD without creating a plugin or executing code.
      job.source.importJobId = job.jobId
      manifest = validatePluginInput({ manifest, files, source: job.source }).manifest
      job.manifest = manifest
      for (const [name, content] of Object.entries(files)) { checkAbort(controller.signal); const destination = path.join(directory, 'source', safeName(name)); await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.writeFile(destination, content, { flag: 'wx' }); job.files.push({ path: name, bytes: Buffer.byteLength(content), sha256: digest(content) }) }
      checkAbort(controller.signal); job.status = 'prepared'; await this.save(directory, job); checkAbort(controller.signal); return job
    } catch (error) {
      job.status = controller.signal.aborted ? 'cancelled' : 'failed'; job.failureStage = 'prepare'; job.error = error instanceof Error ? error.message : String(error); await this.save(directory, job); await this.cleanup(path.join(directory, 'source'))
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { jobId: job.jobId, importStatus: job.status })
    } finally { signal?.removeEventListener('abort', onAbort); this.active.delete(directory) }
  }
  async installImport(tenantId: string, jobId: string, signal?: AbortSignal): Promise<PluginRecord> {
    const directory = this.directory(tenantId, jobId), job = await this.getImport(tenantId, jobId)
    if (job.status === 'installed' && job.pluginId) return this.service.get(tenantId, job.pluginId)
    if ((job.status !== 'prepared' && !(job.status === 'failed' && job.failureStage === 'install')) || !job.manifest || this.active.has(directory)) throw new PluginError('import-not-prepared', 'Plugin import is not prepared or is already being installed', 409)
    const controller = new AbortController(), onAbort = (): void => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true }); if (signal?.aborted) controller.abort()
    this.active.set(directory, controller); job.status = 'installing'; delete job.error; delete job.failureStage; await this.save(directory, job)
    try {
      // A process can die after create commits but before its job receipt is written. Recover that receipt instead of creating another plugin.
      try {
        const existing = await this.service.get(tenantId, job.manifest.id)
        if (existing.source?.importJobId === job.jobId) { job.status = 'installed'; job.pluginId = existing.id; await this.save(directory, job); return existing }
        throw new PluginError('import-id-conflict', 'A different plugin already uses this id; choose another id or edit the existing plugin', 409)
      } catch (error) { if (!(error instanceof PluginError) || error.statusCode !== 404) throw error }
      const files: Record<string, string> = Object.create(null)
      for (const file of job.files) { checkAbort(controller.signal); const filename = path.join(directory, 'source', safeName(file.path)); if ((await fs.lstat(filename)).isSymbolicLink()) return fail('Prepared plugin source was replaced by a link'); const bytes = await boundedFile(filename); if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) return fail('Prepared plugin source changed; prepare again'); files[file.path] = UTF8.decode(bytes) }
      let preparedDependencies: { directory: string } | undefined
      if (job.requirements?.length) {
        if (job.source.format !== 'remark') return fail('Unsupported dependency installation')
        const dependencies = path.join(directory, 'dependencies'); await this.cleanup(dependencies); await fs.mkdir(dependencies, { recursive: true })
        await fs.writeFile(path.join(dependencies, 'package.json'), files['package.json'], { flag: 'wx' })
        await installDependencies(dependencies, controller.signal)
        files['package-lock.json'] = (await boundedFile(path.join(dependencies, 'package-lock.json'), MAX_SOURCE)).toString('utf8')
        preparedDependencies = { directory: dependencies }
      }
      checkAbort(controller.signal)
      this.committing.add(directory)
      const record = await this.service.create(tenantId, { manifest: job.manifest, files, source: job.source }, preparedDependencies)
      job.pluginId = record.id; job.status = 'installed'; await this.save(directory, job)
      await this.cleanup(path.join(directory, 'dependencies')); return record
    } catch (error) { job.status = controller.signal.aborted ? 'cancelled' : 'failed'; job.failureStage = 'install'; job.error = error instanceof Error ? error.message : String(error); await this.save(directory, job); await this.cleanup(path.join(directory, 'dependencies')); throw error }
    finally { signal?.removeEventListener('abort', onAbort); this.active.delete(directory); this.committing.delete(directory) }
  }
}

async function installDependencies(directory: string, signal: AbortSignal): Promise<void> {
  checkAbort(signal)
  await new Promise<void>((resolve, reject) => {
    // npm is a trusted host utility; shell is never used, and plugin lifecycle scripts stay disabled.
    const command = process.platform === 'win32' ? process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe' : 'npm'
    const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'npm install --ignore-scripts --no-audit --no-fund --bin-links=false --package-lock --registry=https://registry.npmjs.org'] : ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--bin-links=false', '--package-lock', '--registry=https://registry.npmjs.org']
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, npm_config_userconfig: path.join(directory, 'empty-npmrc'), npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false', npm_config_registry: 'https://registry.npmjs.org' }
    const child = spawn(command, args, { cwd: directory, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', 'pipe'] })
    const startedAt = Date.now()
    let stderr = '', settled = false, stopping: Promise<void> | undefined, stopError: Error | undefined
    child.stderr.on('data', chunk => { if (stderr.length < 8192) stderr += chunk.toString().slice(0, 8192 - stderr.length) })
    const stop = (): void => {
      if (stopping || settled) return
      stopError = new PluginError(signal.aborted ? 'import-cancelled' : 'dependency-install-timeout', signal.aborted ? 'Plugin dependency installation was cancelled' : 'Plugin dependency installation exceeded 120 seconds', 409)
      stopping = stopCommandProcessTree(child, startedAt).catch(error => { stopError = new PluginError('dependency-cleanup-failed', `Dependency process tree cleanup failed: ${String(error)}`, 500); try { child.kill('SIGKILL') } catch { /* Process may already have exited. */ } })
    }
    const timeout = setTimeout(stop, 120000)
    signal.addEventListener('abort', stop, { once: true })
    const finish = (error?: Error): void => { if (settled) return; settled = true; clearTimeout(timeout); signal.removeEventListener('abort', stop); error ? reject(error) : resolve() }
    child.on('error', error => finish(error))
    child.on('close', code => { void (async () => { await stopping; if (stopError) finish(stopError); else if (signal.aborted) finish(new PluginError('import-cancelled', 'Plugin dependency installation was cancelled', 409)); else if (code !== 0) finish(new PluginError('dependency-install-failed', `Plugin dependency installation failed (${code}): ${stderr}`, 502)); else finish() })() })
  })
}
