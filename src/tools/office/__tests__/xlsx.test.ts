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
  it('accepts an empty date in a totals row without converting empty text or valid dates', async () => {
    const input = basic()
    input.sheets[0].rows[2].date = ''
    input.sheets[0].rows[2].id = ''
    const bytes = await createXlsx(input), sheet = (await reopen(bytes)).getWorksheet('季度预算')!
    expect(sheet.getCell('C4').value).toBeNull()
    expect(sheet.getCell('C4').numFmt).toBe('yyyy-mm-dd')
    expect(sheet.getCell('C4').dataValidation).toMatchObject({ type: 'date', allowBlank: true })
    expect(sheet.getCell('C2').value).toEqual(new Date('2026-10-15T00:00:00Z'))
    expect(sheet.getCell('A4').value).toBe('')
    expect(sheet.getCell('B4').value).toEqual({ formula: 'SUM(B2:B3)', result: 30 })
    expect((await inspectXlsx(bytes)).content).not.toContain('1899-12-30')
  })

  it.each([' ', '—', '2026-02-30', '2026-11-25T10:00:00'])('still rejects nonempty invalid dates: %j', async value => {
    const input = basic()
    input.sheets[0].rows[2].date = value
    await expect(createXlsx(input)).rejects.toThrow(/日期/)
  })

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

  it('diagnoses the compliance check strings at their exact cells without converting or counting them as formulas', async () => {
    const match = (row: number) => `=IF(ABS(D${row}-E${row})<0.0001,"一致","不一致")`
    const bytes = await createXlsx({ sheets: [{ name: '校验表', columns: [
      { key: 'id', header: '校验项ID' }, { key: 'name', header: '校验项' }, { key: 'method', header: '公式/口径' },
      { key: 'actual', header: '实测值', type: 'number' }, { key: 'expected', header: '预期值', type: 'number' },
      { key: 'match', header: '是否一致', type: 'text' },
    ], rows: [...Array.from({ length: 8 }, (_, i) => ({ id: `V${i + 1}`, actual: 6, expected: 6, match: match(i + 2) })),
      { id: 'V9', actual: 6, expected: 6, match: { formula: match(10) } }] }] })
    const before = Buffer.from(bytes), inspection = await inspectXlsx(bytes)
    const warning = inspection.warnings.find(value => value.includes('文本单元格不是公式'))!
    expect(warning).toContain('8 个以 = 开头的文本单元格')
    for (let row = 2; row <= 9; row++) expect(warning).toContain(`"校验表"!F${row}`)
    expect(warning).not.toContain('"校验表"!F10')
    expect(warning).toContain('{formula: "..."}')
    expect(warning).toContain('原文本未更改，未自动执行')
    expect(inspection.content).toContain(`- F2: 文本（以 = 开头，非公式）：${match(2)}`)
    expect(inspection.summary).toMatchObject({ formulas: 1, formulaCaches: 0, pendingFormulas: 1 })
    expect(inspection.warnings.join('\n')).toContain('1 个公式没有有效缓存')
    expect(bytes).toEqual(before)
    const sheet = (await reopen(bytes)).getWorksheet('校验表')!
    expect(sheet.getCell('F2').value).toBe(match(2))
    expect(sheet.getCell('F2').type).toBe(ExcelJS.ValueType.String)
    expect(sheet.getCell('F2').numFmt).toBe('@')
    expect(sheet.getCell('F10').formula).toBe(match(10).slice(1))
  })

  it('keeps intentional equals text and distinguishes a formula whose saved result starts with equals', async () => {
    const book = new ExcelJS.Workbook(), sheet = book.addWorksheet("客户 ' 注释")
    sheet.getCell('A1').value = '=SUM(B2:B3)'
    sheet.getCell('B1').value = { formula: '"=SUM(B2:B3)"', result: '=SUM(B2:B3)' }
    sheet.getCell('C1').value = '普通文字'
    const bytes = Buffer.from(await book.xlsx.writeBuffer()), before = Buffer.from(bytes)
    const inspection = await inspectXlsx(bytes)
    const warning = inspection.warnings.find(value => value.includes('文本单元格不是公式'))!
    expect(warning).toContain('1 个以 = 开头的文本单元格')
    expect(warning).toContain('"客户 \' 注释"!A1')
    expect(warning).not.toContain('!B1')
    expect(inspection.summary).toMatchObject({ formulas: 1, formulaCaches: 1, pendingFormulas: 0 })
    expect(inspection.content).toContain('文件缓存 =SUM(B2:B3)（未独立验证）')
    expect(bytes).toEqual(before)
  })

  it('finds formula-looking text beyond the preview while bounding diagnostic locations', async () => {
    const bytes = await createXlsx({ sheets: [
      { name: '前部数据', columns: [{ key: 'n', header: '值' }], rows: Array.from({ length: 2_000 }, (_, n) => ({ n })) },
      { name: '后部校验', columns: [{ key: 'v', header: '校验' }], rows: Array.from({ length: 30 }, () => ({ v: '=SUM(A1:A2)' })) },
    ] })
    const inspection = await inspectXlsx(bytes)
    expect(inspection.summary).toMatchObject({ formulas: 0, pendingFormulas: 0, previewCells: 2_000, previewTruncated: true })
    expect(inspection.content).not.toContain('=SUM(A1:A2)')
    const warnings = inspection.warnings.filter(value => value.includes('文本单元格不是公式'))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('30 个以 = 开头的文本单元格')
    expect(warnings[0]).toContain('列出 20/30')
    expect(warnings[0]).toContain('"后部校验"!A2')
    expect(warnings[0]).toContain('"后部校验"!A21')
    expect(warnings[0]).not.toContain('"后部校验"!A22')
    expect(warnings[0].length).toBeLessThan(2_500)
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
    const inspection = await inspectXlsx(bytes)
    expect(inspection.warnings.join('\n')).toContain('"季度预算"!E2')
    expect(inspection.content).toContain('- E2: 文本（以 = 开头，非公式）：=HYPERLINK')
  })

  it('edits date targets through JSON ISO values and clears them without coercing text targets', async () => {
    const edits = JSON.parse(JSON.stringify([
      { sheet: '季度预算', cell: 'C2', value: '2026-11-28' },
      { sheet: '季度预算', cell: 'C3', value: '' },
      { sheet: '季度预算', cell: 'C4', value: null },
      { sheet: '季度预算', cell: 'A2', value: '2026-11-28' },
      { sheet: '季度预算', cell: 'A3', value: '' },
    ]))
    const bytes = await editXlsx(await createXlsx(basic()), edits), sheet = (await reopen(bytes)).getWorksheet('季度预算')!
    expect(sheet.getCell('C2').value).toEqual(new Date('2026-11-28T00:00:00Z'))
    expect(sheet.getCell('C3').value).toBeNull()
    expect(sheet.getCell('C4').value).toBeNull()
    expect(sheet.getCell('C3').numFmt).toBe('yyyy-mm-dd')
    expect(sheet.getCell('C3').dataValidation).toMatchObject({ type: 'date', allowBlank: true })
    expect(sheet.getCell('A2').value).toBe('2026-11-28')
    expect(sheet.getCell('A2').type).toBe(ExcelJS.ValueType.String)
    // ExcelJS reads an empty inline string as null; the package must still retain its text type.
    const emptyText = utf8(readOfficeZip(bytes)['xl/worksheets/sheet1.xml']).match(/<c\b[^>]*\br="A3"[^>]*>[\s\S]*?<\/c>/)?.[0]
    expect(emptyText).toContain('t="inlineStr"')
    expect(emptyText).toContain('<t xml:space="preserve"></t>')
  })

  it('recognizes date validation without date formatting and still enforces required dates', async () => {
    const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('日期校验')
    const first = new Date('2026-01-01T00:00:00Z'), last = new Date('2026-12-31T00:00:00Z')
    sheet.getCell('A1').value = 46023
    sheet.getCell('A1').dataValidation = { type: 'date', operator: 'between', allowBlank: false, formulae: [first, last] }
    const original = Buffer.from(await book.xlsx.writeBuffer())
    const changed = await editXlsx(original, [{ sheet: '日期校验', cell: 'A1', value: '2026-11-28' }])
    const actual = (await reopen(changed)).getWorksheet('日期校验')!.getCell('A1')
    expect(actual.value).toBe(new Date('2026-11-28T00:00:00Z').getTime() / 86_400_000 + 25_569)
    expect(actual.dataValidation).toMatchObject({ type: 'date' })
    await expect(editXlsx(original, [{ sheet: '日期校验', cell: 'A1', value: '' }])).rejects.toThrow('数据验证')
    await expect(editXlsx(original, [{ sheet: '日期校验', cell: 'A1', value: '2027-01-01' }])).rejects.toThrow('数据验证范围')
  })

  it('recognizes existing date formats and the 1904 system while preserving intentionally textual date-like cells', async () => {
    const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('日期格式')
    book.properties.date1904 = true
    sheet.getCell('A1').value = new Date('2026-10-01T00:00:00Z')
    sheet.getCell('A1').numFmt = 'yyyy-mm-dd'
    sheet.getCell('A2').value = '日期说明'
    sheet.getCell('A2').numFmt = 'yyyy-mm-dd'
    sheet.getCell('A3').numFmt = 'yyyy-mm-dd'
    const bytes = await editXlsx(Buffer.from(await book.xlsx.writeBuffer()), [
      { sheet: '日期格式', cell: 'A1', value: '2026-11-28T12:30:00+08:00' },
      { sheet: '日期格式', cell: 'A2', value: '2026-11-28' },
      { sheet: '日期格式', cell: 'A3', value: '2026-12-01' },
    ])
    const actual = (await reopen(bytes)).getWorksheet('日期格式')!
    expect(actual.getCell('A1').value).toEqual(new Date('2026-11-28T04:30:00Z'))
    expect(actual.getCell('A2').value).toBe('2026-11-28')
    expect(actual.getCell('A3').value).toEqual(new Date('2026-12-01T00:00:00Z'))
  })

  it.each([' ', '—', '2026-02-30', '2026-11-25T10:00:00'])('rejects invalid JSON date edits atomically: %j', async value => {
    const original = await createXlsx(basic()), before = Buffer.from(original)
    await expect(editXlsx(original, [
      { sheet: '季度预算', cell: 'B2', value: 99 },
      { sheet: '季度预算', cell: 'C2', value },
    ])).rejects.toThrow(/日期/)
    expect(original).toEqual(before)
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
