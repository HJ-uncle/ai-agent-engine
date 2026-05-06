import { spawn } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import type { LspAdapter, Diagnostic } from '../types.js'

/**
 * TypeScript 诊断适配器（基于 tsc --noEmit，单文件模式）。
 *
 * 实现策略：
 *   1. 如果 workspace 中存在 tsconfig.json，使用该 tsconfig
 *   2. 如果传入了未保存内容，先写入临时 .ts 文件
 *   3. spawn npx tsc --noEmit --pretty false <file>
 *   4. 解析输出：`path(line,col): error TSxxxx: message`
 *
 * 注意：tsc 启动较慢，LSP 模块上层已经按 file hash 缓存诊断结果。
 */
class TypeScriptAdapter implements LspAdapter {
  readonly name = 'typescript'
  readonly language = 'typescript'
  readonly extensions = ['.ts', '.tsx', '.mts', '.cts']
  private cachedAvailable: boolean | null = null

  async isAvailable(): Promise<boolean> {
    if (this.cachedAvailable !== null) return this.cachedAvailable
    // 只要能 require.resolve('typescript') 就视为可用
    try {
      // 动态 import 避免打包依赖
      await import('typescript').catch(() => { throw new Error('no ts') })
      this.cachedAvailable = true
    } catch {
      // 也可以探测本地 node_modules/.bin/tsc
      const candidates = [
        path.join(process.cwd(), 'node_modules', '.bin', os.platform() === 'win32' ? 'tsc.cmd' : 'tsc'),
      ]
      this.cachedAvailable = candidates.some((c) => fs.existsSync(c))
    }
    return this.cachedAvailable
  }

  async diagnose(filePath: string, content?: string, signal?: AbortSignal): Promise<Diagnostic[]> {
    // 优先用 typescript 编程 API（更快、不需要起子进程）
    try {
      const ts = await import('typescript')
      return await this.diagnoseWithApi(ts, filePath, content)
    } catch {
      return this.diagnoseWithCli(filePath, content, signal)
    }
  }

  private async diagnoseWithApi(ts: any, filePath: string, content?: string): Promise<Diagnostic[]> {
    const src = content ?? fs.readFileSync(filePath, 'utf-8')
    const sourceFile = ts.createSourceFile(
      filePath,
      src,
      ts.ScriptTarget.ESNext,
      true,
      filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    )

    const host: any = {
      ...ts.createCompilerHost({}),
      getSourceFile: (name: string, lang: any) => {
        if (name === filePath) return sourceFile
        const h = ts.createCompilerHost({})
        return h.getSourceFile(name, lang)
      },
      readFile: (name: string) => (name === filePath ? src : ts.sys.readFile(name)),
    }

    const program = ts.createProgram({
      rootNames: [filePath],
      options: {
        noEmit: true,
        allowJs: true,
        checkJs: false,
        strict: false,
        esModuleInterop: true,
        skipLibCheck: true,
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler ?? ts.ModuleResolutionKind.NodeJs,
        jsx: filePath.endsWith('.tsx') ? ts.JsxEmit.Preserve : undefined,
      },
      host,
    })

    const diags = [
      ...program.getSyntacticDiagnostics(sourceFile),
      ...program.getSemanticDiagnostics(sourceFile),
    ]

    return diags.map((d: any) => {
      const pos = d.file && d.start != null
        ? d.file.getLineAndCharacterOfPosition(d.start)
        : { line: 0, character: 0 }
      return {
        severity: mapTsSeverity(d.category),
        line: pos.line + 1,
        column: pos.character + 1,
        code: 'TS' + d.code,
        message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
        source: 'typescript',
      } as Diagnostic
    })
  }

  private diagnoseWithCli(filePath: string, content: string | undefined, signal?: AbortSignal): Promise<Diagnostic[]> {
    return new Promise((resolve) => {
      let target = filePath
      let cleanup: (() => void) | null = null
      if (content !== undefined) {
        const tmp = path.join(os.tmpdir(), `lsp-${Date.now()}-${Math.random().toString(36).slice(2)}${path.extname(filePath)}`)
        fs.writeFileSync(tmp, content, 'utf-8')
        target = tmp
        cleanup = () => { try { fs.unlinkSync(tmp) } catch {} }
      }
      const tscBin = path.join(process.cwd(), 'node_modules', '.bin', os.platform() === 'win32' ? 'tsc.cmd' : 'tsc')
      const proc = spawn(tscBin, ['--noEmit', '--pretty', 'false', '--allowJs', target], { shell: false })
      let out = ''
      proc.stdout.on('data', (b) => { out += b.toString() })
      proc.stderr.on('data', (b) => { out += b.toString() })
      const onAbort = () => proc.kill('SIGTERM')
      signal?.addEventListener('abort', onAbort)
      proc.on('close', () => {
        signal?.removeEventListener('abort', onAbort)
        cleanup?.()
        resolve(parseTsCliOutput(out, filePath))
      })
      proc.on('error', () => {
        signal?.removeEventListener('abort', onAbort)
        cleanup?.()
        resolve([])
      })
    })
  }
}

function parseTsCliOutput(out: string, filePath: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  const re = /^(?:.+?)\((\d+),(\d+)\):\s+(error|warning)\s+TS(\d+):\s+(.+)$/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(out)) !== null) {
    diagnostics.push({
      severity: m[3] === 'warning' ? 'warning' : 'error',
      line: parseInt(m[1], 10),
      column: parseInt(m[2], 10),
      code: 'TS' + m[4],
      message: m[5].trim(),
      source: 'typescript',
    })
  }
  return diagnostics
}

function mapTsSeverity(category: number): Diagnostic['severity'] {
  // ts.DiagnosticCategory: Warning=0, Error=1, Suggestion=2, Message=3
  if (category === 1) return 'error'
  if (category === 0) return 'warning'
  if (category === 2) return 'hint'
  return 'info'
}

export const typescriptAdapter: LspAdapter = new TypeScriptAdapter()
