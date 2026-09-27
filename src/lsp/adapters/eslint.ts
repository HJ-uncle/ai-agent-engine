import { spawn } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import type { LspAdapter, Diagnostic } from '../types.js'

/**
 * 定位 eslint 的 JS 入口（node 直接跑，绕开 .cmd —— Node 新版禁止
 * shell:false spawn .cmd，报 EINVAL）。优先从被诊断文件所在项目向上找
 * （诊断要用用户项目自己的 eslint 与配置），到根没有则回退引擎侧。
 */
function resolveEslintJs(fromDir: string): { jsPath: string; projectRoot: string } | null {
  let dir = path.dirname(fromDir)
  for (;;) {
    const candidate = path.join(dir, 'node_modules', 'eslint', 'bin', 'eslint.js')
    if (fs.existsSync(candidate)) {
      return { jsPath: candidate, projectRoot: dir }
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  const fallback = path.join(process.cwd(), 'node_modules', 'eslint', 'bin', 'eslint.js')
  return fs.existsSync(fallback) ? { jsPath: fallback, projectRoot: process.cwd() } : null
}

/**
 * ESLint 诊断适配器（基于项目本地 eslint --format json）。
 *
 * 使用被诊断文件所在项目安装的 eslint（含其配置与插件），
 * 仅在存在 eslint 安装时可用。
 */
class ESLintAdapter implements LspAdapter {
  readonly name = 'eslint'
  readonly language = 'javascript'
  readonly extensions = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']
  private cachedAvailable: boolean | null = null

  async isAvailable(): Promise<boolean> {
    if (this.cachedAvailable !== null) return this.cachedAvailable
    // 粗探测：引擎侧或任意常见位置有 eslint 入口即注册；
    // 精确按文件定位在 diagnose 时进行（找不到就安静返回空）
    this.cachedAvailable = fs.existsSync(
      path.join(process.cwd(), 'node_modules', 'eslint', 'bin', 'eslint.js'),
    )
    return this.cachedAvailable
  }

  async diagnose(filePath: string, content?: string, signal?: AbortSignal): Promise<Diagnostic[]> {
    const located = resolveEslintJs(filePath)
    if (!located) return []

    return new Promise((resolve) => {
      let target = filePath
      let cleanup: (() => void) | null = null
      if (content !== undefined) {
        const tmp = path.join(os.tmpdir(), `lsp-eslint-${Date.now()}-${Math.random().toString(36).slice(2)}${path.extname(filePath)}`)
        fs.writeFileSync(tmp, content, 'utf-8')
        target = tmp
        cleanup = () => { try { fs.unlinkSync(tmp) } catch {} }
      }
      // 配置解析以项目根为 cwd
      const proc = spawn(
        process.env.AETHER_ENGINE_NODE || process.execPath,
        [located.jsPath, '--format', 'json', '--no-color', target],
        { shell: false, cwd: located.projectRoot },
      )
      let out = ''
      proc.stdout.on('data', (b) => { out += b.toString() })
      proc.stderr.on('data', () => { /* ignore */ })
      const onAbort = () => proc.kill('SIGTERM')
      signal?.addEventListener('abort', onAbort)
      proc.on('close', () => {
        signal?.removeEventListener('abort', onAbort)
        cleanup?.()
        resolve(parseEslintOutput(out))
      })
      proc.on('error', () => {
        signal?.removeEventListener('abort', onAbort)
        cleanup?.()
        resolve([])
      })
    })
  }
}

interface EslintMessage {
  ruleId: string | null
  severity: number        // 1=warn 2=error
  message: string
  line: number
  column: number
  endLine?: number
  endColumn?: number
  fix?: { range: [number, number]; text: string }
}

interface EslintFileResult {
  messages: EslintMessage[]
}

function parseEslintOutput(out: string): Diagnostic[] {
  try {
    const results = JSON.parse(out) as EslintFileResult[]
    const diagnostics: Diagnostic[] = []
    for (const r of results) {
      for (const m of r.messages) {
        diagnostics.push({
          severity: m.severity === 2 ? 'error' : 'warning',
          line: m.line,
          column: m.column,
          endLine: m.endLine,
          endColumn: m.endColumn,
          code: m.ruleId ?? undefined,
          message: m.message,
          source: 'eslint',
          fix: m.fix ? { title: 'ESLint autofix', newText: m.fix.text } : undefined,
        })
      }
    }
    return diagnostics
  } catch {
    return []
  }
}

export const eslintAdapter: LspAdapter = new ESLintAdapter()
