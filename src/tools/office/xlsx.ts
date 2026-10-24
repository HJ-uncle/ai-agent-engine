import ExcelJS from 'exceljs'
import path from 'node:path'
import { readOfficeZip, writeOfficeZip, decodeXml, encodeXml } from './office-zip.js'

export interface XlsxColumn {
  header: string
  key: string
  type?: 'text' | 'number' | 'date' | 'percent'
  width?: number
}
export interface XlsxInput {
  sheets: Array<{ name: string; columns: XlsxColumn[]; rows: Array<Record<string, unknown>> }>
}
export interface XlsxEdit { sheet: string; cell: string; value: unknown }

const LIMITS = { sheets: 24, columns: 128, rows: 10_000, cells: 100_000, text: 32_767, edits: 5_000, formula: 2_048 }
const NS = '(?:[A-Za-z_][\\w.-]*:)?'
const utf8 = (value: Uint8Array): string => Buffer.from(value).toString('utf8')
type Scalar = string | number | boolean | null
type Value = Scalar | Date | { formula: string }
interface XmlElement { full: string; tag: string; attrs: Record<string, string>; inner: string; index: number }
interface Sheet { name: string; file: string; xml: string; cells: Map<string, XmlElement> }
interface Package { entries: Record<string, Uint8Array>; workbook: string; sheets: Sheet[]; strings: string[]; date1904: boolean; dateStyles: Set<number> }
interface PreparedSheet { name: string; columns: XlsxColumn[]; rows: Value[][] }

