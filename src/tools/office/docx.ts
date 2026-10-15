import { TextDecoder } from 'node:util'
import {
  AlignmentType, BorderStyle, Document, Footer, HeadingLevel, LevelFormat,
  Packer, PageNumber, Paragraph, ShadingType, Table, TableCell, TableLayoutType,
  TableRow, TextRun, WidthType,
  type ILevelsOptions, type IRunOptions,
} from 'docx'
import { decodeXml, encodeXml, readOfficeZip, writeOfficeZip } from './office-zip.js'

const MAIN_PART = 'word/document.xml'
const WORD_NAMESPACE = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const MAX_MARKDOWN_BYTES = 1024 * 1024
const MAX_TEXT_CHARACTERS = 2 * 1024 * 1024
const MAX_BLOCKS = 6000
const MAX_TABLE_CELLS = 20_000
const MAX_EDIT_COUNT = 100
const FONT_BODY = { ascii: 'Aptos', hAnsi: 'Aptos', eastAsia: '宋体' }
const FONT_HEADING = { ascii: 'Aptos Display', hAnsi: 'Aptos Display', eastAsia: '黑体' }

interface XmlElement {
  name: string
  start: number
  openEnd: number
  closeStart: number
  end: number
  attributes: Record<string, string>
  parent?: XmlElement
}

interface TextNode {
  element: XmlElement
  text: string
  offset: number
}

interface DocumentParagraph {
  element: XmlElement
  text: string
  nodes: TextNode[]
  editable: boolean
}

interface DocxPackage {
  entries: Record<string, Uint8Array>
  xml: string
  elements: XmlElement[]
  paragraphs: DocumentParagraph[]
}

function fail(message: string): never {
  throw new Error(`DOCX: ${message}`)
}

function assertXmlCharacters(text: string, label: string): void {
  // XML 1.0 disallows control characters and unpaired UTF-16 surrogates.
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) ||
        (code >= 0xd800 && code <= 0xdfff) || code === 0xfffe || code === 0xffff) {
      fail(`${label} contains a character that XML 1.0 cannot represent`)
    }
  }
}

function assertEntities(text: string): void {
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);)/.test(text)) {
    fail('malformed XML entity')
  }
  assertXmlCharacters(decodeXml(text), 'XML text')
}

function decodePart(bytes: Uint8Array, name: string): string {
  let xml: string
  try {
    xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return fail(`${name} must contain valid UTF-8 XML`)
  }
  const encoding = /^\s*<\?xml[^?]*\bencoding\s*=\s*['"]([^'"]+)['"]/i.exec(xml)?.[1]
  if (encoding && !/^utf-?8$/i.test(encoding)) fail(`${name} uses unsupported XML encoding ${encoding}`)
  return xml
}

