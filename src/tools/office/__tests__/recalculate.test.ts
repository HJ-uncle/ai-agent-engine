/** Real internal formula recalculation, package preservation, rejection, worker isolation and cancellation. */
import ExcelJS from 'exceljs'
import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { recalculateXlsx } from '../recalculate.js'
import { readOfficeZip, writeOfficeZip } from '../office-zip.js'

const text = (value: Uint8Array): string => Buffer.from(value).toString('utf8')
const reopen = async (bytes: Buffer): Promise<ExcelJS.Workbook> => {
  const book = new ExcelJS.Workbook(); await book.xlsx.load(Uint8Array.from(bytes).buffer); return book
}
async function fixture(formulas = ['SUM(数据!A1:A3)']): Promise<Buffer> {
  const book = new ExcelJS.Workbook(), data = book.addWorksheet('数据'), result = book.addWorksheet('汇总')
  data.addRows([[10], [20], [30]])
  for (const [index, formula] of formulas.entries()) result.getCell(`A${index + 1}`).value = { formula, result: 999 }
  return Buffer.from(await book.xlsx.writeBuffer())
}

describe('internal bounded XLSX recalculation', () => {
  it('actually calculates cross-sheet arithmetic, conditions and vertical SUMIF while preserving all unrelated parts', async () => {
    const book = new ExcelJS.Workbook(), source = book.addWorksheet('数据 源'), result = book.addWorksheet('经营摘要')
    source.addRows([['部门', '金额'], ['财务', 10.25], ['研发', 20.5], ['财务', -2]])
    const formulas: Array<[string, number | string | boolean]> = [
      ["SUM('数据 源'!B2:B4)", 28.75], ["AVERAGE('数据 源'!B2:B4)", 28.75 / 3],
      ['IF(A1>0,"盈利","亏损")', '盈利'], ['ROUND(A2,2)', 9.58],
      ['SUMIF(\'数据 源\'!A2:A4,"财务",\'数据 源\'!B2:B4)', 8.25],
      ['SUMIF(\'数据 源\'!B2:B4,">10",\'数据 源\'!B2:B4)', 30.75],
      ["'数据 源'!B2*2+'数据 源'!B3/2-1", 29.75], ['IFERROR(1/0,0)', 0],
      ["COUNT('数据 源'!B2:B4)", 3], ['A1=28.75', true],
      ["sum('数据 源'!$B$2:$B$4)", 28.75], ['SUMIF(\'数据 源\'!B2:B4,">10")', 30.75],
      ['ROUND(2.675,2)', 2.68], ['100*12%', 12], ['IF(A1<0,1,2)', 2],
    ]
    for (const [index, [formula]] of formulas.entries()) result.getCell(`A${index + 1}`).value = { formula, result: 999 }
    result.getCell('A1').numFmt = '#,##0.00'
    const entries = readOfficeZip(Buffer.from(await book.xlsx.writeBuffer()))
    entries['customXml/item1.xml'] = Buffer.from('<office>unrelated original content</office>')
    entries['xl/media/opaque.bin'] = Buffer.from([1, 2, 3, 4, 255])
    const original = writeOfficeZip(entries), originalCopy = Buffer.from(original), output = await recalculateXlsx(original)
    expect(original).toEqual(originalCopy)
    const actual = (await reopen(output)).getWorksheet('经营摘要')!, after = readOfficeZip(output)
    for (const [index, [formula, expected]] of formulas.entries()) {
      expect(actual.getCell(`A${index + 1}`).formula).toBe(formula)
      expect(actual.getCell(`A${index + 1}`).result, formula).toEqual(expected)
    }
    expect(actual.getCell('A1').numFmt).toBe('#,##0.00')
    for (const [name, content] of Object.entries(entries)) if (name !== 'xl/worksheets/sheet2.xml') expect(Buffer.from(after[name]), name).toEqual(Buffer.from(content))
    expect(Object.keys(after).sort()).toEqual(Object.keys(entries).sort())
  })

  it.each([false, true])('keeps Excel date serials and workbook date1904=%s untouched', async date1904 => {
    const book = new ExcelJS.Workbook(); book.properties.date1904 = date1904
    const sheet = book.addWorksheet('日期'); sheet.getCell('A1').value = new Date('2026-11-25T00:00:00Z')
    sheet.getCell('B1').value = { formula: 'A1+3', result: 0 }; sheet.getCell('B1').numFmt = 'yyyy-mm-dd'
    const before = Buffer.from(await book.xlsx.writeBuffer()), after = await recalculateXlsx(before), actual = await reopen(after)
    expect(actual.properties.date1904).toBe(date1904)
    expect(actual.getWorksheet('日期')!.getCell('B1').result).toEqual(new Date('2026-11-28T00:00:00Z'))
    expect(readOfficeZip(after)['xl/workbook.xml']).toEqual(readOfficeZip(before)['xl/workbook.xml'])
  })

  it.each([false, true])('calculates DATE and TEXT in the workbook date1904=%s system', async date1904 => {
    const book = new ExcelJS.Workbook(); book.properties.date1904 = date1904
    const sheet = book.addWorksheet('日期与格式'), offset = date1904 ? 1462 : 0
    const cases: Array<[string, number | string]> = [
      ['DATE(2026,11,25)', Date.UTC(2026, 10, 25) / 86_400_000 + 25569 - offset],
      ['TEXT(A1,"yyyy-mm-dd")', '2026-11-25'], ['TEXT(DATE(2026,12,0),"yyyy/m/d")', '2026/11/30'],
      ['TEXT(12345.678,"#,##0.00")', '12,345.68'], ['TEXT(0.125,"0.0%")', '12.5%'],
      ['TEXT(DATE(100,1,1),"yyyy-mm-dd")', '2000-01-01'],
      ['IF(DATE(2026,11,1)<=A1,1,0)', 1], ['TEXT(DATE(2026,13,1),"yyyy-mm-dd")', '2027-01-01'],
    ]
    for (const [index, [formula]] of cases.entries()) sheet.getCell(`A${index + 1}`).value = { formula, result: 999 }
    const actual = (await reopen(await recalculateXlsx(Buffer.from(await book.xlsx.writeBuffer())))).getWorksheet('日期与格式')!
    for (const [index, [, expected]] of cases.entries()) expect(actual.getCell(`A${index + 1}`).result).toEqual(expected)
  })

  it('preserves the Excel 1900 leap-day fiction for DATE overflow and TEXT formatting', async () => {
    const formulas = ['DATE(1900,1,1)', 'DATE(1900,2,28)', 'DATE(1900,2,29)', 'DATE(1900,3,1)', 'DATE(1900,3,0)', 'DATE(1900,1,60)', 'DATE(1900,2,30)', 'TEXT(DATE(1900,2,29),"yyyy-mm-dd")']
    const expected = [1, 59, 60, 61, 60, 60, 61, '1900-02-29']
    const actual = (await reopen(await recalculateXlsx(await fixture(formulas)))).getWorksheet('汇总')!
    for (const [index, value] of expected.entries()) expect(actual.getCell(`A${index + 1}`).result, formulas[index]).toEqual(value)
  })

  it.each(['DATE(-1,1,1)', 'DATE(10000,1,1)', 'DATE(2026,1000000,1)', 'TEXT(1,"unknown-format")', 'TEXT(1,"0..00")'])('refuses unsupported DATE/TEXT arguments or formats: %s', async formula => {
    await expect(recalculateXlsx(await fixture([formula]))).rejects.toThrow()
  })

  it.each([
    ['FUTURE_FUNCTION(1)', /unsupported function/], ['SUM(数据!A:A)', /unsupported/],
    ['[external.xlsx]数据!A1', /unsupported/], ['SUM(A1:XFD1048576)', /oversized/],
    ['IF(1,"escaped""quote",0)', /escaped string/], ['1/0', /valid scalar/],
    ['A1+1', /circular/], ['SUM(A1:A2)', /circular/], ['1 2', /missing operator/],
  ] as const)('refuses unsupported or invalid formula %s without altering input', async (formula, error) => {
    const original = await fixture([formula]), before = Buffer.from(original)
    await expect(recalculateXlsx(original)).rejects.toThrow(error)
    expect(original).toEqual(before)
  })

  it('rejects a cross-sheet cycle before trusting saved caches', async () => {
    const book = new ExcelJS.Workbook(), a = book.addWorksheet('甲'), b = book.addWorksheet('乙')
    a.getCell('A1').value = { formula: '乙!A1+1', result: 999 }
    b.getCell('A1').value = { formula: '甲!A1+1', result: 998 }
    await expect(recalculateXlsx(Buffer.from(await book.xlsx.writeBuffer()))).rejects.toThrow('circular')
  })

  it('uses Excel reference semantics for aggregates instead of coercing numeric text or booleans', async () => {
    const book = new ExcelJS.Workbook(), data = book.addWorksheet('数据'), result = book.addWorksheet('汇总')
    data.addRows([[true], ['12'], [3], [null], ['表头']])
    const cases: Array<[string, number]> = [['SUM', 3], ['AVERAGE', 3], ['COUNT', 1], ['MIN', 3], ['MAX', 3]]
    for (const [index, [name]] of cases.entries()) result.getCell(`A${index + 1}`).value = { formula: `${name}(数据!A1:A5)`, result: 999 }
    const actual = (await reopen(await recalculateXlsx(Buffer.from(await book.xlsx.writeBuffer())))).getWorksheet('汇总')!
    for (const [index, [, value]] of cases.entries()) expect(actual.getCell(`A${index + 1}`).result).toBe(value)
  })

  it('counts empty strings in COUNTA while excluding actual blank cells', async () => {
    const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('数据')
    sheet.addRows([[''], [true], [12], [null], ['普通文字']])
    sheet.getCell('A4').numFmt = '0.00'
    sheet.getCell('A6').value = { formula: 'IF(1=1,"",1)', result: 'old cache' }
    const cases: Array<[string, number]> = [['COUNTA("")', 1], ['COUNTA(IF(1=1,"",1))', 1], ['COUNTA(A1:A6)', 5], ['COUNTA(A4)', 0]]
    for (const [index, [formula]] of cases.entries()) sheet.getCell(`C${index + 1}`).value = { formula, result: 999 }
    const actual = (await reopen(await recalculateXlsx(Buffer.from(await book.xlsx.writeBuffer())))).getWorksheet('数据')!
    for (const [index, [, expected]] of cases.entries()) expect(actual.getCell(`C${index + 1}`).result).toBe(expected)
  })

  it.each(['-1^2', 'TRUE', 'IF(1=1,TRUE,FALSE)', 'COUNT("12",3)', 'AVERAGE("12",3)'])('refuses known unsupported Excel coercion/precedence semantics: %s', async formula => {
    await expect(recalculateXlsx(await fixture([formula]))).rejects.toThrow(/unsupported|not supported/)
  })

  it.each(['ROUND(0.0000001234,8)', 'ROUND(1000000000000000000000,2)', 'ROUND(10000000000,12)', 'ROUND(1.25,1.5)', 'ROUND(1.25,16)'])('refuses unsupported ROUND exponent/precision semantics: %s', async formula => {
    await expect(recalculateXlsx(await fixture([formula]))).rejects.toThrow('ROUND scientific-notation')
  })

  it('supports bounded text comparison through referenced cells and IF', async () => {
    const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('数据')
    sheet.addRows([['a'], ['A']]); sheet.getCell('B1').value = { formula: 'IF(A1<>A2,1,2)', result: 999 }
    const actual = (await reopen(await recalculateXlsx(Buffer.from(await book.xlsx.writeBuffer())))).getWorksheet('数据')!
    expect(actual.getCell('B1').result).toBe(1)
  })

  it('counts numeric and wildcard text criteria without coercing unrelated range values', async () => {
    const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('数据')
    sheet.addRows([['Apple', 10], ['apple', 20], ['Apricot', 30], ['a*b', 40], ['a?b', 50], ['a~b', 60], ['APPLE', '100'], ['APPLE', true]])
    const cases: Array<[string, number]> = [['apple', 4], ['Ap*', 5], ['<>apple', 4], ['a~*b', 1], ['a~?b', 1], ['a~~b', 1], ['=APPLE', 4], ['A?PLE', 4]]
    for (const [index, [criteria]] of cases.entries()) sheet.getCell(`D${index + 1}`).value = { formula: `COUNTIF(A1:A8,"${criteria}")`, result: 999 }
    sheet.getCell('D10').value = { formula: 'COUNTIF(B1:B8,">10")', result: 999 }
    const actual = (await reopen(await recalculateXlsx(Buffer.from(await book.xlsx.writeBuffer())))).getWorksheet('数据')!
    for (const [index, [, expected]] of cases.entries()) expect(actual.getCell(`D${index + 1}`).result).toBe(expected)
    expect(actual.getCell('D10').result).toBe(5)
  })

  it('adapts Excel case-insensitive and escaped wildcard SUMIF criteria without coercing sum-range text', async () => {
    const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('数据')
    sheet.addRows([['Apple', 10], ['apple', 20], ['Apricot', 30], ['a*b', 40], ['a?b', 50], ['a~b', 60], ['APPLE', '100'], ['APPLE', true]])
    const cases: Array<[string, number]> = [['apple', 30], ['Ap*', 60], ['<>apple', 180], ['a~*b', 40], ['a~?b', 50], ['a~~b', 60], ['=APPLE', 30], ['A?PLE', 30]]
    for (const [index, [criteria]] of cases.entries()) sheet.getCell(`D${index + 1}`).value = { formula: `SUMIF(A1:A8,"${criteria}",B1:B8)`, result: 999 }
    const actual = (await reopen(await recalculateXlsx(Buffer.from(await book.xlsx.writeBuffer())))).getWorksheet('数据')!
    for (const [index, [, expected]] of cases.entries()) expect(actual.getCell(`D${index + 1}`).result).toBe(expected)
  })

  it.each(['shared', 'array', 'dataTable'])('refuses %s formulas without degrading them', async kind => {
    const parts = readOfficeZip(await fixture())
    parts['xl/worksheets/sheet2.xml'] = Buffer.from(text(parts['xl/worksheets/sheet2.xml']).replace('<f>', `<f t="${kind}" ref="A1:A2">`))
    await expect(recalculateXlsx(writeOfficeZip(parts))).rejects.toThrow('shared, array, data-table')
  })

  it('refuses external workbook packages even when their old cache is populated', async () => {
    const entries = readOfficeZip(await fixture()); entries['xl/externalLinks/externalLink1.xml'] = Buffer.from('<externalLink/>')
    await expect(recalculateXlsx(writeOfficeZip(entries))).rejects.toThrow('external workbook links')
  })

  it('runs two workers with queued work without blocking the event loop or mixing results', async () => {
    const inputs = await Promise.all([10, 20, 30, 40].map(n => fixture([`数据!A1+${n}`])))
    let ticks = 0; const timer = setInterval(() => ticks++, 5)
    try {
      const outputs = await Promise.all(inputs.map(input => recalculateXlsx(input)))
      for (const [index, output] of outputs.entries()) expect((await reopen(output)).getWorksheet('汇总')!.getCell('A1').result).toBe(20 + index * 10)
      expect(ticks).toBeGreaterThan(3)
    } finally { clearInterval(timer) }
  })

  it('cancels an active worker and permits the next request to finish', async () => {
    const input = await fixture(), controller = new AbortController()
    const pending = recalculateXlsx(input, controller.signal)
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    setTimeout(() => controller.abort(), 15)
    await rejected
    expect((await reopen(await recalculateXlsx(input))).getWorksheet('汇总')!.getCell('A1').result).toBe(60)
    await expect(recalculateXlsx(input, AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('terminates a nonresponsive worker at its deadline and applies the resource ceiling', async () => {
    const terminate = vi.fn(async () => 1), requests: unknown[] = []
    class StalledWorker extends EventEmitter {
      stdout = { resume: vi.fn() }; stderr = { resume: vi.fn() }; terminate = terminate
      constructor(_script: string, options: unknown) { super(); requests.push(options) }
    }
    vi.resetModules()
    vi.doMock('node:worker_threads', async () => ({ ...await vi.importActual<typeof import('node:worker_threads')>('node:worker_threads'), Worker: StalledWorker }))
    try {
      const isolated = await import('../recalculate.js')
      vi.useFakeTimers()
      const pending = isolated.recalculateXlsx(Buffer.from('worker receives this buffer'))
      const rejected = expect(pending).rejects.toThrow('worker exceeded 10 second deadline')
      await vi.advanceTimersByTimeAsync(isolated.XLSX_RECALCULATION_LIMITS.timeoutMs)
      await rejected
      expect(terminate).toHaveBeenCalledOnce()
      expect(requests).toEqual([expect.objectContaining({ resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 }, execArgv: [] })])
    } finally { vi.useRealTimers(); vi.doUnmock('node:worker_threads'); vi.resetModules() }
  })

  it('bounds active and queued input together and releases the budget after cancellation', async () => {
    const workers: EventEmitter[] = [], terminate = vi.fn(async () => 1)
    class StalledWorker extends EventEmitter {
      stdout = { resume: vi.fn() }; stderr = { resume: vi.fn() }; terminate = terminate
      constructor() { super(); workers.push(this) }
    }
    vi.resetModules()
    vi.doMock('node:worker_threads', async () => ({ ...await vi.importActual<typeof import('node:worker_threads')>('node:worker_threads'), Worker: StalledWorker }))
    try {
      const isolated = await import('../recalculate.js'), input = Buffer.alloc(16 * 1024 * 1024)
      const controllers = Array.from({ length: 4 }, () => new AbortController())
      const pending = controllers.map(controller => isolated.recalculateXlsx(input, controller.signal))
      const settled = Promise.allSettled(pending)
      await Promise.resolve()
      expect(workers).toHaveLength(2)
      await expect(isolated.recalculateXlsx(Buffer.alloc(1))).rejects.toThrow('retained input budget exceeds 64 MiB')
      controllers[2].abort()
      await expect(pending[2]).rejects.toMatchObject({ name: 'AbortError' })
      const replacementController = new AbortController()
      const replacement = isolated.recalculateXlsx(input, replacementController.signal)
      const replacementSettled = expect(replacement).rejects.toMatchObject({ name: 'AbortError' })
      await expect(isolated.recalculateXlsx(Buffer.alloc(1))).rejects.toThrow('retained input budget exceeds 64 MiB')
      replacementController.abort(); controllers.forEach(controller => controller.abort())
      await replacementSettled
      expect((await settled).map(result => result.status)).toEqual(['rejected', 'rejected', 'rejected', 'rejected'])
      expect(terminate).toHaveBeenCalledTimes(2)
      const acceptedAfterCleanup = isolated.recalculateXlsx(Buffer.alloc(32 * 1024 * 1024))
      await Promise.resolve()
      expect(workers).toHaveLength(3)
      workers[2].emit('message', { ok: true, bytes: Uint8Array.from([1, 2, 3]) })
      expect(await acceptedAfterCleanup).toEqual(Buffer.from([1, 2, 3]))
    } finally { vi.doUnmock('node:worker_threads'); vi.resetModules() }
  })
})
