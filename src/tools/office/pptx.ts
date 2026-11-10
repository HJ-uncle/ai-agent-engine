import path from 'node:path'
import { decodeXml, encodeXml, readOfficeZip, writeOfficeZip } from './office-zip.js'

export type { PptxSlide, PptxInput } from './pptx-schema.js'
import type { PptxInput } from './pptx-schema.js'
import { generateDesignedPptx, type PptxAssets } from './pptx-design.js'
export interface PptxEdit { oldText: string; newText: string; slide?: number; textRun?: number; target?: 'notes' }
const MAX_SLIDES = 40
const DRAWING = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const PRESENTATION = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const RELATIONSHIPS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const OFFICE_RELATIONSHIPS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
function fail(message: string): never { throw new Error(`PPTX: ${message}`) }
function text(value: unknown, label: string, limit: number, required = true): string {
  if (typeof value !== 'string' || (required && !value.trim()) || value.length > limit) fail(`${label} 文本为空或超过 ${limit} 字符`)
  encodeXml(value as string)
  return value as string
}

export async function createPptx(input: PptxInput, assets?: PptxAssets): Promise<Buffer> {
  const buffer = await generateDesignedPptx(input, assets)
  loadPresentation(buffer)
  return buffer
}
interface XmlNode { name: string; local: string; namespace: string; attributes: Record<string, string>; namespaces: Record<string, string>; start: number; openEnd: number; closeStart: number; end: number; parent?: XmlNode }
interface TextRun { node: XmlNode; value: string }
interface TextPart { name: string; xml: string; runs: TextRun[] }
interface SlidePart extends TextPart { notes?: TextPart }

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

function readTextPart(name: string, xml: string, root: 'sld' | 'notes'): TextPart {
  const nodes = scan(xml)
  if (nodes[0].local !== root || nodes[0].namespace !== PRESENTATION) fail(root === 'notes' ? '无效备注根节点' : '无效幻灯片根节点')
  const runs = nodes.filter(node => node.local === 't' && node.namespace === DRAWING).map(node => {
    const raw = xml.slice(node.openEnd, node.closeStart)
    if (raw.includes('<')) fail('文本节点含不支持的嵌套结构')
    return { node, value: decodeXml(raw) }
  })
  return { name, xml, runs }
}

function readRelationships(xml: string): XmlNode[] {
  const nodes = scan(xml), root = nodes[0]
  if (root.local !== 'Relationships' || root.namespace !== RELATIONSHIPS) fail('无效关系根节点')
  const ids = new Set<string>()
  for (const relation of nodes.slice(1)) {
    const id = relation.attributes.Id
    if (relation.parent !== root || relation.local !== 'Relationship' || relation.namespace !== RELATIONSHIPS || !id || ids.has(id)) fail('无效或重复部件关系')
    ids.add(id)
  }
  return nodes.slice(1)
}

