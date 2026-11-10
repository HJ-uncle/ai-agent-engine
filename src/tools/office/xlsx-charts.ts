import path from 'node:path'
import { decodeXml, encodeXml } from './office-zip.js'

export const XLSX_CHART_TYPES = ['column', 'bar', 'line', 'area', 'pie', 'doughnut', 'scatter'] as const
export interface XlsxChart {
  type: typeof XLSX_CHART_TYPES[number]
  title?: string
  categoryKey: string
  series: Array<{ key: string; name?: string; color?: string }>
  startRow?: number
  endRow?: number
  anchor?: { cell: string; width?: number; height?: number }
  legend?: boolean
}
interface ChartSheet { name: string; file: string; columns: Array<{ key: string; header: string }>; charts?: XlsxChart[] }
type Entries = Record<string, Uint8Array>
type Scalar = string | number | boolean | null
interface Element { full: string; tag: string; attrs: Record<string, string>; inner: string }
interface Cell { value: Scalar; pending: boolean; date: boolean }
interface SheetData { file: string; cells: Map<string, Cell>; rows: Map<number, number>; defaultHeight: number }
const NS = '(?:[A-Za-z_][\\w.-]*:)?'
const C = 'http://schemas.openxmlformats.org/drawingml/2006/chart'
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const XDR = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
const palette = ['2563EB', '0D9488', 'D97706', '7C3AED', 'DC2626', '0891B2', '65A30D', 'DB2777']
const text = (bytes?: Uint8Array): string => bytes ? Buffer.from(bytes).toString('utf8') : ''
function fail(message: string): never { throw new Error(`XLSX 图表: ${message}`) }
function elements(xml: string, name: string): Element[] {
  return [...xml.matchAll(new RegExp(`<(${NS}${name})\\b([^>]*?)(?:\\/\\s*>|>([\\s\\S]*?)<\\/\\1\\s*>)`, 'g'))].map(match => {
    const attrs: Record<string, string> = Object.create(null)
    for (const attr of match[2].matchAll(/([^\s=/>]+)\s*=\s*(["'])([\s\S]*?)\2/g)) attrs[attr[1]] = decodeXml(attr[3])
    return { full: match[0], tag: match[1], attrs, inner: match[3] ?? '' }
  })
}
function columnName(column: number): string {
  let result = ''
  while (column) { column--; result = String.fromCharCode(65 + column % 26) + result; column = Math.floor(column / 26) }
  return result
}
function address(value: string): { row: number; column: number } {
  const match = /^\$?([A-Z]{1,3})\$?([1-9]\d{0,6})$/i.exec(value)
  if (!match) fail(`无效单元格地址 ${value}`)
  const column = [...match[1].toUpperCase()].reduce((sum, letter) => sum * 26 + letter.charCodeAt(0) - 64, 0), row = Number(match[2])
  if (column > 16384 || row > 1048576) fail('单元格地址超出 Excel 范围')
  return { row, column }
}
function boundedText(value: unknown, field: string, max = 200): string {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/.test(value)
    || Buffer.from(value, 'utf8').toString('utf8') !== value) fail(`${field} 必须为不超过 ${max} 字符的有效文本`)
  return value
}
/** Model schemas also validate this input, but direct callers share the same bounds. */
export function validateXlsxCharts(charts: unknown, columns: Array<{ key: string }>, rows: number): XlsxChart[] | undefined {
  if (charts === undefined) return undefined
  if (!Array.isArray(charts) || charts.length > 8) fail('每张工作表最多 8 个图表')
  const keys = new Set(columns.map(column => column.key))
  return charts.map((raw: unknown) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('图表必须为对象')
    const chart = raw as XlsxChart
    if (!(XLSX_CHART_TYPES as readonly unknown[]).includes(chart.type)) fail('不支持的图表类型')
    if (!keys.has(chart.categoryKey)) fail('categoryKey 必须引用当前工作表的列 key')
    if (chart.title !== undefined) boundedText(chart.title, 'title')
    if (chart.legend !== undefined && typeof chart.legend !== 'boolean') fail('legend 必须为布尔值')
    if (!Array.isArray(chart.series) || !chart.series.length || chart.series.length > 8) fail('每图须为 1-8 个系列')
    if (['pie', 'doughnut'].includes(chart.type) && chart.series.length !== 1) fail('饼图/环形图仅支持一个系列')
    const seen = new Set<string>()
    for (const series of chart.series) {
      if (!series || !keys.has(series.key) || seen.has(series.key)) fail('series.key 必须引用当前工作表的列且不重复')
      seen.add(series.key)
      if (series.name !== undefined) boundedText(series.name, 'series.name')
      if (series.color !== undefined && (typeof series.color !== 'string' || !/^[0-9a-f]{6}$/i.test(series.color))) fail('series.color 必须为六位十六进制颜色')
    }
    const start = chart.startRow ?? 2, end = chart.endRow ?? rows + 1
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 2 || end > rows + 1 || end < start || end - start + 1 > 1000) fail('图表范围须为实际数据行（从第 2 行起），每图最多 1000 个点')
    if (chart.anchor !== undefined) {
      if (!chart.anchor || typeof chart.anchor !== 'object' || typeof chart.anchor.cell !== 'string') fail('anchor.cell 必填')
      address(chart.anchor.cell)
      for (const [key, minimum, maximum] of [['width', 320, 1600], ['height', 240, 1200]] as const) {
        const value = chart.anchor[key]
        if (value !== undefined && (!Number.isFinite(value) || value < minimum || value > maximum)) fail(`anchor.${key} 须为 ${minimum}-${maximum} 像素`)
      }
    }
    return { ...chart, startRow: start, endRow: end, series: chart.series.map(series => ({ ...series })) }
  })
}

/** Read only saved scalar/cached formula values. A missing formula cache is not zero. */
function workbookData(entries: Entries): { sheets: Map<string, SheetData>; date1904: boolean } {
  const workbook = text(entries['xl/workbook.xml']), rels = elements(text(entries['xl/_rels/workbook.xml.rels']), 'Relationship')
  const strings = elements(text(entries['xl/sharedStrings.xml']), 'si').map(item => elements(item.inner, 't').map(node => decodeXml(node.inner)).join(''))
  const styles = text(entries['xl/styles.xml']), custom = new Map(elements(styles, 'numFmt').map(item => [Number(item.attrs.numFmtId), item.attrs.formatCode]))
  const dates = new Set<number>(), builtins = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58])
  elements(elements(styles, 'cellXfs')[0]?.inner ?? '', 'xf').forEach((xf, index) => {
    const id = Number(xf.attrs.numFmtId), original = custom.get(id) ?? '', code = original.replace(/"[^"]*"|\\.|\[[^\]]*\]/g, '')
    if (builtins.has(id) || /\[[hms]+\]/i.test(original) || /[ydhs]|m[\/-]|[\/-]m/i.test(code)) dates.add(index)
  })
  const sheets = new Map<string, SheetData>()
  for (const sheet of elements(workbook, 'sheet')) {
    const relation = rels.find(item => item.attrs.Id === sheet.attrs['r:id'])
    if (!relation?.attrs.Type?.endsWith('/worksheet') || relation.attrs.TargetMode === 'External') continue
    const target = relation.attrs.Target
    if (!target || target.includes('\\')) continue
    const file = target.startsWith('/') ? target.slice(1) : path.posix.normalize(path.posix.join('xl', target))
    if (!file.startsWith('xl/') || !entries[file]) continue
    const xml = text(entries[file]), cells = new Map<string, Cell>(), rows = new Map<number, number>()
    for (const row of elements(xml, 'row')) if (Number(row.attrs.ht) > 0) rows.set(Number(row.attrs.r) - 1, Number(row.attrs.ht) * 4 / 3)
    for (const cell of elements(xml, 'c')) {
      const stored = elements(cell.inner, 'v')[0]?.inner, pending = Boolean(elements(cell.inner, 'f').length && (stored === undefined || cell.attrs.t === 'e'))
      let value: Scalar = null
      if (cell.attrs.t === 'inlineStr') value = elements(cell.inner, 't').map(node => decodeXml(node.inner)).join('')
      else if (stored !== undefined && stored !== '') {
        if (cell.attrs.t === 's') value = strings[Number(stored)] ?? null
        else if (cell.attrs.t === 'str' || cell.attrs.t === 'd') value = decodeXml(stored)
        else if (cell.attrs.t === 'b') value = stored === '1'
        else if (cell.attrs.t !== 'e') { const number = Number(stored); if (Number.isFinite(number)) value = number }
      }
      cells.set(cell.attrs.r?.replaceAll('$', '').toUpperCase(), { value, pending, date: dates.has(Number(cell.attrs.s ?? 0)) })
    }
    sheets.set(sheet.attrs.name.toLowerCase(), { file, cells, rows, defaultHeight: (Number(elements(xml, 'sheetFormatPr')[0]?.attrs.defaultRowHeight) || 15) * 4 / 3 })
  }
  return { sheets, date1904: ['1', 'true'].includes(elements(workbook, 'workbookPr')[0]?.attrs.date1904 ?? '') }
}
function reference(data: ReturnType<typeof workbookData>, formula: string): Cell[] | undefined {
  const match = /^(?:'((?:[^']|'')+)'|([^'!]+))!(\$?[A-Z]{1,3}\$?[1-9]\d{0,6})(?::(\$?[A-Z]{1,3}\$?[1-9]\d{0,6}))?$/i.exec(formula)
  if (!match || /[\[\]]/.test(formula)) return undefined
  const sheet = data.sheets.get((match[1]?.replaceAll("''", "'") ?? match[2]).toLowerCase())
  if (!sheet) return undefined
  let first: ReturnType<typeof address>, last: ReturnType<typeof address>
  try { first = address(match[3]); last = address(match[4] ?? match[3]) } catch { return undefined }
  if (first.row > last.row || first.column > last.column || first.row !== last.row && first.column !== last.column) return undefined
  if (last.row - first.row + last.column - first.column + 1 > 1000) return undefined
  const cells: Cell[] = []
  for (let row = first.row; row <= last.row; row++) for (let col = first.column; col <= last.column; col++) cells.push(sheet.cells.get(`${columnName(col)}${row}`) ?? { value: null, pending: false, date: false })
  return cells
}
function label(cell: Cell, date1904: boolean): string | null {
  if (cell.pending || cell.value === null) return null
  if (typeof cell.value === 'number' && cell.date) {
    const date = new Date((cell.value - 25569 + (date1904 ? 1462 : 0)) * 86400000)
    if (Number.isFinite(date.getTime())) return date.toISOString().slice(0, 10)
  }
  return String(cell.value)
}
function cache(cells: Cell[], numeric: boolean, date1904: boolean, prefix = 'c:', formatCode = 'General'): string {
  const points = cells.flatMap((cell, index) => {
    const value = numeric ? cell.pending || typeof cell.value !== 'number' ? null : cell.value : label(cell, date1904)
    return value === null ? [] : [`<${prefix}pt idx="${index}"><${prefix}v>${encodeXml(String(value))}</${prefix}v></${prefix}pt>`]
  }).join('')
  return `<${prefix}${numeric ? 'numCache' : 'strCache'}>${numeric ? `<${prefix}formatCode>${encodeXml(formatCode)}</${prefix}formatCode>` : ''}<${prefix}ptCount val="${cells.length}"/>${points}</${prefix}${numeric ? 'numCache' : 'strCache'}>`
}
function ref(formula: string, cells: Cell[], numeric: boolean, date1904: boolean): string {
  const tag = numeric ? 'numRef' : 'strRef'
  return `<c:${tag}><c:f>${encodeXml(formula)}</c:f>${cache(cells, numeric, date1904)}</c:${tag}>`
}
function richTitle(title: string): string {
  return `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1600" b="1"/></a:pPr><a:r><a:t>${encodeXml(title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>`
}
function chartXml(chart: XlsxChart, sheet: ChartSheet, data: ReturnType<typeof workbookData>): string {
  const quote = `'${sheet.name.replaceAll("'", "''")}'`, start = chart.startRow!, end = chart.endRow!
  const formula = (key: string, from = start, to = end) => `${quote}!$${columnName(sheet.columns.findIndex(column => column.key === key) + 1)}$${from}:$${columnName(sheet.columns.findIndex(column => column.key === key) + 1)}$${to}`
  const categories = reference(data, formula(chart.categoryKey))!
  if (chart.type === 'scatter' && categories.some(cell => !cell.pending && cell.value !== null && typeof cell.value !== 'number')) fail('散点图 categoryKey 必须为数值 X 坐标列')
  const circular = chart.type === 'pie' || chart.type === 'doughnut'
  const series = chart.series.map((series, index) => {
    const values = reference(data, formula(series.key))!
    if (values.some(cell => !cell.pending && cell.value !== null && typeof cell.value !== 'number')) fail(`系列 ${series.key} 包含非数值，不能将文字伪装成 0`)
    if (circular && values.some(cell => typeof cell.value === 'number' && cell.value < 0)) fail('饼图/环形图不能包含负值')
    if (values.every(cell => !cell.pending && (cell.value === null || circular && cell.value === 0))) fail(`系列 ${series.key} 没有可绘制的数值`)
    const name = series.name === undefined ? ref(formula(series.key, 1, 1), reference(data, formula(series.key, 1, 1))!, false, data.date1904) : `<c:v>${encodeXml(series.name)}</c:v>`
    const color = (series.color ?? palette[index % palette.length]).toUpperCase()
    const shape = chart.type === 'line' || chart.type === 'scatter' ? `<c:spPr><a:ln w="25400"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:ln></c:spPr>` : `<c:spPr><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:ln><a:noFill/></a:ln></c:spPr>`
    const marker = ['line', 'scatter'].includes(chart.type) ? `<c:marker><c:symbol val="circle"/><c:size val="5"/><c:spPr><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:ln><a:noFill/></a:ln></c:spPr></c:marker>` : ''
    const slices = circular ? values.map((_, point) => `<c:dPt><c:idx val="${point}"/><c:spPr><a:solidFill><a:srgbClr val="${palette[point % palette.length]}"/></a:solidFill><a:ln><a:noFill/></a:ln></c:spPr></c:dPt>`).join('') : ''
    const axes = chart.type === 'scatter'
      ? `<c:xVal>${ref(formula(chart.categoryKey), categories, true, data.date1904)}</c:xVal><c:yVal>${ref(formula(series.key), values, true, data.date1904)}</c:yVal>`
      : `<c:cat>${ref(formula(chart.categoryKey), categories, false, data.date1904)}</c:cat><c:val>${ref(formula(series.key), values, true, data.date1904)}</c:val>`
    return `<c:ser><c:idx val="${index}"/><c:order val="${index}"/><c:tx>${name}</c:tx>${shape}${marker}${slices}${axes}${['line', 'scatter'].includes(chart.type) ? '<c:smooth val="0"/>' : ''}</c:ser>`
  }).join('')
  const axisIds = '<c:axId val="10001"/><c:axId val="10002"/>'
  const plot = ['column', 'bar'].includes(chart.type) ? `<c:barChart><c:barDir val="${chart.type === 'bar' ? 'bar' : 'col'}"/><c:grouping val="clustered"/><c:varyColors val="0"/>${series}<c:gapWidth val="100"/><c:overlap val="0"/>${axisIds}</c:barChart>`
    : chart.type === 'line' || chart.type === 'area' ? `<c:${chart.type}Chart><c:grouping val="standard"/><c:varyColors val="0"/>${series}${axisIds}</c:${chart.type}Chart>`
      : chart.type === 'scatter' ? `<c:scatterChart><c:scatterStyle val="marker"/><c:varyColors val="0"/>${series}${axisIds}</c:scatterChart>`
        : `<c:${chart.type}Chart><c:varyColors val="1"/>${series}<c:firstSliceAng val="0"/>${chart.type === 'doughnut' ? '<c:holeSize val="55"/>' : ''}</c:${chart.type}Chart>`
  const axis = (id: number, cross: number, numeric: boolean, position: string): string => `<c:${numeric ? 'valAx' : 'catAx'}><c:axId val="${id}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${position}"/>${numeric ? '<c:majorGridlines/><c:numFmt formatCode="General" sourceLinked="1"/>' : ''}<c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="${cross}"/><c:crosses val="autoZero"/>${numeric ? '<c:crossBetween val="between"/>' : '<c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/>'}</c:${numeric ? 'valAx' : 'catAx'}>`
  const axes = circular ? '' : axis(10001, 10002, chart.type === 'scatter', chart.type === 'bar' ? 'l' : 'b') + axis(10002, 10001, true, chart.type === 'bar' ? 'b' : 'l')
  const legend = chart.legend === false ? '' : '<c:legend><c:legendPos val="b"/><c:overlay val="0"/></c:legend>'
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><c:chartSpace xmlns:c="${C}" xmlns:a="${A}" xmlns:r="${R}"><c:date1904 val="${data.date1904 ? 1 : 0}"/><c:lang val="zh-CN"/><c:roundedCorners val="0"/><c:chart>${chart.title ? richTitle(chart.title) : '<c:autoTitleDeleted val="1"/>'}<c:plotArea><c:layout/>${plot}${axes}</c:plotArea>${legend}<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/><c:showDLblsOverMax val="0"/></c:chart><c:spPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:ln><a:noFill/></a:ln></c:spPr><c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1100"/></a:pPr><a:endParaRPr lang="zh-CN"/></a:p></c:txPr></c:chartSpace>`
}

