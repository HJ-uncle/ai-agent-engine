import { createRequire } from 'node:module'
import path from 'node:path'
import { decodeXml, encodeXml, readOfficeZip, writeOfficeZip } from './office-zip.js'

export interface PptxSlide { title: string; bullets?: string[]; table?: { headers: string[]; rows: Array<Array<string | number>> }; notes?: string }
export interface PptxInput { title?: string; author?: string; slides: PptxSlide[] }
export interface PptxEdit { oldText: string; newText: string; slide?: number; textRun?: number }
const MAX_SLIDES = 40
const DRAWING = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const PRESENTATION = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const RELATIONSHIPS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const OFFICE_RELATIONSHIPS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
// 4.0.1 ships a CJS-marked declaration alongside an ESM export. Use its documented
// CJS entry so NodeNext's constructor type and runtime value agree.
const PptxGenJS: typeof import('pptxgenjs').default = createRequire(import.meta.url)('pptxgenjs')
function fail(message: string): never { throw new Error(`PPTX: ${message}`) }
const units = (text: string): number => Array.from(text).reduce((sum, ch) => sum + (ch.codePointAt(0)! > 255 ? 2 : 1), 0)
function text(value: unknown, label: string, limit: number, required = true): string {
  if (typeof value !== 'string' || (required && !value.trim()) || value.length > limit) fail(`${label} 文本为空或超过 ${limit} 字符`)
  encodeXml(value as string)
  return value as string
}

export async function createPptx(input: PptxInput): Promise<Buffer> {
  if (!input || !Array.isArray(input.slides) || !input.slides.length || input.slides.length > MAX_SLIDES) fail(`需要 1–${MAX_SLIDES} 页`)
  const deck = new PptxGenJS()
  deck.layout = 'LAYOUT_WIDE'; deck.subject = 'Aether office document'; deck.company = 'Aether'
  deck.title = input.title === undefined ? '' : text(input.title, 'title', 256, false)
  deck.author = input.author === undefined ? 'Aether' : text(input.author, 'author', 200, false)
  deck.theme = { headFontFace: 'Microsoft YaHei', bodyFontFace: 'Microsoft YaHei' }
  for (const [index, source] of input.slides.entries()) {
    if (!source || typeof source !== 'object') fail('无效幻灯片')
    const title = text(source.title, `第 ${index + 1} 页标题`, 100)
    if (units(title) > 94 || /[\r\n]/.test(title)) fail('标题过长，请拆分页面')
    const bullets = source.bullets === undefined ? [] : source.bullets
    if (!Array.isArray(bullets) || bullets.length > (source.table ? 2 : 6)) fail('每页最多 6 条要点；含表格时最多 2 条')
    for (const bullet of bullets) if (units(text(bullet, '要点', 160)) > 140 || /[\r\n]/.test(bullet)) fail('单条要点过长，请拆分页面')
    const slide = deck.addSlide()
    slide.background = { color: 'FFFFFF' }
    slide.addShape(deck.ShapeType.rect, { x: 0, y: 0, w: 0.16, h: 7.5, fill: { color: '3268AA' }, line: { color: '3268AA' } })
    slide.addText(title, { x: 0.6, y: 0.4, w: 12.1, h: 1.02, fontSize: 28, bold: true, color: '17243B', margin: 0, breakLine: false, valign: 'middle' })
    for (const [bulletIndex, bullet] of bullets.entries()) slide.addText(bullet, {
      x: 0.8, y: 1.62 + bulletIndex * 0.79, w: 11.8, h: 0.73, fontSize: 20, color: '27364B',
      bullet: { indent: 18 }, margin: 0, valign: 'top', paraSpaceAfter: 4,
    })
    if (source.table) {
      const { headers, rows } = source.table
      if (!Array.isArray(headers) || !headers.length || headers.length > 6 || !Array.isArray(rows) || rows.length > (bullets.length ? 5 : 8)) fail('表格最多 6 列、8 行；含要点时最多 5 行')
      const maxUnits = Math.floor(100 / headers.length)
      const cell = (value: unknown): string => {
        if (typeof value === 'number' && !Number.isFinite(value)) fail('表格数值必须有限')
        const content = typeof value === 'number' ? String(value) : text(value, '单元格', 100, false)
        if (units(content) > maxUnits || /[\r\n]/.test(content)) fail('表格单元格内容过长，请拆分页面或减少列数')
        return content
      }
      const tableRows: Parameters<typeof slide.addTable>[0] = [headers.map(value => ({ text: cell(value), options: { bold: true, fill: { color: 'E8EEF5' }, color: '17243B' } }))]
      for (const row of rows) {
        if (!Array.isArray(row) || row.length !== headers.length) fail('每行单元格数量必须与表头一致')
        tableRows.push(row.map(value => ({ text: cell(value) })))
      }
      slide.addTable(tableRows, { x: 0.7, y: 1.7 + bullets.length * 0.79, w: 11.95, rowH: 0.48,
        autoPage: false, fontSize: 15, color: '27364B', border: { type: 'solid', pt: 0.5, color: 'CBD5E1' },
        margin: 0.1, valign: 'middle', colW: Array(headers.length).fill(11.95 / headers.length) })
    }
    if (source.notes !== undefined) slide.addNotes(text(source.notes, 'notes', 4000, false))
    slide.addText(`Aether · ${index + 1} / ${input.slides.length}`, { x: 0.7, y: 7.02, w: 11.95, h: 0.2, fontSize: 9, color: '687487', align: 'right', margin: 0 })
  }
  const output = await deck.write({ outputType: 'nodebuffer', compression: true })
  if (!(output instanceof Uint8Array)) fail('生成器未返回二进制文件')
  const buffer = Buffer.from(output)
  loadPresentation(buffer)
  return buffer
}

