/** Real OOXML generation/edit/reopen checks, including formula-cache honesty and unrelated-part preservation. */
import { describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import { createHash } from 'node:crypto'
import { createXlsx, editXlsx, inspectXlsx, type XlsxInput } from '../xlsx.js'
import { readOfficeZip, writeOfficeZip } from '../office-zip.js'

const utf8 = (value: Uint8Array): string => Buffer.from(value).toString('utf8')
async function reopen(bytes: Buffer): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(Uint8Array.from(bytes).buffer)
  return workbook
}
function basic(): XlsxInput {
  return { sheets: [{ name: '季度预算', columns: [
    { key: 'id', header: '员工编号', type: 'text' },
    { key: 'amount', header: '金额（元）', type: 'number' },
    { key: 'date', header: '日期', type: 'date' },
    { key: 'ratio', header: '完成率', type: 'percent' },
    { key: 'notes', header: '备注' },
  ], rows: [
    { id: '00123', amount: 10, date: '2026-10-15', ratio: '12.5%', notes: '=SUM(B2:B3)' },
    { id: '00234', amount: 20, date: '2026-10-16', ratio: .8, notes: '中文 & <符号> 😀' },
    { id: '合计', amount: { formula: 'SUM(B2:B3)' }, date: null, ratio: null },
  ] }] }
}