/** A small non-expanding XML scanner: no DTD, external entities or recovery of broken markup. */
function scanXml(xml: string): XmlElement[] {
  assertXmlCharacters(xml, 'XML')
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) fail('DTD and XML entity declarations are unsupported')
  const tokens = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<\/?[A-Za-z_][\w.:-]*(?:[^<>"']|"[^"]*"|'[^']*')*>/g
  const stack: XmlElement[] = []
  const elements: XmlElement[] = []
  let offset = 0
  let rootCount = 0
  for (const match of xml.matchAll(tokens)) {
    const index = match.index
    const between = xml.slice(offset, index)
    if (between.includes('<')) fail('malformed XML markup')
    if (stack.length === 0 && between.trim()) fail('text outside the XML root')
    assertEntities(between)
    const token = match[0]
    offset = index + token.length
    if (token.startsWith('<!--')) {
      if (token.slice(4, -3).includes('--')) fail('malformed XML comment')
      continue
    }
    if (token.startsWith('<?')) continue
    if (token.startsWith('<![CDATA[')) {
      if (stack.length === 0) fail('CDATA outside the XML root')
      continue
    }
    if (token.startsWith('</')) {
      const closing = /^<\/([A-Za-z_][\w.:-]*)\s*>$/.exec(token)
      const current = stack.pop()
      if (!closing || !current || current.name !== closing[1]) fail('mismatched XML tags')
      current.closeStart = index
      current.end = offset
      continue
    }
    const opening = /^<([A-Za-z_][\w.:-]*)([\s\S]*?)(\/?)>$/.exec(token)
    if (!opening) fail('malformed XML opening tag')
    const attributes: Record<string, string> = Object.create(null) as Record<string, string>
    const attributeText = opening[2]
    const attributePattern = /\s+([A-Za-z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/g
    let attributeOffset = 0
    for (const attribute of attributeText.matchAll(attributePattern)) {
      if (attributeText.slice(attributeOffset, attribute.index).trim()) fail('malformed XML attribute')
      if (Object.hasOwn(attributes, attribute[1])) fail('duplicate XML attribute')
      const value = attribute[3] ?? attribute[4]
      if (value.includes('<')) fail('malformed XML attribute value')
      assertEntities(value)
      attributes[attribute[1]] = decodeXml(value)
      attributeOffset = attribute.index + attribute[0].length
    }
    if (attributeText.slice(attributeOffset).trim()) fail('malformed XML attribute')
    const element: XmlElement = {
      name: opening[1], start: index, openEnd: offset, closeStart: offset, end: offset,
      attributes, parent: stack.at(-1),
    }
    if (!element.parent) rootCount += 1
    elements.push(element)
    if (elements.length > 500_000) fail('XML element limit exceeded')
    if (!opening[3]) stack.push(element)
    if (stack.length > 100) fail('XML nesting limit exceeded')
  }
  const tail = xml.slice(offset)
  if (tail.includes('<') || tail.trim() || stack.length || rootCount !== 1) fail('incomplete XML document')
  return elements
}

function nearestParagraph(element: XmlElement): XmlElement | undefined {
  for (let current = element.parent; current; current = current.parent) {
    if (current.name === 'w:p') return current
  }
  return undefined
}

const UNSUPPORTED_EDIT_ELEMENTS = new Set([
  'w:fldChar', 'w:instrText', 'w:fldSimple', 'w:ins', 'w:del', 'w:moveFrom', 'w:moveTo',
  'w:sdt', 'w:hyperlink', 'w:drawing', 'w:pict', 'w:object', 'w:smartTag', 'w:customXml',
  'w:tab', 'w:br', 'w:cr', 'w:sym', 'w:footnoteReference', 'w:endnoteReference',
  'w:bookmarkStart', 'w:bookmarkEnd', 'w:commentRangeStart', 'w:commentRangeEnd',
  'w:commentReference', 'w:vanish', 'w:webHidden', 'mc:AlternateContent',
])

function readParagraphs(xml: string, elements: XmlElement[]): DocumentParagraph[] {
  const result: DocumentParagraph[] = []
  const byElement = new Map<XmlElement, DocumentParagraph>()
  for (const element of elements) {
    if (element.name !== 'w:p') continue
    let editable = element.parent?.name === 'w:body' || element.parent?.name === 'w:tc'
    for (let parent = element.parent; parent; parent = parent.parent) {
      if (UNSUPPORTED_EDIT_ELEMENTS.has(parent.name) || parent.name === 'w:p') editable = false
    }
    const paragraph = { element, text: '', nodes: [], editable }
    result.push(paragraph)
    byElement.set(element, paragraph)
  }
  for (const element of elements) {
    const owner = nearestParagraph(element)
    if (!owner) continue
    const paragraph = byElement.get(owner)
    if (!paragraph) continue
    if (UNSUPPORTED_EDIT_ELEMENTS.has(element.name)) paragraph.editable = false
    // Unknown inline containers can carry semantics such as range ownership;
    // preserve them rather than moving replacement text across their boundary.
    if (element.parent === owner && !['w:pPr', 'w:r', 'w:proofErr'].includes(element.name)) paragraph.editable = false
    if (element.parent?.name === 'w:r' && !['w:rPr', 'w:t'].includes(element.name)) paragraph.editable = false
    if (element.name === 'w:t' || element.name === 'w:delText') {
      const raw = xml.slice(element.openEnd, element.closeStart)
      if (raw.includes('<')) fail('nested markup in a Word text node is unsupported')
      const text = decodeXml(raw)
      if (element.name !== 'w:t' || element.parent?.name !== 'w:r') paragraph.editable = false
      paragraph.nodes.push({ element, text, offset: paragraph.text.length })
      paragraph.text += text
    } else if (element.name === 'w:tab') {
      paragraph.text += '\t'
    } else if (element.name === 'w:br' || element.name === 'w:cr') {
      paragraph.text += '\n'
    }
  }
  if (result.reduce((count, paragraph) => count + paragraph.text.length, 0) > MAX_TEXT_CHARACTERS) {
    fail('extracted text exceeds the 2 MiB character limit')
  }
  return result
}

function readPackage(buffer: Buffer): DocxPackage {
  const entries = readOfficeZip(buffer)
  if (Object.keys(entries).some(name => /^_xmlsignatures\//i.test(name))) {
    fail('digitally signed documents are unsupported; editing would invalidate the signature')
  }
  if (!entries[MAIN_PART] || !entries['[Content_Types].xml'] || !entries['_rels/.rels']) {
    fail('required DOCX package parts are missing')
  }
  const xmlParts = new Map<string, { xml: string; elements: XmlElement[] }>()
  let xmlElementCount = 0
  for (const [name, bytes] of Object.entries(entries)) {
    if (!/\.(?:xml|rels)$/i.test(name)) continue
    const xml = decodePart(bytes, name)
    const elements = scanXml(xml)
    xmlElementCount += elements.length
    if (xmlElementCount > 500_000) fail('package-wide XML element limit exceeded')
    xmlParts.set(name, { xml, elements })
    if (/digital-signature/i.test(xml)) fail('digitally signed documents are unsupported')
  }
  const contentTypes = xmlParts.get('[Content_Types].xml')?.elements ?? []
  const mainType = contentTypes.find(element => element.attributes.PartName === `/${MAIN_PART}`)?.attributes.ContentType
  if (mainType !== 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml') {
    fail('the package is not a supported non-macro DOCX document')
  }
  const rootRelations = xmlParts.get('_rels/.rels')?.elements ?? []
  const mainRelationship = rootRelations.find(element => /\/officeDocument$/.test(element.attributes.Type ?? ''))
  if (!mainRelationship || !['word/document.xml', '/word/document.xml'].includes(mainRelationship.attributes.Target) ||
      mainRelationship.attributes.TargetMode === 'External') {
    fail('unsupported main document relationship')
  }
  const main = xmlParts.get(MAIN_PART)
  if (!main || main.elements[0]?.name !== 'w:document' || main.elements[0].attributes['xmlns:w'] !== WORD_NAMESPACE ||
      main.elements.filter(element => element.name === 'w:body' && element.parent === main.elements[0]).length !== 1 ||
      main.elements.some(element => element.attributes['xmlns:w'] !== undefined && element.attributes['xmlns:w'] !== WORD_NAMESPACE)) {
    fail('unsupported or damaged Word document XML; expected transitional w:document/w:body')
  }
  return { entries, xml: main.xml, elements: main.elements, paragraphs: readParagraphs(main.xml, main.elements) }
}

function inlineRuns(text: string, overrides: IRunOptions = {}): TextRun[] {
  const runs: TextRun[] = []
  let plain = ''
  const pushPlain = (): void => {
    if (plain) runs.push(new TextRun({ text: plain, ...overrides }))
    plain = ''
  }
  for (let index = 0; index < text.length;) {
    if (text[index] === '\\' && index + 1 < text.length && /[\\`*_[\]{}()#+.!|>-]/.test(text[index + 1])) {
      plain += text[index + 1]
      index += 2
      continue
    }
    const marker = text.startsWith('**', index) ? '**' : text[index] === '`' ? '`' : undefined
    if (marker) {
      const end = text.indexOf(marker, index + marker.length)
      if (end > index + marker.length) {
        pushPlain()
        const content = text.slice(index + marker.length, end)
        runs.push(new TextRun({ ...overrides, text: content, ...(marker === '**' ? { bold: true } : { font: 'Consolas', size: 20 }) }))
        index = end + marker.length
        continue
      }
    }
    plain += text[index]
    index += 1
  }
  pushPlain()
  return runs.length ? runs : [new TextRun({ text: '', ...overrides })]
}

/** Keep escaped pipes intact until inline parsing, including a literal backslash before a separator. */
function tableCells(line: string): string[] {
  let input = line.trim()
  if (input.startsWith('|')) input = input.slice(1)
  if (input.endsWith('|') && !/(?<!\\)(?:\\\\)*\\\|$/.test(input)) input = input.slice(0, -1)
  const cells: string[] = []
  let cell = ''
  let backslashes = 0
  let inCode = false
  for (const character of input) {
    if (character === '`' && backslashes % 2 === 0) inCode = !inCode
    if (character === '|' && backslashes % 2 === 0 && !inCode) {
      cells.push(cell.trim())
      cell = ''
    } else {
      cell += character
    }
    backslashes = character === '\\' ? backslashes + 1 : 0
  }
  cells.push(cell.trim())
  return cells
}

function isTableDelimiter(line: string): boolean {
  return line.includes('|') && tableCells(line).every(cell => /^:?-{3,}:?$/.test(cell))
}

function markdownBlocks(markdown: string): { children: Array<Paragraph | Table>; numbering: Array<{ reference: string; levels: ILevelsOptions[] }> } {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const children: Array<Paragraph | Table> = []
  const numbering: Array<{ reference: string; levels: ILevelsOptions[] }> = []
  const headingLevels = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3,
    HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6]
  let tableCellCount = 0
  let activeOrdered: string | undefined
  for (let index = 0; index < lines.length;) {
    if (children.length >= MAX_BLOCKS) fail(`document exceeds ${MAX_BLOCKS} blocks`)
    const line = lines[index]
    const trimmed = line.trim()
    if (!trimmed) { activeOrdered = undefined; index += 1; continue }
    if (/^!\[|^<\/?[A-Za-z!]/.test(trimmed)) fail('Markdown images and raw HTML need a dedicated document template')
    const fence = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      activeOrdered = undefined
      index += 1
      let closed = false
      while (index < lines.length) {
        if (new RegExp(`^\\s*${fence[2][0]}{${fence[2].length},}\\s*$`).test(lines[index])) { closed = true; index += 1; break }
        children.push(new Paragraph({
          children: [new TextRun({ text: lines[index], font: { ascii: 'Consolas', eastAsia: '宋体' }, size: 19 })],
          spacing: { after: 0, line: 280 }, shading: { fill: 'F5F5F7', type: ShadingType.CLEAR },
          indent: { left: 160, right: 160 }, widowControl: true,
        }))
        if (children.length >= MAX_BLOCKS) fail(`document exceeds ${MAX_BLOCKS} blocks`)
        index += 1
      }
      if (!closed) fail('unclosed Markdown code fence')
      continue
    }
    if (index + 1 < lines.length && line.includes('|') && isTableDelimiter(lines[index + 1])) {
      activeOrdered = undefined
      const header = tableCells(line)
      if (header.length > 20) fail('tables with more than 20 columns require a dedicated landscape template')
      const rows = [header]
      index += 2
      while (index < lines.length && lines[index].trim() && lines[index].includes('|')) {
        const cells = tableCells(lines[index])
        if (cells.length !== header.length) fail('Markdown table row has a different column count from its header')
        rows.push(cells)
        index += 1
      }
      tableCellCount += rows.length * header.length
      if (tableCellCount > MAX_TABLE_CELLS) fail(`document exceeds ${MAX_TABLE_CELLS} table cells`)
      const border = { style: BorderStyle.SINGLE, size: 4, color: 'D1D1D6' }
      children.push(new Table({
        width: { size: 100, type: WidthType.PERCENTAGE }, layout: TableLayoutType.FIXED,
        columnWidths: header.map(() => Math.floor(9026 / header.length)),
        borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border },
        rows: rows.map((row, rowIndex) => new TableRow({
          tableHeader: rowIndex === 0, cantSplit: true,
          children: row.map(text => new TableCell({
            width: { size: 100 / header.length, type: WidthType.PERCENTAGE },
            margins: { top: 100, bottom: 100, left: 120, right: 120 },
            shading: rowIndex === 0 ? { fill: 'F0F2F5', type: ShadingType.CLEAR } : undefined,
            children: [new Paragraph({
              children: inlineRuns(text, { bold: rowIndex === 0, size: 21 }),
              spacing: { before: 0, after: 0, line: 300 }, keepNext: rowIndex === 0, widowControl: true,
            })],
          })),
        })),
      }))
      children.push(new Paragraph({ spacing: { after: 80, before: 0, line: 120 } }))
      continue
    }
    const heading = /^(#{1,6})[ \t]+(.+?)(?:[ \t]+#+[ \t]*)?$/.exec(trimmed)
    if (heading) {
      activeOrdered = undefined
      children.push(new Paragraph({
        children: inlineRuns(heading[2]), heading: headingLevels[heading[1].length - 1],
        keepNext: true, keepLines: true,
      }))
      index += 1
      continue
    }
    const unordered = /^(\s*)[-+*]\s+(.+)$/.exec(line)
    const ordered = /^(\s*)(\d{1,6})[.)、]\s+(.+)$/.exec(line)
    if (unordered || ordered) {
      const depth = Math.min(8, Math.floor((unordered?.[1] ?? ordered?.[1] ?? '').replace(/\t/g, '    ').length / 2))
      if (ordered && !activeOrdered) {
        activeOrdered = `office-decimal-${numbering.length + 1}`
        numbering.push({ reference: activeOrdered, levels: Array.from({ length: 9 }, (_, level) => ({
          level, format: LevelFormat.DECIMAL, text: `%${level + 1}.`,
          start: level === depth ? Number(ordered[2]) : 1,
          alignment: AlignmentType.START,
          style: { paragraph: { indent: { left: 420 + level * 360, hanging: 240 } } },
        })) })
      }
      if (unordered) activeOrdered = undefined
      children.push(new Paragraph({
        children: inlineRuns(unordered?.[2] ?? ordered?.[3] ?? ''),
        ...(unordered ? { bullet: { level: depth } } : { numbering: { reference: activeOrdered ?? '', level: depth } }),
        spacing: { before: 0, after: 80, line: 340 }, widowControl: true,
      }))
      index += 1
      continue
    }
    activeOrdered = undefined
    if (/^>\s?/.test(trimmed)) {
      children.push(new Paragraph({
        children: inlineRuns(trimmed.replace(/^>\s?/, ''), { color: '595959' }),
        indent: { left: 420, right: 160 }, border: { left: { style: BorderStyle.SINGLE, size: 12, color: 'D1D1D6', space: 8 } },
        widowControl: true,
      }))
      index += 1
      continue
    }
    if (/^(?:---+|\*\*\*+|___+)\s*$/.test(trimmed)) {
      children.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: 'D1D1D6' } } }))
      index += 1
      continue
    }
    // Soft-wrapped Markdown lines form one paragraph, while blank lines separate paragraphs.
    const paragraph = [trimmed]
    index += 1
    while (index < lines.length && lines[index].trim() &&
        !/^\s*(?:#{1,6}\s|[-+*]\s|\d+[.)、]\s|>|`{3,}|~{3,}|!\[|<\/?[A-Za-z!])/.test(lines[index]) &&
        !(index + 1 < lines.length && lines[index].includes('|') && isTableDelimiter(lines[index + 1]))) {
      paragraph.push(lines[index].trim())
      index += 1
    }
    children.push(new Paragraph({ children: inlineRuns(paragraph.join(' ')), widowControl: true }))
  }
  return { children, numbering }
}

