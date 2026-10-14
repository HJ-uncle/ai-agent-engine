/**
 * Grep 工具 — 文本内容搜索
 * 优先使用 ripgrep (rg)，降级为 Node.js 内置实现
 */
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { createInterface } from 'node:readline'
import fs from 'node:fs'
import path from 'node:path'
import type { Tool, AgentContext, ToolResult } from '../../core/agent-context/index.js'
import { workspaceManager } from '../../workspace/index.js'

const execFileAsync = promisify(execFile)

async function hasRipgrep(): Promise<boolean> {
  try {
    await execFileAsync('rg', ['--version'], { timeout: 3000 })
    return true
  } catch {
    return false
  }
}

function grepWithRipgrep(args: string[], maxResults: number, signal?: AbortSignal, timeoutMs?: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new Error('Search cancelled')); return }
    const child = spawn('rg', args, { windowsHide: true })
    const reader = createInterface({ input: child.stdout, crlfDelay: Infinity })
    const lines: string[] = []
    let stderr = ''
    let commandError: Error | undefined
    let cancelled = false
    let timedOut = false
    let limited = false
    const abort = () => { cancelled = true; child.kill() }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    const timer = timeoutMs !== undefined && timeoutMs > 0 ? setTimeout(() => { timedOut = true; child.kill() }, timeoutMs) : undefined
    timer?.unref?.()
    child.once('error', (error) => { commandError = error })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(0, 64_000) })
    reader.on('line', (line) => {
      if (lines.length >= maxResults) return
      lines.push(line)
      // rg's --max-count is per file; stopping this stream bounds the result set across the whole tree.
      if (lines.length === maxResults) { limited = true; child.kill() }
    })
    child.once('close', (code) => {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      reader.close()
      if (commandError) { reject(commandError); return }
      if (cancelled) { reject(signal?.reason ?? new Error('Search cancelled')); return }
      if (timedOut) { reject(new Error(`ripgrep search timed out after ${timeoutMs} ms`)); return }
      // Exit 1 means no matches; exit 2 remains a command/search error even if it produced partial output.
      if (code === 0 || code === 1 || (limited && code !== 2)) { resolve(lines); return }
      reject(new Error(stderr.trim() || `ripgrep exited with code ${String(code)}`))
    })
  })
}

// Node.js 内置实现（降级方案）
interface FallbackSearchOptions {
  maxLines: number
  filePattern?: string
  root: string
  signal?: AbortSignal
  deadline?: number
  strictRead?: boolean
}

function assertSearchAvailable(signal?: AbortSignal, deadline?: number): void {
  if (signal?.aborted) throw signal.reason ?? new Error('Search cancelled')
  if (deadline !== undefined && Date.now() >= deadline) throw new Error('Search timed out')
}

function globMatches(pattern: string | undefined, relativePath: string): boolean {
  if (!pattern) return true
  const normalized = relativePath.split(path.sep).join('/')
  const target = pattern.includes('/') ? normalized : path.posix.basename(normalized)
  let source = '^'
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]
    if (char === '*') {
      if (pattern[i + 1] === '*') { source += '.*'; i++ }
      else source += '[^/]*'
    } else if (char === '?') source += '[^/]'
    else source += char.replace(/[\\^$+?.()|{}[\]]/g, '\\$&')
  }
  return new RegExp(`${source}$`, 'i').test(target)
}

function grepInFile(filePath: string, regex: RegExp, options: FallbackSearchOptions): string[] {
  let lines: string[]
  try {
    lines = fs.readFileSync(filePath, 'utf-8').split(/\r?\n/)
  } catch (error) {
    if (options.strictRead) throw error
    return []
  }
  const results: string[] = []
  for (let i = 0; i < lines.length && results.length < options.maxLines; i++) {
    if ((i & 0x3ff) === 0) assertSearchAvailable(options.signal, options.deadline)
    if (regex.test(lines[i])) {
      results.push(`${i + 1}:${lines[i]}`)
    }
  }
  return results
}

function grepDir(dir: string, regex: RegExp, options: FallbackSearchOptions): string[] {
  const results: string[] = []
  const walk = (d: string) => {
    assertSearchAvailable(options.signal, options.deadline)
    if (results.length >= options.maxLines) return
    for (const name of fs.readdirSync(d).sort()) {
      assertSearchAvailable(options.signal, options.deadline)
      if (results.length >= options.maxLines) break
      const full = path.join(d, name)
      try {
        // Never follow directory symlinks during a recursive search; a link
        // cycle would otherwise keep a long-running agent walking forever.
        const stat = fs.lstatSync(full)
        if (stat.isDirectory()) {
          walk(full)
        } else if (stat.isFile()) {
          const rel = path.relative(options.root, full)
          if (!globMatches(options.filePattern, rel)) continue
          const matches = grepInFile(full, regex, { ...options, maxLines: options.maxLines - results.length })
          for (const m of matches) {
            results.push(`${rel}:${m}`)
          }
        }
      } catch (error) {
        if (options.signal?.aborted || (options.deadline !== undefined && Date.now() >= options.deadline)) throw error
        /* skip unreadable entries */
      }
    }
  }
  walk(dir)
  return results
}

interface GrepArguments {
  pattern: string
  path?: string
  filePattern?: string
  caseSensitive?: boolean
  maxResults?: number
  offset?: number
  timeoutMs?: number
}

const ARGUMENT_NAMES = ['pattern', 'path', 'filePattern', 'caseSensitive', 'maxResults', 'offset', 'timeoutMs'] as const

