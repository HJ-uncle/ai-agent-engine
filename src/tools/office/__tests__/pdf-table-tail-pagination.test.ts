/** Targeted table-tail regression: parse actual PDF page ownership and geometry,
 * including the case where moving a large pair would overflow a page. */
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createPdf, type PdfInput } from '../pdf.js'

const production = JSON.parse(fs.readFileSync(new URL('./fixtures/pdf-table-tail-production.json', import.meta.url), 'utf8')) as { input: PdfInput; expectedText: string }

const filler = (count: number) => Array.from({ length: count }, (_, index) => `CONTEXT_${index + 1}`).join('\n')
const table = (count: number) => '| Item | Description |\n| --- | --- |\n' + Array.from({ length: count }, (_, index) => `| ROW_${String(index + 1).padStart(2, '0')} | Complete detail |`).join('\n')

async function pages(input: string | PdfInput) {
  const document = await getDocument({ data: new Uint8Array(await createPdf(typeof input === 'string' ? { markdown: input } : input)), useSystemFonts: true }).promise
  try {
    const result: Array<Array<{ text: string; y: number; height: number }>> = []
    for (let index = 1; index <= document.numPages; index++) {
      const content = await (await document.getPage(index)).getTextContent()
      result.push(content.items.flatMap(item => 'str' in item && item.str.trim() && !/^\d+\s*\/\s*\d+$/.test(item.str)
        ? [{ text: item.str, y: item.transform[5], height: item.height }] : []))
    }
    return result
  } finally { await document.destroy() }
}
const rows = (page: Array<{ text: string }>) => page.flatMap(item => item.text.match(/ROW_\d{2}/g) ?? [])
function assertComplete(result: Awaited<ReturnType<typeof pages>>, count: number) {
  expect(result.flatMap(rows)).toEqual(Array.from({ length: count }, (_, index) => `ROW_${String(index + 1).padStart(2, '0')}`))
  for (const page of result) for (const item of page) {
    expect(item.y).toBeGreaterThanOrEqual(58)
    expect(item.y).toBeLessThanOrEqual(841.89 - 54 + .1)
    // PDF.js height is the full font em, not the cap-height above the baseline.
    expect(item.y + item.height).toBeLessThanOrEqual(841.89)
  }
}

describe('PDF final table rows stay together when safe', () => {
  it('keeps the last two real project-file rows on page 4, with every production character preserved', async () => {
    const result = await pages(production.input)
    expect(result).toHaveLength(5)
    expect(result[2].some(item => item.text === 'icons/icon.svg')).toBe(false)
    expect(result[3].filter(item => ['icons/icon.svg', 'README.md'].includes(item.text)).map(item => item.text)).toEqual(['icons/icon.svg', 'README.md'])
    expect(result[3].slice(0, 3).map(item => item.text)).toEqual(['文件', '类型', '职责'])
    expect(result[3].some(item => item.text === '七、边界与已知限制')).toBe(true)
    expect(result[3].some(item => item.text === '自动化测试')).toBe(true)
    const body = result.map((page, index) => index > 0 && ['文件', '类型', '职责'].every((value, at) => page[at]?.text === value) ? page.slice(3) : page)
      .flat().map(item => item.text).join('').replace(/\s/g, '')
    expect(body).toBe(production.expectedText)
    for (const item of result[3]) expect(item.y).toBeGreaterThanOrEqual(58)
  })

  it('moves the final two rows of a 12-row table instead of leaving one row on its continuation page', async () => {
    const result = await pages(`${filler(17)}\n\n${table(12)}`)
    expect(result).toHaveLength(2)
    expect(rows(result[0])).toHaveLength(10)
    expect(rows(result[1])).toEqual(['ROW_11', 'ROW_12'])
    expect(result[1].filter(item => item.text === 'Description')).toHaveLength(1)
    assertComplete(result, 12)
  })

  it('keeps all 12 rows on the current page when there is enough space', async () => {
    const result = await pages(`${filler(15)}\n\n${table(12)}`)
    expect(result).toHaveLength(1)
    assertComplete(result, 12)
  })

  it('leaves an existing three-row continuation unchanged rather than moving extra rows', async () => {
    const result = await pages(`${filler(20)}\n\n${table(12)}`)
    expect(result).toHaveLength(2)
    expect(rows(result[0])).toHaveLength(9)
    expect(rows(result[1])).toEqual(['ROW_10', 'ROW_11', 'ROW_12'])
    assertComplete(result, 12)
  })

  it('does not move an oversized final pair that can fit only on separate pages', async () => {
    const long = 'large '.repeat(70).trim()
    const wide = '| Item | Detail A | Detail B | Detail C | Detail D | Detail E |\n| --- | --- | --- | --- | --- | --- |\n'
      + '| Q1 | Start | Start | Start | Start | Start |\n'
      + ['Q2', 'Q3'].map(marker => `| ${marker} | ${Array.from({ length: 5 }, () => long).join(' | ')} |`).join('\n')
    const result = await pages(wide)
    expect(result).toHaveLength(2)
    expect(result[0].filter(item => /^Q\d$/.test(item.text)).map(item => item.text)).toEqual(['Q1', 'Q2'])
    expect(result[1].filter(item => /^Q\d$/.test(item.text)).map(item => item.text)).toEqual(['Q3'])
    expect(result[1].filter(item => item.text === 'Detail A')).toHaveLength(1)
    for (const item of result.flat()) expect(item.y).toBeGreaterThanOrEqual(58)
  })

  it('preserves a heading with the first row of a two-row table at the page boundary', async () => {
    const result = await pages(`${filler(29)}\n\n## Table heading\n\n${table(2)}`)
    expect(result).toHaveLength(2)
    expect(result[0].some(item => item.text === 'Table heading')).toBe(true)
    expect(rows(result[0])).toEqual(['ROW_01'])
    expect(rows(result[1])).toEqual(['ROW_02'])
    assertComplete(result, 2)
  })
})
