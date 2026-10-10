import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import mammoth from 'mammoth'
import WordExtractor from 'word-extractor'
import { PDFParse } from 'pdf-parse'
import * as XLSX from 'xlsx'
import Tesseract from 'tesseract.js'

/**
 * Formats that can be indexed by the knowledge base.  Keep this list in the
 * engine so clients can expose exactly what the running engine supports.
 */
export const KNOWLEDGE_TEXT_EXTENSIONS = [
  '.txt', '.md', '.markdown', '.json', '.html', '.htm', '.xml', '.csv',
  '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.java', '.c', '.cpp', '.h', '.hpp', '.rs',
  '.css', '.scss', '.less', '.sh', '.yaml', '.yml', '.toml', '.ini', '.lock', '.log', '.svg'
] as const
export const KNOWLEDGE_BINARY_EXTENSIONS = ['.xlsx', '.xls', '.docx', '.doc', '.pdf'] as const
export const KNOWLEDGE_OCR_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff'] as const
export const KNOWLEDGE_SUPPORTED_EXTENSIONS = [...KNOWLEDGE_TEXT_EXTENSIONS, ...KNOWLEDGE_BINARY_EXTENSIONS, ...KNOWLEDGE_OCR_EXTENSIONS] as const

export type KnowledgeExtraction = { content: string; contentType: string; warning?: string }

function htmlToText(input: string): string {
  return input.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim()
}

/** Extract UTF-8, office/PDF formats and OCR-supported images. */
export async function extractKnowledgeContent(filename: string, data: Uint8Array, contentType = ''): Promise<KnowledgeExtraction> {
  const ext = path.extname(filename).toLowerCase()
  if ((KNOWLEDGE_TEXT_EXTENSIONS as readonly string[]).includes(ext)) {
    const raw = Buffer.from(data).toString('utf8')
    return { content: ext === '.html' || ext === '.htm' ? htmlToText(raw) : raw, contentType: contentType || (ext === '.json' ? 'application/json' : 'text/plain') }
  }
  if (ext === '.xlsx' || ext === '.xls') {
    const workbook = XLSX.read(Buffer.from(data), { type: 'buffer' })
    const content = workbook.SheetNames.map(name => `## ${name}\n${XLSX.utils.sheet_to_csv(workbook.Sheets[name])}`).join('\n\n')
    return { content, contentType: contentType || 'application/vnd.ms-excel' }
  }
  if (ext === '.docx') {
    const result = await mammoth.extractRawText({ buffer: Buffer.from(data) })
    return { content: result.value, contentType: contentType || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', warning: result.messages.length ? result.messages.map(message => message.message).join('; ') : undefined }
  }
  if (ext === '.doc') {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aether-kb-'))
    const tempFile = path.join(tempDir, 'upload.doc')
    try {
      await fs.writeFile(tempFile, data)
      const extracted = await new WordExtractor().extract(tempFile)
      return { content: extracted.getBody(), contentType: contentType || 'application/msword' }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
    }
  }
  if (ext === '.pdf') {
    const parser = new PDFParse({ data: Buffer.from(data) })
    try {
      const result = await parser.getText()
      // pdf-parse may include page separators even when every page's text
      // layer is empty. Inspect page text rather than treating those markers
      // as extracted content, otherwise image-only scans skip OCR.
      const text = result.pages.map(page => page.text.trim()).filter(Boolean).join('\n\n')
      if (text) return { content: result.text, contentType: contentType || 'application/pdf' }

      // A scanned PDF has no text layer. Render a bounded number of pages with
      // the production PDF renderer and run the same OCR pipeline used for
      // image knowledge documents. The page limit keeps uploads predictable;
      // callers can raise it deliberately for longer scans.
      const configuredPages = Number.parseInt(process.env.KNOWLEDGE_PDF_OCR_PAGES?.trim() || '3', 10)
      const pageLimit = Number.isFinite(configuredPages) ? Math.min(Math.max(configuredPages, 1), 10) : 3
      const language = process.env.KNOWLEDGE_OCR_LANGUAGE?.trim() || 'eng+chi_sim'
      const screenshots = await parser.getScreenshot({ first: pageLimit, desiredWidth: 1600, imageBuffer: true, imageDataUrl: false })
      const pages: string[] = []
      const errors: string[] = []
      for (const page of screenshots.pages) {
        if (!page.data?.length) continue
        try {
          const ocr = await Tesseract.recognize(Buffer.from(page.data), language, { logger: () => undefined })
          const pageText = ocr.data.text?.trim() ?? ''
          if (pageText) pages.push(`## Page ${page.pageNumber}\n${pageText}`)
        } catch (error) {
          errors.push(`page ${page.pageNumber}: ${(error as Error).message}`)
        }
      }
      const ocrText = pages.join('\n\n')
      if (ocrText) return {
        content: ocrText,
        contentType: contentType || 'application/pdf',
        warning: errors.length ? `扫描 PDF OCR 部分页面失败（${errors.join('; ')}）` : undefined
      }
      const detail = errors.length ? `；${errors.join('; ')}` : ''
      return { content: '', contentType: contentType || 'application/pdf', warning: `该 PDF 未提取到文本，扫描件 OCR 未识别到可检索文字${detail}` }
    } finally { await parser.destroy() }
  }
  if ((KNOWLEDGE_OCR_EXTENSIONS as readonly string[]).includes(ext)) {
    const language = process.env.KNOWLEDGE_OCR_LANGUAGE?.trim() || 'eng+chi_sim'
    const result = await Tesseract.recognize(Buffer.from(data), language, { logger: () => undefined })
    const text = result.data.text?.trim() ?? ''
    return {
      content: text,
      contentType: contentType || `image/${ext.slice(1)}`,
      warning: text ? undefined : '图片未识别到可检索文字'
    }
  }
  throw new Error(`不支持的知识库文件格式：${ext || '无扩展名'}`)
}

export function supportedKnowledgeFormatsDescription(): string {
  return '文本/代码：.txt .md .markdown .json .html .htm .xml .csv .ts .tsx .js .jsx .py .go .java .c .cpp .h .hpp .rs .css .scss .less .sh .yaml .yml .toml .ini .lock .log .svg；表格：.xlsx .xls；文档：.docx .doc；PDF：.pdf（扫描件按 OCR 处理）；图片 OCR：.png .jpg .jpeg .gif .webp .bmp .tiff。'
}

// Keep this import alive for environments that tree-shake optional .doc support
// while still advertising the dependency in the generated bundle.
void WordExtractor
