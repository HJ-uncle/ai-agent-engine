import fs from 'node:fs'
import path from 'node:path'
import PDFDocument from 'pdfkit'
import { PDFParse } from 'pdf-parse'
import { MAX_OFFICE_FILE_BYTES } from './office-zip.js'

export interface PdfInput { markdown: string; title?: string; author?: string }
const MAX_INPUT_BYTES = 256 * 1024
const MAX_PAGES = 200
const MAX_PREVIEW_CHARACTERS = 120_000
function fail(message: string): never { throw new Error(`PDF: ${message}`) }

function inputText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)
    || Buffer.from(value, 'utf8').toString('utf8') !== value) fail(`${field} 必须是有效且有界的文本`)
  return value as string
}

// These are known installed CJK faces, not model-selected executable/font paths.
// A missing font is a capability error: Helvetica cannot silently stand in for Chinese.
function setBodyFont(document: PDFKit.PDFDocument, text: string): void {
  const unicode = /[^\u0000-\u00ff]/.test(text)
  if (!unicode) { document.font('Helvetica'); return }
  const windows = process.env.SystemRoot || 'C:\\Windows'
  const candidates: Array<[string, string | undefined]> = [
    [path.join(windows, 'Fonts', 'msyh.ttc'), 'MicrosoftYaHei'],
    [path.join(windows, 'Fonts', 'simsun.ttc'), 'SimSun'],
    ['/System/Library/Fonts/PingFang.ttc', 'PingFangSC-Regular'],
    ['/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', 'NotoSansCJKsc-Regular'],
    ['/usr/share/fonts/truetype/noto/NotoSansSC-Regular.ttf', undefined],
  ]
  for (const [file, family] of candidates) {
    if (!fs.existsSync(file)) continue
    try { if (family) document.font(file, family); else document.font(file); return } catch { /* Try only the remaining known faces. */ }
  }
  fail('CJK_FONT_UNAVAILABLE：未发现可嵌入的中文字体，未生成乱码 PDF。请由平台配置中文字体。')
}

const inlineText = (text: string): string => text.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1')
function tableCells(line: string): string[] {
  return line.trim().slice(1, -1).split(/(?<!\\)\|/).map(cell => inlineText(cell.trim().replace(/\\\|/g, '|')))
}

function drawTable(document: PDFKit.PDFDocument, headers: string[], rows: string[][]): void {
  if (!headers.length || headers.length > 6 || rows.length > 200) fail('表格最多 6 列、200 行；请拆分表格')
  if (headers.some(header => !header.trim())) fail('表头不能为空')
  for (const row of [headers, ...rows]) {
    if (row.length !== headers.length) fail('表格列数与表头不一致')
    if (row.some(value => value.length > 500)) fail('表格单元格超过 500 字符，请拆分内容')
  }
  const left = document.page.margins.left, width = document.page.width - left - document.page.margins.right
  const columnWidth = width / headers.length, padding = 7, innerWidth = columnWidth - padding * 2
  const height = (row: string[], header: boolean): number => {
    document.fontSize(header ? 10.5 : 10)
    return Math.max(28, ...row.map(cell => document.heightOfString(cell || ' ', { width: innerWidth, lineGap: 2 }) + padding * 2))
  }
  const headerHeight = height(headers, true), rowHeights = rows.map(row => height(row, false))
  const usable = document.page.height - document.page.margins.top - document.page.margins.bottom
  if (headerHeight > usable / 3 || rowHeights.some(value => value + headerHeight > usable)) fail('表格单行内容超过单页可用区域，请拆分行或缩短单元格')
  let y = document.y
  const bottom = () => document.page.height - document.page.margins.bottom
  const draw = (row: string[], rowHeight: number, header: boolean, stripe: boolean) => {
    for (const [index, value] of row.entries()) {
      const x = left + index * columnWidth
      document.save().lineWidth(0.5).rect(x, y, columnWidth, rowHeight)
        .fillAndStroke(header ? '#E8EEF5' : stripe ? '#F7F9FC' : '#FFFFFF', '#CBD5E1').restore()
      document.fontSize(header ? 10.5 : 10).fillColor(header ? '#17243B' : '#27364B').text(value, x + padding, y + padding,
        { width: innerWidth, lineGap: 2, align: !header && /^[+-]?[\d,.]+%?$/.test(value) ? 'right' : 'left' })
    }
    y += rowHeight
    document.x = left; document.y = y
  }
  if (y + headerHeight + (rowHeights[0] ?? 0) > bottom()) { document.addPage(); y = document.y }
  draw(headers, headerHeight, true, false)
  for (const [index, row] of rows.entries()) {
    if (y + rowHeights[index] > bottom()) { document.addPage(); y = document.y; draw(headers, headerHeight, true, false) }
    draw(row, rowHeights[index], false, index % 2 === 1)
  }
  document.x = left; document.y = y + 10
}

