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

function grepWithRipgrep(args: string[], maxResults: number, signal?: AbortSignal, timeoutMs = 120_000): Promise<string[]> {
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
    const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; child.kill() }, timeoutMs) : undefined
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
    lines = fs.readFileSync(filePath, 'utf-8').split('\n')
  } catch {
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
    for (const name of fs.readdirSync(d)) {
      assertSearchAvailable(options.signal, options.deadline)
      if (results.length >= options.maxLines) break
      const full = path.join(d, name)
      try {
        // Never follow directory symlinks during a recursive search; a link
        // cycle would otherwise keep a long-running agent walking forever.
        const stat = fs.lstatSync(full)
        if (stat.isDirectory()) {
          walk(full)
        } else {
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

export const grepTool: Tool = {
  name: 'grep_search',
  displayName: 'Grep 内容搜索',
  description: '在文件中搜索文本或正则，支持 ripgrep',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string' },
      path: { type: 'string' },
      filePattern: { type: 'string', description: '文件过滤如 *.ts' },
      caseSensitive: { type: 'boolean' },
      maxResults: { type: 'integer', minimum: 1, description: '本页返回的最大匹配行数，默认50' },
      offset: { type: 'integer', minimum: 0, description: '跳过前 offset 条匹配，用于继续分页' },
      timeoutMs: { type: 'integer', minimum: 0, description: '搜索超时毫秒数；0 表示不设超时，默认 120000' },
    },
    required: ['pattern'],
  },
  async execute(rawArgs: unknown, ctx: AgentContext): Promise<ToolResult> {
    const { pattern, path: searchPath = '.', filePattern, caseSensitive = false, maxResults = 50, offset = 0, timeoutMs = 120_000 } =
      rawArgs as { pattern: string; path?: string; filePattern?: string; caseSensitive?: boolean; maxResults?: number; offset?: number; timeoutMs?: number }
    if (!Number.isSafeInteger(maxResults) || maxResults < 1 || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || !Number.isSafeInteger(offset + maxResults)) {
      return { success: false, output: 'grep_search: maxResults 必须是正整数，offset/timeoutMs 必须是非负整数。' }
    }
    try {
      const basePath = workspaceManager.resolveSafePath(ctx, searchPath)
      const rgAvailable = await hasRipgrep()

      if (rgAvailable) {
        // 使用 ripgrep
        const fetchCount = offset + maxResults + 1
        const args = ['--line-number', '--no-heading', '--color=never', '--max-count', String(fetchCount)]
        if (!caseSensitive) args.push('--ignore-case')
        if (filePattern) args.push('--glob', filePattern)
        args.push('--', pattern, basePath)

        const lines = await grepWithRipgrep(args, fetchCount, ctx.signal, timeoutMs)
        const page = lines.slice(offset, offset + maxResults)
        const hasMore = lines.length > offset + maxResults
        return {
          success: true,
          output: page.length
            ? `Found ${page.length} match(es) [ripgrep]:\n${page.join('\n')}`
            : `No matches found for "${pattern}"`,
          ...(page.length ? { metadata: { count: page.length, offset, maxResults, hasMore, nextOffset: hasMore ? offset + maxResults : undefined } } : {}),
        }
      }

      // 降级：Node.js 实现
      const flags = caseSensitive ? '' : 'i'
      let regex: RegExp
      try { regex = new RegExp(pattern, flags) } catch { regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags) }
      const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : undefined
      const results = grepDir(basePath, regex, { maxLines: offset + maxResults + 1, filePattern, root: basePath, signal: ctx.signal, deadline })
      const page = results.slice(offset, offset + maxResults)
      const hasMore = results.length > offset + maxResults
      return {
        success: true,
        output: page.length
          ? `Found ${page.length} match(es) [nodejs fallback]:\n${page.join('\n')}`
          : `No matches found for "${pattern}"`,
        ...(page.length ? { metadata: { count: page.length, offset, maxResults, hasMore, nextOffset: hasMore ? offset + maxResults : undefined } } : {}),
      }
    } catch (err) {
      return { success: false, output: err instanceof Error ? err.message : 'Unknown error' }
    }
  },
}
