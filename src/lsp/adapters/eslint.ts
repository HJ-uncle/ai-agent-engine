import path from 'node:path'
import fs from 'node:fs'
import type { LspAdapter, Diagnostic } from '../types.js'
import { runDiagnosticProcess } from './process.js'
import { throwIfAborted } from '../../core/utils/abort.js'

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

function hasEslintConfig(filePath: string): boolean {
  let dir = path.dirname(filePath)
  for (;;) {
    if (['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', 'eslint.config.mts', 'eslint.config.cts',
      '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yaml', '.eslintrc.yml']
      .some(name => fs.existsSync(path.join(dir, name)))) return true
    try {
      if (JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).eslintConfig) return true
    } catch { /* not a package directory */ }
    const parent = path.dirname(dir)
    if (parent === dir) return false
    dir = parent
  }
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
  async isAvailable(filePath?: string): Promise<boolean> {
    const target = filePath ?? path.join(process.cwd(), 'index.js')
    return resolveEslintJs(target) !== null && (!filePath || hasEslintConfig(target))
  }

  async diagnose(filePath: string, content?: string, signal?: AbortSignal): Promise<Diagnostic[]> {
    throwIfAborted(signal)
    const located = resolveEslintJs(filePath)
    if (!located) throw new Error('ESLint 不可用')
    const args = [located.jsPath, '--format', 'json', '--no-color']
    // stdin preserves the original filename/config when content is unsaved.
    if (content !== undefined) args.push('--stdin', '--stdin-filename', filePath)
    else args.push(filePath)
    const { stdout, stderr, exitCode } = await runDiagnosticProcess(
      process.env.AETHER_ENGINE_NODE || process.execPath, args,
      { cwd: located.projectRoot, input: content, signal },
    )
    if (exitCode !== 0 && exitCode !== 1) throw new Error(`ESLint 失败 (${exitCode}): ${stderr.slice(0, 500)}`)
    return parseEslintOutput(stdout)
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
          line: Number.isFinite(m.line) && m.line >= 1 ? m.line : 1,
          column: Number.isFinite(m.column) && m.column >= 1 ? m.column : 1,
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
  } catch (error) {
    throw new Error(`ESLint 返回无效诊断: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export const eslintAdapter: LspAdapter = new ESLintAdapter()