function addToRoot(xml: string, name: string, child: string): string {
  const roots = elements(xml, name)
  if (roots.length !== 1) fail(`缺少唯一 ${name} 节点`)
  const root = roots[0], opening = root.full.slice(0, root.full.indexOf('>') + 1)
  return xml.replace(root.full, () => opening.endsWith('/>') ? opening.slice(0, -2) + '>' + child + `</${root.tag}>` : opening + root.inner + child + `</${root.tag}>`)
}
/** Attach native chart/drawing parts after cells and formula caches exist. */
export function attachXlsxCharts(entries: Entries, sheets: ChartSheet[]): void {
  if (!sheets.some(sheet => sheet.charts?.length)) return
  const data = workbookData(entries), occupied = new Set(Object.keys(entries).map(name => name.toLowerCase()))
  let types = text(entries['[Content_Types].xml'])
  const typePrefix = elements(types, 'Types')[0]?.tag.replace(/Types$/, '') ?? ''
  for (const item of elements(types, 'Override')) occupied.add(item.attrs.PartName?.slice(1).toLowerCase())
  const part = (kind: 'chart' | 'drawing'): string => {
    let index = 1
    while (occupied.has(`xl/${kind}s/aether${kind}${index}.xml`.toLowerCase()) || occupied.has(`xl/${kind}s/_rels/aether${kind}${index}.xml.rels`.toLowerCase())) index++
    const file = `xl/${kind}s/aether${kind}${index}.xml`; occupied.add(file.toLowerCase()); return file
  }
  for (const sheet of sheets) {
    if (!sheet.charts?.length) continue
    const source = data.sheets.get(sheet.name.toLowerCase())
    if (!source || source.file !== sheet.file) fail('图表工作表关系不匹配')
    let xml = text(entries[sheet.file])
    if (elements(xml, 'drawing').length) fail('新建图表的工作表已含 drawing；未覆盖原绘图')
    const drawingFile = part('drawing'), chartRelations: string[] = [], anchors: string[] = []
    let defaultOffset = 0
    for (const [index, chart] of sheet.charts.entries()) {
      const chartFile = part('chart'), relationId = `chart${index + 1}`
      entries[chartFile] = Buffer.from(chartXml(chart, sheet, data))
      types = addToRoot(types, 'Types', `<${typePrefix}Override PartName="/${chartFile}" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`)
      chartRelations.push(`<Relationship Id="${relationId}" Type="${R}/chart" Target="${path.posix.relative(path.posix.dirname(drawingFile), chartFile)}"/>`)
      const width = chart.anchor?.width ?? 640, height = chart.anchor?.height ?? 360
      const anchor = address(chart.anchor?.cell ?? `${columnName(sheet.columns.length + 2)}2`)
      let row = anchor.row - 1, offset = chart.anchor ? 0 : defaultOffset
      while (offset >= (source.rows.get(row) ?? source.defaultHeight)) { offset -= source.rows.get(row) ?? source.defaultHeight; row++ }
      if (row > 1048575) fail('图表位置超出工作表行数')
      const title = chart.title || `图表 ${index + 1}`
      anchors.push(`<xdr:oneCellAnchor><xdr:from><xdr:col>${anchor.column - 1}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>${Math.round(offset * 9525)}</xdr:rowOff></xdr:from><xdr:ext cx="${Math.round(width * 9525)}" cy="${Math.round(height * 9525)}"/><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${index + 2}" name="${encodeXml(title)}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="${C}"><c:chart xmlns:c="${C}" xmlns:r="${R}" r:id="${relationId}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:oneCellAnchor>`)
      if (!chart.anchor) defaultOffset += height + 24
    }
    entries[drawingFile] = Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="${XDR}" xmlns:a="${A}">${anchors.join('')}</xdr:wsDr>`)
    entries[`${path.posix.dirname(drawingFile)}/_rels/${path.posix.basename(drawingFile)}.rels`] = Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${REL}">${chartRelations.join('')}</Relationships>`)
    types = addToRoot(types, 'Types', `<${typePrefix}Override PartName="/${drawingFile}" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`)
    const relationFile = `${path.posix.dirname(sheet.file)}/_rels/${path.posix.basename(sheet.file)}.rels`
    let relations = text(entries[relationFile]) || `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${REL}"/>`
    const ids = new Set(elements(relations, 'Relationship').map(item => item.attrs.Id))
    let relationId = 'aetherDrawing', index = 1
    while (ids.has(relationId)) relationId = `aetherDrawing${index++}`
    const relPrefix = elements(relations, 'Relationships')[0]?.tag.replace(/Relationships$/, '') ?? ''
    relations = addToRoot(relations, 'Relationships', `<${relPrefix}Relationship Id="${relationId}" Type="${R}/drawing" Target="${path.posix.relative(path.posix.dirname(sheet.file), drawingFile)}"/>`)
    entries[relationFile] = Buffer.from(relations)
    const root = elements(xml, 'worksheet')[0]
    if (!root) fail('工作表根节点缺失')
    if (root.attrs['xmlns:r'] && root.attrs['xmlns:r'] !== R) fail('工作表关系命名空间无效')
    if (!root.attrs['xmlns:r']) xml = xml.replace(new RegExp(`<${root.tag}\\b`), `<${root.tag} xmlns:r="${R}"`)
    const prefix = root.tag.replace(/worksheet$/, '')
    entries[sheet.file] = Buffer.from(addToRoot(xml, 'worksheet', `<${prefix}drawing r:id="${relationId}"/>`))
  }
  entries['[Content_Types].xml'] = Buffer.from(types)
}