function resolveRelationship(source: string, relation: XmlNode, kind: 'slide' | 'notesSlide'): string {
  const label = kind === 'slide' ? '幻灯片' : '备注'
  if (relation.attributes.TargetMode !== undefined && relation.attributes.TargetMode !== 'Internal') fail(`外部或未知模式的${label}关系不支持`)
  const target = relation.attributes.Target || ''
  if (!target || /[\\\u0000:?#%]/.test(target) || target.startsWith('//')) fail(`不支持的${label}路径`)
  // Resolve from the referring slide, never infer notesSlideN from slideN. Reject
  // package-root traversal even if later segments would return to an allowed dir.
  const segments = target.startsWith('/') ? [] : path.posix.dirname(source).split('/')
  for (const segment of target.split('/')) {
    if (segment === '..') { if (!segments.length) fail(`无效${label}路径`); segments.pop() }
    else if (segment && segment !== '.') segments.push(segment)
  }
  const name = segments.join('/'), directory = kind === 'slide' ? 'ppt/slides/' : 'ppt/notesSlides/'
  if (!name.startsWith(directory) || !name.endsWith('.xml')) fail(`无效${label}路径`)
  return name
}

function loadPresentation(buffer: Buffer): { entries: Record<string, Uint8Array>; slides: SlidePart[] } {
  const entries = readOfficeZip(buffer)
  const part = (name: string): string => {
    if (!entries[name]) fail(`缺少 ${name}`)
    return new TextDecoder('utf-8', { fatal: true }).decode(entries[name])
  }
  const presentation = scan(part('ppt/presentation.xml'))
  if (presentation[0].local !== 'presentation' || presentation[0].namespace !== PRESENTATION) fail('无效演示文稿根节点')
  const relationships = readRelationships(part('ppt/_rels/presentation.xml.rels'))
  const relationshipMap = new Map<string, string>()
  for (const relation of relationships) {
    if (relation.attributes.Type !== `${OFFICE_RELATIONSHIPS}/slide`) continue
    const name = resolveRelationship('ppt/presentation.xml', relation, 'slide')
    relationshipMap.set(relation.attributes.Id, name)
  }
  const ids = presentation.filter(node => node.local === 'sldId' && node.namespace === PRESENTATION)
  if (!ids.length || ids.length > MAX_SLIDES) fail(`幻灯片页数必须为 1–${MAX_SLIDES}`)
  const seen = new Set<string>(), seenNotes = new Set<string>(), slides: SlidePart[] = []
  for (const id of ids) {
    const attribute = Object.keys(id.attributes).find(key => key.includes(':') && key.split(':')[1] === 'id' && id.namespaces[key.split(':')[0]] === OFFICE_RELATIONSHIPS)
    const name = attribute && relationshipMap.get(id.attributes[attribute])
    if (!name || seen.has(name)) fail('缺失或重复幻灯片关系')
    seen.add(name)
    const slide: SlidePart = readTextPart(name, part(name), 'sld')
    const relationsName = path.posix.join(path.posix.dirname(name), '_rels', `${path.posix.basename(name)}.rels`)
    if (entries[relationsName]) {
      const notes = readRelationships(part(relationsName)).filter(relation => relation.attributes.Type === `${OFFICE_RELATIONSHIPS}/notesSlide`)
      if (notes.length > 1) fail('一页不能引用多个备注部件')
      if (notes.length) {
        const notesName = resolveRelationship(name, notes[0], 'notesSlide')
        if (seenNotes.has(notesName)) fail('多页共享同一备注部件不支持')
        seenNotes.add(notesName)
        slide.notes = readTextPart(notesName, part(notesName), 'notes')
      }
    }
    slides.push(slide)
  }
  return { entries, slides }
}

export async function inspectPptx(buffer: Buffer): Promise<{ format: 'pptx'; content: string; summary: Record<string, number | string | boolean>; warnings: string[] }> {
  const pkg = loadPresentation(buffer)
  // Index every extracted text node, including fields, so an inspect locator and
  // an edit always address the same node. Fields are visible but never writable.
  const marked = (part: TextPart, index: number, notes = false): string => part.runs.map((run, runIndex) =>
    `[${notes ? 'target=notes ' : ''}slide=${index + 1} textRun=${runIndex + 1} editable=${run.node.parent?.local === 'r' && run.node.parent.namespace === DRAWING}]\n${run.value}`).join('\n')
  const full = pkg.slides.map((slide, index) => `## 第 ${index + 1} 页\n${marked(slide, index)}${slide.notes ? `\n### 备注\n${marked(slide.notes, index, true)}` : ''}`).join('\n\n')
  const previewTruncated = full.length > 120_000
  const warnings = ['只提取幻灯片正文、表格和关联备注文本；图片、图表数据及母版未提取。字段可见但不可编辑。结构检查不等同于视觉布局验收。']
  if (previewTruncated) warnings.push('正文及备注预览超过 120000 字符，已截断。')
  return { format: 'pptx', content: full.slice(0, 120_000), summary: { slides: pkg.slides.length, textRuns: pkg.slides.reduce((sum, slide) => sum + slide.runs.length, 0), previewTruncated,
    notesSlides: pkg.slides.filter(slide => slide.notes).length, notesTextRuns: pkg.slides.reduce((sum, slide) => sum + (slide.notes?.runs.length ?? 0), 0),
    editLocator: 'slide/textRun are 1-based: display order / text nodes within body or notes separately. Notes require target="notes" plus both indices; omitted target edits body only. Only editable=true nodes support edit; use the same expectedHash.' }, warnings }
}

export async function editPptx(buffer: Buffer, edits: PptxEdit[]): Promise<Buffer> {
  if (!Array.isArray(edits) || !edits.length || edits.length > 100) fail('编辑数量必须为 1–100')
  const pkg = loadPresentation(buffer)
  for (const edit of edits) {
    if (!edit || typeof edit !== 'object') fail('无效编辑')
    if (Object.keys(edit).some(key => !['oldText', 'newText', 'slide', 'textRun', 'target'].includes(key))) fail('不支持的编辑属性')
    if (edit.target !== undefined && edit.target !== 'notes') fail('target 仅支持 notes；省略时只编辑正文')
    const targeted = edit.slide !== undefined || edit.textRun !== undefined
    if (edit.target === 'notes' && !targeted) fail('备注编辑必须提供 slide 和 textRun 定位')
    if (targeted && (!Number.isSafeInteger(edit.slide) || !Number.isSafeInteger(edit.textRun) || edit.slide! < 1 || edit.textRun! < 1)) fail('slide 和 textRun 必须成对提供从 1 开始的整数')
    const oldText = text(edit.oldText, 'oldText', 10_000), newText = text(edit.newText, 'newText', 10_000, false)
    if (/[\r\n\t]/.test(newText)) fail('定点编辑不支持换行或制表符，请拆成独立文本段')
    const matches: Array<{ part: TextPart; run: TextRun; offset: number }> = []
    const selectedSlide = targeted ? pkg.slides[edit.slide! - 1] : undefined
    const targetPart = edit.target === 'notes' ? selectedSlide?.notes : selectedSlide
    const targetRun = targetPart?.runs[edit.textRun! - 1]
    if (targeted && (!targetPart || !targetRun)) fail('slide 或 textRun 超出所选正文/备注范围；请重新 inspect 获取定位')
    if (targetRun && (targetRun.node.parent?.local !== 'r' || targetRun.node.parent.namespace !== DRAWING)) fail('字段或非普通文本段不可编辑')
    for (const part of targetPart ? [targetPart] : pkg.slides) for (const run of targetRun ? [targetRun] : part.runs) {
      let start = 0
      for (;;) { const offset = run.value.indexOf(oldText, start); if (offset < 0) break; matches.push({ part, run, offset }); start = offset + 1 }
    }
    if (matches.length !== 1) fail(targeted ? 'oldText 必须在指定 textRun 内唯一匹配；跨格式文本段不支持' : 'oldText 必须在全部幻灯片的单个文本段内唯一匹配；跨格式文本段不支持')
    const { part, run, offset } = matches[0]
    if (run.node.parent?.local !== 'r' || run.node.parent.namespace !== DRAWING) fail('字段或非普通文本段不可编辑')
    // Preserve formatting, shapes and unrelated ZIP parts. Only the matched
    // ordinary text node changes; split runs/fields are never guessed or flattened.
    const replacement = run.value.slice(0, offset) + newText + run.value.slice(offset + oldText.length)
    part.xml = part.xml.slice(0, run.node.openEnd) + encodeXml(replacement) + part.xml.slice(run.node.closeStart)
    pkg.entries[part.name] = Buffer.from(part.xml)
    part.runs = readTextPart(part.name, part.xml, edit.target === 'notes' ? 'notes' : 'sld').runs
  }
  return writeOfficeZip(pkg.entries)
}
