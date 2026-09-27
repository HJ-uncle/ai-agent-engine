import { spawn } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import type { LspAdapter, Diagnostic } from '../types.js'

/**
 * 解析 typescript 模块。两处探测：
 *   1. 引擎自身模块位置向上 —— 打包环境（sdk-package/bin/dist 与 node_modules 同根）
 *      打包器会改写动态 import('typescript')，必须用 createRequire 绕开；
 *   2. process.cwd() —— dev 环境（引擎仓库 node_modules）。
 */
function loadTs(): any | null {
  for (const base of [import.meta.url, path.join(process.cwd(), 'index.js')]) {
    try {
      return createRequire(base)('typescript')
    } catch { /* 尝试下一个 */ }
  }
  return null
}

/** tsc 的 JS 入口：node 直接跑，绕开 .cmd（Node 新版禁止 shell:false spawn .cmd，报 EINVAL） */
function resolveTscJs(): string | null {
  for (const base of [import.meta.url, path.join(process.cwd(), 'index.js')]) {
    try {
      return createRequire(base).resolve('typescript/lib/tsc.js')
    } catch { /* 尝试下一个 */ }
  }
  return null
}

/**
 * TypeScript 诊断适配器（基于 tsc --noEmit，单文件模式）。
 *
 * 实现策略：
 *   1. 优先 typescript 编程 API（createRequire 解析，无需子进程）
 *   2. 如果传入了未保存内容，先写入临时 .ts 文件
 *   3. spawn node tsc.js --noEmit --pretty false <file>
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
    this.cachedAvailable = loadTs() !== null || resolveTscJs() !== null
    return this.cachedAvailable
  }

  async diagnose(filePath: string, content?: string, signal?: AbortSignal): Promise<Diagnostic[]> {
    // 优先用 typescript 编程 API（更快、不需要起子进程）
    const ts = loadTs()
    if (ts) {
      try {
        const diags = await this.diagnoseWithApi(ts, filePath, content)
        console.log(`[LSP][typescript] api: ${diags.length} diag(s), ts=${ts.version}`)
        return diags
      } catch (e: any) {
        console.error(`[LSP][typescript] api failed: ${e?.message ?? e}`)
      }
    } else {
      console.error('[LSP][typescript] loadTs() returned null, falling back to CLI')
    }
    return this.diagnoseWithCli(filePath, content, signal)
  }

  private async diagnoseWithApi(ts: any, filePath: string, content?: string): Promise<Diagnostic[]> {
    const src = content ?? fs.readFileSync(filePath, 'utf-8')
    // 统一正斜杠：Windows 反斜杠路径会让 program 内部 fileName 规范化与
    // host.getSourceFile 的匹配失败，检查器拿到错位的节点（实测报
    // "Cannot read properties of undefined (reading 'flags')"）
    const normPath = filePath.replace(/\\/g, '/')
    const sourceFile = ts.createSourceFile(
      normPath,
      src,
      ts.ScriptTarget.ESNext,
      true,
      normPath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    )

    const host: any = {
      ...ts.createCompilerHost({}),
      getSourceFile: (name: string, lang: any) => {
        if (name === normPath) return sourceFile
        const h = ts.createCompilerHost({})
        return h.getSourceFile(name, lang)
      },
      readFile: (name: string) => (name === normPath ? src : ts.sys.readFile(name)),
    }

    const program = ts.createProgram({
      rootNames: [normPath],
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
        jsx: normPath.endsWith('.tsx') ? ts.JsxEmit.Preserve : undefined,
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
      const tscJs = resolveTscJs()
      if (!tscJs) return []
      // node 直接跑 tsc.js：不能 spawn .cmd（Node 新版 EINVAL），且
      // embedded 宿主是 electron.exe + ELECTRON_RUN_AS_NODE（继承后即 node 模式）
      const nodeBin = process.env.AETHER_ENGINE_NODE || process.execPath
      const proc = spawn(
        nodeBin,
        ['--max-old-space-size=4096', tscJs, '--noEmit', '--pretty', 'false', '--allowJs', target],
        { shell: false },
      )
      let out = ''
      proc.stdout.on('data', (b) => { out += b.toString() })
      proc.stderr.on('data', (b) => { out += b.toString() })
      const onAbort = () => proc.kill('SIGTERM')
      signal?.addEventListener('abort', onAbort)
      proc.on('close', () => {
        signal?.removeEventListener('abort', onAbort)
        cleanup?.()
        console.log(`[LSP][typescript] cli exit: ${parseTsCliOutput(out, filePath).length} diag(s), out=${out.slice(0, 200)}`)
        resolve(parseTsCliOutput(out, filePath))
      })
      proc.on('error', (e) => {
        signal?.removeEventListener('abort', onAbort)
        cleanup?.()
        console.error(`[LSP][typescript] cli spawn error: ${e.message}`)
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
