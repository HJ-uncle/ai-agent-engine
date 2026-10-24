/** Add sheets to real OOXML without resaving original sheets/objects through ExcelJS. */
import ExcelJS from 'exceljs'
import { describe, expect, it } from 'vitest'
import { appendXlsxSheets, createXlsx, editXlsx, inspectXlsx, type XlsxInput } from '../xlsx.js'
import { readOfficeZip, writeOfficeZip } from '../office-zip.js'
import { zipSync } from 'fflate'

const text = (bytes: Uint8Array) => Buffer.from(bytes).toString('utf8')
const main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const relationships = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const sheet = (name = '新增校验'): XlsxInput => ({ sheets: [{ name, columns: [
  { key: 'id', header: '编号', type: 'text' }, { key: 'amount', header: '金额', type: 'number' },
  { key: 'date', header: '日期', type: 'date' }, { key: 'ratio', header: '完成率', type: 'percent' },
], rows: [{ id: '0007', amount: 10, date: '2026-10-24', ratio: '12.5%' },
  { id: '0008', amount: 20 }, { id: '=文字', amount: { formula: 'SUM(B2:B3)' } }] }] })
const reopen = async (bytes: Buffer) => { const book = new ExcelJS.Workbook(); await book.xlsx.load(Uint8Array.from(bytes).buffer); return book }

