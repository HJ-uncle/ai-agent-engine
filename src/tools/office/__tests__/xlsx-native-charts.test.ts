/** Native Excel charts: package relationships, editable cell references, source
 * caches, new-sheet preservation, and cell-edit refresh. No legacy/export tests. */
import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { appendXlsxSheets, createXlsx, editXlsx, inspectXlsx, type XlsxChart, type XlsxInput } from '../xlsx.js'
import { refreshXlsxChartCaches, XLSX_CHART_TYPES } from '../xlsx-charts.js'
import { readOfficeZip, writeOfficeZip } from '../office-zip.js'

// Only this XML parser surface is needed; jsdom does not ship TS declarations.
const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html: string) => { window: { DOMParser: new () => DOMParser } }
}
const parser = new (new JSDOM('').window.DOMParser)()
const xml = (parts: Record<string, Uint8Array>, file: string) => Buffer.from(parts[file]).toString('utf8')
const chartFiles = (parts: Record<string, Uint8Array>) => Object.keys(parts).filter(file => /^xl\/charts\/[^/]+\.xml$/.test(file))
const input = (type: XlsxChart['type'] = 'column', name = "经营 ' 汇总"): XlsxInput => ({ sheets: [{ name,
  columns: [{ header: '月份', key: 'month', type: 'text' }, { header: '营业额', key: 'revenue', type: 'number' }, { header: '投入', key: 'cost', type: 'number' }, { header: '样本位置', key: 'x', type: 'number' }],
  rows: [{ month: '一月', revenue: 12, cost: 5, x: 1 }, { month: '二月', revenue: 25, cost: 9, x: 2 }, { month: '三月', revenue: 0, cost: 7, x: 4 }],
  charts: [{ type, title: '营业额与投入', categoryKey: type === 'scatter' ? 'x' : 'month', series: [{ key: 'revenue', color: '1D4ED8' }], anchor: { cell: 'F2', width: 720, height: 420 } }],
}] })
function parsed(value: string): Document {
  const result = parser.parseFromString(value, 'text/xml')
  expect(result.getElementsByTagName('parsererror').length).toBe(0)
  return result
}
const points = (value: string, kind = 'numCache') => [...parsed(value).getElementsByTagNameNS('*', kind)[0].getElementsByTagNameNS('*', 'pt')].map(node => ({ index: Number(node.getAttribute('idx')), value: node.textContent }))