/** Native searchable PDF creation; this is not DOCX/PPTX source-format conversion. */
export async function createPdf(input: PdfInput): Promise<Buffer> {
  if (!input || typeof input !== 'object') fail('缺少文档参数')
  const markdown = inputText(input.markdown, 'markdown', MAX_INPUT_BYTES)
  if (!markdown.trim() || Buffer.byteLength(markdown) > MAX_INPUT_BYTES) fail('正文为空或超过 256 KiB')
  const title = input.title === undefined ? '' : inputText(input.title, 'title', 256)
  const author = input.author === undefined ? '' : inputText(input.author, 'author', 200)
  const document = new PDFDocument({ size: 'A4', margins: { top: 54, left: 54, right: 54, bottom: 58 },
    bufferPages: true, info: { Title: title, Author: author, Creator: 'Aether', Producer: 'Aether / PDFKit' } })
  const chunks: Buffer[] = []
  return new Promise<Buffer>((resolve, reject) => {
    let size = 0, pages = 1, failed = false
    const stop = (reason: unknown) => { if (failed) return; failed = true; reject(reason); document.destroy() }
    document.on('error', stop)
    document.on('pageAdded', () => { if (++pages > MAX_PAGES) fail(`超过 ${MAX_PAGES} 页上限`) })
    document.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_OFFICE_FILE_BYTES) { stop(new Error('PDF: 输出超过 32 MiB')); return }
      chunks.push(chunk)
    })
    document.on('end', () => { if (!failed) resolve(Buffer.concat(chunks)) })
    try {
      setBodyFont(document, `${title}\n${markdown}`)
      if (title) { document.fontSize(22).fillColor('#17243B').text(title, { lineGap: 5 }); document.moveDown(0.8) }
      const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
      for (let line = 0; line < lines.length; line++) {
        const raw = lines[line]
        if (!raw.trim()) { document.moveDown(0.4); continue }
        if (/^\s*\|.*\|\s*$/.test(raw) && line + 1 < lines.length && /^\s*\|.*\|\s*$/.test(lines[line + 1])) {
          const separator = tableCells(lines[line + 1])
          if (separator.every(cell => /^:?-{3,}:?$/.test(cell))) {
            const headers = tableCells(raw), rows: string[][] = []
            if (separator.length !== headers.length) fail('表格分隔行列数与表头不一致')
            line += 2
            while (line < lines.length && /^\s*\|.*\|\s*$/.test(lines[line])) rows.push(tableCells(lines[line++]))
            line--
            drawTable(document, headers, rows)
            continue
          }
        }
        const heading = /^(#{1,6})\s+(.+)$/.exec(raw)
        // A conservative Markdown subset preserves source text; unsupported syntax
        // remains visible rather than disappearing during a lossy HTML conversion.
        const text = inlineText(heading ? heading[2] : raw)
        const fontSize = heading ? Math.max(12, 21 - heading[1].length * 2) : 10.5
        document.fontSize(fontSize).fillColor(heading ? '#17243B' : '#27364B')
        const lineHeight = document.heightOfString(text, { width: 487, lineGap: 4 })
        if (heading && document.y + lineHeight + 35 > document.page.height - 58) document.addPage()
        document.text(text, { lineGap: 4, paragraphGap: heading ? 6 : 3 })
        if (heading) document.moveDown(0.2)
      }
      const range = document.bufferedPageRange()
      for (let index = range.start; index < range.start + range.count; index++) {
        document.switchToPage(index)
        const bottom = document.page.margins.bottom
        document.page.margins.bottom = 0
        document.fontSize(8).fillColor('#687487').text(`Aether · ${index + 1} / ${range.count}`, 54, document.page.height - 35,
          { width: document.page.width - 108, align: 'center', lineBreak: false })
        document.page.margins.bottom = bottom
      }
      document.end()
    } catch (reason) { stop(reason) }
  })
}

export async function inspectPdf(buffer: Buffer): Promise<{ format: 'pdf'; content: string; summary: Record<string, number | string | boolean>; warnings: string[] }> {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_OFFICE_FILE_BYTES || !buffer.subarray(0, 8).toString('ascii').startsWith('%PDF-')) fail('无效 PDF 或超过 32 MiB')
  const parser = new PDFParse({ data: new Uint8Array(buffer) })
  try {
    const info = await parser.getInfo()
    if (!info.total || info.total > MAX_PAGES) fail(`页数为空或超过 ${MAX_PAGES} 页上限`)
    const text = await parser.getText()
    const previewTruncated = text.text.length > MAX_PREVIEW_CHARACTERS
    const warnings = ['PDF 文本与页数已读取；未执行视觉布局验收，也不等同于 DOCX/PPTX 原版式转换。']
    if (!text.text.trim()) warnings.push('PDF 未提取到可检索文本；图片内容或扫描件需要单独 OCR。')
    if (previewTruncated) warnings.push(`文本预览只包含前 ${MAX_PREVIEW_CHARACTERS} 字符。`)
    return { format: 'pdf', content: text.text.slice(0, MAX_PREVIEW_CHARACTERS),
      summary: { pages: info.total, characters: text.text.length, previewTruncated }, warnings }
  } finally { await parser.destroy() }
}
