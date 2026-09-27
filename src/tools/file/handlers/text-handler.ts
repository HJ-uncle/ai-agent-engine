import fs from 'node:fs'
import path from 'node:path'
import type { AgentContext } from '../../../core/agent-context/index.js'
import type { FileHandler, ReadOptions, ReadResult } from './interface.js'
import { extractCodeSummary } from '../utils.js'

export class TextHandler implements FileHandler {
  extensions = ['.txt', '.md', '.ts', '.js', '.tsx', '.jsx', '.py', '.go', '.java', '.c', '.cpp', '.h', '.hpp', '.rs', '.css', '.html', '.sh', '.yaml', '.yml', '.toml', '.lock']

  async read(filePath: string, _ctx: AgentContext, options?: ReadOptions): Promise<ReadResult> {
    const fullContent = fs.readFileSync(filePath, 'utf-8')
    const ext = path.extname(filePath).toLowerCase()
    const mode = options?.mode || 'auto'
    
    if (mode === 'summary' && ['.ts', '.js', '.tsx', '.jsx', '.py', '.go', '.java'].includes(ext)) {
      return {
        type: 'text_summary',
        data: fullContent,
        content: extractCodeSummary(fullContent, ext)
      }
    }

    const lines = fullContent.split('\n')
    const totalLines = lines.length

    // 默认分页逻辑：如果没指定范围且文件超过 300 行，默认读前 300 行
    let startLine = options?.startLine ?? 1
    let endLine = options?.endLine ?? (options?.startLine ? startLine + 299 : 300)

    if (mode === 'full') {
      startLine = 1
      endLine = totalLines
    }

    // 边界检查
    startLine = Math.max(1, startLine)
    endLine = Math.min(totalLines, endLine)

    const slice = lines.slice(startLine - 1, endLine)
    
    // 添加行号以便 AI 引用和翻页
    const displayContent = slice
      .map((line, i) => `${(startLine + i).toString().padStart(4, ' ')} | ${line}`)
      .join('\n')

    const paginationInfo = totalLines > (endLine - startLine + 1) 
      ? `\n\n[第 ${startLine}-${endLine} 行，共 ${totalLines} 行。使用 start_line 和 end_line 读取更多内容]` 
      : ''

    return {
      type: 'text',
      data: fullContent,
      content: `[文件: ${path.basename(filePath)}]\n${displayContent}${paginationInfo}`
    }
  }

  async write(filePath: string, data: any, _ctx: AgentContext): Promise<void> {
    const content = typeof data === 'string' ? data : String(data)
    fs.writeFileSync(filePath, content, 'utf-8')
  }
}