function fail(message: string): never { throw new Error(`XLSX: ${message}`) }
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)
}
function validText(value: string, label: string, limit = LIMITS.text): string {
  if (value.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u.test(value)) fail(`${label} 包含不支持的控制字符或超过 ${limit} 字符`)
  return value
}
function attrs(source: string): Record<string, string> {
  const result: Record<string, string> = Object.create(null)
  for (const match of source.matchAll(/([^\s=/>]+)\s*=\s*(["'])([\s\S]*?)\2/g)) {
    if (Object.hasOwn(result, match[1])) fail('XML 属性重复')
    result[match[1]] = decodeXml(match[3])
  }
  return result
}
function elements(xml: string, name: string): XmlElement[] {
  const re = new RegExp(`<(${NS}${name})\\b([^>]*?)(?:\\/\\s*>|>([\\s\\S]*?)<\\/\\1\\s*>)`, 'g')
  return Array.from(xml.matchAll(re), match => ({ full: match[0], tag: match[1], attrs: attrs(match[2]), inner: match[3] ?? '', index: match.index }))
}
function texts(xml: string): string { return elements(xml, 't').map(item => decodeXml(item.inner)).join('') }
function cellAddress(raw: string): { name: string; row: number; column: number } {
  const match = /^\$?([A-Z]{1,3})\$?([1-9]\d{0,6})$/i.exec(raw)
  if (!match) fail(`无效单元格地址 ${raw}`)
  let column = 0
  for (const letter of match[1].toUpperCase()) column = column * 26 + letter.charCodeAt(0) - 64
  const row = Number(match[2])
  if (column > 16_384 || row > 1_048_576) fail(`单元格地址超出 Excel 范围 ${raw}`)
  return { name: `${match[1].toUpperCase()}${row}`, row, column }
}
function columnName(value: number): string {
  let name = ''
  while (value > 0) { value--; name = String.fromCharCode(65 + value % 26) + name; value = Math.floor(value / 26) }
  return name
}
function range(raw: string): { start: ReturnType<typeof cellAddress>; end: ReturnType<typeof cellAddress> } {
  const parts = raw.split(':')
  if (parts.length > 2) fail(`不支持的单元格范围 ${raw}`)
  const start = cellAddress(parts[0]), end = cellAddress(parts[1] ?? parts[0])
  if (start.row > end.row || start.column > end.column) fail(`反向单元格范围 ${raw}`)
  return { start, end }
}
function contains(raw: string, cell: string): boolean {
  const { start, end } = range(raw), target = cellAddress(cell)
  return target.row >= start.row && target.row <= end.row && target.column >= start.column && target.column <= end.column
}
function serialDate(value: Date, date1904 = false): number {
  return value.getTime() / 86_400_000 + 25_569 - (date1904 ? 1_462 : 0)
}
function parseDate(value: unknown): Date {
  if (value instanceof Date && Number.isFinite(value.getTime())) return new Date(value)
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) fail('日期列需要有效 Date 或 ISO 日期（时间必须附时区）')
  const date = new Date(value)
  const day = new Date(`${value.slice(0, 10)}T00:00:00Z`)
  if (!Number.isFinite(date.getTime()) || day.toISOString().slice(0, 10) !== value.slice(0, 10)) fail(`无效日期 ${value}`)
  return date
}
function valueFor(value: unknown, type?: XlsxColumn['type']): Value {
  if (value === null || value === undefined) return null
  if (record(value)) {
    if (Object.keys(value).length !== 1 || typeof value.formula !== 'string') fail('对象单元格只支持显式 {formula: "SUM(B2:B3)"}')
    const formula = validText(value.formula.replace(/^=/, '').trim(), '公式', LIMITS.formula)
    if (!formula || /[\r\n\[\]]/.test(formula)) fail('公式为空或包含外部工作簿引用')
    return { formula }
  }
  if (type === 'date') return parseDate(value)
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) fail('无效 Date 单元格')
    return new Date(value)
  }
  if (type === 'text') {
    if (!['string', 'number', 'boolean'].includes(typeof value)) fail('文本列需要标量值')
    return validText(String(value), '单元格文本')
  }
  if (type === 'percent' && typeof value === 'string' && /^-?\d+(?:\.\d+)?%$/.test(value)) return Number(value.slice(0, -1)) / 100
  if (type === 'number' || type === 'percent') {
    if (typeof value !== 'number' || !Number.isFinite(value)) fail('数值/百分比列需要有限 number；标识符请使用文本列')
    return value
  }
  if (typeof value === 'string') return validText(value, '单元格文本')
  if (typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean') return value
  return fail('单元格只支持文本、有限数字、布尔、日期、空值或显式公式对象')
}
function packageFrom(buffer: Buffer): Package {
  const entries = readOfficeZip(buffer)
  const readXml = (file: string): string => {
    if (!entries[file]) fail(`缺少 ${file}`)
    const xml = utf8(entries[file])
    if (/<!DOCTYPE|<!ENTITY|<!\[CDATA\[/i.test(xml)) fail(`${file} 包含不支持的 XML 声明`)
    return xml
  }
  const workbook = readXml('xl/workbook.xml'), rels = elements(readXml('xl/_rels/workbook.xml.rels'), 'Relationship')
  const sheetList = elements(workbook, 'sheet')
  if (sheetList.length === 0 || sheetList.length > LIMITS.sheets) fail(`工作表数量须为 1-${LIMITS.sheets}`)
  const names = new Set<string>(), files = new Set<string>()
  let count = 0
  const sheets = sheetList.map(item => {
    const name = item.attrs.name
    if (!name || names.has(name.toLowerCase())) fail('工作表名称缺失或重复')
    names.add(name.toLowerCase())
    const relationship = rels.find(rel => rel.attrs.Id === item.attrs['r:id'])
    if (!relationship || !relationship.attrs.Type?.endsWith('/worksheet') || relationship.attrs.TargetMode === 'External') fail(`工作表 ${name} 关系无效或不是普通 worksheet`)
    const target = relationship.attrs.Target
    if (!target || target.includes('\\')) fail('工作表路径无效')
    const file = target.startsWith('/') ? target.slice(1) : path.posix.normalize(path.posix.join('xl', target))
    if (!file.startsWith('xl/worksheets/') || files.has(file)) fail('工作表路径越界或重复')
    files.add(file)
    const xml = readXml(file), cells = new Map<string, XmlElement>()
    for (const cell of elements(xml, 'c')) {
      if (++count > LIMITS.cells) fail(`工作簿超过 ${LIMITS.cells} 个实际单元格`)
      const address = cellAddress(cell.attrs.r ?? '').name
      if (cells.has(address)) fail(`工作表 ${name} 单元格 ${address} 重复`)
      cells.set(address, cell)
    }
    return { name, file, xml, cells }
  })
  const strings = entries['xl/sharedStrings.xml'] ? elements(readXml('xl/sharedStrings.xml'), 'si').map(item => texts(item.inner)) : []
  if (strings.length > LIMITS.cells) fail('共享字符串数量超出限额')
  const date1904 = ['1', 'true'].includes(elements(workbook, 'workbookPr')[0]?.attrs.date1904 ?? '')
  const dateStyles = new Set<number>()
  if (entries['xl/styles.xml']) {
    const styles = readXml('xl/styles.xml'), formats = new Map(elements(styles, 'numFmt').map(item => [Number(item.attrs.numFmtId), item.attrs.formatCode]))
    const builtins = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58])
    const xfs = elements(styles, 'cellXfs')[0]
    for (const [index, xf] of elements(xfs?.inner ?? '', 'xf').entries()) {
      const id = Number(xf.attrs.numFmtId), original = formats.get(id) ?? '', code = original.replace(/"[^"]*"|\\.|\[[^\]]*\]/g, '')
      // Color/locale tokens such as [Red] and [$USD] are not date components.
      if (builtins.has(id) || /\[[hms]+\]/i.test(original) || /[ydhs]|m[\/-]|[\/-]m/i.test(code)) dateStyles.add(index)
    }
  }
  return { entries, workbook, sheets, strings, date1904, dateStyles }
}
function cellScalar(cell: XmlElement | undefined, pkg: Package): Scalar {
  if (!cell) return null
  const stored = elements(cell.inner, 'v')[0]?.inner
  if (cell.attrs.t === 'inlineStr') return texts(cell.inner)
  if (cell.attrs.t === 's') {
    const index = Number(stored)
    if (stored === undefined || !Number.isInteger(index) || index < 0 || index >= pkg.strings.length) fail('共享字符串引用无效')
    return pkg.strings[index]
  }
  if (stored === undefined || stored === '') return null
  if (cell.attrs.t === 'b') {
    if (stored !== '0' && stored !== '1') fail('无效布尔单元格')
    return stored === '1'
  }
  if (['str', 'e', 'd'].includes(cell.attrs.t ?? '')) return decodeXml(stored)
  const number = Number(stored)
  if (!Number.isFinite(number)) fail('无效数值单元格')
  return number
}

/** Only a small, bounded aggregate subset is evaluated. Other formulas remain visibly pending. */
function aggregate(formula: string, read: (address: string) => Scalar | undefined, budget: { remaining: number }): number | undefined {
  const match = /^(SUM|AVERAGE|MIN|MAX|COUNT)\(([^()]*)\)$/i.exec(formula.trim())
  if (!match) return undefined
  const values: number[] = []
  for (const part of match[2].split(',')) {
    const argument = part.trim()
    if (!argument || --budget.remaining < 0) return undefined
    if (/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(argument)) { const value = Number(argument); if (!Number.isFinite(value)) return undefined; values.push(value); continue }
    if (!/^\$?[A-Z]{1,3}\$?[1-9]\d{0,6}(?::\$?[A-Z]{1,3}\$?[1-9]\d{0,6})?$/i.test(argument)) return undefined
    let bounds: ReturnType<typeof range>
    try { bounds = range(argument) } catch { return undefined }
    const size = (bounds.end.row - bounds.start.row + 1) * (bounds.end.column - bounds.start.column + 1)
    if (size > budget.remaining) return undefined
    for (let row = bounds.start.row; row <= bounds.end.row; row++) for (let col = bounds.start.column; col <= bounds.end.column; col++) {
      budget.remaining--
      const value = read(`${columnName(col)}${row}`)
      if (value === undefined) return undefined
      if (typeof value === 'number') values.push(value)
    }
  }
  const operation = match[1].toUpperCase()
  if (operation === 'COUNT') return values.length
  if (operation === 'AVERAGE' && values.length === 0) return undefined
  const result = operation === 'SUM' ? values.reduce((sum, value) => sum + value, 0)
    : operation === 'AVERAGE' ? values.reduce((sum, value) => sum + value, 0) / values.length
      : operation === 'MIN' ? (values.length ? values.reduce((best, value) => Math.min(best, value), Infinity) : 0) : (values.length ? values.reduce((best, value) => Math.max(best, value), -Infinity) : 0)
  return Number.isFinite(result) ? result : undefined
}
function refreshFormulaCaches(pkg: Package): void {
  const budget = { remaining: 300_000 }
  for (const sheet of pkg.sheets) {
    const memo = new Map<string, Scalar | undefined>(), active = new Set<string>()
    const read = (address: string): Scalar | undefined => {
      if (memo.has(address)) return memo.get(address)
      const cell = sheet.cells.get(address), formula = cell && elements(cell.inner, 'f')[0]
      if (!formula) return cell?.attrs.t === 'e' ? undefined : cellScalar(cell, pkg)
      if (active.has(address) || active.size > 64 || budget.remaining <= 0 || formula.attrs.t && formula.attrs.t !== 'normal') return undefined
      active.add(address)
      const value = aggregate(decodeXml(formula.inner), read, budget)
      active.delete(address); memo.set(address, value)
      return value
    }
    sheet.xml = sheet.xml.replace(new RegExp(`<(${NS}c)\\b([^>]*?)(?:\\/\\s*>|>([\\s\\S]*?)<\\/\\1\\s*>)`, 'g'), (full: string, tag: string, attrSource: string, inner = '') => {
      if (!elements(inner, 'f').length) return full
      const attribute = attrs(attrSource), address = cellAddress(attribute.r ?? '').name
      const result = read(address)
      delete attribute.t
      const prefix = tag.includes(':') ? tag.slice(0, tag.indexOf(':') + 1) : ''
      const body = inner.replace(new RegExp(`<${NS}v\\b[^>]*(?:\\/\\s*>|>[\\s\\S]*?<\\/${NS}v\\s*>)`, 'g'), '')
      return `<${tag}${attributeString(attribute)}>${body}${typeof result === 'number' ? `<${prefix}v>${result}</${prefix}v>` : ''}</${tag}>`
    })
    pkg.entries[sheet.file] = Buffer.from(sheet.xml)
  }
  let workbook = pkg.workbook
  const current = elements(workbook, 'calcPr')[0]
  const properties = { ...(current?.attrs ?? {}), calcMode: 'auto', fullCalcOnLoad: '1', forceFullCalc: '1' }
  const prefix = /^<([\w.-]+:)?workbook\b/m.exec(workbook)?.[1] ?? ''
  const xml = `<${prefix}calcPr${attributeString(properties)}/>`
  workbook = current ? workbook.replace(current.full, () => xml) : workbook.replace(new RegExp(`</${NS}workbook\\s*>`), closing => xml + closing)
  pkg.entries['xl/workbook.xml'] = Buffer.from(workbook)
  // A previous dependency chain describes old cell values; Excel rebuilds it on opening.
  delete pkg.entries['xl/calcChain.xml']
  for (const [file, tag, isChain] of [
    ['xl/_rels/workbook.xml.rels', 'Relationship', (item: XmlElement) => item.attrs.Type?.endsWith('/calcChain')],
    ['[Content_Types].xml', 'Override', (item: XmlElement) => item.attrs.PartName === '/xl/calcChain.xml'],
  ] as const) {
    if (!pkg.entries[file]) continue
    let xmlPart = utf8(pkg.entries[file])
    for (const item of elements(xmlPart, tag)) if (isChain(item)) xmlPart = xmlPart.replace(item.full, '')
    pkg.entries[file] = Buffer.from(xmlPart)
  }
}
function attributeString(value: Record<string, string>): string {
  return Object.entries(value).map(([key, item]) => ` ${key}="${encodeXml(item)}"`).join('')
}

function prepareSheets(input: XlsxInput): PreparedSheet[] {
  if (!record(input) || !Array.isArray(input.sheets) || input.sheets.length < 1 || input.sheets.length > LIMITS.sheets) fail(`sheets 数量须为 1-${LIMITS.sheets}`)
  const names = new Set<string>(), prepared: PreparedSheet[] = []
  let cells = 0
  for (const raw of input.sheets) {
    if (!record(raw) || typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 31 || /[\\/*?:\[\]\u0000-\u001f]/.test(raw.name) || /^'|'$/.test(raw.name)) fail('工作表名称无效（1-31 字符且不能包含特殊字符）')
    if (names.has(raw.name.toLowerCase())) fail('工作表名称重复')
    names.add(raw.name.toLowerCase())
    if (!Array.isArray(raw.columns) || raw.columns.length < 1 || raw.columns.length > LIMITS.columns || !Array.isArray(raw.rows) || raw.rows.length > LIMITS.rows) fail(`每表须为 1-${LIMITS.columns} 列、至多 ${LIMITS.rows} 数据行`)
    const keys = new Set<string>()
    for (const column of raw.columns) {
      if (!record(column) || typeof column.header !== 'string' || !column.header.trim() || typeof column.key !== 'string' || !column.key || keys.has(column.key)) fail('列 header/key 必填且 key 不能重复')
      validText(column.header, '表头', 255); validText(column.key, '列 key', 128)
      if (column.type !== undefined && !['text', 'number', 'date', 'percent'].includes(column.type)) fail('列类型无效')
      if (column.width !== undefined && (!Number.isFinite(column.width) || column.width < 8 || column.width > 80)) fail('列宽须为 8-80')
      keys.add(column.key)
    }
    cells += (raw.rows.length + 1) * raw.columns.length
    if (cells > LIMITS.cells) fail(`工作簿总单元格上限为 ${LIMITS.cells}`)
    const rows = raw.rows.map(row => {
      if (!record(row) || Object.keys(row).some(key => !keys.has(key))) fail('数据行须为对象，且不能包含未声明的列 key')
      return raw.columns.map(column => valueFor(row[column.key], column.type))
    })
    prepared.push({ name: raw.name, columns: raw.columns, rows })
  }
  return prepared
}

export async function createXlsx(input: XlsxInput): Promise<Buffer> {
  const prepared = prepareSheets(input)
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Aether'; workbook.created = new Date(); workbook.calcProperties.fullCalcOnLoad = true
  for (const sheet of prepared) {
    const worksheet = workbook.addWorksheet(sheet.name, {
      views: [{ state: 'frozen', ySplit: 1 }],
      pageSetup: { paperSize: 9, orientation: sheet.columns.length > 6 ? 'landscape' : 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
    })
    worksheet.pageSetup.printTitlesRow = '1:1'
    worksheet.pageSetup.margins = { left: .3, right: .3, top: .5, bottom: .5, header: .2, footer: .2 }
    worksheet.headerFooter.oddFooter = '&L&A&R第 &P 页 / 共 &N 页'
    worksheet.columns = sheet.columns.map((column, index) => ({ header: column.header, key: column.key,
      width: column.width ?? Math.min(42, Math.max(12, ...[column.header, ...sheet.rows.slice(0, 100).map(row => String(row[index] ?? ''))].map(text => Array.from(text).reduce((count, char) => count + (char.charCodeAt(0) > 255 ? 2 : 1), 0) + 3))) }))
    for (const values of sheet.rows) worksheet.addRow(values)
    worksheet.autoFilter = { from: 'A1', to: `${columnName(sheet.columns.length)}${sheet.rows.length + 1}` }
    worksheet.pageSetup.printArea = `A1:${columnName(sheet.columns.length)}${sheet.rows.length + 1}`
    worksheet.eachRow((row, rowNumber) => {
      row.height = rowNumber === 1 ? 28 : 23
      row.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
        const column = sheet.columns[columnNumber - 1]
        cell.font = { name: 'Microsoft YaHei', size: rowNumber === 1 ? 11 : 10, bold: rowNumber === 1, color: { argb: 'FF243247' } }
        cell.alignment = { vertical: 'middle', wrapText: true, horizontal: rowNumber === 1 ? 'left' : ['number', 'percent'].includes(column.type ?? '') ? 'right' : 'left' }
        cell.border = { bottom: { style: 'hair', color: { argb: 'FFDCE3EB' } } }
        if (rowNumber === 1 || rowNumber % 2 === 1) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: rowNumber === 1 ? 'FFE8EEF5' : 'FFF7F9FC' } }
        if (rowNumber === 1) return
        if (column.type === 'date' || cell.value instanceof Date) cell.numFmt = 'yyyy-mm-dd'
        else if (column.type === 'percent') cell.numFmt = '0.00%'
        else if (column.type === 'number') cell.numFmt = '#,##0.00;[Red](#,##0.00)'
        else if (column.type === 'text') cell.numFmt = '@'
        const type = column.type === 'text' ? 'textLength' : column.type === 'date' ? 'date' : column.type === 'number' || column.type === 'percent' ? 'decimal' : undefined
        // ExcelJS treats date-validation operands as Date inputs, not Excel serial numbers.
        if (type) cell.dataValidation = { type, operator: 'between', allowBlank: true, showErrorMessage: true, errorStyle: 'stop', errorTitle: '数据类型不符', error: '请按列定义输入文本、有效日期或数值。', formulae: type === 'textLength' ? [0, LIMITS.text] : type === 'date' ? [new Date('1900-01-01T00:00:00Z'), new Date('9999-12-31T00:00:00Z')] : [-1e308, 1e308] }
      })
    })
  }
  const pkg = packageFrom(Buffer.from(await workbook.xlsx.writeBuffer()))
  refreshFormulaCaches(pkg)
  return writeOfficeZip(pkg.entries)
}

export async function inspectXlsx(buffer: Buffer): Promise<{ format: 'xlsx'; content: string; summary: Record<string, number | string | boolean>; warnings: string[] }> {
  const pkg = packageFrom(buffer), warnings: string[] = [], lines: string[] = []
  const formulaTextLocations: string[] = []
  let formulaTextCells = 0, formulaTextLocationCharacters = 0
  const errorLocations: string[] = []
  let errorCells = 0, formulaErrorCells = 0, errorLocationCharacters = 0
  let cells = 0, formulas = 0, formulaCaches = 0, pendingFormulas = 0, shown = 0, characters = 0, shortenedCells = 0
  for (const sheet of pkg.sheets) {
    lines.push(`## ${sheet.name}`)
    for (const [address, cell] of sheet.cells) {
      cells++
      const formula = elements(cell.inner, 'f')[0], value = cellScalar(cell, pkg)
      // A local PASS count cannot certify other sheets. Inspect saved error types
      // during this same bounded traversal, including cells outside the preview.
      if (cell.attrs.t === 'e') {
        errorCells++
        if (formula) formulaErrorCells++
        const location = `${JSON.stringify(sheet.name)}!${address} (${JSON.stringify(String(value ?? '无错误代码').slice(0, 40))})`
        if (errorLocations.length < 20 && errorLocationCharacters + location.length <= 2_000) {
          errorLocations.push(location); errorLocationCharacters += location.length
        }
      }
      let display = value === null ? '（空）' : String(value)
      if (!formula && typeof value === 'number' && pkg.dateStyles.has(Number(cell.attrs.s ?? 0))) {
        const date = new Date((value - 25_569 + (pkg.date1904 ? 1_462 : 0)) * 86_400_000)
        if (Number.isFinite(date.getTime())) display = `${date.toISOString()}（日期）`
      }
      if (formula) {
        formulas++
        const hasCache = value !== null
        if (hasCache) formulaCaches++; else pendingFormulas++
        display = `公式 =${decodeXml(formula.inner) || `[${formula.attrs.t ?? '未知'}公式]`}；${hasCache ? `文件缓存 ${String(value)}（未独立验证）` : '待重算，无有效缓存'}`
      } else if (typeof value === 'string' && value.startsWith('=')) {
        // A successful write of literal text is not evidence that a check formula ran.
        // Count during the existing bounded traversal, even beyond the content preview.
        formulaTextCells++
        if (formulaTextLocations.length < 20 && formulaTextLocationCharacters + sheet.name.length + address.length + 3 <= 2_000) {
          const location = `${JSON.stringify(sheet.name)}!${address}`
          if (formulaTextLocationCharacters + location.length <= 2_000) {
            formulaTextLocations.push(location); formulaTextLocationCharacters += location.length
          }
        }
        display = `文本（以 = 开头，非公式）：${value}`
      }
      if (shown < 2_000 && characters < 60_000) {
        if (display.length > 600) shortenedCells++
        const text = `- ${address}: ${display.slice(0, 600).replace(/\r?\n/g, ' ↵ ')}`
        lines.push(text); characters += text.length; shown++
      }
    }
  }
  if (shown < cells) warnings.push(`内容预览已截断：显示 ${shown}/${cells} 个单元格，实际文件未截断。`)
  if (shortenedCells) warnings.push(`${shortenedCells} 个单元格的长文本仅预览前 600 字符，实际文件未截断。`)
  if (errorCells) warnings.push(`全工作簿发现 ${errorCells} 个已保存的错误单元格，其中 ${formulaErrorCells} 个为公式错误缓存；位置（列出 ${errorLocations.length}/${errorCells}）：${errorLocations.join('、') || '超出诊断长度上限'}。缓存存在不代表结果有效；局部校验表 PASS 不能替代全表检查。这里只检查文件保存的错误类型，未重新计算，也不保证无业务错误。`)
  if (formulaTextCells) warnings.push(`${formulaTextCells} 个以 = 开头的文本单元格不是公式，不会计算；位置（列出 ${formulaTextLocations.length}/${formulaTextCells}）：${formulaTextLocations.join('、') || '超出诊断长度上限'}。如需计算，请显式写入 {formula: "..."}；若为文字示例可保持原样。原文本未更改，未自动执行，也不计入 formulas / formulaCaches / pendingFormulas。`)
  if (formulas) warnings.push('公式缓存是文件中保存的值；只有 SUM/AVERAGE/MIN/MAX/COUNT 的同表简单引用在生成/编辑时尝试本地求值，其他公式需要 Excel/WPS 重算。')
  if (pendingFormulas) warnings.push(`${pendingFormulas} 个公式没有有效缓存，当前结果为待重算，不能视为已完成计算。`)
  if (Object.keys(pkg.entries).some(file => /vbaProject\.bin$|pivotTables\/|externalLinks\//i.test(file))) warnings.push('文件含宏、数据透视或外部链接等复杂内容；读取不执行这些内容，编辑只支持明确单元格局部更新。')
  return { format: 'xlsx', content: lines.join('\n'), summary: { sheets: pkg.sheets.length, cells, formulas, formulaCaches, pendingFormulas, errorCells, formulaErrorCells, date1904: pkg.date1904, previewCells: shown, previewTruncated: shown < cells || shortenedCells > 0, calculation: elements(pkg.workbook, 'calcPr')[0]?.attrs.calcMode ?? 'unspecified' }, warnings }
}

function encodeCell(address: string, value: Value, existing: XmlElement | undefined, prefix: string, date1904: boolean): string {
  const attribute: Record<string, string> = { ...(existing?.attrs ?? {}), r: address }
  delete attribute.t
  let inner: string
  if (value === null) inner = ''
  else if (typeof value === 'string') { attribute.t = 'inlineStr'; inner = `<${prefix}is><${prefix}t xml:space="preserve">${encodeXml(value)}</${prefix}t></${prefix}is>` }
  else if (typeof value === 'boolean') { attribute.t = 'b'; inner = `<${prefix}v>${value ? 1 : 0}</${prefix}v>` }
  else if (typeof value === 'number') inner = `<${prefix}v>${value}</${prefix}v>`
  else if (value instanceof Date) inner = `<${prefix}v>${serialDate(value, date1904)}</${prefix}v>`
  else inner = `<${prefix}f>${encodeXml(value.formula)}</${prefix}f>`
  return `<${prefix}c${attributeString(attribute)}>${inner}</${prefix}c>`
}
interface TargetRules { merges: XmlElement[]; protectedRanges: string[]; protectedCells: Set<string>; validations: XmlElement[]; structured: boolean }
function targetRules(sheet: Sheet): TargetRules {
  const protectedRanges: string[] = [], protectedCells = new Set<string>()
  for (const [address, cell] of sheet.cells) {
    const formula = elements(cell.inner, 'f')[0]
    if (!formula) continue
    if (formula.attrs.t && formula.attrs.t !== 'normal') protectedCells.add(address)
    if (formula.attrs.ref) protectedRanges.push(formula.attrs.ref)
  }
  return { merges: elements(sheet.xml, 'mergeCell'), protectedRanges, protectedCells, validations: elements(sheet.xml, 'dataValidation'),
    structured: elements(sheet.xml, 'tableParts').length > 0 || elements(sheet.xml, 'pivotTableParts').length > 0 }
}
function validateTarget(sheet: Sheet, rules: TargetRules, address: string, value: Value, date1904: boolean): void {
  const existing = sheet.cells.get(address)
  if (existing && (existing.attrs.cm || existing.attrs.vm || elements(existing.inner, 'extLst').length)) fail(`${sheet.name}!${address} 含富数据元信息，暂不支持修改`)
  for (const merge of rules.merges) if (merge.attrs.ref && contains(merge.attrs.ref, address) && range(merge.attrs.ref).start.name !== address) fail(`${sheet.name}!${address} 是合并区域从属单元格`)
  if (rules.protectedCells.has(address) || rules.protectedRanges.some(ref => contains(ref, address))) fail(`${sheet.name}!${address} 涉及数组/共享/区域公式，暂不支持修改`)
  if (rules.structured) fail(`工作表 ${sheet.name} 包含结构化表格或数据透视，暂不支持直接编辑；请另存普通工作表后重试`)
  for (const validation of rules.validations) {
    if (!(validation.attrs.sqref ?? '').split(/\s+/).filter(Boolean).some(item => contains(item, address))) continue
    if (value === null && ['1', 'true'].includes(validation.attrs.allowBlank)) continue
    if (record(value)) continue // Formula result is validated by Excel after recalculation, never guessed here.
    const type = validation.attrs.type, first = decodeXml(elements(validation.inner, 'formula1')[0]?.inner ?? ''), second = decodeXml(elements(validation.inner, 'formula2')[0]?.inner ?? '')
    if (!type || type === 'none') continue
    if (type === 'list' && /^"[^"\r\n]*"$/.test(first)) {
      if (!first.slice(1, -1).split(',').includes(String(value ?? ''))) fail(`${sheet.name}!${address} 不符合列表数据验证`)
      continue
    }
    if (!['whole', 'decimal', 'date', 'textLength'].includes(type) || !first || !Number.isFinite(Number(first)) || second && !Number.isFinite(Number(second))) fail(`${sheet.name}!${address} 包含无法在本地验证的数据规则，未修改文件`)
    const actual = type === 'textLength' ? String(value ?? '').length : value instanceof Date ? serialDate(value, date1904) : value
    if (typeof actual !== 'number' || !Number.isFinite(actual) || type === 'whole' && !Number.isInteger(actual)) fail(`${sheet.name}!${address} 不符合 ${type} 数据验证`)
    const a = Number(first), b = Number(second), op = validation.attrs.operator ?? 'between'
    const allowed = op === 'between' ? actual >= a && actual <= b : op === 'notBetween' ? actual < a || actual > b : op === 'equal' ? actual === a : op === 'notEqual' ? actual !== a : op === 'greaterThan' ? actual > a : op === 'lessThan' ? actual < a : op === 'greaterThanOrEqual' ? actual >= a : op === 'lessThanOrEqual' ? actual <= a : false
    if (!allowed) fail(`${sheet.name}!${address} 不符合 ${type} 数据验证范围`)
  }
}
function patchSheet(sheet: Sheet, edits: Array<{ address: string; value: Value }>, date1904: boolean): void {
  const sheetData = elements(sheet.xml, 'sheetData')[0]
  if (!sheetData) fail(`工作表 ${sheet.name} 没有 sheetData`)
  const prefix = sheetData.tag.includes(':') ? sheetData.tag.slice(0, sheetData.tag.indexOf(':') + 1) : ''
  const rows = new Map<number, { attrs: Record<string, string>; cells: Map<number, string> }>()
  for (const row of elements(sheetData.inner, 'row')) {
    const index = Number(row.attrs.r)
    if (!Number.isInteger(index) || index < 1 || index > 1_048_576 || rows.has(index)) fail('工作表 row 索引无效或重复')
    const cells = new Map<number, string>()
    for (const cell of elements(row.inner, 'c')) {
      const address = cellAddress(cell.attrs.r ?? '')
      if (address.row !== index) fail('单元格与 row 索引不匹配')
      cells.set(address.column, cell.full)
    }
    // Non-cell row extensions cannot be safely reconstructed by this deliberately narrow patcher.
    const other = row.inner.replace(new RegExp(`<(${NS}c)\\b[^>]*?(?:\\/\\s*>|>[\\s\\S]*?<\\/\\1\\s*>)`, 'g'), '')
    if (other.trim()) fail('目标工作表包含不支持的 row 扩展，未修改文件')
    rows.set(index, { attrs: row.attrs, cells })
  }
  for (const edit of edits) {
    const address = cellAddress(edit.address)
    let row = rows.get(address.row)
    if (!row) { row = { attrs: { r: String(address.row) }, cells: new Map() }; rows.set(address.row, row) }
    delete row.attrs.spans
    row.cells.set(address.column, encodeCell(address.name, edit.value, sheet.cells.get(address.name), prefix, date1904))
  }
  const data = [...rows.entries()].sort(([a], [b]) => a - b).map(([, row]) => `<${prefix}row${attributeString(row.attrs)}>${[...row.cells.entries()].sort(([a], [b]) => a - b).map(([, cell]) => cell).join('')}</${prefix}row>`).join('')
  sheet.xml = sheet.xml.replace(sheetData.full, () => `<${sheetData.tag}${attributeString(sheetData.attrs)}>${data}</${sheetData.tag}>`)
  const all = [...sheet.cells.keys(), ...edits.map(edit => edit.address)].map(cellAddress)
  if (all.length) {
    let minColumn = 16_384, maxColumn = 1, minRow = 1_048_576, maxRow = 1
    for (const item of all) { minColumn = Math.min(minColumn, item.column); maxColumn = Math.max(maxColumn, item.column); minRow = Math.min(minRow, item.row); maxRow = Math.max(maxRow, item.row) }
    const dimension = elements(sheet.xml, 'dimension')[0]
    if (dimension) sheet.xml = sheet.xml.replace(dimension.full, () => `<${prefix}dimension ref="${columnName(minColumn)}${minRow}:${columnName(maxColumn)}${maxRow}"/>`)
  }
}

export async function editXlsx(buffer: Buffer, edits: XlsxEdit[]): Promise<Buffer> {
  if (!Array.isArray(edits) || edits.length < 1 || edits.length > LIMITS.edits) fail(`edits 数量须为 1-${LIMITS.edits}`)
  const pkg = packageFrom(buffer)
  if (Object.keys(pkg.entries).some(file => /^_xmlsignatures\//i.test(file))) fail('签名工作簿不能局部修改，否则会使签名失效')
  const seen = new Set<string>(), grouped = new Map<Sheet, Array<{ address: string; value: Value }>>()
  const rulesBySheet = new Map<Sheet, TargetRules>()
  let extraCells = 0, validationBudget = 500_000
  // Validate the complete batch before creating replacement bytes.
  for (const edit of edits) {
    if (!record(edit) || typeof edit.sheet !== 'string' || typeof edit.cell !== 'string') fail('每个编辑项必须有 sheet/cell/value')
    const sheet = pkg.sheets.find(item => item.name === edit.sheet)
    if (!sheet) fail(`工作表不存在 ${edit.sheet}`)
    const address = cellAddress(edit.cell).name, key = `${sheet.file}:${address}`
    if (seen.has(key)) fail(`同一批次重复编辑 ${edit.sheet}!${address}`)
    seen.add(key)
    const value = valueFor(edit.value)
    let rules = rulesBySheet.get(sheet)
    if (!rules) { rules = targetRules(sheet); rulesBySheet.set(sheet, rules) }
    validationBudget -= rules.merges.length + rules.protectedRanges.length + rules.validations.length + 1
    if (validationBudget < 0) fail('批量编辑涉及过多区域验证，请拆分批次或简化工作表后重试')
    validateTarget(sheet, rules, address, value, pkg.date1904)
    if (!sheet.cells.has(address)) extraCells++
    const group = grouped.get(sheet) ?? []
    group.push({ address, value }); grouped.set(sheet, group)
  }
  const currentCells = pkg.sheets.reduce((count, sheet) => count + sheet.cells.size, 0)
  if (currentCells + extraCells > LIMITS.cells) fail(`编辑后超过 ${LIMITS.cells} 个单元格`)
  for (const [sheet, changes] of grouped) { patchSheet(sheet, changes, pkg.date1904); pkg.entries[sheet.file] = Buffer.from(sheet.xml) }
  const updated = packageFrom(writeOfficeZip(pkg.entries))
  refreshFormulaCaches(updated)
  return writeOfficeZip(updated.entries)
}

const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const DOC_REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PACKAGE_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const CONTENT_NS = 'http://schemas.openxmlformats.org/package/2006/content-types'

function uniqueElement(xml: string, name: string): XmlElement {
  const matches = elements(xml, name)
  if (matches.length !== 1) fail(`追加工作表需要唯一 ${name} 节点，未修改文件`)
  return matches[0]
}
function xmlPrefix(item: XmlElement): string { return item.tag.includes(':') ? item.tag.slice(0, item.tag.indexOf(':') + 1) : '' }
function checkedRoot(xml: string, name: string, namespace: string): XmlElement {
  const root = uniqueElement(xml, name), prefix = xmlPrefix(root)
  if (root.attrs[prefix ? `xmlns:${prefix.slice(0, -1)}` : 'xmlns'] !== namespace) fail(`追加工作表暂不支持 ${name} 的 XML 命名空间`)
  return root
}
function appendChildren(xml: string, name: string, children: string, additions?: number): string {
  const parent = uniqueElement(xml, name), attributes = { ...parent.attrs }
  if (additions !== undefined) attributes.count = String(Number(attributes.count) + additions)
  // OOXML text may contain literal replacement tokens ($&, $$, $', $`). A
  // callback prevents JavaScript from interpreting names or preserved content.
  return xml.replace(parent.full, () => `<${parent.tag}${attributeString(attributes)}>${parent.inner}${children}</${parent.tag}>`)
}

/** Styles are appended without renumbering any source index. New strings use
 * inlineStr, so adding sheets cannot alter a source sharedStrings reference. */
function appendSheetStyles(pkg: Package): Record<string, number> {
  if (!pkg.entries['xl/styles.xml']) fail('追加工作表需要已有 styles.xml；此工作簿样式结构暂不支持')
  let xml = utf8(pkg.entries['xl/styles.xml'])
  const root = checkedRoot(xml, 'styleSheet', MAIN_NS), prefix = xmlPrefix(root)
  const sectionSize = (parent: string, child: string): number => {
    const section = uniqueElement(xml, parent), size = elements(section.inner, child).length
    if (!size || size > 10_000 || Number(section.attrs.count) !== size) fail(`样式 ${parent} 索引数量无效或过大`)
    return size
  }
  const font = sectionSize('fonts', 'font'), fill = sectionSize('fills', 'fill'), border = sectionSize('borders', 'border')
  sectionSize('cellStyleXfs', 'xf')
  const firstStyle = sectionSize('cellXfs', 'xf')
  const numFmts = elements(xml, 'numFmts')
  if (numFmts.length > 1) fail('numFmts 重复')
  const formats = numFmts.length ? elements(numFmts[0].inner, 'numFmt') : []
  if (numFmts.length && Number(numFmts[0].attrs.count) !== formats.length) fail('numFmts 数量无效')
  const ids = formats.map(item => Number(item.attrs.numFmtId))
  if (ids.some(id => !Number.isInteger(id) || id < 0 || id > 65_533) || new Set(ids).size !== ids.length) fail('numFmtId 无效或重复')
  const dateFormat = Math.max(163, ...ids) + 1, numberFormat = dateFormat + 1
  const formatsXml = `<${prefix}numFmt numFmtId="${dateFormat}" formatCode="yyyy-mm-dd"/><${prefix}numFmt numFmtId="${numberFormat}" formatCode="#,##0.00;[Red](#,##0.00)"/>`
  if (numFmts.length) xml = appendChildren(xml, 'numFmts', formatsXml, 2)
  else {
    const opening = new RegExp(`<${root.tag}\\b[^>]*>`)
    xml = xml.replace(opening, matched => `${matched}<${prefix}numFmts count="2">${formatsXml}</${prefix}numFmts>`)
  }
  const makeFont = (bold: boolean) => `<${prefix}font><${prefix}sz val="${bold ? 11 : 10}"/><${prefix}color rgb="FF243247"/><${prefix}name val="Microsoft YaHei"/>${bold ? `<${prefix}b/>` : ''}</${prefix}font>`
  xml = appendChildren(xml, 'fonts', makeFont(false) + makeFont(true), 2)
  xml = appendChildren(xml, 'fills', `<${prefix}fill><${prefix}patternFill patternType="none"/></${prefix}fill><${prefix}fill><${prefix}patternFill patternType="solid"><${prefix}fgColor rgb="FFE8EEF5"/><${prefix}bgColor indexed="64"/></${prefix}patternFill></${prefix}fill>`, 2)
  xml = appendChildren(xml, 'borders', `<${prefix}border><${prefix}left/><${prefix}right/><${prefix}top/><${prefix}bottom style="hair"><${prefix}color rgb="FFDCE3EB"/></${prefix}bottom><${prefix}diagonal/></${prefix}border>`, 1)
  const kinds = ['header', 'general', 'text', 'number', 'percent', 'date']
  const formatIds = [0, 0, 49, numberFormat, 10, dateFormat]
  const xfs = kinds.map((kind, index) => `<${prefix}xf numFmtId="${formatIds[index]}" fontId="${font + (kind === 'header' ? 1 : 0)}" fillId="${fill + (kind === 'header' ? 1 : 0)}" borderId="${border}" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><${prefix}alignment vertical="center" horizontal="${['number', 'percent'].includes(kind) ? 'right' : 'left'}" wrapText="1"/></${prefix}xf>`).join('')
  xml = appendChildren(xml, 'cellXfs', xfs, kinds.length)
  pkg.entries['xl/styles.xml'] = Buffer.from(xml)
  return Object.fromEntries(kinds.map((kind, index) => [kind, firstStyle + index]))
}

function newWorksheet(sheet: PreparedSheet, styles: Record<string, number>, date1904: boolean): string {
  const last = `${columnName(sheet.columns.length)}${sheet.rows.length + 1}`
  const encode = (address: string, value: Value, style: number) => encodeCell(address, value,
    { attrs: { s: String(style) }, full: '', tag: 'c', inner: '', index: 0 }, '', date1904)
  const header = sheet.columns.map((column, index) => encode(`${columnName(index + 1)}1`, column.header, styles.header)).join('')
  const rows = sheet.rows.map((row, index) => `<row r="${index + 2}" ht="23" customHeight="1">${row.map((value, col) => encode(`${columnName(col + 1)}${index + 2}`, value, styles[sheet.columns[col].type ?? (value instanceof Date ? 'date' : 'general')])).join('')}</row>`).join('')
  const columns = sheet.columns.map((column, index) => `<col min="${index + 1}" max="${index + 1}" width="${column.width ?? Math.min(42, Math.max(12, Array.from(column.header).length * 2 + 3))}" customWidth="1"/>`).join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${MAIN_NS}"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><dimension ref="A1:${last}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="23"/><cols>${columns}</cols><sheetData><row r="1" ht="28" customHeight="1">${header}</row>${rows}</sheetData><autoFilter ref="A1:${last}"/><pageMargins left="0.3" right="0.3" top="0.5" bottom="0.5" header="0.2" footer="0.2"/><pageSetup paperSize="9" orientation="${sheet.columns.length > 6 ? 'landscape' : 'portrait'}" fitToWidth="1" fitToHeight="0"/><headerFooter><oddFooter>&amp;L&amp;A&amp;R第 &amp;P 页 / 共 &amp;N 页</oddFooter></headerFooter></worksheet>`
}

/** Only the relationship-designated calc-chain part is removed. Never strip
 * other relations or arbitrary similarly named parts when preserving a book. */
function removeAppendCalcChains(pkg: Package): void {
  let rels = utf8(pkg.entries['xl/_rels/workbook.xml.rels']), types = utf8(pkg.entries['[Content_Types].xml'])
  for (const rel of elements(rels, 'Relationship').filter(item => item.attrs.Type === `${DOC_REL_NS}/calcChain`)) {
    const target = rel.attrs.Target
    if (!target || target.includes('\\') || rel.attrs.TargetMode === 'External') fail('计算链关系无效')
    const file = target.startsWith('/') ? target.slice(1) : path.posix.normalize(path.posix.join('xl', target))
    const overrides = elements(types, 'Override').filter(item => item.attrs.PartName === '/' + file)
    if (!file.startsWith('xl/') || !pkg.entries[file] || overrides.length !== 1 ||
      overrides[0].attrs.ContentType !== 'application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml') fail('计算链部件/内容类型不匹配，未修改文件')
    checkedRoot(utf8(pkg.entries[file]), 'calcChain', MAIN_NS)
    delete pkg.entries[file]
    rels = rels.replace(rel.full, ''); types = types.replace(overrides[0].full, '')
  }
  pkg.entries['xl/_rels/workbook.xml.rels'] = Buffer.from(rels)
  pkg.entries['[Content_Types].xml'] = Buffer.from(types)
}

/** Adds ordinary worksheets without round-tripping an existing workbook
 * through ExcelJS. Existing worksheets and opaque object parts stay byte-exact
 * after ZIP extraction; their caches are deliberately not silently rewritten. */
export async function appendXlsxSheets(buffer: Buffer, input: XlsxInput): Promise<Buffer> {
  if (!Array.isArray(input?.sheets) || input.sheets.length < 1 || input.sheets.length > 4) fail('每次追加 1-4 张工作表；建议一次一张并复用最新 expectedHash')
  const prepared = prepareSheets(input), pkg = packageFrom(buffer)
  const workbookRoot = checkedRoot(pkg.workbook, 'workbook', MAIN_NS)
  if (workbookRoot.attrs['xmlns:r'] !== DOC_REL_NS) fail('追加工作表需要标准 r 关系命名空间')
  const protection = elements(pkg.workbook, 'workbookProtection')
  if (protection.some(item => ['1', 'true', 'on'].includes(item.attrs.lockStructure?.toLowerCase() ?? ''))) fail('工作簿结构已保护，不能添加工作表')
  if (elements(pkg.workbook, 'fileSharing').length || Object.keys(pkg.entries).some(file => file.startsWith('xl/revisions/'))) fail('共享修订工作簿暂不支持追加工作表')
  const existingNames = new Set(pkg.sheets.map(sheet => sheet.name.toLowerCase()))
  if (prepared.some(sheet => existingNames.has(sheet.name.toLowerCase()))) fail('工作表名称已存在；追加不能覆盖原表，请 inspect 后编辑或使用新名称')
  if (pkg.sheets.length + prepared.length > LIMITS.sheets) fail(`追加后工作表不能超过 ${LIMITS.sheets} 张`)
  const addedCells = prepared.reduce((sum, sheet) => sum + (sheet.rows.length + 1) * sheet.columns.length, 0)
  if (pkg.sheets.reduce((sum, sheet) => sum + sheet.cells.size, 0) + addedCells > LIMITS.cells) fail(`追加后工作簿超过 ${LIMITS.cells} 个单元格`)
  let rels = utf8(pkg.entries['xl/_rels/workbook.xml.rels']), types = utf8(pkg.entries['[Content_Types].xml'] ?? new Uint8Array())
  const relRoot = checkedRoot(rels, 'Relationships', PACKAGE_REL_NS), typeRoot = checkedRoot(types, 'Types', CONTENT_NS)
  const allRels = elements(rels, 'Relationship'), relationIds = new Set(allRels.map(item => item.attrs.Id))
  if (allRels.some(item => !item.attrs.Id) || relationIds.size !== allRels.length) fail('工作簿关系 Id 缺失或重复')
  const overrides = elements(types, 'Override'), declaredParts = overrides.map(item => item.attrs.PartName?.toLowerCase())
  if (declaredParts.some(name => !name?.startsWith('/')) || new Set(declaredParts).size !== declaredParts.length) fail('内容类型 PartName 缺失或重复')
  const styleRelations = allRels.filter(item => item.attrs.Type === `${DOC_REL_NS}/styles`)
  if (styleRelations.length !== 1 || styleRelations[0].attrs.TargetMode === 'External' || !['styles.xml', '/xl/styles.xml'].includes(styleRelations[0].attrs.Target)) fail('追加工作表需要唯一标准 styles.xml 关系')
  const ids = elements(pkg.workbook, 'sheet').map(item => Number(item.attrs.sheetId))
  if (ids.some(id => !Number.isInteger(id) || id <= 0 || id > 4_294_967_295 - prepared.length) || new Set(ids).size !== ids.length) fail('工作表 sheetId 无效或重复')
  const styles = appendSheetStyles(pkg), prefix = xmlPrefix(workbookRoot), relPrefix = xmlPrefix(relRoot), typePrefix = xmlPrefix(typeRoot)
  const occupiedParts = new Set([...Object.keys(pkg.entries).map(file => file.toLowerCase()), ...declaredParts.map(name => name.slice(1))])
  for (const rel of allRels) if (rel.attrs.TargetMode !== 'External' && rel.attrs.Target) {
    const target = rel.attrs.Target.startsWith('/') ? rel.attrs.Target.slice(1) : path.posix.normalize(path.posix.join('xl', rel.attrs.Target))
    occupiedParts.add(target.toLowerCase())
  }
  let partIndex = 1, relationshipIndex = 1, sheetId = Math.max(...ids)
  const newSheets: Sheet[] = [], definitions: string[] = []
  for (const [index, sheet] of prepared.entries()) {
    while (occupiedParts.has(`xl/worksheets/sheet${partIndex}.xml`.toLowerCase())) partIndex++
    const file = `xl/worksheets/sheet${partIndex++}.xml`; occupiedParts.add(file.toLowerCase())
    while (relationIds.has(`aetherSheet${relationshipIndex}`)) relationshipIndex++
    const relationId = `aetherSheet${relationshipIndex++}`; relationIds.add(relationId)
    pkg.workbook = appendChildren(pkg.workbook, 'sheets', `<${prefix}sheet name="${encodeXml(sheet.name)}" sheetId="${++sheetId}" r:id="${relationId}"/>`)
    rels = appendChildren(rels, 'Relationships', `<${relPrefix}Relationship Id="${relationId}" Type="${DOC_REL_NS}/worksheet" Target="${file.slice(3)}"/>`)
    types = appendChildren(types, 'Types', `<${typePrefix}Override PartName="/${file}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
    const xml = newWorksheet(sheet, styles, pkg.date1904)
    const cells = new Map(elements(xml, 'c').map(cell => [cell.attrs.r, cell]))
    newSheets.push({ name: sheet.name, file, xml, cells })
    const quotedName = `'${sheet.name.replace(/'/g, "''")}'`
    const localId = pkg.sheets.length + index
    definitions.push(`<${prefix}definedName name="_xlnm.Print_Titles" localSheetId="${localId}">${encodeXml(quotedName)}!$1:$1</${prefix}definedName>`,
      `<${prefix}definedName name="_xlnm.Print_Area" localSheetId="${localId}">${encodeXml(quotedName)}!$A$1:$${columnName(sheet.columns.length)}$${sheet.rows.length + 1}</${prefix}definedName>`)
  }
  if (elements(pkg.workbook, 'definedNames').length) pkg.workbook = appendChildren(pkg.workbook, 'definedNames', definitions.join(''))
  else {
    const afterSheets = uniqueElement(pkg.workbook, 'sheets')
    // definedNames follows sheets and workbook-level externalReferences. Insert
    // before calcPr when present; otherwise after externalReferences/sheets.
    const before = elements(pkg.workbook, 'calcPr')[0]
    const after = elements(pkg.workbook, 'externalReferences')[0] ?? afterSheets
    const xml = `<${prefix}definedNames>${definitions.join('')}</${prefix}definedNames>`
    pkg.workbook = before ? pkg.workbook.replace(before.full, () => xml + before.full) : pkg.workbook.replace(after.full, () => after.full + xml)
  }
  pkg.entries['xl/workbook.xml'] = Buffer.from(pkg.workbook)
  pkg.entries['xl/_rels/workbook.xml.rels'] = Buffer.from(rels)
  pkg.entries['[Content_Types].xml'] = Buffer.from(types)
  // Evaluate only new sheets. Running this over the original sheets would
  // destroy their caches and contradict the preservation contract.
  const addition: Package = { ...pkg, entries: Object.create(null), sheets: newSheets }
  refreshFormulaCaches(addition)
  Object.assign(pkg.entries, addition.entries)
  removeAppendCalcChains(pkg)
  const output = writeOfficeZip(pkg.entries)
  packageFrom(output)
  return output
}
