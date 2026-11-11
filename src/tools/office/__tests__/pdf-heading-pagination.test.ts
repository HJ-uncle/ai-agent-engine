/** New targeted pagination regression, including the exact round-2 PDF input.
 * Parses real PDF text geometry; no model, old E2E or external Office process. */
import fs from 'node:fs'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { describe, expect, it } from 'vitest'
import { createPdf, type PdfInput } from '../pdf.js'

const production = JSON.parse(fs.readFileSync(new URL('./fixtures/pdf-heading-production.json', import.meta.url), 'utf8')) as { input: PdfInput; expectedText: string }
const filler = (count: number) => Array.from({ length: count }, (_, index) => `CONTEXT_${index + 1}`).join('\n')
const body = (count: number) => Array.from({ length: count }, (_, index) => `BODY${String(index).padStart(2, '0')}`).join(' ')
const chain = (count: number, words: number) => `${filler(count)}\n\n## Parent heading\n\n### Child heading\n\n${body(words)}`

async function pages(input: PdfInput) {
  const pdf = await getDocument({ data: new Uint8Array(await createPdf(input)), useSystemFonts: true }).promise
  try {
    const result: Array<Array<{ text: string; y: number; height: number }>> = []
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number), content = await page.getTextContent()
      result.push(content.items.flatMap(item => 'str' in item && item.str.trim() && !/^\d+\s*\/\s*\d+$/.test(item.str)
        ? [{ text: item.str, y: item.transform[5], height: item.height }] : []))
    }
    return result
  } finally { await pdf.destroy() }
}
const text = (page: Array<{ text: string }>) => page.map(item => item.text).join('\n')
function bodyText(result: Array<Array<{ text: string }>>): string {
  const headers = [['项目', '内容'], ['步骤', '操作', '说明'], ['文件', '类型', '职责'], ['事项', '现状']]
  return result.map((page, index) => {
    // A changed page break legitimately repeats the table header. Only omit
    // that exact prefix on continuation pages when comparing source content.
    const repeated = index > 0 && headers.find(header => header.every((value, at) => page[at]?.text === value))
    return (repeated ? page.slice(repeated.length) : page).map(item => item.text).join('')
  }).join('').replace(/\s/g, '')
}

describe('PDF heading chains keep their following content', () => {
  it('moves the real consecutive Chinese headings with their paragraph and preserves every source character', async () => {
    const result = await pages(production.input)
    expect(result).toHaveLength(4)
    expect(text(result[0])).not.toContain('三、主要功能')
    expect(text(result[1])).toContain('三、主要功能')
    expect(text(result[1])).toContain('对局与棋盘')
    const paragraph = result[1].filter(item => item.text.includes('三种棋盘规格') || item.text.includes('电脑执白'))
    expect(paragraph.length).toBeGreaterThanOrEqual(2)
    expect(bodyText(result)).toBe(production.expectedText)
  })

  it('keeps a short three-line paragraph whole after both headings at a page boundary', async () => {
    const result = await pages({ markdown: chain(28, 28) })
    expect(result).toHaveLength(2)
    expect(text(result[0])).not.toContain('Parent heading')
    for (const marker of ['Parent heading', 'Child heading', 'BODY00', 'BODY27']) expect(text(result[1])).toContain(marker)
    expect(result[1].filter(item => item.text.startsWith('BODY'))).toHaveLength(3)
  })

  it('keeps the same heading chain on the current page when its full short paragraph fits', async () => {
    const result = await pages({ markdown: chain(27, 28) })
    expect(result).toHaveLength(1)
    for (const marker of ['Parent heading', 'Child heading', 'BODY00', 'BODY27']) expect(text(result[0])).toContain(marker)
  })

  it('reserves at least two lines of long prose without unnecessarily moving the entire paragraph', async () => {
    const result = await pages({ markdown: chain(28, 100) })
    expect(result).toHaveLength(2)
    expect(text(result[0])).toContain('Parent heading')
    expect(text(result[0])).toContain('Child heading')
    expect(result[0].filter(item => item.text.startsWith('BODY')).length).toBeGreaterThanOrEqual(2)
    expect(text(result[1])).toContain('BODY99')
    const markers = result.flat().flatMap(item => item.text.match(/BODY\d{2}/g) ?? [])
    expect(markers).toEqual(Array.from({ length: 100 }, (_, index) => `BODY${String(index).padStart(2, '0')}`))
  })

  it('retains a wrapped heading chain with the actual table header and first multiline row', async () => {
    const title = 'Parent heading spanning multiple lines '.repeat(4).trim()
    const detail = 'First-row-detail '.repeat(24).trim()
    const result = await pages({ markdown: `${filler(25)}\n\n## ${title}\n\n### Child table heading\n\n| Item | Explanation |\n| --- | --- |\n| First row | ${detail} |\n| Last row | Complete |` })
    expect(result).toHaveLength(2)
    expect(text(result[0])).not.toContain('Parent heading')
    for (const marker of ['Parent heading', 'Child table heading', 'Explanation', 'First row', 'Last row', 'Complete']) expect(text(result[1])).toContain(marker)
    const lines = result[1].filter(item => item.text.includes('First-row-detail'))
    expect(lines.length).toBeGreaterThan(1)
    const header = result[1].find(item => item.text === 'Explanation')!
    expect(Math.min(...lines.map(item => item.y))).toBeGreaterThan(58)
    expect(header.y).toBeGreaterThan(Math.max(...lines.map(item => item.y)))
  })

  it('does not create a blank initial page for an oversized heading chain', async () => {
    const headings = Array.from({ length: 32 }, (_, index) => `## HEADING_${index + 1}`).join('\n\n')
    const result = await pages({ markdown: `${headings}\n\nTAIL-CONTENT` })
    expect(result.length).toBeGreaterThan(1)
    expect(text(result[0])).toContain('HEADING_1')
    expect(result.every(page => page.length > 0)).toBe(true)
    expect(result.flat().map(item => item.text).filter(value => /^HEADING_\d+$/.test(value))).toHaveLength(32)
    expect(text(result.at(-1)!)).toContain('TAIL-CONTENT')
  })

  it('uses natural pagination for 70 consecutive short headings instead of starting a page for each heading', async () => {
    const headings = Array.from({ length: 70 }, (_, index) => `## HEADING_${index + 1}`).join('\n\n')
    const result = await pages({ markdown: `${headings}\n\nTAIL-CONTENT` })
    expect(result.length).toBeGreaterThan(1)
    expect(result.length).toBeLessThanOrEqual(6)
    expect(result.every(page => page.length > 0)).toBe(true)
    expect(result.flat().map(item => item.text).filter(value => /^HEADING_\d+$/.test(value)))
      .toEqual(Array.from({ length: 70 }, (_, index) => `HEADING_${index + 1}`))
    expect(text(result.at(-1)!)).toContain('TAIL-CONTENT')
  })
})
