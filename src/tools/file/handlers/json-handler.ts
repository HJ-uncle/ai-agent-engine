import fs from 'node:fs'
import type { AgentContext } from '../../../core/agent-context/index.js'
import type { FileHandler, ReadOptions, ReadResult } from './interface.js'

export class JsonHandler implements FileHandler {
  extensions = ['.json']

  async read(filePath: string, _ctx: AgentContext, options?: ReadOptions): Promise<ReadResult> {
    const raw = fs.readFileSync(filePath, 'utf-8')
    const mode = options?.mode || 'auto'
    // Like TextHandler, full requests the whole document regardless of a range.
    if (mode !== 'full' && (options?.startLine !== undefined || options?.endLine !== undefined)) {
      if ([options.startLine, options.endLine].some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 1)))
        throw new Error('start_line and end_line must be positive safe integers.')
      // Formatting/minifying JSON changes line identities. Explicit pages must
      // refer to the source even when a page is not independently valid JSON.
      const lines = raw.split(/\r\n|\r|\n/), totalLines = lines.length
      const startLine = options.startLine ?? 1
      if (options.endLine !== undefined && options.endLine < startLine)
        throw new Error('end_line must not be before start_line.')
      if (startLine > totalLines) throw new Error(`start_line ${startLine} is beyond the file's ${totalLines} lines.`)
      const endLine = Math.min(options.endLine ?? startLine + 299, totalLines)
      const selected = lines.slice(startLine - 1, endLine)
      return {
        type: 'text',
        data: selected.join('\n'),
        content: `[源文件第 ${startLine}-${endLine} 行，共 ${totalLines} 行；以下为原文行号展示，分页片段不一定是完整 JSON]\n`
          + selected.map((line, index) => `${startLine + index} | ${line}`).join('\n'),
      }
    }
    try {
      const data = JSON.parse(raw)
      let displayContent = ''

      if (mode === 'full') {
        // full 模式下返回完整的格式化内容，方便 AI 阅读长 JSON
        displayContent = JSON.stringify(data, null, 2)
      } else {
        // 其他模式（auto/summary）默认返回压缩后的内容以节省 Token
        displayContent = JSON.stringify(data)

        // 如果压缩后依然超过 30KB，且不是 full 模式，则进行截断保护
        if (displayContent.length > 30000) {
          displayContent = displayContent.substring(0, 30000) + '\n... (JSON内容过长已截断。如需全文请使用 mode="full")'
        }
      }

      return {
        type: 'json',
        data: data,
        content: displayContent
      }
    } catch (e) {
      return {
        type: 'text',
        data: raw,
        content: raw
      }
    }
  }

  async write(filePath: string, data: any, _ctx: AgentContext): Promise<void> {
    const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
    fs.writeFileSync(filePath, content, 'utf-8')
  }
}