describe('bounded XLSX sheet append', () => {
  it.each(['existing-defined-names', 'before-calc-pr', 'after-sheets'])('preserves dollar replacement tokens as literal XML data (%s)', async layout => {
    const names = ['费用$$收入', '费用$&收入', "费用$'收入", '费用$`收入']
    const literal = "原文 $$ $& $' $`", oldName = "原$&$$$'$`表"
    const book = new ExcelJS.Workbook(), old = book.addWorksheet(oldName)
    old.getCell('A1').value = literal
    old.getCell('A2').value = 123
    old.getCell('A2').numFmt = '"$$ $& $\' $`"0.00'
    old.getCell('A2').font = { name: literal }
    const before = readOfficeZip(Buffer.from(await book.xlsx.writeBuffer()))
    if (layout === 'existing-defined-names') {
      const area = `'${oldName.replace(/'/g, "''")}'!$A$1:$B$2`.replace(/&/g, '&amp;')
      // Use a valid quoted reference even when the source name has apostrophes.
      before['xl/workbook.xml'] = Buffer.from(text(before['xl/workbook.xml']).replace('</sheets>', () => `</sheets><definedNames><definedName name="_xlnm.Print_Area" localSheetId="0">${area}</definedName></definedNames>`))
    }
    if (layout === 'after-sheets') before['xl/workbook.xml'] = Buffer.from(text(before['xl/workbook.xml']).replace(/<calcPr\b[^>]*\/>/, ''))
    expect((await reopen(writeOfficeZip(before))).getWorksheet(oldName)!.getCell('A1').value).toBe(literal)
    const oldWorkbook = text(before['xl/workbook.xml']), oldStyles = text(before['xl/styles.xml'])
    const oldSheets = oldWorkbook.match(/<sheets\b[^>]*>([\s\S]*?)<\/sheets>/)![1]
    const oldDefinitions = oldWorkbook.match(/<definedNames\b[^>]*>([\s\S]*?)<\/definedNames>/)?.[1]
    const output = await appendXlsxSheets(writeOfficeZip(before), { sheets: names.map(name => ({ name,
      columns: [{ key: 'value', header: literal, type: 'text' }], rows: [{ value: literal }] })) })
    const after = readOfficeZip(output), reopened = await reopen(output)
    expect(reopened.worksheets.map(value => value.name)).toEqual([oldName, ...names])
    expect(text(after['xl/workbook.xml'])).toContain(oldSheets)
    if (oldDefinitions) expect(text(after['xl/workbook.xml'])).toContain(oldDefinitions)
    for (const tag of ['font', 'numFmt']) for (const original of oldStyles.match(new RegExp(`<${tag}\\b[^>]*(?:\\/>|>[\\s\\S]*?<\\/${tag}>)`, 'g')) ?? []) {
      expect(text(after['xl/styles.xml'])).toContain(original)
    }
    expect(Buffer.from(after['xl/worksheets/sheet1.xml'])).toEqual(Buffer.from(before['xl/worksheets/sheet1.xml']))
    for (const name of names) {
      const added = reopened.getWorksheet(name)!
      expect(added.getCell('A1').value).toBe(literal)
      expect(added.getCell('A2').value).toBe(literal)
      expect(added.pageSetup).toMatchObject({ printTitlesRow: '1:1', printArea: 'A1:A2' })
    }
    const edited = await reopen(await editXlsx(output, [{ sheet: names[0], cell: 'A2', value: literal + ' edited' }]))
    expect(edited.getWorksheet(names[0])!.getCell('A1').value).toBe(literal)
    expect(edited.getWorksheet(names[0])!.getCell('A2').value).toBe(literal + ' edited')
    expect(edited.getWorksheet(oldName)!.getCell('A1').value).toBe(literal)
  })

  it('adds formatted typed sheets, preserving old sheets/styles indexes and linked image/table/custom parts', async () => {
    const book = new ExcelJS.Workbook(), old = book.addWorksheet('旧数据')
    old.addTable({ name: 'OriginalTable', ref: 'A1', headerRow: true, columns: [{ name: '旧值' }], rows: [[7], [8]] })
    old.getCell('C2').value = { formula: 'INDIRECT("新增校验!B2")', result: 999 }
    const image = book.addImage({ base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jv1sAAAAASUVORK5CYII=', extension: 'png' })
    old.addImage(image, 'E1:F3')
    const before = readOfficeZip(Buffer.from(await book.xlsx.writeBuffer()))
    before['customXml/item1.xml'] = Buffer.from('<custom>opaque metadata</custom>')
    before['xl/charts/chart99.xml'] = Buffer.from('<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart><c:plotArea/></c:chart></c:chartSpace>')
    const original = writeOfficeZip(before), appended = await appendXlsxSheets(original, sheet()), after = readOfficeZip(appended)
    const mutable = new Set(['xl/workbook.xml', 'xl/_rels/workbook.xml.rels', '[Content_Types].xml', 'xl/styles.xml'])
    for (const [name, bytes] of Object.entries(before)) if (!mutable.has(name)) expect(Buffer.from(after[name]), name).toEqual(Buffer.from(bytes))
    expect(text(after['xl/worksheets/sheet1.xml'])).toContain('999')
    const reopened = await reopen(appended), added = reopened.getWorksheet('新增校验')!
    expect(reopened.worksheets.map(value => value.name)).toEqual(['旧数据', '新增校验'])
    expect(reopened.getWorksheet('旧数据')!.getCell('C2').value).toEqual({ formula: 'INDIRECT("新增校验!B2")', result: 999 })
    expect(added.getCell('A2').value).toBe('0007')
    expect(added.getCell('A4').value).toBe('=文字')
    expect(added.getCell('B4').value).toEqual({ formula: 'SUM(B2:B3)', result: 30 })
    expect(added.getCell('C2').value).toEqual(new Date('2026-10-24T00:00:00Z'))
    expect(added.getCell('D2').value).toBe(.125)
    expect(added.getCell('D2').numFmt).toBe('0.00%')
    expect(added.getCell('A1').font.bold).toBe(true)
    expect(added.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 })
    expect(added.autoFilter).toBe('A1:D4')
    expect(added.pageSetup).toMatchObject({ printTitlesRow: '1:1', printArea: 'A1:D4', fitToWidth: 1 })
    expect(text(after['xl/workbook.xml'])).toContain('forceFullCalc="1"')
    expect((await inspectXlsx(appended)).summary.sheets).toBe(2)
  })

  it('keeps the original 1904 date system and appends another batch without renumbering earlier sheets', async () => {
    const book = new ExcelJS.Workbook(); book.properties.date1904 = true
    book.addWorksheet('原日期').getCell('A1').value = new Date('2026-10-01T00:00:00Z')
    const first = await appendXlsxSheets(Buffer.from(await book.xlsx.writeBuffer()), sheet("客户 ' 台账"))
    const second = await appendXlsxSheets(first, sheet('第二批'))
    const firstParts = readOfficeZip(first), secondParts = readOfficeZip(second)
    expect(secondParts['xl/worksheets/sheet2.xml']).toEqual(firstParts['xl/worksheets/sheet2.xml'])
    const actual = await reopen(second)
    expect(actual.properties.date1904).toBe(true)
    expect(actual.getWorksheet("客户 ' 台账")!.getCell('C2').value).toEqual(new Date('2026-10-24T00:00:00Z'))
    expect(actual.getWorksheet('第二批')!.getCell('C2').value).toEqual(new Date('2026-10-24T00:00:00Z'))
    expect(actual.getWorksheet("客户 ' 台账")!.pageSetup.printTitlesRow).toBe('1:1')
  })

  it('allocates unused relationship/part/sheet IDs and removes only the actual calc-chain link/part/override', async () => {
    const parts = readOfficeZip(await createXlsx(sheet('原表')))
    parts['xl/worksheets/sheet2.xml'] = Buffer.from('<opaque>reserved orphan part</opaque>')
    parts['xl/custom-chain.xml'] = Buffer.from(`<calcChain xmlns="${main}"><c r="B4" i="1"/></calcChain>`)
    parts['xl/keep.xml'] = Buffer.from('<keep>unrelated</keep>')
    parts['xl/_rels/workbook.xml.rels'] = Buffer.from(text(parts['xl/_rels/workbook.xml.rels']).replace('</Relationships>', `<Relationship Id="aetherSheet1" Type="${relationships}/customXml" Target="keep.xml"/><Relationship Id="chain-link" Type="${relationships}/calcChain" Target="custom-chain.xml"/></Relationships>`))
    parts['[Content_Types].xml'] = Buffer.from(text(parts['[Content_Types].xml']).replace('</Types>', '<Override PartName="/xl/custom-chain.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"/><Override PartName="/xl/keep.xml" ContentType="application/xml"/></Types>'))
    const output = readOfficeZip(await appendXlsxSheets(writeOfficeZip(parts), sheet()))
    expect(output['xl/custom-chain.xml']).toBeUndefined()
    expect(Buffer.from(output['xl/worksheets/sheet2.xml'])).toEqual(Buffer.from(parts['xl/worksheets/sheet2.xml']))
    expect(output['xl/worksheets/sheet3.xml']).toBeDefined()
    expect(Buffer.from(output['xl/keep.xml'])).toEqual(Buffer.from(parts['xl/keep.xml']))
    expect(text(output['xl/_rels/workbook.xml.rels'])).toContain('Id="aetherSheet2"')
    expect(text(output['xl/_rels/workbook.xml.rels'])).toContain('Target="keep.xml"')
    expect(text(output['[Content_Types].xml'])).toContain('PartName="/xl/keep.xml"')
    expect(text(output['xl/_rels/workbook.xml.rels'])).not.toContain('custom-chain.xml')
    expect(text(output['[Content_Types].xml'])).not.toContain('custom-chain.xml')
  })

  it('refuses protected structure, signatures, duplicate names and a duplicate-name batch without changing source bytes', async () => {
    const original = await createXlsx(sheet('Original')), before = Buffer.from(original)
    await expect(appendXlsxSheets(original, sheet('original'))).rejects.toThrow(/已存在/)
    await expect(appendXlsxSheets(original, { sheets: [sheet('重复').sheets[0], sheet('重复').sheets[0]] })).rejects.toThrow(/重复/)
    const parts = readOfficeZip(original)
    parts['xl/workbook.xml'] = Buffer.from(text(parts['xl/workbook.xml']).replace('<sheets>', '<workbookProtection lockStructure="1"/><sheets>'))
    await expect(appendXlsxSheets(writeOfficeZip(parts), sheet())).rejects.toThrow(/结构已保护/)
    const signed = readOfficeZip(original); signed['_xmlsignatures/sig1.xml'] = Buffer.from('<signature/>')
    await expect(appendXlsxSheets(Buffer.from(zipSync(signed)), sheet())).rejects.toThrow(/signed/)
    expect(original).toEqual(before)
  })

  it('bounds each append and final sheet count and fails safely on a calc-chain misdirected at another part', async () => {
    const original = await createXlsx({ sheets: Array.from({ length: 24 }, (_, i) => ({ name: '表' + i, columns: [{ key: 'v', header: '值' }], rows: [] })) })
    await expect(appendXlsxSheets(original, sheet())).rejects.toThrow(/24/)
    await expect(appendXlsxSheets(original, { sheets: Array.from({ length: 5 }, (_, i) => sheet('新增' + i).sheets[0]) })).rejects.toThrow(/1-4/)
    const parts = readOfficeZip(await createXlsx(sheet('原表')))
    parts['xl/_rels/workbook.xml.rels'] = Buffer.from(text(parts['xl/_rels/workbook.xml.rels']).replace('</Relationships>', `<Relationship Id="malformed-chain" Type="${relationships}/calcChain" Target="styles.xml"/></Relationships>`))
    await expect(appendXlsxSheets(writeOfficeZip(parts), sheet())).rejects.toThrow(/计算链部件/)
  })
})
