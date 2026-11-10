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
function assertFits(value: string, box: Box, size: number, label: string): void {
  encodeXml(value)
  if (!value.trim()) fail(`${label}文本为空`)
  // Conservative glyph/line bounds reject dense content rather than silently
  // shrinking text. This is a preflight estimate, never a visual-QA claim.
  const capacity = Math.max(1, Math.floor(box.w * 72 / (size * 0.56)))
  const lines = value.split(/\r\n|\r|\n/).reduce((sum, line) => sum + Math.max(1, Math.ceil(units(line) / capacity)), 0)
  if (lines * size * 1.3 > box.h * 72 + 1) fail(`${label}文本超出布局容量；请缩短内容、增大文本框或拆分页面`)
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
    slide.background = { color: theme.background }
    const txt = (value: string, box: Box, fontSize: number, options: TextOptions = {}) => {
      assertBox(box, label); assertFits(value, box, fontSize, label)
      slide.addText(value, { ...box, fontSize, fontFace: theme.fontFace, color: theme.foreground, margin: 0, valign: 'top', breakLine: false, ...options })
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
    const titleBox = { x: 0.7, y: 0.5, w: 11.93, h: 1.08 }
    if (layout !== 'cover' && layout !== 'section' && layout !== 'custom') txt(source.title, titleBox, 28, { bold: true })
    if (source.subtitle?.trim() && !['cover', 'section', 'custom'].includes(layout)) txt(source.subtitle, { x: 0.72, y: 1.58, w: 11.88, h: 0.68 }, 16, { color: theme.muted })
    const top = source.subtitle?.trim() ? 2.45 : 1.95, bottom = theme.footer || theme.pageNumbers ? 6.78 : 7.0
    if (layout === 'cover') {
      shape({ x: 0.75, y: 1.35, w: 1.05, h: 0.07 }, theme.accent)
      txt(source.title, { x: 0.75, y: 2.0, w: 11.65, h: 2.15 }, 42, { bold: true })
      if (source.subtitle?.trim()) txt(source.subtitle, { x: 0.78, y: 4.65, w: 10.7, h: 1.45 }, 22, { color: theme.muted })
    } else if (layout === 'section') {
      slide.background = { color: theme.foreground }
      shape({ x: 0.8, y: 1.6, w: 0.7, h: 0.07 }, theme.accent)
      txt(source.title, { x: 0.8, y: 2.25, w: 11.6, h: 2.1 }, 40, { bold: true, color: theme.background })
      if (source.subtitle?.trim()) txt(source.subtitle, { x: 0.82, y: 4.8, w: 10.9, h: 1.35 }, 21, { color: theme.background })
    } else if (layout === 'bullets') {
      const bullets = source.bullets!, gap = 0.18, height = (bottom - top - (bullets.length - 1) * gap) / bullets.length
      bullets.forEach((bullet, i) => {
        shape({ x: 0.75, y: top + i * (height + gap) + 0.13, w: 0.07, h: 0.07 }, theme.accent, 'ellipse')
        txt(bullet, { x: 1.05, y: top + i * (height + gap), w: 11.15, h: height }, 22)
      })
    } else if (layout === 'columns') {
      const columns = source.columns!, gap = 0.45, width = (11.83 - gap * (columns.length - 1)) / columns.length
      columns.forEach((column, i) => {
        const x = 0.75 + (width + gap) * i
        shape({ x, y: top, w: 0.5, h: 0.05 }, theme.accent)
        txt(column.title, { x, y: top + 0.25, w: width, h: 1.0 }, 24, { bold: true })
        txt(column.body, { x, y: top + 1.5, w: width, h: bottom - top - 1.5 }, 19)
      })
    } else if (layout === 'image') {
      const image = source.image!, captionHeight = image.caption?.trim() ? 0.65 : 0
      picture(image.path, { x: 0.75, y: top, w: 11.83, h: bottom - top - captionHeight }, image.fit)
      if (image.caption?.trim()) txt(image.caption, { x: 0.75, y: bottom - 0.5, w: 11.83, h: 0.5 }, 14, { color: theme.muted })
    } else if (layout === 'chart') {
      const chart = source.chart!
      chart.series.forEach(series => { if (series.values.length !== chart.categories.length) fail(`${label}图表系列数据须与 categories 数量相同`) })
      if (chart.type === 'pie' && (chart.series.length !== 1 || chart.series[0].values.some(value => value < 0) || !chart.series[0].values.some(value => value > 0))) fail(`${label}饼图需要一个非负且包含正值的系列`)
      chart.categories.forEach(value => { if (units(value) > 24) fail(`${label}图表分类标签过长，请缩短至 24 英文字符宽度`); encodeXml(value) })
      chart.series.forEach(value => encodeXml(value.name))
      const palette = [theme.accent, theme.foreground, theme.muted, 'B7AAA1']
      slide.addChart(deck.ChartType[chart.type], chart.series.map(series => ({ name: series.name, labels: chart.categories, values: series.values })), {
        x: 0.75, y: top, w: 11.83, h: bottom - top, showTitle: false, showLegend: chart.series.length > 1 || chart.type === 'pie',
        legendPos: 'b', legendFontFace: theme.fontFace, legendFontSize: 12, chartColors: palette,
        catAxisLabelFontFace: theme.fontFace, catAxisLabelFontSize: 12, catAxisLabelColor: theme.muted,
        valAxisLabelFontFace: theme.fontFace, valAxisLabelFontSize: 12, valAxisLabelColor: theme.muted,
        showValue: false, showLabel: chart.type === 'pie', showPercent: chart.type === 'pie',
        chartArea: { fill: { color: theme.background }, border: { color: theme.background, pt: 0 } }, plotArea: { fill: { color: theme.background }, border: { color: theme.background, pt: 0 } },
      })
    } else if (layout === 'table') {
      const table = source.table!, bullets = source.bullets ?? []
      if (bullets.length > 2) fail(`${label}表格最多附带 2 条要点，请拆页`)
      const bulletHeight = bullets.length ? 0.68 : 0
      bullets.forEach((value, i) => txt(value, { x: 0.75, y: top + i * bulletHeight, w: 11.83, h: bulletHeight - 0.08 }, 18))
      const y = top + bullets.length * bulletHeight, rowHeight = Math.min(0.66, (bottom - y) / (table.rows.length + 1)), width = 11.83 / table.headers.length
      const rows = [table.headers, ...table.rows].map((row, rowIndex) => {
        if (row.length !== table.headers.length) fail(`${label}表格第 ${rowIndex + 1} 行列数必须与表头一致`)
        return row.map(value => { const content = String(value); if (content) assertFits(content, { x: 0, y: 0, w: width - 0.22, h: rowHeight - 0.16 }, 15, `${label}表格第 ${rowIndex + 1} 行`); return { text: content, options: { bold: rowIndex === 0, color: rowIndex === 0 ? theme.background : theme.foreground, fill: { color: rowIndex === 0 ? theme.foreground : theme.background } } } })
      })
      slide.addTable(rows, { x: 0.75, y, w: 11.83, h: rowHeight * rows.length, rowH: rowHeight, colW: Array<number>(table.headers.length).fill(width), autoPage: false, fontFace: theme.fontFace, fontSize: 15, margin: 0.08, border: { type: 'solid', color: theme.muted, pt: 0.4 }, valign: 'middle' })
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
      for (const element of source.elements!) {
        if (element.type === 'text') txt(element.text, element, element.fontSize ?? 22, { bold: element.bold, color: element.color ?? theme.foreground, align: element.align })
        else if (element.type === 'image') picture(element.path, element, element.fit)
        else shape(element, element.fill ?? theme.accent, element.shape, element.line ?? element.fill ?? theme.accent)
      }
    }
    if (source.notes !== undefined) { encodeXml(source.notes); slide.addNotes(source.notes) }
    if (layout !== 'custom') {
      const footerColor = layout === 'section' ? theme.background : theme.muted
      if (theme.footer.trim()) txt(theme.footer, { x: 0.75, y: 7.12, w: 10.4, h: 0.2 }, 10, { color: footerColor })
      if (theme.pageNumbers) txt(`${index + 1} / ${sourceInput.slides.length}`, { x: 11.4, y: 7.12, w: 1.18, h: 0.2 }, 10, { color: footerColor, align: 'right' })
    }
  }
  const output = await deck.write({ outputType: 'nodebuffer', compression: true })
  if (!(output instanceof Uint8Array)) fail('生成器未返回二进制文件')
  return Buffer.from(output)
}
