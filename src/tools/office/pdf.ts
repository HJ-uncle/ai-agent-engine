import fs from 'node:fs'
import path from 'node:path'
import PDFDocument from 'pdfkit'
import { PDFParse } from 'pdf-parse'
import { MAX_OFFICE_FILE_BYTES } from './office-zip.js'
import { documentBodyWithoutRepeatedTitle, documentColumnWidths, DOCUMENT_TABLE_STYLE } from './document-layout.js'

export interface PdfInput { markdown: string; title?: string; author?: string }
const MAX_INPUT_BYTES = 256 * 1024
const MAX_PAGES = 200
const MAX_PREVIEW_CHARACTERS = 120_000
function fail(message: string): never { throw new Error(`PDF: ${message}`) }

function inputText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string' || value.length > maximum
    || Buffer.from(value, 'utf8').toString('utf8') !== value) fail(`${field} 必须是有效且有界的文本`)
  const control = /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f-\u009f]/.exec(value)
  if (control) fail(`${field} 含不支持的控制字符 U+${control[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}；请使用普通空格及换行`)
  return value
}

// PDFKit accepting a font only proves that it parses. Its actual selected face
// must cover the text too; an absent glyph otherwise becomes invisible/NUL text.
function missingGlyphs(document: PDFKit.PDFDocument, codePoints: number[]): number[] {
  const selected: unknown = Reflect.get(document, '_font')
  const face: unknown = selected && typeof selected === 'object' ? Reflect.get(selected, 'font') : undefined
  if (!face || typeof face !== 'object') fail('PDF_FONT_CHECK_UNAVAILABLE：无法核实实际字体，未生成 PDF')
  const hasGlyph: unknown = Reflect.get(face, 'hasGlyphForCodePoint')
  if (typeof hasGlyph === 'function') return codePoints.filter(code => Reflect.apply(hasGlyph, face, [code]) !== true)
  const glyphName: unknown = Reflect.get(face, 'characterToGlyph')
  if (typeof glyphName === 'function') return codePoints.filter(code => Reflect.apply(glyphName, face, [code]) === '.notdef')
  fail('PDF_FONT_CHECK_UNAVAILABLE：当前字体不支持字形检查，未生成 PDF')
}

// Known installed fonts only, never model-selected executable/font paths. A
// single face must cover the whole document so measuring and drawing agree.
function setBodyFont(document: PDFKit.PDFDocument, text: string): void {
  const codePoints = [...new Set(Array.from(`${text}\n0123456789 /`.replace(/[\r\n]/g, ''), character => character.codePointAt(0)!))]
  document.font('Helvetica')
  let missing = missingGlyphs(document, codePoints)
  if (!missing.length) return
  const windows = process.env.SystemRoot || 'C:\\Windows'
  const candidates: Array<[string, string | undefined]> = [
    [path.join(windows, 'Fonts', 'msyh.ttc'), 'MicrosoftYaHei'],
    [path.join(windows, 'Fonts', 'simsun.ttc'), 'SimSun'],
    ['/System/Library/Fonts/PingFang.ttc', 'PingFangSC-Regular'],
    ['/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', 'NotoSansCJKsc-Regular'],
    ['/usr/share/fonts/truetype/noto/NotoSansSC-Regular.ttf', undefined],
    [path.join(windows, 'Fonts', 'seguisym.ttf'), undefined],
    ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', undefined],
  ]
  let loaded = false
  for (const [file, family] of candidates) {
    if (!fs.existsSync(file)) continue
    try { if (family) document.font(file, family); else document.font(file) } catch { continue }
    loaded = true
    const remaining = missingGlyphs(document, codePoints)
    if (!remaining.length) return
    if (remaining.length < missing.length) missing = remaining
  }
  if (!loaded && /[\u2e80-\u9fff\uf900-\ufaff]/.test(text)) {
    fail('CJK_FONT_UNAVAILABLE：未发现可嵌入的中文字体，未生成乱码 PDF。请由平台配置中文字体。')
  }
  const codes = missing.slice(0, 8).map(code => `U+${code.toString(16).toUpperCase().padStart(4, '0')}`).join('、')
  fail(`PDF_GLYPH_UNAVAILABLE：未发现能完整显示本文的字体（缺少 ${codes}${missing.length > 8 ? ' 等' : ''}），未生成缺字 PDF。请由平台配置覆盖所需字符的字体。`)
}