export async function createDocx(options: { markdown: string; title?: string; author?: string }): Promise<Buffer> {
  if (typeof options.markdown !== 'string' || !options.markdown.trim()) fail('markdown must be a nonempty string')
  if (Buffer.byteLength(options.markdown, 'utf8') > MAX_MARKDOWN_BYTES) fail('Markdown input exceeds 1 MiB')
  if ((options.title?.length ?? 0) > 500 || (options.author?.length ?? 0) > 200) fail('title or author exceeds the metadata length limit')
  assertXmlCharacters(options.markdown, 'Markdown')
  if (options.title !== undefined) assertXmlCharacters(options.title, 'Title')
  if (options.author !== undefined) assertXmlCharacters(options.author, 'Author')
  const { children, numbering } = markdownBlocks(options.markdown)
  if (!children.length) fail('Markdown contains no document content')
  if (options.title?.trim()) {
    children.unshift(new Paragraph({
      children: inlineRuns(options.title.trim(), { font: FONT_HEADING, size: 36, bold: true }),
      heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER,
      spacing: { before: 0, after: 360 }, keepNext: true, keepLines: true,
    }))
  }
  const headingStyle = (size: number) => ({
    run: { font: FONT_HEADING, size, bold: true, color: '1D1D1F' },
    paragraph: { spacing: { before: 300, after: 140, line: 340 }, keepNext: true, keepLines: true },
  })
  const document = new Document({
    creator: options.author?.trim() || 'Aether', title: options.title?.trim(),
    description: 'Created with the Aether office document workflow',
    styles: { default: {
      document: {
        run: { font: FONT_BODY, size: 24, color: '1D1D1F', language: { value: 'zh-CN', eastAsia: 'zh-CN' } },
        paragraph: { spacing: { after: 160, line: 360 } },
      },
      heading1: headingStyle(32), heading2: headingStyle(28), heading3: headingStyle(26),
      heading4: headingStyle(24), heading5: headingStyle(24), heading6: headingStyle(24),
    } },
    numbering: { config: numbering },
    sections: [{
      properties: { page: {
        size: { width: 11906, height: 16838 },
        margin: { top: 1417, right: 1440, bottom: 1417, left: 1440, header: 708, footer: 708 },
      } },
      footers: { default: new Footer({ children: [new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ children: ['第 ', PageNumber.CURRENT, ' 页 / 共 ', PageNumber.TOTAL_PAGES, ' 页'], font: FONT_BODY, size: 18, color: '6E6E73' })],
      })] }) },
      children,
    }],
  })
  const buffer = await Packer.toBuffer(document)
  const reopened = readPackage(buffer)
  if (!reopened.paragraphs.some(paragraph => paragraph.text.trim())) fail('generated document failed the reopen content check')
  return buffer
}

