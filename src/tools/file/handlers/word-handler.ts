import mammoth from 'mammoth'
import WordExtractor from 'word-extractor'
import path from 'node:path'
import type { AgentContext } from '../../../core/agent-context/index.js'
import type { FileHandler, ReadOptions, ReadResult } from './interface.js'

export class WordHandler implements FileHandler {
  extensions = ['.docx', '.doc']

  async read(filePath: string, _ctx: AgentContext, _options?: ReadOptions): Promise<ReadResult> {
    const ext = path.extname(filePath).toLowerCase()
    let text = ''

    if (ext === '.doc') {
      const extractor = new WordExtractor()
      const extracted = await extractor.extract(filePath)
      text = extracted.getBody()
    } else {
      const result = await mammoth.extractRawText({ path: filePath })
      text = result.value
    }
    
    return {
      type: 'word',
      data: { text },
      content: text
    }
  }

  async write(_filePath: string, _data: any, _ctx: AgentContext): Promise<void> {
    throw new Error('Word writing is not supported.')
  }
}
