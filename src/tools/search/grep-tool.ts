/**
 * Grep 工具 — 文本内容搜索
 * 优先使用 ripgrep (rg)，降级为 Node.js 内置实现
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
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
  description: '在工作区文件中搜索包含指定文本或正则表达式的行。优先使用 ripgrep (rg) 以获得更快的速度。',
  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: '要搜索的文本或正则表达式',
      },
      path: {
        type: 'string',
        description: '搜索目录或文件（相对工作区根目录，默认为根目录）',
        default: '.',
      },
      filePattern: {
        type: 'string',
        description: '文件名过滤模式，如 "*.ts"（仅 ripgrep 模式支持）',
      },
      caseSensitive: {
        type: 'boolean',
        description: '是否区分大小写，默认 false',
        default: false,
      },
      maxResults: {
        type: 'number',
        description: '最多返回结果数量，默认 50',
        default: 50,
      },
    },
    required: ['pattern'],
  },
  async execute(rawArgs: unknown, ctx: AgentContext): Promise<ToolResult> {
    const { pattern, path: searchPath = '.', filePattern, caseSensitive = false, maxResults = 50 } =
      rawArgs as { pattern: string; path?: string; filePattern?: string; caseSensitive?: boolean; maxResults?: number }
    try {
      const basePath = workspaceManager.resolveSafePath(ctx, searchPath)
      const rgAvailable = await hasRipgrep()

      if (rgAvailable) {
        // 使用 ripgrep
        const args = ['--line-number', '--no-heading', '--color=never', '--max-count=1000']
        if (!caseSensitive) args.push('--ignore-case')
        if (filePattern) args.push('--glob', filePattern)
        args.push('--max-results', String(maxResults))
        args.push(pattern, basePath)

        const { stdout } = await execFileAsync('rg', args, { timeout: 15000, maxBuffer: 1024 * 1024 })
        const lines = stdout.trim().split('\n').filter(Boolean).slice(0, maxResults)
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
    } catch (err: any) {
      if (err.code === 1) return { success: true, output: `No matches found for "${pattern}"` }
      return { success: false, output: err instanceof Error ? err.message : 'Unknown error' }
    }
  },
}
