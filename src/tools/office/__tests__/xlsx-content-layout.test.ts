/** Content sizing and create/append parity on real in-memory OOXML; no UI/export workflow. */
import ExcelJS from 'exceljs'
import { describe, expect, it } from 'vitest'
import { appendXlsxSheets, createXlsx, type XlsxInput } from '../xlsx.js'
import { readOfficeZip, writeOfficeZip } from '../office-zip.js'

const reopen = async (bytes: Buffer): Promise<ExcelJS.Workbook> => {
  const book = new ExcelJS.Workbook()
  await book.xlsx.load(Uint8Array.from(bytes).buffer)
  return book
}
const input = (name = '内容布局'): XlsxInput => ({ sheets: [{ name, columns: [
  { header: '说明', key: 'note', type: 'text', width: 12 },
  { header: '数量', key: 'amount', type: 'number' },
  { header: '日期', key: 'date', type: 'date' },
  { header: '比例', key: 'ratio', type: 'percent' },
  { header: '描述', key: 'detail' },
], rows: [
  { note: '第一行\n第二行\n第三行\n第四行', amount: 3, date: '2026-11-10', ratio: '12.5%', detail: '这是一个不能只根据表头宽度判断的中文描述' },
  { note: '编号0001', amount: 0.000123456, date: null, ratio: 0.5 },
  { amount: { formula: 'SUM(B2:B3)' } },
  {},
] }] })
const base = (): Promise<Buffer> => createXlsx({ sheets: [{ name: '原表', columns: [{ header: '保留', key: 'value' }], rows: [{ value: '已有内容' }] }] })

