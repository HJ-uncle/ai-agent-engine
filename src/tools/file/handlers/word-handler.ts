import mammoth from 'mammoth'
import WordExtractor from 'word-extractor'
import path from 'node:path'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import * as docxModule from 'docx'
const docx = docxModule as any
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

  async write(filePath: string, data: any, _ctx: AgentContext): Promise<void> {
    const ext = path.extname(filePath).toLowerCase()
    if (ext !== '.docx') {
      throw new Error('Only .docx writing is supported.')
    }

    const isBusiness = data.theme === 'business'
    // 全局样式配置
    const config = {
      primaryColor: data.primaryColor || (isBusiness ? "1E3A8A" : "000000"),
      font: data.font || (isBusiness ? "Microsoft YaHei" : undefined),
      fontSize: data.fontSize || (isBusiness ? 24 : undefined),
      margin: data.margin || (isBusiness ? { top: 1440, right: 1440, bottom: 1440, left: 1440 } : undefined)
    }

    let sections: any[] = []

    if (typeof data === 'string') {
      sections = [{
        children: [new docx.Paragraph({ children: [new docx.TextRun(data)] })]
      }]
    } else if (data.sections) {
      sections = data.sections.map((section: any) => {
        const children = (section.children || []).map((child: any) => {
          if (child instanceof docx.Paragraph || child instanceof docx.Table) return child
          
          if (child.type === 'paragraph') {
            return new docx.Paragraph({
              text: child.text,
              heading: child.heading ? (docx.HeadingLevel as any)[child.heading] : undefined,
              alignment: child.alignment ? (docx.AlignmentType as any)[child.alignment] : (isBusiness ? docx.AlignmentType.LEFT : undefined),
              spacing: child.spacing || (isBusiness ? { before: 200, after: 200, line: 360 } : undefined),
              indent: child.indent,
              children: Array.isArray(child.children) ? child.children.map((run: any) => {
                // 如果是图片
                if (run.type === 'image' || run.path) {
                  try {
                     return new docx.ImageRun({
                       data: fsSync.readFileSync(run.path),
                       transformation: {
                        width: run.width || 200,
                        height: run.height || 200,
                      },
                    })
                  } catch (e) {
                    return new docx.TextRun(`[Image Load Error: ${run.path}]`)
                  }
                }
                // 普通文本
                return new docx.TextRun({
                  text: run.text || run,
                  bold: run.bold,
                  italic: run.italic,
                  underline: run.underline,
                  size: run.size || config.fontSize,
                  color: run.color || (run.primary ? config.primaryColor : undefined),
                  font: run.font || config.font,
                  break: run.break
                })
              }) : undefined
            })
          }
          if (child.type === 'table') {
            const table = new docx.Table({
              rows: (child.rows || []).map((row: any[], rowIndex: number) => new docx.TableRow({
                children: row.map(cell => {
                  const cellData = typeof cell === 'string' ? { text: cell } : cell
                  return new docx.TableCell({
                    children: [new docx.Paragraph({
                      text: cellData.text,
                      alignment: cellData.alignment ? (docx.AlignmentType as any)[cellData.alignment] : (isBusiness ? docx.AlignmentType.CENTER : undefined)
                    })],
                    shading: cellData.shading || (rowIndex === 0 && (cellData.primary || isBusiness) ? { fill: config.primaryColor, type: docx.ShadingType.CLEAR, color: "FFFFFF" } : undefined),
                    verticalAlign: cellData.verticalAlign ? (docx.VerticalAlign as any)[cellData.verticalAlign] : (isBusiness ? docx.VerticalAlign.CENTER : undefined),
                    width: cellData.width
                  })
                })
              })),
              width: child.width || (isBusiness ? { size: 100, type: docx.WidthType.PERCENTAGE } : undefined),
              alignment: child.alignment ? (docx.AlignmentType as any)[child.alignment] : (isBusiness ? docx.AlignmentType.CENTER : undefined)
            })
            return table
          }
          return new docx.Paragraph(String(child))
        })
        return { 
          properties: section.properties || (config.margin ? { page: { margin: config.margin } } : {}),
          children 
        }
      })
    } else if (data.content) {
      sections = [{
        children: [new docx.Paragraph(String(data.content))]
      }]
    } else {
      // 兜底方案
      sections = [{
        children: [new docx.Paragraph(JSON.stringify(data, null, 2))]
      }]
    }

    const doc = new docx.Document({ sections })
    const buffer = await docx.Packer.toBuffer(doc)
    await fs.writeFile(filePath, buffer)
  }
}
