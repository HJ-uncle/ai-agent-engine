import { createRequire } from 'node:module'
import { encodeXml } from './office-zip.js'
import { presentationSchema, type PptxInput, type PptxSlide } from './pptx-schema.js'

// PptxGenJS 4 uses a CJS declaration; its CJS entry preserves NodeNext types.
const PptxGenJS: typeof import('pptxgenjs').default = createRequire(import.meta.url)('pptxgenjs')
type Deck = InstanceType<typeof PptxGenJS>
type Slide = ReturnType<Deck['addSlide']>
type TextOptions = NonNullable<Parameters<Slide['addText']>[1]>
type Box = { x: number; y: number; w: number; h: number }
export const PPTX_CANVAS = { w: 13.333333, h: 7.5 }
export const MAX_PPTX_IMAGE_BYTES = 8 * 1024 * 1024
export const MAX_PPTX_ASSET_BYTES = 24 * 1024 * 1024
export type PptxAssets = ReadonlyMap<string, Buffer>
function fail(message: string): never { throw new Error(`PPTX: ${message}`) }
const units = (value: string) => Array.from(value).reduce((sum, ch) => sum + ((ch.codePointAt(0) ?? 0) > 255 ? 2 : 1), 0)
const luminance = (color: string) => [0, 2, 4].map(offset => parseInt(color.slice(offset, offset + 2), 16) / 255)
  .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0)
function contrastingColor(background: string, first: string, second: string): string {
  const base = luminance(background), contrast = (color: string) => (Math.max(base, luminance(color)) + 0.05) / (Math.min(base, luminance(color)) + 0.05)
  return contrast(first) >= contrast(second) ? first : second
}

export function pptxImagePaths(input: Pick<PptxInput, 'slides'>): string[] {
  return [...new Set(input.slides.flatMap(slide => [
    ...(slide.image ? [slide.image.path] : []), ...(slide.elements?.flatMap(element => element.type === 'image' ? [element.path] : []) ?? []),
  ]))]
}

export function inspectPptxImage(bytes: Buffer): { mime: 'image/png' | 'image/jpeg'; width: number; height: number } {
  if (!bytes.length || bytes.length > MAX_PPTX_IMAGE_BYTES) fail('图片须为非空文件，且不超过 8 MiB')
  let mime: 'image/png' | 'image/jpeg', width = 0, height = 0
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    mime = 'image/png'
    if (bytes.length < 45 || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') fail('PNG 图片头无效')
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20)
    let offset = 8, data = false, ended = false
    while (offset + 12 <= bytes.length) {
      const size = bytes.readUInt32BE(offset), name = bytes.toString('ascii', offset + 4, offset + 8)
      if (offset + 12 + size > bytes.length) fail('PNG 图片截断')
      if (name === 'IDAT' && size) data = true
      offset += size + 12
      if (name === 'IEND') { ended = size === 0 && offset === bytes.length; break }
    }
    if (!data || !ended) fail('PNG 图片缺少完整图像数据')
  } else if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
    mime = 'image/jpeg'
    if (bytes[bytes.length - 2] !== 255 || bytes[bytes.length - 1] !== 217) fail('JPEG 图片截断')
    let offset = 2, scan = false
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 255) fail('JPEG 标记无效')
      while (bytes[offset] === 255) offset++
      const marker = bytes[offset++]
      if (marker === 217) break
      if (marker === 216 || (marker >= 208 && marker <= 215)) continue
      const size = bytes.readUInt16BE(offset)
      if (size < 2 || offset + size > bytes.length) fail('JPEG 图片截断')
      if ([192, 193, 194].includes(marker)) {
        if (size < 8) fail('JPEG 图片尺寸无效')
        height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5)
      }
      if (marker === 218) { scan = true; break }
      offset += size
    }
    if (!scan) fail('JPEG 图片缺少图像数据')
  } else return fail('图片仅支持真实 PNG/JPEG 二进制，不支持 URL、SVG 或其他格式')
  if (!width || !height || width > 10000 || height > 10000 || width * height > 40_000_000) fail('图片尺寸须为 1–10000 像素，且总像素不超过 4000 万')
  return { mime, width, height }
}