describe('spreadsheet content layout', () => {
  it('allocates real saved height for explicit line breaks without changing the text', async () => {
    const book = await reopen(await createXlsx(input())), sheet = book.worksheets[0]
    expect(sheet.getRow(2).height).toBeGreaterThanOrEqual(64)
    expect(sheet.getRow(2).height).toBeLessThanOrEqual(409)
    expect(sheet.getCell('A2').value).toBe('第一行\n第二行\n第三行\n第四行')
    expect(sheet.getCell('A2').alignment.wrapText).toBe(true)
    expect(sheet.getColumn(1).width).toBe(12)
  })

  it('shares widths, heights, styles, validation and typed values between create and append', async () => {
    const created = (await reopen(await createXlsx(input()))).worksheets[0]
    const appended = (await reopen(await appendXlsxSheets(await base(), input()))).getWorksheet('内容布局')!
    expect(appended.getColumn(5).width).toBeGreaterThan(12)
    for (let column = 1; column <= 5; column++) expect(appended.getColumn(column).width).toBe(created.getColumn(column).width)
    for (let row = 1; row <= 5; row++) {
      expect(appended.getRow(row).height).toBe(created.getRow(row).height)
      for (let column = 1; column <= 5; column++) {
        const actual = appended.getCell(row, column), expected = created.getCell(row, column)
        expect(actual.value).toEqual(expected.value)
        expect(actual.numFmt || 'General').toBe(expected.numFmt || 'General')
        expect(actual.font.name).toBe(expected.font.name)
        expect(actual.font.size).toBe(expected.font.size)
        expect(Boolean(actual.font.bold)).toBe(Boolean(expected.font.bold))
        expect(actual.font.color).toEqual(expected.font.color)
        expect(actual.fill).toEqual(expected.fill)
        expect(actual.border.bottom).toEqual(expected.border.bottom)
        expect(actual.alignment).toEqual(expected.alignment)
        expect(actual.dataValidation).toEqual(expected.dataValidation)
      }
    }
    expect(appended.getCell('A3').fill).toMatchObject({ fgColor: { argb: 'FFF7F9FC' } })
    expect(appended.getCell('B5').dataValidation.type).toBe('decimal')
    expect(appended.getCell('B4').value).toEqual({ formula: 'SUM(B2:B3)', result: 3.000123456 })
  })

  it('accounts for data after row 100 when choosing automatic width', async () => {
    const values: XlsxInput = { sheets: [{ name: '晚出现长值', columns: [{ header: '描述', key: 'text' }],
      rows: [...Array.from({ length: 120 }, () => ({ text: '短值' })), { text: '这是在第一百行之后出现的很长说明内容' }] }] }
    const sheet = (await reopen(await createXlsx(values))).worksheets[0]
    expect(sheet.getColumn(1).width).toBeGreaterThan(30)
    expect(sheet.getColumn(1).width).toBeLessThanOrEqual(42)
    expect(sheet.getCell('A122').value).toBe(values.sheets[0].rows[120].text)
  })

  it('keeps ordinary numeric precision while retaining percent and text semantics', async () => {
    const values: XlsxInput = { sheets: [{ name: '类型', columns: [
      { header: '数值', key: 'number', type: 'number' }, { header: '比例', key: 'percent', type: 'percent' }, { header: '编号', key: 'text', type: 'text' },
    ], rows: [{ number: 0.000123456, percent: '12.5%', text: '0003' }, { number: 3, percent: 1 }, { number: -1e-20 }] }] }
    for (const bytes of [await createXlsx(values), await appendXlsxSheets(await base(), values)]) {
      const sheet = (await reopen(bytes)).getWorksheet('类型')!
      expect(sheet.getCell('A2').numFmt || 'General').toBe('General')
      expect(sheet.getCell('A2').value).toBe(0.000123456)
      expect(sheet.getCell('A3').value).toBe(3)
      expect(sheet.getCell('A4').value).toBe(-1e-20)
      expect(sheet.getCell('B2').numFmt).toBe('0.00%')
      expect(sheet.getCell('B2').value).toBe(0.125)
      expect(sheet.getCell('C2').numFmt).toBe('@')
      expect(sheet.getCell('C2').value).toBe('0003')
    }
  })

  it('preserves Date display precedence when a typed column receives a Date object', async () => {
    const date = new Date('2026-11-10T00:00:00Z')
    const values: XlsxInput = { sheets: [{ name: '日期对象', columns: [
      { header: '文字列日期', key: 'text', type: 'text' }, { header: '数值列日期', key: 'number', type: 'number' },
    ], rows: [{ text: date, number: date }] }] }
    for (const bytes of [await createXlsx(values), await appendXlsxSheets(await base(), values)]) {
      const sheet = (await reopen(bytes)).getWorksheet('日期对象')!
      for (const address of ['A2', 'B2']) {
        expect(sheet.getCell(address).numFmt).toBe('yyyy-mm-dd')
        expect(sheet.getCell(address).value).toEqual(date)
      }
    }
  })

  it('rejects cells taller than Excel can display and identifies the actual cell', async () => {
    const values = input('超高内容')
    values.sheets[0].rows[0].note = Array.from({ length: 40 }, () => '内容').join('\n')
    await expect(createXlsx(values)).rejects.toThrow(/超高内容!A2.*409.*拆分/)
    const original = await base(), copy = Buffer.from(original)
    await expect(appendXlsxSheets(original, values)).rejects.toThrow(/超高内容!A2.*409.*拆分/)
    expect(original).toEqual(copy)
  })

  it('wraps long headers and prose while respecting an explicit column width', async () => {
    const values: XlsxInput = { sheets: [{ name: '窄列', columns: [{ header: '这是多行表头', key: 'text', width: 8 }],
      rows: [{ text: 'A longer description with several words that wrap across lines.' }] }] }
    const sheet = (await reopen(await createXlsx(values))).worksheets[0]
    expect(sheet.getColumn(1).width).toBe(8)
    expect(sheet.getRow(1).height).toBeGreaterThan(28)
    expect(sheet.getRow(2).height).toBeGreaterThan(100)
    expect(sheet.getCell('A2').value).toBe(values.sheets[0].rows[0].text)
  })

  it('preserves original worksheets and opaque parts during styled append', async () => {
    const entries = readOfficeZip(await base())
    entries['customXml/item1.xml'] = Buffer.from('<custom>original metadata</custom>')
    const original = writeOfficeZip(entries), after = readOfficeZip(await appendXlsxSheets(original, input()))
    const mutable = new Set(['xl/workbook.xml', 'xl/_rels/workbook.xml.rels', '[Content_Types].xml', 'xl/styles.xml'])
    for (const [name, bytes] of Object.entries(entries)) if (!mutable.has(name)) expect(Buffer.from(after[name]), name).toEqual(Buffer.from(bytes))
  })

  it('writes date validation operands relative to an existing 1904 workbook', async () => {
    const source = new ExcelJS.Workbook()
    source.properties.date1904 = true
    source.addWorksheet('原表').getCell('A1').value = '保留'
    const original = Buffer.from(await source.xlsx.writeBuffer())
    const output = await appendXlsxSheets(original, input())
    const xml = Buffer.from(readOfficeZip(output)['xl/worksheets/sheet2.xml']).toString('utf8')
    expect(xml).toContain('<formula1>-1460</formula1>')
    expect((await reopen(output)).getWorksheet('内容布局')!.getCell('C2').value).toEqual(new Date('2026-11-10T00:00:00Z'))
  })
})
