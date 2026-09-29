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

function grepWithRipgrep(args: string[], maxResults: number, signal?: AbortSignal): Promise<string[]> {
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
    const timer = setTimeout(() => { timedOut = true; child.kill() }, 15_000)
    timer.unref?.()
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
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      reader.close()
      if (commandError) { reject(commandError); return }
      if (cancelled) { reject(signal?.reason ?? new Error('Search cancelled')); return }
      if (timedOut) { reject(new Error('ripgrep search timed out after 15000 ms')); return }
      // Exit 1 means no matches; exit 2 remains a command/search error even if it produced partial output.
      if (code === 0 || code === 1 || (limited && code !== 2)) { resolve(lines); return }
      reject(new Error(stderr.trim() || `ripgrep exited with code ${String(code)}`))
    })
  })
}

// Node.js 内置实现（降级方案）
function grepInFile(filePath: string, regex: RegExp, maxLines: number): string[] {
  try {
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n')
    const results: string[] = []
    for (let i = 0; i < lines.length && results.length < maxLines; i++) {
      if (regex.test(lines[i])) {
        results.push(`${i + 1}:${lines[i]}`)
      }
    }
    return results
  } catch {
    return []
  }
}

function grepDir(dir: string, regex: RegExp, maxResults: number, fileGlob?: string): string[] {
  const results: string[] = []
  const walk = (d: string) => {
    if (results.length >= maxResults) return
    for (const name of fs.readdirSync(d)) {
      if (results.length >= maxResults) break
      const full = path.join(d, name)
      try {
        const stat = fs.statSync(full)
        if (stat.isDirectory()) {
          walk(full)
        } else {
          const rel = path.relative(dir, full)
          const matches = grepInFile(full, regex, maxResults - results.length)
          for (const m of matches) {
            results.push(`${rel}:${m}`)
          }
        }
      } catch { /* skip */ }
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
      maxResults: { type: 'integer', minimum: 1, description: '整个搜索范围内返回的最大匹配行数，默认50' },
    },
    required: ['pattern'],
  },
  async execute(rawArgs: unknown, ctx: AgentContext): Promise<ToolResult> {
    const { pattern, path: searchPath = '.', filePattern, caseSensitive = false, maxResults = 50 } =
      rawArgs as { pattern: string; path?: string; filePattern?: string; caseSensitive?: boolean; maxResults?: number }
    if (!Number.isSafeInteger(maxResults) || maxResults < 1) {
      return { success: false, output: 'grep_search: maxResults 必须是正整数。' }
    }
    try {
      const basePath = workspaceManager.resolveSafePath(ctx, searchPath)
      const rgAvailable = await hasRipgrep()

      if (rgAvailable) {
        // 使用 ripgrep
        const args = ['--line-number', '--no-heading', '--color=never', '--max-count', String(maxResults)]
        if (!caseSensitive) args.push('--ignore-case')
        if (filePattern) args.push('--glob', filePattern)
        args.push('--', pattern, basePath)

        const lines = await grepWithRipgrep(args, maxResults, ctx.signal)
        return {
          success: true,
          output: lines.length
            ? `Found ${lines.length} match(es) [ripgrep]:\n${lines.join('\n')}`
            : `No matches found for "${pattern}"`,
        }
      }

      // 降级：Node.js 实现
      const flags = caseSensitive ? '' : 'i'
      let regex: RegExp
      try { regex = new RegExp(pattern, flags) } catch { regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags) }
      const results = grepDir(basePath, regex, maxResults)
      return {
        success: true,
        output: results.length
          ? `Found ${results.length} match(es) [nodejs fallback]:\n${results.join('\n')}`
          : `No matches found for "${pattern}"`,
      }
    } catch (err) {
      return { success: false, output: err instanceof Error ? err.message : 'Unknown error' }
    }
  },
}