/** Cell writes refresh only references whose values can be resolved reliably.
 * Named/external references retain their original data and inspection warns. */
export function refreshXlsxChartCaches(entries: Entries): void {
  const files = Object.keys(entries).filter(file => /^xl\/charts\/[^/]+\.xml$/i.test(file))
  if (!files.length) return
  const data = workbookData(entries)
  for (const file of files) {
    let xml = text(entries[file])
    for (const numeric of [false, true]) {
      for (const item of elements(xml, numeric ? 'numRef' : 'strRef')) {
        const formula = elements(item.inner, 'f')[0]
        if (!formula) continue
        const cells = reference(data, decodeXml(formula.inner)), prefix = item.tag.replace(/(?:numRef|strRef)$/, '')
        if (!cells) continue
        let inner = item.inner
        const previous = elements(inner, numeric ? 'numCache' : 'strCache')
        const format = numeric ? decodeXml(elements(previous[0]?.inner ?? '', 'formatCode')[0]?.inner ?? 'General') : 'General'
        for (const prior of previous) inner = inner.replace(prior.full, '')
        inner += cache(cells, numeric, data.date1904, prefix, format)
        const opening = item.full.slice(0, item.full.indexOf('>') + 1)
        const replacement = `${opening}${inner}</${item.tag}>`
        xml = xml.replace(item.full, () => replacement)
      }
    }
    entries[file] = Buffer.from(xml)
  }
}

export function unresolvedXlsxChartReferences(entries: Entries): number {
  const files = Object.keys(entries).filter(file => /^xl\/charts\/[^/]+\.xml$/i.test(file))
  if (!files.length) return 0
  const data = workbookData(entries)
  let count = 0
  for (const file of files) for (const kind of ['numRef', 'strRef']) for (const item of elements(text(entries[file]), kind)) {
    const formula = elements(item.inner, 'f')[0]
    if (formula && !reference(data, decodeXml(formula.inner))) count++
  }
  return count
}