function assertBox(box: Box, label: string): void {
  if (box.x < 0 || box.y < 0 || box.w <= 0 || box.h <= 0 || box.x + box.w > PPTX_CANVAS.w + 0.0001 || box.y + box.h > PPTX_CANVAS.h + 0.0001) fail(`${label}超出 13.333 × 7.5 英寸画布`)
}
function textHeight(value: string, width: number, size: number): number {
  const capacity = Math.max(1, Math.floor(width * 72 / (size * 0.56)))
  const lines = value.split(/\r\n|\r|\n/).reduce((sum, line) => sum + Math.max(1, Math.ceil(units(line) / capacity)), 0)
  return lines * size * 1.3 / 72
}
function assertFits(value: string, box: Box, size: number, label: string, elementPath?: string): void {
  encodeXml(value)
  if (!value.trim()) fail(`${label}文本为空`)
  // Conservative glyph/line bounds reject dense content rather than silently
  // shrinking text. This is a preflight estimate, never a visual-QA claim.
  const height = textHeight(value, box.w, size)
  if (height > box.h + 1 / 72) {
    if (elementPath) {
      const required = (Math.ceil(height * 1000) / 1000).toFixed(3)
      fail(`${label} ${elementPath}.text: 文本超出布局容量，${size}pt，当前 w=${box.w.toFixed(3)}、h=${box.h.toFixed(3)} 英寸，按当前宽度测量需 h=${required}；可将 ${elementPath}.h 至少设为 ${required}，增高前须核对相邻元素与画布边界；也可增大宽度或拆页`)
    }
    fail(`${label}文本超出布局容量；请缩短内容、增大文本框或拆分页面`)
  }
}
type Table = NonNullable<PptxSlide['table']>
type TableMeasurement = { widths: number[]; values: (string | number)[][]; rowHeights: number[]; cellHeights: number[][]; height: number }
function measureTable(table: Table, box: Box, label: string): TableMeasurement {
  assertBox(box, label)
  if (table.colWidths && table.colWidths.length !== table.headers.length) fail(`${label}表格 colWidths 数量必须与表头一致`)
  const proportions = table.colWidths ?? table.headers.map(() => 1), total = proportions.reduce((sum, value) => sum + value, 0)
  const widths = proportions.map(value => box.w * value / total), values = [table.headers, ...table.rows]
  const cellHeights = values.map((row, rowIndex) => {
    if (row.length !== table.headers.length) fail(`${label}表格第 ${rowIndex + 1} 行列数必须与表头一致`)
    return row.map((value, column) => {
      const content = String(value); encodeXml(content)
      if (widths[column] <= 0.24) fail(`${label}表格列宽过窄，请调整 colWidths`)
      return textHeight(content, widths[column] - 0.24, 17) + 0.24
    })
  })
  const rowHeights = cellHeights.map(row => Math.max(0.58, ...row))
  return { widths, values, rowHeights, cellHeights, height: rowHeights.reduce((sum, value) => sum + value, 0) }
}
function contentGeometry(source: PptxSlide, hasFooter: boolean) {
  const titleHeight = Math.max(0.68, textHeight(source.title, 11.83, 32) + 0.04)
  const subtitleHeight = source.subtitle?.trim() ? Math.max(0.4, textHeight(source.subtitle, 11.83, 18) + 0.04) : 0
  return { titleHeight, subtitleHeight, top: 0.55 + titleHeight + 0.42 + (subtitleHeight ? subtitleHeight + 0.25 : 0), bottom: hasFooter ? 6.78 : 7.0 }
}
function tableCapacityIssue(table: TableMeasurement, box: Box, tablePath: string, heightPath?: string): string {
  const required = (Math.ceil(table.height * 1000) / 1000).toFixed(3)
  const row = table.rowHeights.indexOf(Math.max(...table.rowHeights)), cells = table.cellHeights[row]
  const column = cells.indexOf(Math.max(...cells)), cellPath = row ? `${tablePath}.rows.${row - 1}.${column}` : `${tablePath}.headers.${column}`
  const contributor = cells[column] > 0.58 ? `${cellPath} 换行后该行需 ${table.rowHeights[row].toFixed(3)}` : '各行至少 0.580'
  const repair = heightPath && table.height <= PPTX_CANVAS.h - box.y + 0.0001 ? `；可将 ${heightPath} 至少设为 ${required}` : ''
  return `${tablePath}: 表格超出布局容量，17pt、含表头 ${table.rowHeights.length} 行，需 h=${required}，当前 h=${box.h.toFixed(3)}，差 ${(Math.ceil((table.height - box.h) * 1000) / 1000).toFixed(3)} 英寸；实际列宽 [${table.widths.map(width => width.toFixed(3)).join(', ')}]；${contributor} 英寸${repair}`
}
function layoutFor(source: PptxSlide, index: number): Exclude<PptxSlide['layout'], 'auto' | undefined> {
  const primary = (['columns', 'image', 'chart', 'table', 'quote', 'steps', 'elements'] as const).filter(key => source[key] !== undefined)
  if (primary.length > 1 || (primary.length && primary[0] !== 'table' && source.bullets?.length)) fail(`第 ${index + 1} 页包含互斥内容字段；请拆页或使用 custom`)
  const selected = source.layout && source.layout !== 'auto' ? source.layout
    : primary[0] === 'steps' ? 'timeline' : primary[0] === 'elements' ? 'custom' : primary[0] ?? (source.bullets?.length ? 'bullets' : index === 0 ? 'cover' : 'section')
  const expected: Partial<Record<typeof selected, typeof primary[number]>> = { columns: 'columns', image: 'image', chart: 'chart', table: 'table', quote: 'quote', timeline: 'steps', custom: 'elements' }
  if (expected[selected] && source[expected[selected]!] === undefined) fail(`第 ${index + 1} 页 ${selected} 布局缺少 ${expected[selected]}`)
  if (primary.length && primary[0] !== expected[selected]) fail(`第 ${index + 1} 页 ${selected} 布局不接受 ${primary[0]}`)
  if (source.bullets?.length && selected !== 'bullets' && selected !== 'table') fail(`第 ${index + 1} 页 ${selected} 布局不接受 bullets`)
  if (selected === 'bullets' && !source.bullets?.length) fail(`第 ${index + 1} 页 bullets 布局需要非空要点`)
  if (selected === 'custom' && source.subtitle !== undefined) fail(`第 ${index + 1} 页 custom 的文字请放入 elements，不能附加 subtitle`)
  return selected
}

