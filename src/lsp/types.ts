/**
 * LSP 诊断类型定义
 */

export type DiagnosticSeverity = 'error' | 'warning' | 'info' | 'hint'

export interface Diagnostic {
  severity: DiagnosticSeverity
  line: number       // 1-based
  column: number     // 1-based
  endLine?: number
  endColumn?: number
  code?: string
  message: string
  source: string     // 'typescript' | 'eslint' | ...
  /** 可选的自动修复建议（文本替换） */
  fix?: {
    title: string
    newText: string
  }
}

export interface DiagnoseResult {
  /** Empty diagnostics mean a pass only when status is completed. */
  status: 'completed' | 'unsupported' | 'error' | 'cancelled'
  error?: string
  errorCode?: string
  filePath: string
  language: string
  adapter: string
  diagnostics: Diagnostic[]
  durationMs: number
  fromCache: boolean
}

export interface LspAdapter {
  /** 唯一名称：'typescript' / 'eslint' / 'python' ... */
  readonly name: string
  /** 可诊断的文件扩展名（小写，带点） */
  readonly extensions: string[]
  /** 对应 language 字段（'typescript', 'javascript', 'python' ...） */
  readonly language: string
  /** 是否可用（如 tsc/eslint 二进制存在） */
  isAvailable(filePath?: string): Promise<boolean>
  /** 诊断一个文件；content 可传入未保存的内容 */
  diagnose(filePath: string, content?: string, signal?: AbortSignal): Promise<Diagnostic[]>
}