describe('native spreadsheet charts', () => {
  it.each(XLSX_CHART_TYPES)('writes a real %s chart with editable references and valid drawing relationships', async type => {
    const bytes = await createXlsx(input(type)), parts = readOfficeZip(bytes), files = chartFiles(parts)
    expect(files).toHaveLength(1)
    const chart = xml(parts, files[0]), chartDocument = parsed(chart)
    expect(chartDocument.getElementsByTagNameNS('*', type === 'column' || type === 'bar' ? 'barChart' : `${type}Chart`).length).toBe(1)
    expect(chart).toContain('&apos;经营 &apos;&apos; 汇总&apos;!$B$2:$B$4')
    expect(points(chart, type === 'scatter' ? 'numCache' : 'numCache')).toEqual(type === 'scatter' ? [{ index: 0, value: '1' }, { index: 1, value: '2' }, { index: 2, value: '4' }] : [{ index: 0, value: '12' }, { index: 1, value: '25' }, { index: 2, value: '0' }])
    expect(chart).not.toContain('externalData')
    const drawingFile = Object.keys(parts).find(file => /^xl\/drawings\/[^/]+\.xml$/.test(file))!
    const drawing = parsed(xml(parts, drawingFile))
    expect(drawing.getElementsByTagNameNS('*', 'oneCellAnchor').length).toBe(1)
    expect(drawing.getElementsByTagNameNS('*', 'col')[0].textContent).toBe('5')
    expect(drawing.getElementsByTagNameNS('*', 'ext')[0].getAttribute('cx')).toBe(String(720 * 9525))
    expect(xml(parts, 'xl/worksheets/sheet1.xml')).toContain('<drawing r:id="aetherDrawing"/>')
    expect(xml(parts, 'xl/worksheets/_rels/sheet1.xml.rels')).toContain('Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing"')
    expect(xml(parts, '[Content_Types].xml')).toContain(`PartName="/${files[0]}"`)
    for (const [file, bytes] of Object.entries(parts)) if (/\.(xml|rels)$/.test(file)) parsed(Buffer.from(bytes).toString())
    expect((await inspectXlsx(bytes)).summary.charts).toBe(1)
  })

  it('keeps gaps distinct from zero, links series names to headers, and supports multiple series', async () => {
    const source = input('line')
    source.sheets[0].rows[1].revenue = null
    source.sheets[0].charts![0].series.push({ key: 'cost', name: '实际投入', color: '0D9488' })
    source.sheets[0].charts![0].legend = false
    const parts = readOfficeZip(await createXlsx(source)), chart = xml(parts, chartFiles(parts)[0])
    expect(points(chart)).toEqual([{ index: 0, value: '12' }, { index: 2, value: '0' }])
    expect(chart).toContain('<c:ptCount val="3"/>')
    expect(chart).toContain('$B$1:$B$1')
    expect(chart).toContain('<c:v>实际投入</c:v>')
    expect(chart).toContain('<c:dispBlanksAs val="gap"/>')
    expect(chart).not.toContain('<c:legend>')
  })

  it('adds charts to new sheets without rewriting the existing sheets, charts or opaque parts', async () => {
    const old = readOfficeZip(await createXlsx(input('bar', '原表')))
    old['xl/custom/note.xml'] = Buffer.from('<note>preserved</note>')
    const output = readOfficeZip(await appendXlsxSheets(writeOfficeZip(old), input('doughnut', '新增表')))
    for (const file of [...chartFiles(old), 'xl/worksheets/sheet1.xml', 'xl/custom/note.xml', 'xl/drawings/aetherdrawing1.xml']) expect(Buffer.from(output[file]).equals(Buffer.from(old[file]))).toBe(true)
    expect(chartFiles(output)).toHaveLength(2)
    expect(xml(output, 'xl/worksheets/sheet2.xml')).toContain('drawing')
    expect(xml(output, 'xl/worksheets/_rels/sheet2.xml.rels')).toContain('aetherdrawing2.xml')
    expect(xml(output, 'xl/charts/aetherchart2.xml')).toContain('&apos;新增表&apos;!$B$2:$B$4')
  })

  it('refreshes linked caches after source edits, preserving shape configuration and names', async () => {
    const source = input('column', '数据')
    const before = await createXlsx(source)
    const after = readOfficeZip(await editXlsx(before, [{ sheet: '数据', cell: 'A2', value: '更新月份' }, { sheet: '数据', cell: 'B2', value: 99 }]))
    const chart = xml(after, chartFiles(after)[0])
    expect(points(chart)[0]).toEqual({ index: 0, value: '99' })
    expect(chart).toContain('<c:v>更新月份</c:v>')
    expect(chart).toContain('srgbClr val="1D4ED8"')
    expect(chart).toContain('clustered')
  })

  it('does not invent cached values for formulas awaiting recalculation', async () => {
    const source = input('column', '公式')
    source.sheets[0].rows[0].revenue = { formula: 'C2*2' }
    const bytes = await createXlsx(source), parts = readOfficeZip(bytes)
    expect(points(xml(parts, chartFiles(parts)[0]))).toEqual([{ index: 1, value: '25' }, { index: 2, value: '0' }])
    expect((await inspectXlsx(bytes)).summary.pendingFormulas).toBe(1)
  })

  it('preserves unsupported reference caches and discloses that they cannot be refreshed', async () => {
    const parts = readOfficeZip(await createXlsx(input())), file = chartFiles(parts)[0]
    parts[file] = Buffer.from(xml(parts, file).replace(/<c:numRef>[\s\S]*?<\/c:numRef>/, '<c:numRef><c:f>NamedSeries</c:f><c:numCache><c:ptCount val="1"/><c:pt idx="0"><c:v>999</c:v></c:pt></c:numCache></c:numRef>'))
    refreshXlsxChartCaches(parts)
    expect(xml(parts, file)).toContain('<c:numRef><c:f>NamedSeries</c:f><c:numCache><c:ptCount val="1"/><c:pt idx="0"><c:v>999</c:v></c:pt></c:numCache></c:numRef>')
    expect((await inspectXlsx(writeOfficeZip(parts))).warnings.some(warning => warning.includes('1 个图表引用') && warning.includes('不更新'))).toBe(true)
  })

  it('preserves an existing numeric cache format while refreshing its values', async () => {
    const parts = readOfficeZip(await createXlsx(input())), file = chartFiles(parts)[0]
    parts[file] = Buffer.from(xml(parts, file).replace('<c:formatCode>General</c:formatCode>', '<c:formatCode>0.00%</c:formatCode>'))
    refreshXlsxChartCaches(parts)
    expect(xml(parts, file)).toContain('<c:formatCode>0.00%</c:formatCode>')
    expect(points(xml(parts, file))[0]).toEqual({ index: 0, value: '12' })
  })

  it.each([
    { categoryKey: 'missing' }, { series: [{ key: 'missing' }] }, { startRow: 1 }, { endRow: 99 },
    { anchor: { cell: 'XFE1' } }, { series: [{ key: 'revenue', color: 'red' }] },
    { type: 'pie', series: [{ key: 'revenue' }, { key: 'cost' }] },
  ])('rejects invalid chart input before publishing: %j', async patch => {
    const source = input(); Object.assign(source.sheets[0].charts![0], patch)
    await expect(createXlsx(source)).rejects.toThrow('XLSX 图表')
  })

  it('rejects text series and negative pie values rather than distorting the data', async () => {
    const source = input(); source.sheets[0].charts![0].series = [{ key: 'month' }]
    await expect(createXlsx(source)).rejects.toThrow('非数值')
    const pie = input('pie'); pie.sheets[0].rows[0].revenue = -1
    await expect(createXlsx(pie)).rejects.toThrow('负值')
  })
})