const inlineText = (text: string): string => text.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1')
function tableCells(line: string): string[] {
  return line.trim().slice(1, -1).split(/(?<!\\)\|/).map(cell => inlineText(cell.trim().replace(/\\\|/g, '|')))
}

function tableLayout(document: PDFKit.PDFDocument, headers: string[], rows: string[][]) {
  if (!headers.length || headers.length > 6 || rows.length > 200) fail('表格最多 6 列、200 行；请拆分表格')
  if (headers.some(header => !header.trim())) fail('表头不能为空')
  for (const row of [headers, ...rows]) {
    if (row.length !== headers.length) fail('表格列数与表头不一致')
    if (row.some(value => value.length > 500)) fail('表格单元格超过 500 字符，请拆分内容')
  }
  const left = document.page.margins.left, width = document.page.width - left - document.page.margins.right
  const widths = documentColumnWidths([headers, ...rows], width), padding = 8
  const measure = (value: string, index: number) => document.heightOfString(value || ' ', {
    width: widths[index] - padding * 2, lineGap: 3, paragraphGap: 0,
  })
  const height = (row: string[], header: boolean): number => {
    document.fontSize(header ? 10.5 : 10)
    return Math.max(30, ...row.map((cell, index) => measure(cell, index) + padding * 2))
  }
  const headerHeight = height(headers, true), rowHeights = rows.map(row => height(row, false))
  const usable = document.page.height - document.page.margins.top - document.page.margins.bottom
  if (headerHeight > usable / 3 || rowHeights.some(value => value + headerHeight > usable)) fail('表格单行内容超过单页可用区域，请拆分行或缩短单元格')
  return { left, widths, padding, measure, headerHeight, rowHeights }
}

function markdownTableAt(lines: string[], line: number): { headers: string[]; rows: string[][]; next: number } | undefined {
  if (!/^\s*\|.*\|\s*$/.test(lines[line] ?? '') || !/^\s*\|.*\|\s*$/.test(lines[line + 1] ?? '')) return undefined
  const separator = tableCells(lines[line + 1])
  if (!separator.every(cell => /^:?-{3,}:?$/.test(cell))) return undefined
  const headers = tableCells(lines[line]), rows: string[][] = []
  if (separator.length !== headers.length) fail('表格分隔行列数与表头不一致')
  line += 2
  while (line < lines.length && /^\s*\|.*\|\s*$/.test(lines[line])) rows.push(tableCells(lines[line++]))
  return { headers, rows, next: line }
}

function drawTable(document: PDFKit.PDFDocument, headers: string[], rows: string[][]): void {
  const { left, widths, padding, measure, headerHeight, rowHeights } = tableLayout(document, headers, rows)
  let y = document.y
  let rowsOnPage = 0
  const bottom = () => document.page.height - document.page.margins.bottom
  const draw = (row: string[], rowHeight: number, header: boolean, stripe: boolean) => {
    let x = left
    for (const [index, value] of row.entries()) {
      const columnWidth = widths[index]
      document.save().lineWidth(0.5).rect(x, y, columnWidth, rowHeight)
        .fillAndStroke(header ? `#${DOCUMENT_TABLE_STYLE.header}` : stripe ? `#${DOCUMENT_TABLE_STYLE.stripe}` : '#FFFFFF', `#${DOCUMENT_TABLE_STYLE.border}`).restore()
      document.fontSize(header ? 10.5 : 10).fillColor(`#${header ? DOCUMENT_TABLE_STYLE.headerText : DOCUMENT_TABLE_STYLE.text}`)
      const textHeight = measure(value, index)
      document.text(value, x + padding, y + Math.max(padding, (rowHeight - textHeight) / 2),
        { width: columnWidth - padding * 2, lineGap: 3, paragraphGap: 0, align: !header && /^[+-]?[\d,.]+%?$/.test(value) ? 'right' : 'left' })
      x += columnWidth
    }
    y += rowHeight
    document.x = left; document.y = y
  }
  if (y + headerHeight + (rowHeights[0] ?? 0) > bottom()) { document.addPage(); y = document.y }
  draw(headers, headerHeight, true, false)
  for (const [index, row] of rows.entries()) {
    // Avoid a final page containing only the last data row. Move the final pair
    // only after this table has already drawn a row here, so a heading and its
    // first row stay together. Oversized pairs keep normal row-by-row paging.
    const tailHeight = index === rows.length - 2 ? rowHeights[index] + rowHeights[index + 1] : 0
    const keepTailTogether = rowsOnPage > 0 && tailHeight > 0 && y + tailHeight > bottom()
      && headerHeight + tailHeight <= bottom() - document.page.margins.top
    if (y + rowHeights[index] > bottom() || keepTailTogether) {
      document.addPage(); y = document.y; rowsOnPage = 0; draw(headers, headerHeight, true, false)
    }
    draw(row, rowHeights[index], false, index % 2 === 1)
    rowsOnPage++
  }
  document.x = left; document.y = y + 10
}

