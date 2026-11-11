/** Real generated packages: readable page tables and native workbook styling,
 * with unchanged content/formulas. No model, app export, or external Office. */
import ExcelJS from 'exceljs'
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { describe, expect, it } from 'vitest'
import { createDocx, inspectDocx } from '../docx.js'
import { createPdf } from '../pdf.js'
import { documentBodyWithoutRepeatedTitle } from '../document-layout.js'
import { readOfficeZip } from '../office-zip.js'
import { appendXlsxSheets, createXlsx, type XlsxInput } from '../xlsx.js'

describe('Office page layout and styles', () => {
  it('only coalesces an identical leading title and keeps body headings, case and punctuation', () => {
    expect(documentBodyWithoutRepeatedTitle('\n# Project notes\n\nBody\n\n# Project notes', 'Project notes'))
      .toBe('\nBody\n\n# Project notes')
    expect(documentBodyWithoutRepeatedTitle('\r\n# **Project notes** ###\r\nBody', 'Project notes')).toBe('Body')
    expect(documentBodyWithoutRepeatedTitle('# C#\rBody', 'C#')).toBe('Body')
    for (const markdown of ['# Different title\nBody', '## Project notes\nBody',
      'Introduction\n\n# Project notes', '```\n# Project notes\n```', '# project notes\nBody', '# Project notes!\nBody']) {
      expect(documentBodyWithoutRepeatedTitle(markdown, 'Project notes')).toBe(markdown)
    }
    expect(documentBodyWithoutRepeatedTitle('# Project notes\nBody')).toBe('# Project notes\nBody')
  })

  it('renders a matching title once in actual Word/PDF output without losing later headings or metadata', async () => {
    for (const markdown of ['# Project notes', '# **Project notes**\n\nBody stays intact.\n\n## Project notes\n\nEnding stays intact.']) {
      const docx = await createDocx({ title: 'Project notes', markdown })
      const wordContent = (await inspectDocx(docx)).content
      const entries = readOfficeZip(docx)
      expect(Buffer.from(entries['docProps/core.xml']).toString()).toContain('<dc:title>Project notes</dc:title>')
      const bytes = await createPdf({ title: 'Project notes', markdown })
      const pdf = await getDocument({ data: new Uint8Array(bytes), useSystemFonts: true }).promise
      try {
        const content = await (await pdf.getPage(1)).getTextContent()
        const pdfContent = content.items.flatMap(item => 'str' in item ? [item.str] : []).join('\n')
        const expected = markdown.includes('Ending') ? 2 : 1
        expect(wordContent.match(/Project notes/g)).toHaveLength(expected)
        expect(pdfContent.match(/Project notes/g)).toHaveLength(expected)
        expect((await pdf.getMetadata()).info).toMatchObject({ Title: 'Project notes' })
        if (expected === 2) for (const text of [wordContent, pdfContent]) {
          expect(text).toContain('Body stays intact.')
          expect(text).toContain('Ending stays intact.')
        }
      } finally { await pdf.destroy() }
    }
  })

  it('preserves different metadata and first-heading titles in actual Word and PDF content', async () => {
    const input = { title: 'Document title', markdown: '# Section title\n\nUnchanged body.' }
    const word = (await inspectDocx(await createDocx(input))).content
    const pdf = await getDocument({ data: new Uint8Array(await createPdf(input)), useSystemFonts: true }).promise
    try {
      const content = await (await pdf.getPage(1)).getTextContent()
      const text = content.items.flatMap(item => 'str' in item ? [item.str] : []).join('\n')
      for (const output of [word, text]) for (const expected of ['Document title', 'Section title', 'Unchanged body.']) expect(output).toContain(expected)
    } finally { await pdf.destroy() }
  })

  it('gives descriptive Word columns space while keeping exact text and automatic row height', async () => {
    const description = '保留完整的功能说明，让长说明列拥有足够宽度，并且在需要时自然换行。'
    const buffer = await createDocx({ title: '项目说明', markdown: `## 功能清单\n\n| 编号 | 功能说明 | 数量 |\n| --- | --- | ---: |\n| 001 | ${description} | 12 |\n| 002 | 保留原始数据 | 3 |` })
    const entries = readOfficeZip(buffer), xml = Buffer.from(entries['word/document.xml']).toString('utf8')
    const widths = [...xml.matchAll(/<w:gridCol w:w="(\d+)"\/>/g)].map(match => Number(match[1]))
    expect(widths).toHaveLength(3)
    expect(widths[1]).toBeGreaterThan(widths[0] * 1.5)
    expect(widths.reduce((sum, value) => sum + value, 0)).toBe(9026)
    expect(xml).not.toContain('w:trHeight')
    expect(xml).toContain('w:fill="243247"')
    expect(xml).toContain('w:color w:val="FFFFFF"')
    expect(xml).toContain('<w:vAlign w:val="center"/>')
    expect((await inspectDocx(buffer)).content).toContain(description)
    expect((await inspectDocx(buffer)).content).toContain('001')
  })

  it('draws multiline PDF table rows with separated text bounds and repeated headers on later pages', async () => {
    const rows = Array.from({ length: 24 }, (_, index) => {
      const marker = `r${String(index + 1).padStart(2, '0')}`
      return `| ${index + 1} | ${Array.from({ length: 14 }, () => `${marker}-detail`).join(' ')} | ${100 + index} |`
    })
    const bytes = await createPdf({ title: 'Project notes', markdown: '| ID | Description | Count |\n| --- | --- | ---: |\n' + rows.join('\n') })
    const pdf = await getDocument({ data: new Uint8Array(bytes), useSystemFonts: true }).promise
    try {
      expect(pdf.numPages).toBeGreaterThan(1)
      const seen = new Set<string>()
      for (let number = 1; number <= pdf.numPages; number++) {
        const page = await pdf.getPage(number), content = await page.getTextContent()
        const operations = await page.getOperatorList()
        const fillColors = operations.fnArray.flatMap((operation, index) => operation === OPS.setFillRGBColor ? operations.argsArray[index] : [])
        expect(fillColors).toContain('#243247')
        expect(fillColors).toContain('#ffffff')
        expect(fillColors).toContain('#f7f9fc')
        const items = content.items.filter((item): item is Extract<typeof item, { str: string }> => 'str' in item)
        expect(items.filter(item => item.str === 'Description')).toHaveLength(1)
        const bounds = new Map<string, { top: number; bottom: number }>()
        for (const item of items) {
          const marker = /r\d{2}-detail/.exec(item.str)?.[0]
          if (!marker) continue
          seen.add(marker)
          const y = item.transform[5], previous = bounds.get(marker)
          bounds.set(marker, { top: Math.max(previous?.top ?? -Infinity, y + item.height), bottom: Math.min(previous?.bottom ?? Infinity, y) })
        }
        const ordered = [...bounds.values()].sort((a, b) => b.top - a.top)
        for (let index = 1; index < ordered.length; index++) expect(ordered[index - 1].bottom - ordered[index].top).toBeGreaterThan(8)
      }
      expect(seen.size).toBe(24)
    } finally { await pdf.destroy() }
  })

  it('keeps a PDF section heading with the following table header and first row near a page boundary', async () => {
    const filler = '| ID | Note |\n| --- | --- |\n' + Array.from({ length: 19 }, (_, i) => `| ${i + 1} | Context |`).join('\n')
    const detail = Array.from({ length: 50 }, () => 'detail').join(' ')
    const bytes = await createPdf({ markdown: `${filler}\n\n# Known limits\n\n| Item | Explanation |\n| --- | --- |\n| First finding | ${detail} |\n| Last finding | Final detail |` })
    const pdf = await getDocument({ data: new Uint8Array(bytes), useSystemFonts: true }).promise
    try {
      expect(pdf.numPages).toBe(2)
      const pageTexts: string[] = []
      for (let number = 1; number <= pdf.numPages; number++) {
        const content = await (await pdf.getPage(number)).getTextContent()
        pageTexts.push(content.items.flatMap(item => 'str' in item ? [item.str] : []).join('\n'))
      }
      expect(pageTexts[0]).not.toContain('Known limits')
      expect(pageTexts[1]).toContain('Known limits')
      expect(pageTexts[1]).toContain('Explanation')
      expect(pageTexts[1]).toContain('First finding')
      expect(pageTexts[1]).toContain('Last finding')
    } finally { await pdf.destroy() }
  })

  it('keeps typed workbook values and formulas while improving created and appended sheet views', async () => {
    const input: XlsxInput = { sheets: [{ name: '布局', columns: [
      { header: '项目', key: 'label', type: 'text', width: 16 },
      { header: '说明', key: 'note', width: 60 },
      { header: '数量', key: 'amount', type: 'number', width: 16 },
      { header: '自动值', key: 'auto', width: 16 },
    ], rows: [{ label: '0001', note: '长说明保持全部内容，并保留换行的可读性。', amount: 12.3456, auto: 9 },
      { label: '汇总', note: null, amount: { formula: 'SUM(C2:C2)' }, auto: { formula: 'SUM(D2:D2)' } }] }] }
    const base = await createXlsx({ sheets: [{ name: '已有', columns: [{ header: '原值', key: 'v' }], rows: [{ v: '不变' }] }] })
    for (const bytes of [await createXlsx(input), await appendXlsxSheets(base, input)]) {
      const book = new ExcelJS.Workbook()
      await book.xlsx.load(Uint8Array.from(bytes).buffer)
      const sheet = book.getWorksheet('布局')!
      expect(sheet.views[0].showGridLines).toBe(false)
      expect(sheet.pageSetup.orientation).toBe('landscape')
      expect(sheet.getCell('A1').alignment.horizontal).toBe('center')
      expect(sheet.getCell('A1').font.color).toEqual({ argb: 'FFFFFFFF' })
      expect(sheet.getCell('A2').value).toBe('0001')
      expect(sheet.getCell('C2').alignment.horizontal).toBe('right')
      expect(sheet.getCell('C2').value).toBe(12.3456)
      expect(sheet.getCell('C3').value).toEqual({ formula: 'SUM(C2:C2)', result: 12.3456 })
      expect(sheet.getCell('D3').value).toEqual({ formula: 'SUM(D2:D2)', result: 9 })
      expect(sheet.getCell('D3').alignment.horizontal).toBeUndefined()
    }
  })
})