function validateArguments(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return '参数必须是对象，并提供字符串 pattern。'
  const args = raw as Record<string, unknown>
  const unknown = Object.keys(args).filter(key => !ARGUMENT_NAMES.includes(key as typeof ARGUMENT_NAMES[number]))
  if (unknown.length) return `不支持参数 ${unknown.join(', ')}。合法参数：${ARGUMENT_NAMES.join(', ')}。分页请使用 offset 与 maxResults。`
  if (typeof args.pattern !== 'string') return 'pattern 必须是字符串。'
  if (['path', 'filePattern'].some(key => args[key] !== undefined && typeof args[key] !== 'string')) return 'path/filePattern 必须是字符串。'
  if (args.caseSensitive !== undefined && typeof args.caseSensitive !== 'boolean') return 'caseSensitive 必须是布尔值。'
  const maxResults = args.maxResults === undefined ? 50 : args.maxResults
  const offset = args.offset === undefined ? 0 : args.offset
  const timeoutMs = args.timeoutMs
  if (typeof maxResults !== 'number' || !Number.isSafeInteger(maxResults) || maxResults < 1
    || typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0
    || (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 0))
    || !Number.isSafeInteger(offset + maxResults + 1)) {
    return 'maxResults 必须是正整数，offset/timeoutMs 必须是非负整数，offset + maxResults + 1 必须是安全整数。'
  }
  return undefined
}

/** Pagination must reach the model in output even when the adapter omits metadata. */
function searchPage(lines: string[], pattern: string, backend: string, offset: number, maxResults: number): ToolResult {
  const page = lines.slice(offset, offset + maxResults)
  const hasMore = lines.length > offset + maxResults
  const nextOffset = hasMore ? offset + maxResults : null
  const progress = `offset=${offset} count=${page.length} maxResults=${maxResults} hasMore=${hasMore} nextOffset=${nextOffset}`
  const heading = page.length
    ? `Found ${page.length} match(es) [${backend}]: ${progress}`
    : offset > 0
      ? `Search page exhausted [${backend}]: ${progress}; no further matches at this offset.`
      : `No matches found for "${pattern}" [${backend}]: ${progress}`
  return {
    success: true,
    output: page.length ? `${heading}\n${page.join('\n')}` : heading,
    metadata: { count: page.length, offset, maxResults, hasMore, nextOffset, backend },
  }
}

export const grepTool: Tool = {
  name: 'grep_search',
  displayName: 'Grep 内容搜索',
  description: '在文件中搜索文本或正则，支持 ripgrep',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      pattern: { type: 'string' },
      path: { type: 'string' },
      filePattern: { type: 'string', description: '文件过滤如 *.ts' },
      caseSensitive: { type: 'boolean' },
      maxResults: { type: 'integer', minimum: 1, description: '本页返回的最大匹配行数，默认50' },
      offset: { type: 'integer', minimum: 0, description: '跳过前 offset 条匹配，用于继续分页' },
      timeoutMs: { type: 'integer', minimum: 0, description: '可选搜索超时毫秒数；省略或 0 表示不设超时' },
    },
    required: ['pattern'],
  },
  async execute(rawArgs: unknown, ctx: AgentContext): Promise<ToolResult> {
    const invalid = validateArguments(rawArgs)
    if (invalid) return { success: false, output: `grep_search: ${invalid}`, metadata: { status: 'failed', error: 'INVALID_ARGUMENTS' } }
    const { pattern, path: searchPath = '.', filePattern, caseSensitive = false, maxResults = 50, offset = 0, timeoutMs } =
      rawArgs as GrepArguments
    let backend: string | undefined
    try {
      assertSearchAvailable(ctx.signal)
      const basePath = workspaceManager.resolveSafePath(ctx, searchPath)
      const rgAvailable = await hasRipgrep()

      if (rgAvailable) {
        // 使用 ripgrep
        const fetchCount = offset + maxResults + 1
        backend = 'ripgrep'
        const args = ['--line-number', '--no-heading', '--color=never', '--sort=path', '--max-count', String(fetchCount)]
        if (!caseSensitive) args.push('--ignore-case')
        if (filePattern) args.push('--glob', filePattern)
        args.push('--', pattern, basePath)

        const lines = await grepWithRipgrep(args, fetchCount, ctx.signal, timeoutMs)
        return searchPage(lines, pattern, backend, offset, maxResults)
      }

      // 降级：Node.js 实现
      backend = 'nodejs fallback'
      const flags = caseSensitive ? '' : 'i'
      let regex: RegExp
      try { regex = new RegExp(pattern, flags) } catch { regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags) }
      const deadline = timeoutMs !== undefined && timeoutMs > 0 ? Date.now() + timeoutMs : undefined
      assertSearchAvailable(ctx.signal, deadline)
      const options = { maxLines: offset + maxResults + 1, filePattern, root: basePath, signal: ctx.signal, deadline }
      const stat = fs.statSync(basePath)
      const results = stat.isDirectory() ? grepDir(basePath, regex, options)
        : stat.isFile() ? grepInFile(basePath, regex, { ...options, strictRead: true })
        : (() => { throw new Error('grep_search: path must be a file or directory') })()
      return searchPage(results, pattern, backend, offset, maxResults)
    } catch (err) {
      return { success: false, output: err instanceof Error ? err.message : 'Unknown error', metadata: { status: 'failed', error: 'SEARCH_FAILED', offset, maxResults, backend } }
    }
  },
}