function headingGroupHeight(document: PDFKit.PDFDocument, lines: string[], start: number, width: number): number {
  const usable = document.page.height - document.page.margins.top - document.page.margins.bottom
  let height = 0, next = start
  while (next < lines.length) {
    const heading = /^(#{1,6})\s+(.+)$/.exec(lines[next])
    if (!heading) break
    document.fontSize(Math.max(11.5, 20 - heading[1].length * 2))
    if (next !== start || document.y > document.page.margins.top) height += 10
    height += document.heightOfString(inlineText(heading[2]), { width, lineGap: 4, paragraphGap: 8 })
    // An oversized heading chain cannot fit as a unit. Bound the lookahead and
    // let normal pagination proceed without inserting an empty first page.
    if (height > usable) return height
    next++
    while (next < lines.length && !lines[next].trim()) { height += 6; next++ }
    if (/^(#{1,6})\s+(.+)$/.test(lines[next] ?? '')) continue
    const table = markdownTableAt(lines, next)
    if (table) {
      const layout = tableLayout(document, table.headers, table.rows)
      return height + layout.headerHeight + (layout.rowHeights[0] ?? 0)
    }
    if (next < lines.length) {
      document.fontSize(11)
      const lineHeight = document.currentLineHeight(true) + 4
      const paragraphHeight = document.heightOfString(inlineText(lines[next]), { width, lineGap: 4, paragraphGap: 4 })
      // Keep short paragraphs whole; longer prose needs two visible lines after
      // the entire heading chain, not a fixed allowance consumed by subheads.
      height += paragraphHeight <= lineHeight * 3 + 4 + 0.01 ? paragraphHeight : lineHeight * 2
    }
    break
  }
  return height
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
      if (title) { document.fontSize(22).fillColor('#000000').text(title, { lineGap: 5 }); document.y += 18 }
      const textWidth = document.page.width - document.page.margins.left - document.page.margins.right
      const lines = documentBodyWithoutRepeatedTitle(markdown, title).replace(/\r\n?/g, '\n').split('\n')
      for (let line = 0; line < lines.length; line++) {
        const raw = lines[line]
        if (!raw.trim()) { document.y += 6; continue }
        const table = markdownTableAt(lines, line)
        if (table) {
          line = table.next - 1
          drawTable(document, table.headers, table.rows)
          continue
        }
        const heading = /^(#{1,6})\s+(.+)$/.exec(raw)
        // A conservative Markdown subset preserves source text; unsupported syntax
        // remains visible rather than disappearing during a lossy HTML conversion.
        const text = inlineText(heading ? heading[2] : raw)
        const fontSize = heading ? Math.max(11.5, 20 - heading[1].length * 2) : 11
        document.fontSize(fontSize).fillColor(heading ? '#000000' : `#${DOCUMENT_TABLE_STYLE.text}`)
        if (heading) {
          const groupHeight = headingGroupHeight(document, lines, line, textWidth)
          document.fontSize(fontSize)
          const bottom = document.page.height - document.page.margins.bottom
          // A chain longer than a full page must flow naturally; moving every
          // remaining oversized suffix would otherwise create one page per heading.
          if (groupHeight <= bottom - document.page.margins.top && document.y > document.page.margins.top && document.y + groupHeight > bottom) document.addPage()
        }
        if (heading && document.y > document.page.margins.top) document.y += 10
        document.text(text, { width: textWidth, lineGap: 4, paragraphGap: heading ? 8 : 4 })
      }
      const range = document.bufferedPageRange()
      for (let index = range.start; index < range.start + range.count; index++) {
        document.switchToPage(index)
        const bottom = document.page.margins.bottom
        document.page.margins.bottom = 0
        document.fontSize(8).fillColor('#687487').text(`${index + 1} / ${range.count}`, 54, document.page.height - 35,
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
