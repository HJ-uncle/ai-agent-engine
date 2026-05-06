import { spawn } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import type { LspAdapter, Diagnostic } from '../types.js'

/**
 * ESLint 诊断适配器（基于本地 node_modules/.bin/eslint --format json）。
 *
 * 仅在用户项目中安装了 eslint 时才可用。
 */
class ESLintAdapter implements LspAdapter {
  readonly name = 'eslint'
  readonly language = 'javascript'
  readonly extensions = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']
  private cachedAvailable: boolean | null = null

  async isAvailable(): Promise<boolean> {
    if (this.cachedAvailable !== null) return this.cachedAvailable
    const bin = this.eslintBin()
    this.cachedAvailable = fs.existsSync(bin)
    return this.cachedAvailable
  }

  private eslintBin(): string {
    return path.join(process.cwd(), 'node_modules', '.bin', os.platform() === 'win32' ? 'eslint.cmd' : 'eslint')
  }

  async diagnose(filePath: string, content?: string, signal?: AbortSignal): Promise<Diagnostic[]> {
    return new Promise((resolve) => {
      let target = filePath
      let cleanup: (() => void) | null = null
      if (content !== undefined) {
        const tmp = path.join(os.tmpdir(), `lsp-eslint-${Date.now()}-${Math.random().toString(36).slice(2)}${path.extname(filePath)}`)
        fs.writeFileSync(tmp, content, 'utf-8')
        target = tmp
        cleanup = () => { try { fs.unlinkSync(tmp) } catch {} }
      }
      const proc = spawn(this.eslintBin(), ['--format', 'json', '--no-color', target], { shell: false })
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
