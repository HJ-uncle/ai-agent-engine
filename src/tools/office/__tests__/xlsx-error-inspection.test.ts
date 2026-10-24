/** Regresses a real finance workbook claiming zero errors while a late sheet had #NAME?. */
import ExcelJS from 'exceljs'
import { describe, expect, it } from 'vitest'
import { inspectXlsx } from '../xlsx.js'

describe('office saved error diagnostics', () => {
  it('finds saved errors beyond preview without mistaking literal error examples or empty caches for errors', async () => {
    const book = new ExcelJS.Workbook(), first = book.addWorksheet('校验表')
    for (let i = 1; i <= 2001; i++) first.getCell(i, 1).value = i === 1 ? 'PASS' : i
    const later = book.addWorksheet('12_版本差异桥')
    later.getCell('A27').value = { formula: 'V2 十一月末现金', result: { error: '#NAME?' } }
    later.getCell('B27').value = { error: '#DIV/0!' }
    later.getCell('C27').value = '#NAME?'
    later.getCell('D27').value = { formula: '"#REF!"', result: '#REF!' }
    later.getCell('E27').value = { formula: 'SUM(A28:A29)' }
    const bytes = Buffer.from(await book.xlsx.writeBuffer()), before = Buffer.from(bytes)
    const result = await inspectXlsx(bytes)
    expect(result.summary).toMatchObject({ errorCells: 2, formulaErrorCells: 1, formulas: 3, formulaCaches: 2, pendingFormulas: 1, previewCells: 2000, previewTruncated: true })
    expect(result.content).not.toContain('V2 十一月末现金')
    const warning = result.warnings.find(x => x.includes('已保存的错误单元格'))!
    expect(warning).toContain('"12_版本差异桥"!A27 ("#NAME?")')
    expect(warning).toContain('"12_版本差异桥"!B27 ("#DIV/0!")')
    expect(warning).not.toMatch(/!C27|!D27|!E27/)
    expect(warning).toContain('未重新计算')
    expect(bytes).toEqual(before)
  })

  it('bounds locations while counting all error cells, including hidden sheets', async () => {
    const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('隐藏错误', { state: 'hidden' })
    for (let i = 1; i <= 45; i++) sheet.getCell(i, 1).value = { formula: '1/0', result: { error: '#DIV/0!' } }
    const result = await inspectXlsx(Buffer.from(await book.xlsx.writeBuffer()))
    expect(result.summary).toMatchObject({ errorCells: 45, formulaErrorCells: 45 })
    const warnings = result.warnings.filter(x => x.includes('已保存的错误单元格'))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('列出 20/45')
    expect(warnings[0]).toContain('!A20 ')
    expect(warnings[0]).not.toContain('!A21 ')
    expect(warnings[0].length).toBeLessThan(2500)
  })

  it('does not claim a workbook is recalculated or business-correct when no saved error exists', async () => {
    const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('结果')
    sheet.getCell('A1').value = { formula: '1+1', result: 999 }
    const result = await inspectXlsx(Buffer.from(await book.xlsx.writeBuffer()))
    expect(result.summary).toMatchObject({ errorCells: 0, formulaErrorCells: 0, formulaCaches: 1 })
    expect(result.content).toContain('文件缓存 999（未独立验证）')
    expect(result.warnings.join('\n')).not.toContain('已保存的错误单元格')
  })
})