export async function generateDesignedPptx(input: PptxInput, assets: PptxAssets = new Map()): Promise<Buffer> {
  const parsed = presentationSchema.safeParse({ theme: input.theme, slides: input.slides })
  if (!parsed.success) fail(parsed.error.issues.slice(0, 5).map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '))
  const sourceInput = parsed.data
  const theme = { background: 'FAF9F6', foreground: '202322', accent: 'C15B3E', muted: '666A66', fontFace: 'Microsoft YaHei', footer: '', pageNumbers: false, ...sourceInput.theme }
  const tableMeasurements = new Map<Table, TableMeasurement>(), capacityIssues: string[] = []
  // Report every overflowing table together: a fail-fast message on page three
  // used to hide a second bad table, forcing a full-deck retry after each fix.
  for (const [index, source] of sourceInput.slides.entries()) {
    const layout = layoutFor(source, index), label = `第 ${index + 1} 页`, slidePath = `presentation.slides.${index}`
    const check = (table: Table, box: Box, tablePath: string, heightPath?: string) => {
      const measurement = measureTable(table, box, `${label} ${tablePath}`)
      tableMeasurements.set(table, measurement)
      if (measurement.height > box.h + 0.0001) capacityIssues.push(tableCapacityIssue(measurement, box, tablePath, heightPath))
    }
    if (layout === 'custom') source.elements!.forEach((element, elementIndex) => {
      if (element.type === 'table') check(element.table, element, `${slidePath}.elements.${elementIndex}.table`, `${slidePath}.elements.${elementIndex}.h`)
    })
    else if (layout === 'table') {
      const { top, bottom } = contentGeometry(source, !!(theme.footer || theme.pageNumbers)), y = top + (source.bullets?.length ?? 0) * 0.68
      check(source.table!, { x: 0.75, y, w: 11.83, h: bottom - y }, `${slidePath}.table`)
    }
  }
  if (capacityIssues.length) fail(`表格预检发现 ${capacityIssues.length} 处容量不足（单位为英寸）：\n${capacityIssues.slice(0, 8).join('\n')}${capacityIssues.length > 8 ? `\n另有 ${capacityIssues.length - 8} 处，请按同样方式检查。` : ''}\n增高前须核对相邻元素与画布边界；也可调整列宽或拆页，保留全部数据。不要同步缩小 h 或通过缩小字号、删除行规避。`)
  const deck = new PptxGenJS()
  deck.layout = 'LAYOUT_WIDE'; deck.title = input.title ?? ''; deck.author = input.author ?? 'Aether'; deck.subject = 'Presentation'; deck.company = ''
  for (const [label, value, limit] of [['title', deck.title, 256], ['author', deck.author, 200]] as const) { if (typeof value !== 'string' || value.length > limit) fail(`${label}无效`); encodeXml(value) }
  deck.theme = { headFontFace: theme.fontFace, bodyFontFace: theme.fontFace }
  const prepared = new Map<string, ReturnType<typeof inspectPptxImage> & { data: string }>()
  let totalBytes = 0
  for (const file of pptxImagePaths(sourceInput)) {
    const bytes = assets.get(file)
    if (!bytes) fail(`图片未通过工作区授权读取：${file}`)
    totalBytes += bytes.length
    if (totalBytes > MAX_PPTX_ASSET_BYTES) fail('演示文稿图片总量超过 24 MiB')
    const info = inspectPptxImage(bytes)
    prepared.set(file, { ...info, data: `${info.mime};base64,${bytes.toString('base64')}` })
  }
  for (const [index, source] of sourceInput.slides.entries()) {
    const layout = layoutFor(source, index), slide = deck.addSlide(), label = `第 ${index + 1} 页`
    const background = source.background ?? (layout === 'section' ? theme.foreground : theme.background)
    const foreground = source.background ? contrastingColor(background, theme.foreground, theme.background) : theme.foreground
    const sectionForeground = source.background ? foreground : theme.background
    slide.background = { color: background }
    const txt = (value: string, box: Box, fontSize: number, options: TextOptions = {}, elementPath?: string) => {
      assertBox(box, label); assertFits(value, box, fontSize, label, elementPath)
      slide.addText(value, { ...box, fontSize, fontFace: theme.fontFace, color: foreground, margin: 0, valign: 'top', breakLine: false, ...options })
    }
    const shape = (box: Box, fill: string, kind: 'rect' | 'ellipse' | 'line' = 'rect', line = fill) => {
      assertBox(box, label)
      slide.addShape(deck.ShapeType[kind], { ...box, fill: { color: fill }, line: { color: line, width: kind === 'line' ? 1 : 0 } })
    }
    const picture = (file: string, box: Box, fit: 'contain' | 'cover' = 'contain') => {
      assertBox(box, label)
      const asset = prepared.get(file)!
      const altText = file.split(/[\\/]/).at(-1)
      if (fit === 'contain') {
        // Negative srcRect padding is valid OOXML but ignored by some slide
        // viewers. A centered native picture box preserves the aspect ratio in
        // both Office and the Work preview without touching the source pixels.
        const scale = Math.min(box.w / asset.width, box.h / asset.height)
        const w = asset.width * scale, h = asset.height * scale
        slide.addImage({ data: asset.data, x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h, altText })
      } else slide.addImage({ data: asset.data, x: box.x, y: box.y, w: asset.width / 96, h: asset.height / 96, sizing: { type: 'cover', w: box.w, h: box.h }, altText })
    }
    const drawChart = (chart: NonNullable<PptxSlide['chart']>, box: Box) => {
      assertBox(box, label)
      chart.series.forEach(series => { if (series.values.length !== chart.categories.length) fail(`${label}图表系列数据须与 categories 数量相同`) })
      if (chart.type === 'pie' && (chart.series.length !== 1 || chart.series[0].values.some(value => value < 0) || !chart.series[0].values.some(value => value > 0))) fail(`${label}饼图需要一个非负且包含正值的系列`)
      chart.categories.forEach(value => { if (units(value) > 24) fail(`${label}图表分类标签过长，请缩短至 24 英文字符宽度`); encodeXml(value) })
      chart.series.forEach(value => encodeXml(value.name))
      const palette = [theme.accent, foreground, theme.muted, 'B7AAA1']
      slide.addChart(deck.ChartType[chart.type], chart.series.map(series => ({ name: series.name, labels: chart.categories, values: series.values })), {
        ...box, showTitle: false, showLegend: chart.series.length > 1 || chart.type === 'pie',
        legendPos: 'b', legendFontFace: theme.fontFace, legendFontSize: 12, chartColors: palette,
        catAxisLabelFontFace: theme.fontFace, catAxisLabelFontSize: 12, catAxisLabelColor: theme.muted,
        valAxisLabelFontFace: theme.fontFace, valAxisLabelFontSize: 12, valAxisLabelColor: theme.muted,
        showValue: false, showLabel: chart.type === 'pie', showPercent: chart.type === 'pie',
        chartArea: { fill: { color: background }, border: { color: background, pt: 0 } }, plotArea: { fill: { color: background }, border: { color: background, pt: 0 } },
      })
    }
    const drawTable = (table: Table, box: Box) => {
      const { widths, values, rowHeights, height } = tableMeasurements.get(table)!
      // Horizontal rules preserve row tracking without boxing every cell into
      // a spreadsheet grid. Column proportions remain native and editable.
      const rows: Parameters<Slide['addTable']>[0] = values.map((row, rowIndex) => row.map(value => ({ text: String(value), options: {
        bold: rowIndex === 0, color: rowIndex === 0 ? theme.accent : foreground, fill: { color: background },
        border: [{ type: 'none' }, { type: 'none' }, { type: 'solid', color: rowIndex === 0 ? theme.accent : theme.muted, pt: rowIndex === 0 ? 0.8 : 0.35 }, { type: 'none' }],
      } })))
      slide.addTable(rows, { x: box.x, y: box.y, w: box.w, h: height, rowH: rowHeights, colW: widths, autoPage: false, fontFace: theme.fontFace, fontSize: 17, margin: 0.12, border: { type: 'none' }, valign: 'middle' })
    }
    let top = 1.65
    const bottom = theme.footer || theme.pageNumbers ? 6.78 : 7.0
    if (!['cover', 'section', 'custom'].includes(layout)) {
      const geometry = contentGeometry(source, !!(theme.footer || theme.pageNumbers)), height = geometry.titleHeight
      if (height > 1.3) fail(`${label}标题过长，请缩短至两行以内`)
      txt(source.title, { x: 0.75, y: 0.55, w: 11.83, h: height }, 32, { bold: true })
      top = 0.55 + height + 0.42
      if (source.subtitle?.trim()) {
        const subtitleHeight = geometry.subtitleHeight
        txt(source.subtitle, { x: 0.75, y: top - 0.12, w: 11.83, h: subtitleHeight }, 18, { color: theme.muted })
        top += subtitleHeight + 0.25
      }
    }
    if (layout === 'cover') {
      shape({ x: 0.75, y: 1.35, w: 1.05, h: 0.07 }, theme.accent)
      txt(source.title, { x: 0.75, y: 2.0, w: 11.65, h: 2.15 }, 42, { bold: true })
      if (source.subtitle?.trim()) txt(source.subtitle, { x: 0.78, y: 4.65, w: 10.7, h: 1.45 }, 22, { color: theme.muted })
    } else if (layout === 'section') {
      shape({ x: 0.8, y: 1.6, w: 0.7, h: 0.07 }, theme.accent)
      txt(source.title, { x: 0.8, y: 2.25, w: 11.6, h: 2.1 }, 40, { bold: true, color: sectionForeground })
      if (source.subtitle?.trim()) txt(source.subtitle, { x: 0.82, y: 4.8, w: 10.9, h: 1.35 }, 21, { color: sectionForeground })
    } else if (layout === 'bullets') {
      let y = top
      source.bullets!.forEach(bullet => {
        const height = textHeight(bullet, 11.15, 22) + 0.04
        if (y + height > bottom) fail(`${label}要点超出布局容量；请缩短内容或拆分页面`)
        shape({ x: 0.75, y: y + 0.15, w: 0.07, h: 0.07 }, theme.accent, 'ellipse')
        txt(bullet, { x: 1.05, y, w: 11.15, h: height }, 22)
        y += height + 0.3
      })
    } else if (layout === 'columns') {
      const columns = source.columns!, gap = 0.45, width = (11.83 - gap * (columns.length - 1)) / columns.length
      const headingHeight = Math.max(0.55, ...columns.map(column => textHeight(column.title, width, 24) + 0.04))
      columns.forEach((column, i) => {
        const x = 0.75 + (width + gap) * i
        txt(column.title, { x, y: top, w: width, h: headingHeight }, 24, { bold: true })
        const y = top + headingHeight + 0.25, height = textHeight(column.body, width, 19) + 0.04
        if (y + height > bottom) fail(`${label}分栏正文超出布局容量；请缩短内容或拆分页面`)
        txt(column.body, { x, y, w: width, h: height }, 19)
      })
    } else if (layout === 'image') {
      const image = source.image!, captionHeight = image.caption?.trim() ? 0.65 : 0
      picture(image.path, { x: 0.75, y: top, w: 11.83, h: bottom - top - captionHeight }, image.fit)
      if (image.caption?.trim()) txt(image.caption, { x: 0.75, y: bottom - 0.5, w: 11.83, h: 0.5 }, 14, { color: theme.muted })
    } else if (layout === 'chart') {
      drawChart(source.chart!, { x: 0.75, y: top, w: 11.83, h: bottom - top })
    } else if (layout === 'table') {
      const table = source.table!, bullets = source.bullets ?? []
      if (bullets.length > 2) fail(`${label}表格最多附带 2 条要点，请拆页`)
      const bulletHeight = bullets.length ? 0.68 : 0
      bullets.forEach((value, i) => txt(value, { x: 0.75, y: top + i * bulletHeight, w: 11.83, h: bulletHeight - 0.08 }, 18))
      const y = top + bullets.length * bulletHeight
      drawTable(table, { x: 0.75, y, w: 11.83, h: bottom - y })
    } else if (layout === 'quote') {
      txt('“', { x: 0.75, y: top - 0.15, w: 1.2, h: 1.25 }, 54, { color: theme.accent })
      txt(source.quote!.text, { x: 1.95, y: top + 0.25, w: 10.2, h: bottom - top - 1.15 }, 28)
      if (source.quote!.attribution) txt(source.quote!.attribution, { x: 1.72, y: bottom - 0.55, w: 10.3, h: 0.5 }, 17, { color: theme.muted })
    } else if (layout === 'timeline') {
      const steps = source.steps!, width = 11.83 / steps.length
      // A one-point native rectangle renders consistently in the preview's
      // shape converter while keeping this connector editable in Office.
      shape({ x: 0.75 + width / 2, y: top + 0.53, w: width * (steps.length - 1), h: 1 / 72 }, theme.muted)
      steps.forEach((step, i) => {
        const x = 0.75 + width * i
        shape({ x: x + width / 2 - 0.26, y: top + 0.27, w: 0.52, h: 0.52 }, theme.accent, 'ellipse')
        txt(String(i + 1), { x: x + width / 2 - 0.23, y: top + 0.34, w: 0.46, h: 0.35 }, 15, { color: theme.background, align: 'center', bold: true })
        txt(step.title, { x: x + 0.1, y: top + 1.2, w: width - 0.2, h: 1.05 }, 21, { bold: true, align: 'center' })
        if (step.body?.trim()) txt(step.body, { x: x + 0.12, y: top + 2.5, w: width - 0.24, h: bottom - top - 2.5 }, 16, { align: 'center' })
      })
    } else {
      for (const [elementIndex, element] of source.elements!.entries()) {
        if (element.type === 'text') txt(element.text, element, element.fontSize ?? 22, { bold: element.bold, color: element.color ?? foreground, align: element.align }, `presentation.slides.${index}.elements.${elementIndex}`)
        else if (element.type === 'image') picture(element.path, element, element.fit)
        else if (element.type === 'chart') drawChart(element.chart, element)
        else if (element.type === 'table') drawTable(element.table, element)
        else shape(element, element.fill ?? theme.accent, element.shape, element.line ?? element.fill ?? theme.accent)
      }
    }
    if (source.notes !== undefined) { encodeXml(source.notes); slide.addNotes(source.notes) }
    if (layout !== 'custom') {
      const footerColor = layout === 'section' ? sectionForeground : theme.muted
      if (theme.footer.trim()) txt(theme.footer, { x: 0.75, y: 7.12, w: 10.4, h: 0.2 }, 10, { color: footerColor })
      if (theme.pageNumbers) txt(`${index + 1} / ${sourceInput.slides.length}`, { x: 11.4, y: 7.12, w: 1.18, h: 0.2 }, 10, { color: footerColor, align: 'right' })
    }
  }
  const output = await deck.write({ outputType: 'nodebuffer', compression: true })
  if (!(output instanceof Uint8Array)) fail('生成器未返回二进制文件')
  return Buffer.from(output)
}
