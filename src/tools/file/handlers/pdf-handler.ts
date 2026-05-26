import fs from 'node:fs/promises'
import path from 'node:path'
import { createWriteStream } from 'node:fs'
import { PDFParse } from 'pdf-parse'
import PDFDocument from 'pdfkit'
import type { AgentContext } from '../../../core/agent-context/index.js'
import type { FileHandler, ReadOptions, ReadResult } from './interface.js'

export class PdfHandler implements FileHandler {
  extensions = ['.pdf']

  async read(filePath: string, _ctx: AgentContext, options?: ReadOptions): Promise<ReadResult> {
    const dataBuffer = await fs.readFile(filePath)
    
    const parser = new PDFParse({ data: dataBuffer })
    try {
      const textResult = await parser.getText()
      const infoResult = await parser.getInfo()
      
      const pageCount = textResult.pages.length
      const fullText = textResult.text
      const info = infoResult.info

      const lines = fullText.split('\n')
      const totalLines = lines.length

      // 分页逻辑
      let startLine = options?.startLine ?? 1
      let endLine = options?.endLine ?? (options?.startLine ? startLine + 299 : 300)

      if (options?.mode === 'full') {
        startLine = 1
        endLine = totalLines
      }

      startLine = Math.max(1, startLine)
      endLine = Math.min(totalLines, endLine)

      const slice = lines.slice(startLine - 1, endLine)
      const displayContent = slice
        .map((line: string, i: number) => `${(startLine + i).toString().padStart(4, ' ')} | ${line}`)
        .join('\n')

      const paginationInfo = totalLines > (endLine - startLine + 1)
        ? `\n\n[第 ${startLine}-${endLine} 行，共 ${totalLines} 行。使用 start_line 和 end_line 读取更多内容]`
        : ''

      const header = [
        `[PDF 文件: ${path.basename(filePath)}]`,
        `页数: ${pageCount}`,
        `元数据: ${JSON.stringify(info)}`,
        `--- 内容 ---`,
      ].join('\n')

      return {
        type: 'pdf',
        data: {
          pageCount,
          info,
          text: fullText
        },
        content: `${header}\n${displayContent}${paginationInfo}`
      }
    } catch (err: any) {
      throw new Error(`PDF 解析失败: ${err.message}`)
    } finally {
      await parser.destroy()
    }
  }

  async write(filePath: string, data: any, _ctx: AgentContext): Promise<void> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ autoFirstPage: true })
      const stream = createWriteStream(filePath)
      
      doc.pipe(stream)
      
      const content = typeof data === 'string' ? data : (data.text || JSON.stringify(data))
      
      // 基础的分页逻辑：pdfkit 会在内容超出页面时自动分页，但我们也可以手动处理长文本
      doc.fontSize(12).text(content, {
        align: 'left',
        lineGap: 2
      })
      
      doc.end()
      
      stream.on('finish', () => resolve())
      stream.on('error', (err) => reject(err))
    })
  }
}