export async function inspectDocx(buffer: Buffer): Promise<{
  format: 'docx'; content: string; summary: Record<string, number | string | boolean>; warnings: string[]
}> {
  const { entries, elements, paragraphs } = readPackage(buffer)
  const content = paragraphs.map(paragraph => paragraph.text).filter(Boolean).join('\n\n')
  const images = Object.keys(entries).filter(name => /^word\/media\//i.test(name) && !name.endsWith('/')).length
  const warnings: string[] = []
  if (images) warnings.push('Image parts are present; this text inspection does not verify their visual contents or page layout.')
  if (elements.some(element => ['w:fldChar', 'w:fldSimple', 'w:instrText'].includes(element.name))) {
    warnings.push('Field results are cached document text; fields and page numbers are recalculated by Word/WPS.')
  }
  if (elements.some(element => ['w:ins', 'w:del', 'w:moveFrom', 'w:moveTo'].includes(element.name))) {
    warnings.push('Tracked changes are present; text inspection includes their stored text without accepting or rejecting changes.')
  }
  return {
    format: 'docx', content,
    summary: {
      paragraphs: paragraphs.length, tables: elements.filter(element => element.name === 'w:tbl').length,
      images, sections: elements.filter(element => element.name === 'w:sectPr').length,
      headers: Object.keys(entries).filter(name => /^word\/header[^/]*\.xml$/i.test(name)).length,
      footers: Object.keys(entries).filter(name => /^word\/footer[^/]*\.xml$/i.test(name)).length,
      characters: content.length, editScope: 'main document paragraphs only',
      layoutVerified: false,
    }, warnings,
  }
}

/** Exact original-text edits; inserted text inherits the run containing the first matched character. */
export async function editDocx(buffer: Buffer, edits: Array<{ oldText: string; newText: string }>): Promise<Buffer> {
  if (!Array.isArray(edits) || !edits.length || edits.length > MAX_EDIT_COUNT) fail(`edits must contain 1–${MAX_EDIT_COUNT} replacements`)
  const packageData = readPackage(buffer)
  const plans: Array<{ paragraph: DocumentParagraph; start: number; end: number; replacement: string }> = []
  for (const edit of edits) {
    if (!edit || typeof edit.oldText !== 'string' || !edit.oldText || typeof edit.newText !== 'string') {
      fail('every replacement needs nonempty oldText and a string newText')
    }
    if (edit.oldText.length > 100_000 || edit.newText.length > 100_000) fail('a replacement exceeds 100,000 characters')
    assertXmlCharacters(edit.oldText, 'oldText')
    assertXmlCharacters(edit.newText, 'newText')
    if (/[\r\n\t]/.test(edit.oldText + edit.newText)) fail('text replacements cannot contain tabs or line/paragraph breaks')
    const matches: Array<{ paragraph: DocumentParagraph; start: number }> = []
    for (const paragraph of packageData.paragraphs) {
      let start = paragraph.text.indexOf(edit.oldText)
      while (start !== -1) {
        matches.push({ paragraph, start })
        if (matches.length > 1) break
        start = paragraph.text.indexOf(edit.oldText, start + 1)
      }
      if (matches.length > 1) break
    }
    if (matches.length !== 1) fail(matches.length ? 'oldText is ambiguous; each replacement must match exactly once' : 'oldText was not found in a single main-document paragraph')
    const match = matches[0]
    if (!match.paragraph.editable) fail('the matched paragraph contains unsupported fields, revisions, links, images, controls, or text boundaries')
    const plan = { ...match, end: match.start + edit.oldText.length, replacement: edit.newText }
    if (plans.some(other => other.paragraph === plan.paragraph && other.start < plan.end && plan.start < other.end)) {
      fail('replacement ranges overlap; the entire batch was rejected')
    }
    plans.push(plan)
  }
  const patches = new Map<TextNode, Array<{ start: number; end: number; value: string }>>()
  for (const plan of plans) {
    let first = true
    for (const node of plan.paragraph.nodes) {
      const start = Math.max(plan.start, node.offset)
      const end = Math.min(plan.end, node.offset + node.text.length)
      if (start >= end) continue
      const nodePatches = patches.get(node) ?? []
      nodePatches.push({ start: start - node.offset, end: end - node.offset, value: first ? plan.replacement : '' })
      patches.set(node, nodePatches)
      first = false
    }
    if (first) fail('replacement could not be mapped to editable text runs')
  }
  const replacements: Array<{ start: number; end: number; value: string }> = []
  for (const [node, nodePatches] of patches) {
    let text = node.text
    for (const patch of nodePatches.sort((a, b) => b.start - a.start)) text = text.slice(0, patch.start) + patch.value + text.slice(patch.end)
    let opening = packageData.xml.slice(node.element.start, node.element.openEnd)
    if (/\bxml:space\s*=/.test(opening)) opening = opening.replace(/\bxml:space\s*=\s*(?:"[^"]*"|'[^']*')/, 'xml:space="preserve"')
    else opening = opening.slice(0, -1) + ' xml:space="preserve">'
    replacements.push({ start: node.element.start, end: node.element.end, value: opening + encodeXml(text) + '</w:t>' })
  }
  let xml = packageData.xml
  for (const patch of replacements.sort((a, b) => b.start - a.start)) xml = xml.slice(0, patch.start) + patch.value + xml.slice(patch.end)
  const output = writeOfficeZip({ ...packageData.entries, [MAIN_PART]: Buffer.from(xml, 'utf8') })
  const reopened = readPackage(output)
  if (reopened.paragraphs.length !== packageData.paragraphs.length) fail('edited document failed paragraph structure verification')
  for (let index = 0; index < packageData.paragraphs.length; index += 1) {
    const paragraph = packageData.paragraphs[index]
    let expected = paragraph.text
    for (const plan of plans.filter(plan => plan.paragraph === paragraph).sort((a, b) => b.start - a.start)) {
      expected = expected.slice(0, plan.start) + plan.replacement + expected.slice(plan.end)
    }
    if (reopened.paragraphs[index].text !== expected) fail('edited document failed exact content verification')
  }
  for (const [name, bytes] of Object.entries(packageData.entries)) {
    if (name !== MAIN_PART && !Buffer.from(reopened.entries[name] ?? []).equals(Buffer.from(bytes))) {
      fail(`edited document changed an unrelated package part: ${name}`)
    }
  }
  return output
}
