/** Real XLSX create/edit/reopen checks for aggregate coercion and honest pending caches. */
import { describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import { createXlsx, editXlsx, inspectXlsx, type XlsxInput } from '../xlsx.js'

const operations = ['SUM', 'AVERAGE', 'MIN', 'MAX', 'COUNT'] as const

async function reopen(bytes: Buffer): Promise<ExcelJS.Worksheet> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(Uint8Array.from(bytes).buffer)
  return workbook.getWorksheet('混合类型')!
}

function mixedInput(): XlsxInput {
  const values = [0, -4, 12.5, true, false, '100', '', null, '中文']
  return { sheets: [{ name: '混合类型', columns: [
    { key: 'input', header: '保留原始类型' },
    { key: 'range', header: '混合范围' },
    { key: 'nonNumeric', header: '非数字范围' },
    { key: 'literals', header: '范围和数字参数' },
    { key: 'references', header: '单独引用文本和布尔' },
    { key: 'missing', header: '未创建的空范围' },
  ], rows: values.map((input, i) => ({ input, ...(i < operations.length ? {
    range: { formula: `${operations[i]}(a2:$A$10)` },
    nonNumeric: { formula: `${operations[i]}(A5:A10)` },
    literals: { formula: `${operations[i]}($A$2:$A$10,5,-2,.5,1e1)` },
    references: { formula: `${operations[i]}(A5,A7)` },
    missing: { formula: `${operations[i]}(Z20:Z22)` },
  } : {}) })) }] }
}

function expectCaches(sheet: ExcelJS.Worksheet, column: string, results: Array<number | undefined>): void {
  for (const [index, result] of results.entries()) {
    const cell = sheet.getCell(`${column}${index + 2}`)
    expect(cell.formula, cell.address).toBeDefined()
    if (result === undefined) expect(cell.result, cell.address).toBeUndefined()
    else expect(cell.result, cell.address).toBeCloseTo(result, 12)
  }
}

describe('XLSX create/edit aggregate cache type semantics', () => {
  it('counts only numeric cells in references and ranges while preserving zero and negative numbers', async () => {
    const bytes = await createXlsx(mixedInput()), sheet = await reopen(bytes)
    expectCaches(sheet, 'B', [8.5, 8.5 / 3, -4, 12.5, 3])
    expectCaches(sheet, 'C', [0, undefined, 0, 0, 0])
    expectCaches(sheet, 'D', [22, 22 / 7, -4, 12.5, 7])
    expectCaches(sheet, 'E', [0, undefined, 0, 0, 0])
    expectCaches(sheet, 'F', [0, undefined, 0, 0, 0])
    expect(sheet.getCell('A5').value).toBe(true)
    expect(sheet.getCell('A6').value).toBe(false)
    expect(sheet.getCell('A7').value).toBe('100')
    expect(sheet.getCell('A8').value).toBe('')
    expect(sheet.getCell('A9').value).toBeNull()
    expect((await inspectXlsx(bytes)).summary).toMatchObject({ formulas: 25, formulaCaches: 22, pendingFormulas: 3 })
  })

  it('recomputes after edits change numeric cells to blank/text/boolean and ignored cells to numbers', async () => {
    const original = await createXlsx(mixedInput())
    const bytes = await editXlsx(original, [
      { sheet: '混合类型', cell: 'A2', value: null },
      { sheet: '混合类型', cell: 'A3', value: '200' },
      { sheet: '混合类型', cell: 'A4', value: false },
      { sheet: '混合类型', cell: 'A5', value: 7 },
      { sheet: '混合类型', cell: 'A6', value: -3 },
      { sheet: '混合类型', cell: 'A7', value: 0 },
    ])
    const sheet = await reopen(bytes)
    expectCaches(sheet, 'B', [4, 4 / 3, -3, 7, 3])
    expectCaches(sheet, 'C', [4, 4 / 3, -3, 7, 3])
    expectCaches(sheet, 'D', [17.5, 17.5 / 7, -3, 10, 7])
    expectCaches(sheet, 'E', [7, 3.5, 0, 7, 2])
    expectCaches(sheet, 'F', [0, undefined, 0, 0, 0])
    expect(sheet.getCell('A2').value).toBeNull()
    expect(sheet.getCell('A3').value).toBe('200')
    expect(sheet.getCell('A4').value).toBe(false)
    expect((await inspectXlsx(bytes)).summary).toMatchObject({ formulas: 25, formulaCaches: 24, pendingFormulas: 1 })
    expectCaches(await reopen(original), 'B', [8.5, 8.5 / 3, -4, 12.5, 3])
  })

  it('leaves unsupported direct logical/string expressions pending rather than claiming a coerced result', async () => {
    const formulas = ['SUM(TRUE)', 'AVERAGE(1,"3")', 'MIN(TRUE,FALSE)', 'MAX("4")', 'COUNT("10")', 'SUM(A2*2)', 'SUM(1e999)']
    const bytes = await createXlsx({ sheets: [{ name: '混合类型', columns: [{ key: 'value', header: '公式' }],
      rows: formulas.map(formula => ({ value: { formula } })),
    }] })
    const sheet = await reopen(bytes)
    for (const [i, formula] of formulas.entries()) {
      expect(sheet.getCell(`A${i + 2}`).formula).toBe(formula)
      expect(sheet.getCell(`A${i + 2}`).result).toBeUndefined()
    }
    expect((await inspectXlsx(bytes)).summary).toMatchObject({ formulas: 7, formulaCaches: 0, pendingFormulas: 7 })
  })

  it('recomputes supported dependencies without trusting stale caches or swallowing error dependencies', async () => {
    const book = new ExcelJS.Workbook(), source = book.addWorksheet('混合类型')
    source.getCell('A1').value = 4
    source.getCell('A2').value = true
    source.getCell('A3').value = '99'
    source.getCell('B1').value = { formula: 'SUM(A1:A3)', result: 999 }
    source.getCell('C1').value = { formula: 'COUNT(B1,A2:A3)', result: 999 }
    source.getCell('D1').value = { error: '#DIV/0!' }
    source.getCell('E1').value = { formula: 'SUM(D1,A1)', result: 999 }
    source.getCell('F1').value = { formula: 'SUM(E1,A1)', result: 999 }
    source.getCell('G1').value = { formula: 'A1*2', result: 999 }
    source.getCell('H1').value = { formula: 'SUM(G1,A1)', result: 999 }
    const original = Buffer.from(await book.xlsx.writeBuffer())
    const bytes = await editXlsx(original, [{ sheet: '混合类型', cell: 'A1', value: 8 }])
    const sheet = await reopen(bytes)
    expect(sheet.getCell('B1').result).toBe(8)
    expect(sheet.getCell('C1').result).toBe(1)
    expect(sheet.getCell('D1').value).toEqual({ error: '#DIV/0!' })
    for (const address of ['E1', 'F1', 'G1', 'H1']) expect(sheet.getCell(address).result, address).toBeUndefined()
    expect((await inspectXlsx(bytes)).summary).toMatchObject({ formulas: 6, formulaCaches: 2, pendingFormulas: 4, errorCells: 1 })
  })
})
