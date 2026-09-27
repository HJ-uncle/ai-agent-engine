import type { AgentContext } from '../../../core/agent-context/index.js'

export interface ReadOptions {
  mode?: 'auto' | 'full' | 'summary' | 'vision' | 'ocr'
  language?: string
  encoding?: string
  startLine?: number
  endLine?: number
}

export interface ReadResult {
  type: string
  data: any
  raw?: string
  content?: string // 用于向 AI 展示的文本内容
}

export interface FileHandler {
  extensions: string[]
  read(path: string, ctx: AgentContext, options?: ReadOptions): Promise<ReadResult>
  write(path: string, data: any, ctx: AgentContext): Promise<void>
}
