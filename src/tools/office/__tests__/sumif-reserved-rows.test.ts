/** Real regression from the Work acceptance workbook: reserved blank rows
 * must allow a later feature to enter its existing status summary formulas. */
import ExcelJS from 'exceljs'
import { describe, expect, it } from 'vitest'
import { recalculateXlsx } from '../recalculate.js'

async function recalculate(book: ExcelJS.Workbook): Promise<ExcelJS.Workbook> {
  const result = new ExcelJS.Workbook()
  const bytes = await recalculateXlsx(Buffer.from(await book.xlsx.writeBuffer()))
  await result.xlsx.load(Uint8Array.from(bytes).buffer)
  return result
}

describe('SUMIF with reserved rows', () => {
  it('keeps a 100-row formula range and includes a new row 31 without rebuilding the workbook', async () => {
    const book = new ExcelJS.Workbook(), source = book.addWorksheet('功能清单'), summary = book.addWorksheet('汇总')
    source.addRow(['编号', '功能', '模块', '状态', '计数', '备注'])
    for (let index = 1; index <= 29; index++) source.addRow([
      `F${String(index).padStart(3, '0')}`, `功能 ${index}`, '测试模块', index <= 23 ? '已实现' : index <= 25 ? '未提供' : '待核实', 1, '',
    ])
    const formulas = {
      B2: 'COUNTA(功能清单!A2:A100)',
      B3: 'SUMIF(功能清单!D2:D100,"已实现",功能清单!E2:E100)',
      B4: 'SUMIF(功能清单!D2:D100,"未提供",功能清单!E2:E100)',
      B5: 'SUMIF(功能清单!D2:D100,"待核实",功能清单!E2:E100)',
    }
    for (const [cell, formula] of Object.entries(formulas)) summary.getCell(cell).value = { formula, result: 999 }
    const initial = await recalculate(book)
    expect(['B2', 'B3', 'B4', 'B5'].map(cell => initial.getWorksheet('汇总')!.getCell(cell).result)).toEqual([29, 23, 2, 4])
    initial.getWorksheet('功能清单')!.getRow(31).values = ['F030', '验收新增条目', '测试', '已实现', 1, '仅隔离夹具测试']
    const updated = await recalculate(initial), updatedSummary = updated.getWorksheet('汇总')!
    expect(['B2', 'B3', 'B4', 'B5'].map(cell => updatedSummary.getCell(cell).result)).toEqual([30, 24, 2, 4])
    for (const [cell, formula] of Object.entries(formulas)) expect(updatedSummary.getCell(cell).formula).toBe(formula)
    expect(updated.getWorksheet('功能清单')!.getCell('A31').value).toBe('F030')
    expect(updated.getWorksheet('功能清单')!.getCell('D32').value).toBeNull()
  })

  it('skips true blanks for positive text/wildcards and does not coerce sum-range strings or booleans', async () => {
    const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('数据')
    sheet.addRows([['Apple', 10], [null, 1000], ['apple', 20], ['a*b', 40], ['Apple', '100'], ['Apple', true], ['Apple', null]])
    for (const [index, [criterion]] of [['apple', 30], ['=APPLE', 30], ['Ap*', 30], ['a~*b', 40]].entries()) {
      sheet.getCell(`D${index + 1}`).value = { formula: `SUMIF(A1:A10,"${criterion}",B1:B10)`, result: 999 }
    }
    const result = (await recalculate(book)).getWorksheet('数据')!
    expect(['D1', 'D2', 'D3', 'D4'].map(cell => result.getCell(cell).result)).toEqual([30, 30, 30, 40])
    expect(result.getCell('B5').value).toBe('100')
    expect(result.getCell('B6').value).toBe(true)
  })

  it.each(['0', '"=0"', '""', '"="', '"<>已实现"', '"<>"'])('keeps ambiguous blank/coercion semantics explicit for criterion %s', async criterion => {
    const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('数据')
    sheet.addRows([[null, 100], [null, 10]])
    sheet.getCell('D1').value = { formula: `SUMIF(A1:A2,${criterion},B1:B2)`, result: 999 }
    await expect(recalculate(book)).rejects.toThrow('blank range cells are outside the current calculation contract')
    expect(sheet.getCell('D1').result).toBe(999)
  })

  it.each(['criteria', 'sum'] as const)('does not hide an error in the %s range behind an unmatched/blank row', async location => {
    const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('数据')
    sheet.addRows([['已实现', 1], [null, null]])
    sheet.getCell(location === 'criteria' ? 'A2' : 'B2').value = { error: '#N/A' }
    sheet.getCell('D1').value = { formula: 'SUMIF(A1:A4,"已实现",B1:B4)', result: 999 }
    await expect(recalculate(book)).rejects.toThrow(/error|#N\/A/)
    expect(sheet.getCell('D1').result).toBe(999)
  })
})