describe('unified office XLSX', () => {
  it('writes real types, Chinese text, safe literal strings and professional print/table affordances', async () => {
    const bytes = await createXlsx(basic())
    expect(bytes.subarray(0, 2).toString()).toBe('PK')
    const book = await reopen(bytes), sheet = book.getWorksheet('季度预算')!
    expect(sheet.getCell('A2').value).toBe('00123')
    expect(sheet.getCell('B2').value).toBe(10)
    expect(sheet.getCell('C2').value).toEqual(new Date('2026-10-15T00:00:00Z'))
    expect(sheet.getCell('D2').value).toBe(.125)
    expect(sheet.getCell('D2').numFmt).toBe('0.00%')
    expect(sheet.getCell('E2').value).toBe('=SUM(B2:B3)')
    expect(sheet.getCell('E3').value).toBe('中文 & <符号> 😀')
    expect(sheet.getCell('B4').value).toEqual({ formula: 'SUM(B2:B3)', result: 30 })
    expect(sheet.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 })
    expect(sheet.autoFilter).toBe('A1:E4')
    expect(sheet.pageSetup).toMatchObject({ fitToWidth: 1, fitToPage: true, printTitlesRow: '1:1' })
    expect(sheet.getRow(1).getCell(1).font.bold).toBe(true)
    expect(sheet.getColumn(1).width).toBeGreaterThanOrEqual(12)
    expect(sheet.getCell('B2').dataValidation).toMatchObject({ type: 'decimal', allowBlank: true })
    const inspection = await inspectXlsx(bytes)
    expect(inspection.content).toContain('2026-10-15T00:00:00.000Z（日期）')
    expect(inspection.content).toContain('- B2: 10\n')
    expect(inspection.content).toContain('00123')
    expect(inspection.summary).toMatchObject({ sheets: 1, formulas: 1, formulaCaches: 1, pendingFormulas: 0 })
  })

  it('only computes supported aggregates; unresolved and cyclic formulas remain pending', async () => {
    const bytes = await createXlsx({ sheets: [{ name: '计算', columns: [{ key: 'a', header: '输入' }, { key: 'b', header: '结果' }], rows: [
      { a: 10, b: { formula: 'SUM(A2:A3)' } },
      { a: 20, b: { formula: 'AVERAGE(A2:A3)' } },
      { a: '文字', b: { formula: 'COUNT(A2:A4)' } },
      { a: 0, b: { formula: 'MIN(A2:A3)' } },
      { b: { formula: 'MAX(A2:A3)' } },
      { b: { formula: 'XLOOKUP(A2,A2:A3,B2:B3)' } },
      { b: { formula: 'SUM(B8:B8)' } },
    ] }] })
    const sheet = (await reopen(bytes)).getWorksheet('计算')!
    expect(sheet.getCell('B2').value).toEqual({ formula: 'SUM(A2:A3)', result: 30 })
    expect(sheet.getCell('B3').value).toEqual({ formula: 'AVERAGE(A2:A3)', result: 15 })
    expect(sheet.getCell('B4').value).toEqual({ formula: 'COUNT(A2:A4)', result: 2 })
    expect(sheet.getCell('B5').value).toEqual({ formula: 'MIN(A2:A3)', result: 10 })
    expect(sheet.getCell('B6').value).toEqual({ formula: 'MAX(A2:A3)', result: 20 })
    const inspection = await inspectXlsx(bytes)
    expect(inspection.summary).toMatchObject({ formulas: 7, formulaCaches: 5, pendingFormulas: 2 })
    expect(inspection.warnings.join('\n')).toContain('2 个公式没有有效缓存')
    expect(inspection.content).toContain('待重算，无有效缓存')
  })

  it('patches only intended cells while preserving styles, metadata and untouched package parts', async () => {
    const input = basic()
    input.sheets.push({ name: '保留中文', columns: [{ key: 'data', header: '其他数据' }], rows: [{ data: '不应丢失' }] })
    const entries = readOfficeZip(await createXlsx(input))
    entries['customXml/item1.xml'] = Buffer.from('<root><metadata>保留自定义扩展</metadata></root>')
    entries['xl/media/opaque.bin'] = Buffer.from([0, 1, 2, 255, 7, 8])
    const original = writeOfficeZip(entries), originalDigest = createHash('sha256').update(original).digest('hex')
    const bytes = await editXlsx(original, [
      { sheet: '季度预算', cell: 'B2', value: 25 },
      { sheet: '季度预算', cell: 'E3', value: '更新后的中文' },
      { sheet: '季度预算', cell: 'A6', value: '新增行 006' },
    ])
    expect(createHash('sha256').update(original).digest('hex')).toBe(originalDigest)
    const output = readOfficeZip(bytes)
    for (const [name, before] of Object.entries(entries)) {
      if (['xl/worksheets/sheet1.xml', 'xl/workbook.xml'].includes(name)) continue
      expect(Buffer.from(output[name]), `unchanged ${name}`).toEqual(Buffer.from(before))
    }
    const sheet = (await reopen(bytes)).getWorksheet('季度预算')!
    expect(sheet.getCell('B2').value).toBe(25)
    expect(sheet.getCell('B2').numFmt).toBe('#,##0.00;[Red](#,##0.00)')
    expect(sheet.getCell('B4').value).toEqual({ formula: 'SUM(B2:B3)', result: 45 })
    expect(sheet.getCell('E3').value).toBe('更新后的中文')
    expect(sheet.getCell('A6').value).toBe('新增行 006')
    expect(sheet.getCell('A2').value).toBe('00123')
    expect((await reopen(bytes)).getWorksheet('保留中文')!.getCell('A2').value).toBe('不应丢失')
  })

  it('invalidates unsupported stale caches throughout the workbook and removes obsolete calc chains', async () => {
    const entries = readOfficeZip(await createXlsx({ sheets: [{ name: '数据', columns: [{ key: 'n', header: '值' }, { key: 'f', header: '公式' }], rows: [{ n: 1, f: { formula: 'A2*2' } }] }] }))
    entries['xl/worksheets/sheet1.xml'] = Buffer.from(utf8(entries['xl/worksheets/sheet1.xml']).replace('<f>A2*2</f>', '<f>A2*2</f><v>999</v>'))
    entries['xl/calcChain.xml'] = Buffer.from('<calcChain xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><c r="B2" i="1"/></calcChain>')
    entries['xl/_rels/workbook.xml.rels'] = Buffer.from(utf8(entries['xl/_rels/workbook.xml.rels']).replace('</Relationships>', '<Relationship Id="rIdChain" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/calcChain" Target="calcChain.xml"/></Relationships>'))
    entries['[Content_Types].xml'] = Buffer.from(utf8(entries['[Content_Types].xml']).replace('</Types>', '<Override PartName="/xl/calcChain.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"/></Types>'))
    const bytes = await editXlsx(writeOfficeZip(entries), [{ sheet: '数据', cell: 'A2', value: 4 }]), output = readOfficeZip(bytes)
    expect(output['xl/calcChain.xml']).toBeUndefined()
    expect(utf8(output['xl/_rels/workbook.xml.rels'])).not.toContain('calcChain')
    expect(utf8(output['[Content_Types].xml'])).not.toContain('calcChain')
    expect(utf8(output['xl/workbook.xml'])).toContain('forceFullCalc="1"')
    expect(utf8(output['xl/worksheets/sheet1.xml'])).not.toContain('999')
    expect((await inspectXlsx(bytes)).summary).toMatchObject({ pendingFormulas: 1, formulaCaches: 0 })
    expect((await reopen(bytes)).getWorksheet('数据')!.getCell('B2').formula).toBe('A2*2')
  })

  it('rejects an entire invalid edit batch and preserves the input bytes', async () => {
    const original = await createXlsx(basic()), before = Buffer.from(original)
    await expect(editXlsx(original, [{ sheet: '季度预算', cell: 'B2', value: 99 }, { sheet: '不存在', cell: 'A1', value: '失败' }])).rejects.toThrow('工作表不存在')
    expect(original).toEqual(before)
    expect((await reopen(original)).getWorksheet('季度预算')!.getCell('B2').value).toBe(10)
    await expect(editXlsx(original, [{ sheet: '季度预算', cell: 'B2', value: 99 }, { sheet: '季度预算', cell: 'b2', value: 100 }])).rejects.toThrow('重复编辑')
    await expect(editXlsx(original, [{ sheet: '季度预算', cell: 'XFE1', value: 99 }])).rejects.toThrow('超出 Excel 范围')
    await expect(editXlsx(original, [{ sheet: '季度预算', cell: 'B2', value: '10' }])).rejects.toThrow('数据验证')
  })

  it('keeps leading-equals edit values as literal strings and Date edits as dates', async () => {
    const bytes = await editXlsx(await createXlsx(basic()), [
      { sheet: '季度预算', cell: 'E2', value: '=HYPERLINK("https://example.invalid")' },
      { sheet: '季度预算', cell: 'A2', value: '00007' },
      { sheet: '季度预算', cell: 'C2', value: new Date('2026-11-01T00:00:00Z') },
      { sheet: '季度预算', cell: 'B4', value: { formula: 'SUM(B2:B3,5)' } },
    ])
    const sheet = (await reopen(bytes)).getWorksheet('季度预算')!
    expect(sheet.getCell('E2').type).toBe(ExcelJS.ValueType.String)
    expect(sheet.getCell('E2').value).toBe('=HYPERLINK("https://example.invalid")')
    expect(sheet.getCell('A2').value).toBe('00007')
    expect(sheet.getCell('C2').value).toEqual(new Date('2026-11-01T00:00:00Z'))
    expect(sheet.getCell('B4').value).toEqual({ formula: 'SUM(B2:B3,5)', result: 35 })
  })

  it('refuses edits into merged subordinate cells, array ranges and structured table sheets', async () => {
    const bytes = await createXlsx(basic()), entries = readOfficeZip(bytes), file = 'xl/worksheets/sheet1.xml'
    const xml = utf8(entries[file])
    entries[file] = Buffer.from(xml.replace('</worksheet>', '<mergeCells count="1"><mergeCell ref="A6:B6"/></mergeCells></worksheet>'))
    await expect(editXlsx(writeOfficeZip(entries), [{ sheet: '季度预算', cell: 'B6', value: 'x' }])).rejects.toThrow('合并区域从属')
    entries[file] = Buffer.from(xml.replace('<f>SUM(B2:B3)</f>', '<f t="array" ref="B4:C5">SUM(B2:B3)</f>'))
    await expect(editXlsx(writeOfficeZip(entries), [{ sheet: '季度预算', cell: 'C5', value: 6 }])).rejects.toThrow('数组/共享/区域公式')
    entries[file] = Buffer.from(xml.replace('</worksheet>', '<tableParts count="1"><tablePart r:id="rIdTable"/></tableParts></worksheet>'))
    await expect(editXlsx(writeOfficeZip(entries), [{ sheet: '季度预算', cell: 'E2', value: 'x' }])).rejects.toThrow('结构化表格')
  })

  it('rejects unrepresentable values, invalid dates, malformed schemas and size overruns before output', async () => {
    await expect(createXlsx({ sheets: [] })).rejects.toThrow('sheets')
    const duplicate = basic(); duplicate.sheets.push({ ...duplicate.sheets[0] })
    await expect(createXlsx(duplicate)).rejects.toThrow('名称重复')
    const invalidDate = basic(); invalidDate.sheets[0].rows[0].date = '2026-02-30'
    await expect(createXlsx(invalidDate)).rejects.toThrow('无效日期')
    const unknownColumn = basic(); unknownColumn.sheets[0].rows[0].typo = 5
    await expect(createXlsx(unknownColumn)).rejects.toThrow('未声明的列')
    const invalidNumber = basic(); invalidNumber.sheets[0].rows[0].amount = Infinity
    await expect(createXlsx(invalidNumber)).rejects.toThrow('有限 number')
    const invalidObject = basic(); invalidObject.sheets[0].rows[0].notes = { message: 'unsupported' }
    await expect(createXlsx(invalidObject)).rejects.toThrow('显式')
    const long = basic(); long.sheets[0].rows[0].notes = 'x'.repeat(32_768)
    await expect(createXlsx(long)).rejects.toThrow('32767')
    const external = basic(); external.sheets[0].rows[0].amount = { formula: '[book.xlsx]Sheet1!A1' }
    await expect(createXlsx(external)).rejects.toThrow('外部工作簿')
  })

  it('does not use cached error cells as valid aggregate values', async () => {
    const entries = readOfficeZip(await createXlsx({ sheets: [{ name: '错误传播', columns: [{ key: 'a', header: '输入' }, { key: 'b', header: '公式' }], rows: [{ a: 10, b: { formula: 'SUM(A2:A3)' } }, { a: 20 }] }] }))
    entries['xl/worksheets/sheet1.xml'] = Buffer.from(utf8(entries['xl/worksheets/sheet1.xml']).replace(/<c r="A3"([^>]*)>[\s\S]*?<\/c>/, '<c r="A3" t="e"><v>#DIV/0!</v></c>'))
    const bytes = await editXlsx(writeOfficeZip(entries), [{ sheet: '错误传播', cell: 'C2', value: '触发重算' }])
    expect((await inspectXlsx(bytes)).summary).toMatchObject({ pendingFormulas: 1, formulaCaches: 0 })
  })

  it('discloses cell text preview truncation while retaining the complete file value', async () => {
    const fullText = '办公长段落'.repeat(200)
    const bytes = await createXlsx({ sheets: [{ name: '长文本', columns: [{ header: '原文', key: 'text' }], rows: [{ text: fullText }] }] })
    const inspection = await inspectXlsx(bytes)
    expect(inspection.summary.previewTruncated).toBe(true)
    expect(inspection.warnings.join('\n')).toContain('仅预览前 600 字符')
    expect((await reopen(bytes)).getWorksheet('长文本')!.getCell('A2').value).toBe(fullText)
  })
})