interface XmlNode { name: string; local: string; namespace: string; attributes: Record<string, string>; namespaces: Record<string, string>; start: number; openEnd: number; closeStart: number; end: number; parent?: XmlNode }
interface TextRun { node: XmlNode; value: string }
interface SlidePart { name: string; xml: string; runs: TextRun[] }

// No DTD/entity expansion and no recovery: preserving a package requires rejecting
// malformed or namespace-ambiguous source rather than regex-rewriting its markup.
function scan(xml: string): XmlNode[] {
  const nodes: XmlNode[] = [], stack: XmlNode[] = []
  const tokens = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<\/?[A-Za-z_][\w.:-]*(?:[^<>"']|"[^"]*"|'[^']*')*>/g
  let offset = 0, roots = 0
  const entities = (value: string) => { if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);)/i.test(value)) fail('无效 XML 实体'); return decodeXml(value) }
  for (const match of xml.matchAll(tokens)) {
    const between = xml.slice(offset, match.index), token = match[0]
    if (between.includes('<') || (!stack.length && between.trim())) fail('无效 XML 结构')
    entities(between); offset = match.index + token.length
    if (token.startsWith('<?') || token.startsWith('<!--')) continue
    if (token.startsWith('</')) {
      const current = stack.pop(), name = /^<\/([\w.:-]+)\s*>$/.exec(token)?.[1]
      if (!current || name !== current.name) fail('XML 标签未配对')
      current.closeStart = match.index; current.end = offset; continue
    }
    const opening = /^<([\w.:-]+)([\s\S]*?)(\/?)>$/.exec(token)!
    const attributes: Record<string, string> = Object.create(null) as Record<string, string>
    let attributeOffset = 0
    for (const attribute of opening[2].matchAll(/\s+([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      if (opening[2].slice(attributeOffset, attribute.index).trim() || Object.hasOwn(attributes, attribute[1])) fail('无效 XML 属性')
      const value = attribute[2] ?? attribute[3]
      if (value.includes('<')) fail('无效 XML 属性值')
      attributes[attribute[1]] = entities(value); attributeOffset = attribute.index + attribute[0].length
    }
    if (opening[2].slice(attributeOffset).trim()) fail('无效 XML 属性尾部')
    const parent = stack.at(-1), namespaces = { ...parent?.namespaces }
    for (const [key, value] of Object.entries(attributes)) { if (key === 'xmlns') namespaces[''] = value; else if (key.startsWith('xmlns:')) namespaces[key.slice(6)] = value }
    const colon = opening[1].indexOf(':'), prefix = colon < 0 ? '' : opening[1].slice(0, colon), local = colon < 0 ? opening[1] : opening[1].slice(colon + 1)
    if (prefix && !namespaces[prefix]) fail('XML 命名空间未声明')
    const node: XmlNode = { name: opening[1], local, namespace: namespaces[prefix] || '', attributes, namespaces, start: match.index,
      openEnd: offset, closeStart: offset, end: offset, parent }
    nodes.push(node)
    if (!parent) roots++
    if (!opening[3]) stack.push(node)
    if (nodes.length > 100_000 || stack.length > 100) fail('XML 超过结构上限')
  }
  if (stack.length || roots !== 1 || xml.slice(offset).trim()) fail('XML 文档未闭合')
  return nodes
}

function readSlide(name: string, xml: string): SlidePart {
  const nodes = scan(xml)
  if (nodes[0].local !== 'sld' || nodes[0].namespace !== PRESENTATION) fail('无效幻灯片根节点')
  const runs = nodes.filter(node => node.local === 't' && node.namespace === DRAWING).map(node => {
    const raw = xml.slice(node.openEnd, node.closeStart)
    if (raw.includes('<')) fail('文本节点含不支持的嵌套结构')
    return { node, value: decodeXml(raw) }
  })
  return { name, xml, runs }
}

function loadPresentation(buffer: Buffer): { entries: Record<string, Uint8Array>; slides: SlidePart[] } {
  const entries = readOfficeZip(buffer)
  const part = (name: string): string => {
    if (!entries[name]) fail(`缺少 ${name}`)
    return new TextDecoder('utf-8', { fatal: true }).decode(entries[name])
  }
  const presentation = scan(part('ppt/presentation.xml'))
  if (presentation[0].local !== 'presentation' || presentation[0].namespace !== PRESENTATION) fail('无效演示文稿根节点')
  const relationships = scan(part('ppt/_rels/presentation.xml.rels'))
  const relationshipMap = new Map<string, string>()
  for (const relation of relationships.filter(node => node.local === 'Relationship' && node.namespace === RELATIONSHIPS)) {
    if (relation.attributes.Type !== `${OFFICE_RELATIONSHIPS}/slide`) continue
    if (relation.attributes.TargetMode === 'External' || relationshipMap.has(relation.attributes.Id)) fail('外部或重复幻灯片关系不支持')
    const target = relation.attributes.Target || ''
    if (target.includes('\\') || /[:?#]/.test(target)) fail('不支持的幻灯片路径')
    const name = target.startsWith('/') ? target.slice(1) : path.posix.normalize(path.posix.join('ppt', target))
    if (!name.startsWith('ppt/slides/') || !name.endsWith('.xml')) fail('无效幻灯片路径')
    relationshipMap.set(relation.attributes.Id, name)
  }
  const ids = presentation.filter(node => node.local === 'sldId' && node.namespace === PRESENTATION)
  if (!ids.length || ids.length > MAX_SLIDES) fail(`幻灯片页数必须为 1–${MAX_SLIDES}`)
  const seen = new Set<string>(), slides: SlidePart[] = []
  for (const id of ids) {
    const attribute = Object.keys(id.attributes).find(key => key.includes(':') && key.split(':')[1] === 'id' && id.namespaces[key.split(':')[0]] === OFFICE_RELATIONSHIPS)
    const name = attribute && relationshipMap.get(id.attributes[attribute])
    if (!name || seen.has(name)) fail('缺失或重复幻灯片关系')
    seen.add(name)
    slides.push(readSlide(name, part(name)))
  }
  return { entries, slides }
}

export async function inspectPptx(buffer: Buffer): Promise<{ format: 'pptx'; content: string; summary: Record<string, number | string | boolean>; warnings: string[] }> {
  const pkg = loadPresentation(buffer)
  // Index every extracted text node, including fields, so an inspect locator and
  // an edit always address the same node. Fields are visible but never writable.
  const full = pkg.slides.map((slide, index) => `## 第 ${index + 1} 页\n${slide.runs.map((run, runIndex) =>
    `[slide=${index + 1} textRun=${runIndex + 1} editable=${run.node.parent?.local === 'r' && run.node.parent.namespace === DRAWING}]\n${run.value}`).join('\n')}`).join('\n\n')
  const previewTruncated = full.length > 120_000
  const warnings = ['只提取幻灯片正文和表格文本；图片、图表数据、备注及母版未提取。结构检查不等同于视觉布局验收。']
  if (previewTruncated) warnings.push('正文预览超过 120000 字符，已截断。')
  return { format: 'pptx', content: full.slice(0, 120_000), summary: { slides: pkg.slides.length, textRuns: pkg.slides.reduce((sum, slide) => sum + slide.runs.length, 0), previewTruncated,
    editLocator: 'slide/textRun are 1-based: presentation order / all extracted text nodes on that slide. Only editable=true nodes support edit; use the same expectedHash.' }, warnings }
}

export async function editPptx(buffer: Buffer, edits: PptxEdit[]): Promise<Buffer> {
  if (!Array.isArray(edits) || !edits.length || edits.length > 100) fail('编辑数量必须为 1–100')
  const pkg = loadPresentation(buffer)
  for (const edit of edits) {
    if (!edit || typeof edit !== 'object') fail('无效编辑')
    if (Object.keys(edit).some(key => !['oldText', 'newText', 'slide', 'textRun'].includes(key))) fail('不支持的编辑属性')
    const targeted = edit.slide !== undefined || edit.textRun !== undefined
    if (targeted && (!Number.isSafeInteger(edit.slide) || !Number.isSafeInteger(edit.textRun) || edit.slide! < 1 || edit.textRun! < 1)) fail('slide 和 textRun 必须成对提供从 1 开始的整数')
    const oldText = text(edit.oldText, 'oldText', 10_000), newText = text(edit.newText, 'newText', 10_000, false)
    if (/[\r\n\t]/.test(newText)) fail('定点编辑不支持换行或制表符，请拆成独立文本段')
    const matches: Array<{ slide: SlidePart; run: TextRun; offset: number }> = []
    const targetSlide = targeted ? pkg.slides[edit.slide! - 1] : undefined
    const targetRun = targetSlide?.runs[edit.textRun! - 1]
    if (targeted && (!targetSlide || !targetRun)) fail('slide 或 textRun 超出当前文稿范围；请重新 inspect 获取定位')
    if (targetRun && (targetRun.node.parent?.local !== 'r' || targetRun.node.parent.namespace !== DRAWING)) fail('字段或非普通文本段不可编辑')
    for (const slide of targetSlide ? [targetSlide] : pkg.slides) for (const run of targetRun ? [targetRun] : slide.runs) {
      let start = 0
      for (;;) { const offset = run.value.indexOf(oldText, start); if (offset < 0) break; matches.push({ slide, run, offset }); start = offset + 1 }
    }
    if (matches.length !== 1) fail(targeted ? 'oldText 必须在指定 textRun 内唯一匹配；跨格式文本段不支持' : 'oldText 必须在全部幻灯片的单个文本段内唯一匹配；跨格式文本段不支持')
    const { slide, run, offset } = matches[0]
    if (run.node.parent?.local !== 'r' || run.node.parent.namespace !== DRAWING) fail('字段或非普通文本段不可编辑')
    // Preserve formatting, shapes, notes and unrelated ZIP parts. Only the matched
    // ordinary text node changes; split runs/fields are never guessed or flattened.
    const replacement = run.value.slice(0, offset) + newText + run.value.slice(offset + oldText.length)
    slide.xml = slide.xml.slice(0, run.node.openEnd) + encodeXml(replacement) + slide.xml.slice(run.node.closeStart)
    pkg.entries[slide.name] = Buffer.from(slide.xml)
    pkg.slides[pkg.slides.indexOf(slide)] = readSlide(slide.name, slide.xml)
  }
  return writeOfficeZip(pkg.entries)
}
