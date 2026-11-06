import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

export interface WorkspaceSearchInput {
  query: string
  options: { caseSensitive: boolean; wholeWord: boolean; useRegex: boolean; include: string; exclude: string }
  excludes: Record<string, boolean>
  useIgnoreFiles: boolean
}
export interface WorkspaceSearchHit { path: string; line: number; text: string; column: number; length: number }
export interface WorkspaceSearchResult { hits: WorkspaceSearchHit[]; truncated: boolean; strategy: 'git' | 'scan'; error?: string }
export interface SearchContext {
  signal?: AbortSignal
  onProgress?: (result: WorkspaceSearchResult) => void
  maxHits?: number
  timeoutMs?: number
}
const git = promisify(execFile)
const MAX_BYTES = 1024 * 1024
const BINARY_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.avif', '.apng',
  '.mp4', '.m4v', '.webm', '.mov', '.ogg', '.mp3', '.wav', '.pdf', '.zip', '.tar', '.gz', '.rar', '.7z',
  '.xlsx', '.xls', '.doc', '.docx', '.ppt', '.pptx', '.woff', '.woff2', '.ttf', '.otf', '.wasm', '.exe', '.dll', '.pdb', '.db', '.sqlite', '.db3', '.bin'])
const BATCH = 8
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const slash = (value: string): string => value.replace(/\\/g, '/')
const samePath = (a: string, b: string): boolean => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
const inside = (root: string, target: string): boolean => {
  const rel = path.relative(root, target)
  return !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`)
}

/** Search and replacement in the desktop use line-based JavaScript regexes. */
export function workspaceSearchMatcher(input: WorkspaceSearchInput): RegExp {
  const source = input.options.useRegex ? input.query : escape(input.query)
  return new RegExp(input.options.wholeWord ? `\\b(?:${source})\\b` : source, input.options.caseSensitive ? '' : 'i')
}

function glob(pattern: string, anchored = false): RegExp {
  let result = ''
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        result += pattern[index + 2] === '/' ? '(?:.*/)?' : '.*'
        index += pattern[index + 2] === '/' ? 2 : 1
      } else result += '[^/]*'
    } else if (char === '?') result += '[^/]'
    else if (char === '[') {
      const end = pattern.indexOf(']', index + 1)
      if (end > index + 1) {
        const body = pattern.slice(index + 1, end)
        result += `[${body.startsWith('!') ? '^' + body.slice(1) : body}]`
        index = end
      } else result += '\\['
    } else if (char === '\\' && index + 1 < pattern.length) result += escape(pattern[++index])
    else result += escape(char)
  }
  return new RegExp(`${anchored || pattern.includes('/') ? '^' : '^(?:.*/)?'}${result}$`)
}
const patterns = (value: string): string[] => value.split(',').map(item => slash(item.trim()).replace(/^\/+|\/+$/g, '')).filter(Boolean)
function ancestors(relative: string): string[] {
  const parts = relative.split('/')
  return parts.map((_, index) => parts.slice(0, index + 1).join('/'))
}
interface IgnoreRule { base: string; regex: RegExp; negate: boolean; directory: boolean }
function ignored(relative: string, directory: boolean, rules: IgnoreRule[]): boolean {
  let value = false
  for (const rule of rules) {
    if (rule.base && !relative.startsWith(rule.base + '/')) continue
    const local = rule.base ? relative.slice(rule.base.length + 1) : relative
    const names = ancestors(local)
    if (names.some((name, index) => (!rule.directory || directory || index < names.length - 1) && rule.regex.test(name))) value = !rule.negate
  }
  return value
}

/** Reject every link component, even an in-root alias. Git's file list is only
 * an enumeration hint; it is never authority to read outside the bound root. */
async function safePath(root: string, relative: string): Promise<string> {
  if (!relative || path.isAbsolute(relative) || /[\0]/.test(relative) || relative.split('/').some(part => !part || part === '.' || part === '..' || part.includes(':'))) throw new Error('搜索路径无效')
  if (!samePath(await fs.realpath(root), root)) throw new Error('工作区目录目标已变化')
  let full = root
  for (const part of relative.split('/')) {
    full = path.join(full, part)
    if ((await fs.lstat(full)).isSymbolicLink()) throw new Error('跳过符号链接')
  }
  const actual = await fs.realpath(full)
  if (!inside(root, actual) || !samePath(actual, full)) throw new Error('文件已离开工作区')
  return full
}

async function readText(root: string, relative: string, signal?: AbortSignal): Promise<string | null> {
  const full = await safePath(root, relative)
  const handle = await fs.open(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile()) return null
    if (BINARY_EXTENSIONS.has(path.extname(relative).toLowerCase())) return null
    const sample = Buffer.alloc(Math.min(metadata.size, 8192))
    const sampled = await handle.read(sample, 0, sample.length, 0)
    const prefix = sample.subarray(0, sampled.bytesRead)
    if (prefix.includes(0)) return null
    try { new TextDecoder('utf-8', { fatal: true }).decode(prefix, { stream: true }) } catch { return null }
    // Large binary assets are intentionally unsearchable, not an incomplete
    // text scan. Only classify the size limit after inspecting the byte prefix.
    if (metadata.size > MAX_BYTES) throw new Error('文件超过 1 MiB，已跳过')
    signal?.throwIfAborted()
    // A bounded handle read prevents a growing file from exhausting worker memory.
    const buffer = Buffer.alloc(metadata.size + 1)
    let offset = 0
    while (offset < buffer.length) {
      signal?.throwIfAborted()
      const result = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (!result.bytesRead) break
      offset += result.bytesRead
    }
    const latestPath = await safePath(root, relative), latest = await fs.lstat(latestPath)
    const after = await handle.stat()
    if (offset !== metadata.size || latest.dev !== metadata.dev || latest.ino !== metadata.ino ||
      after.size !== metadata.size || after.mtimeMs !== metadata.mtimeMs || after.ctimeMs !== metadata.ctimeMs) throw new Error('文件在搜索期间发生变化')
    const bytes = buffer.subarray(0, offset)
    if (bytes.includes(0)) return null
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { return null }
  } finally { await handle.close() }
}

export async function searchWorkspace(directory: string, input: WorkspaceSearchInput, context: SearchContext = {}): Promise<WorkspaceSearchResult> {
  context.signal?.throwIfAborted()
  const root = await fs.realpath(directory)
  const result: WorkspaceSearchResult = { hits: [], truncated: false, strategy: 'scan' }
  if (!input.query.trim()) return result
  let matcher: RegExp
  try { matcher = workspaceSearchMatcher(input) } catch { return { ...result, error: '正则表达式无效' } }
  const includes = patterns(input.options.include).map(value => glob(value))
  // Only literal directory prefixes can safely prune an include glob. A
  // filename-only glob such as *.ts must still visit every unexcluded directory.
  const prefixes = patterns(input.options.include).map(value => {
    if (!value.includes('/')) return ''
    const parts = value.split('/'), firstGlob = parts.findIndex(part => /[*?[]/.test(part))
    return parts.slice(0, firstGlob < 0 ? -1 : firstGlob).join('/')
  })
  const includedDirectory = (relative: string): boolean => !prefixes.length || prefixes.some(prefix => !prefix ||
    relative === prefix || relative.startsWith(prefix + '/') || prefix.startsWith(relative + '/'))
  const excluded = [...patterns(input.options.exclude), ...Object.entries(input.excludes).filter(([, enabled]) => enabled).map(([name]) => slash(name))].map(value => glob(value.replace(/^\/+|\/+$/g, '')))
  const excludedPath = (relative: string): boolean => relative.split('/').includes('.git') || ancestors(relative).some(name => excluded.some(regex => regex.test(name)))
  const selected = (relative: string): boolean => !excludedPath(relative) && (!includes.length || ancestors(relative).some(name => includes.some(regex => regex.test(name))))
  const deadline = Date.now() + (context.timeoutMs ?? 30_000), maxHits = context.maxHits ?? 500
  let issues = 0, lastProgress = 0
  const publish = (): void => {
    if (!lastProgress || Date.now() - lastProgress >= 50) { lastProgress = Date.now(); context.onProgress?.({ ...result, hits: [...result.hits] }) }
  }
  const stopped = (): boolean => {
    context.signal?.throwIfAborted()
    if (Date.now() > deadline) { result.truncated = true; result.error = '搜索达到时间上限，已保留当前结果；可缩小范围后继续搜索'; return true }
    return result.hits.length >= maxHits
  }
  const searchFiles = async (files: string[]): Promise<void> => {
    for (let offset = 0; offset < files.length; offset += BATCH) {
      if (stopped()) return
      const batch = await Promise.all(files.slice(offset, offset + BATCH).filter(selected).map(async relative => {
        try { return { relative, content: await readText(root, relative, context.signal) } }
        catch (error) { context.signal?.throwIfAborted(); if ((error as NodeJS.ErrnoException).code !== 'ENOENT') issues++; return { relative, content: null } }
      }))
      for (const file of batch) {
        if (file.content === null) continue
        const lines = file.content.split(/\r\n|\r|\n/)
        for (let line = 0; line < lines.length; line++) {
          if (stopped()) return
          const found = matcher.exec(lines[line])
          if (!found) continue
          const radius = Math.floor(Math.max(0, 240 - found[0].length) / 2)
          const start = Math.max(0, Math.min(found.index - radius, lines[line].length - 240))
          result.hits.push({ path: file.relative, line: line + 1, text: lines[line].slice(start, start + 240), column: found.index + 1, length: found[0].length })
          if (result.hits.length >= maxHits) { result.truncated = true; publish(); return }
          publish()
        }
      }
      publish()
    }
  }
  let gitFiles: string[] | undefined
  try {
    const options = { cwd: root, timeout: Math.min(5000, context.timeoutMs ?? 30_000), maxBuffer: 32 * 1024 * 1024, windowsHide: true, signal: context.signal }
    const probe = await git('git', ['rev-parse', '--is-inside-work-tree'], options)
    if (probe.stdout.trim() === 'true') {
      const listed = await git('git', ['ls-files', '-z', '--cached', '--others', ...(input.useIgnoreFiles ? ['--exclude-standard'] : []), '--', '.'], options)
      gitFiles = [...new Set(listed.stdout.split('\0').filter(Boolean).map(slash))]
      result.strategy = 'git'
    }
  } catch { context.signal?.throwIfAborted() }
  if (gitFiles) await searchFiles(gitFiles)
  else {
    const pending: Array<{ relative: string; rules: IgnoreRule[] }> = [{ relative: '', rules: [] }]
    for (let head = 0; head < pending.length && !stopped();) {
      const jobs = pending.slice(head, head + BATCH); head += jobs.length
      const directories = await Promise.all(jobs.map(async job => {
        try {
          const full = job.relative ? await safePath(root, job.relative) : root
          let rules = job.rules
          if (input.useIgnoreFiles) for (const name of ['.gitignore', '.ignore']) {
            try {
              const relative = job.relative ? `${job.relative}/${name}` : name
              const text = await readText(root, relative, context.signal)
              if (text === null) continue
              rules = [...rules]
              for (let pattern of text.split(/\r?\n/)) {
                pattern = pattern.replace(/(?<!\\)\s+$/, '')
                if (!pattern || pattern.startsWith('#')) continue
                const negate = pattern.startsWith('!'); if (negate) pattern = pattern.slice(1)
                const directory = pattern.endsWith('/'); if (directory) pattern = pattern.slice(0, -1)
                const anchored = pattern.startsWith('/'); if (anchored) pattern = pattern.slice(1)
                if (pattern) rules.push({ base: job.relative, regex: glob(pattern, anchored), negate, directory })
              }
            } catch (error) { context.signal?.throwIfAborted(); if ((error as NodeJS.ErrnoException).code !== 'ENOENT') issues++ }
          }
          const files: string[] = [], children: typeof pending = []
          const handle = await fs.opendir(full)
          for await (const entry of handle) {
            if (stopped()) break
            const relative = job.relative ? `${job.relative}/${entry.name}` : entry.name
            if (entry.isSymbolicLink() || excludedPath(relative) || input.useIgnoreFiles && ignored(relative, entry.isDirectory(), rules)) continue
            if (entry.isDirectory() && includedDirectory(relative)) children.push({ relative, rules })
            else if (entry.isFile()) files.push(relative)
          }
          return { files, children }
        } catch { context.signal?.throwIfAborted(); issues++; return { files: [], children: [] } }
      }))
      for (const dir of directories) pending.push(...dir.children)
      await searchFiles(directories.flatMap(dir => dir.files))
    }
  }
  context.signal?.throwIfAborted()
  if (issues) { result.truncated = true; result.error ??= `有 ${issues} 个文件或目录无法完整搜索，已保留可用结果` }
  context.onProgress?.({ ...result, hits: [...result.hits] })
  return result
}
