import fs from 'node:fs'
import type { AgentContext } from '../../../core/agent-context/index.js'
import type { FileHandler, ReadOptions, ReadResult } from './interface.js'

export class JsonHandler implements FileHandler {
  extensions = ['.json']

  async read(filePath: string, _ctx: AgentContext, options?: ReadOptions): Promise<ReadResult> {
    const raw = fs.readFileSync(filePath, 'utf-8')
    const mode = options?.mode || 'auto'
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
