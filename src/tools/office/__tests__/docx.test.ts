import { describe, expect, it } from 'vitest'
import {
  Document, Footer, Header, ImageRun, Packer, Paragraph, TextRun,
} from 'docx'
import { zipSync } from 'fflate'
import mammoth from 'mammoth'
import { createDocx, editDocx, inspectDocx } from '../docx.js'
import { MAX_OFFICE_FILE_BYTES, readOfficeZip, writeOfficeZip } from '../office-zip.js'

// Exercise actual OOXML artifacts: text extraction, real structure and byte
// preservation of assets matter more than a successful ZIP file extension.
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFeQAAAAASUVORK5CYII=', 'base64')
const decoder = new TextDecoder()
const documentXml = (buffer: Buffer): string => decoder.decode(readOfficeZip(buffer)['word/document.xml'])

async function richFixture(): Promise<Buffer> {
  return Packer.toBuffer(new Document({
    creator: '办公验收',
    sections: [{
      headers: { default: new Header({ children: [new Paragraph('保留页眉：内部资料')] }) },
      footers: { default: new Footer({ children: [new Paragraph('保留页脚：审核版本')] }) },
      children: [
        new Paragraph({ children: [
          new TextRun({ text: '项目：', bold: true, font: '黑体' }),
          new TextRun({ text: '第一', bold: true, color: '123456' }),
          new TextRun({ text: '阶段', italics: true }),
          new TextRun({ text: '完成。其余内容保持原样。', underline: {} }),
        ] }),
        new Paragraph({ children: [new ImageRun({ type: 'png', data: pixel, transformation: { width: 32, height: 32 } })] }),
        new Paragraph('第二段：需要审查。'),
      ],
    }],
  }))
}

function replaceMainXml(buffer: Buffer, transform: (xml: string) => string): Buffer {
  const entries = readOfficeZip(buffer)
  return writeOfficeZip({ ...entries, 'word/document.xml': Buffer.from(transform(decoder.decode(entries['word/document.xml']))) })
}

describe('office DOCX creation and exact OOXML editing', () => {
  it('creates separate Chinese business blocks, real lists/table, page numbering and A4 styles', async () => {
    const buffer = await createDocx({
      title: '项目周报', author: '测试团队',
      markdown: [
        '# 本期概要', '已完成 **引擎优化**，保留业务说明。', '',
        '## 重点进展', '- 接口联调', '- 文档验收', '',
        '1. 执行检查', '2. 复核成果', '',
        '| 项目 | 结果 |', '| --- | --- |', '| A\\|B | 正常 |', '| 客户端 | 完成 |', '',
        '### 风险', '【待补充：负责人】', '', '> 请复核材料。', '',
        '```text', 'status=ready', '```',
      ].join('\n'),
    })
    const inspected = await inspectDocx(buffer)
    expect(inspected.format).toBe('docx')
    expect(inspected.content).toContain('项目周报')
    expect(inspected.content).toContain('已完成 引擎优化，保留业务说明。')
    expect(inspected.content).toContain('A|B')
    expect(inspected.content).not.toContain('**引擎优化**')
    expect(inspected.summary.tables).toBe(1)
    expect(inspected.summary.paragraphs).toBeGreaterThan(12)
    expect(inspected.summary.footers).toBe(1)
    expect(inspected.summary.layoutVerified).toBe(false)
    const externalReader = await mammoth.extractRawText({ buffer })
    expect(externalReader.value).toContain('已完成 引擎优化，保留业务说明。')
    expect(externalReader.value).toContain('A|B')
    const entries = readOfficeZip(buffer)
    const xml = decoder.decode(entries['word/document.xml'])
    expect(xml).toContain('w:w="11906"')
    expect(xml).toContain('w:h="16838"')
    expect(xml).toContain('<w:tblHeader')
    expect(xml).toContain('<w:cantSplit')
    expect(xml).toContain('<w:keepNext')
    expect(xml).toContain('<w:numPr>')
    expect(xml).toContain('<w:b/>')
    const styles = decoder.decode(entries['word/styles.xml'])
    expect(styles).toContain('宋体')
    expect(styles).toContain('黑体')
    expect(styles).toContain('w:line="360"')
    const footer = decoder.decode(entries['word/footer1.xml'])
    expect(footer).toContain('PAGE')
    expect(footer).toContain('NUMPAGES')
  })

  it('preserves heading punctuation and treats Markdown closing hashes separately', async () => {
    const buffer = await createDocx({ markdown: '# C#\n\n## 调研结论 ###\n\n中文正文。' })
    const content = (await inspectDocx(buffer)).content
    expect(content).toContain('C#')
    expect(content).toContain('调研结论')
    expect(content).not.toContain('###')
  })

  it('preserves escaped pipes and inline code pipes without creating extra columns', async () => {
    const buffer = await createDocx({ markdown: '| 类型 | 内容 |\n| --- | --- |\n| 文本 | 左\\|右 |\n| 代码 | `x|y` |\n| 路径 | C:\\\\ |' })
    const inspected = await inspectDocx(buffer)
    expect(inspected.content).toContain('左|右')
    expect(inspected.content).toContain('x|y')
    expect(inspected.content).toContain('C:\\')
    expect((documentXml(buffer).match(/<w:tc>/g) ?? []).length).toBe(8)
  })

  it('replaces text across differently styled runs, preserves image/header/footer/styles and leaves input bytes untouched', async () => {
    const original = await richFixture()
    const inputCopy = Buffer.from(original)
    const previous = readOfficeZip(original)
    const updated = await editDocx(original, [{ oldText: '第一阶段', newText: '第二阶段 & <复核>' }])
    const next = readOfficeZip(updated)
    expect(original.equals(inputCopy)).toBe(true)
    const inspected = await inspectDocx(updated)
    expect(inspected.content).toContain('项目：第二阶段 & <复核>完成。其余内容保持原样。')
    expect(inspected.content).not.toContain('第一阶段')
    expect(inspected.summary.images).toBe(1)
    expect(inspected.summary.headers).toBe(1)
    expect(inspected.summary.footers).toBe(1)
    expect(Object.keys(next).sort()).toEqual(Object.keys(previous).sort())
    for (const [name, bytes] of Object.entries(previous)) {
      if (name !== 'word/document.xml') expect(Buffer.from(next[name]).equals(Buffer.from(bytes)), name).toBe(true)
    }
    const xml = decoder.decode(next['word/document.xml'])
    expect(xml).toMatch(/<w:r><w:rPr><w:b\/><w:bCs\/><w:color w:val="123456"\/><\/w:rPr><w:t xml:space="preserve">第二阶段 &amp; &lt;复核&gt;<\/w:t><\/w:r>/)
    expect(xml).toContain('<w:i/>')
    expect(xml).toContain('完成。其余内容保持原样。')
  })

  it('applies multiple disjoint replacements against the original snapshot, including same-run replacements and deletion', async () => {
    const original = await createDocx({ markdown: '甲任务、乙任务、丙任务。\n\n独立段落。' })
    const updated = await editDocx(original, [
      { oldText: '甲任务', newText: '已完成' },
      { oldText: '乙任务', newText: '复核中' },
      { oldText: '、丙任务', newText: '' },
      { oldText: '独立段落', newText: ' 新段落 ' },
    ])
    expect((await inspectDocx(updated)).content).toBe('已完成、复核中。\n\n 新段落 。')
    expect((await inspectDocx(original)).content).toBe('甲任务、乙任务、丙任务。\n\n独立段落。')
  })

  it('rejects an entire ambiguous/missing/overlapping batch without changing the original artifact', async () => {
    const original = await createDocx({ markdown: '重复词、重复词。\n\n唯一目标ABC。' })
    const copy = Buffer.from(original)
    await expect(editDocx(original, [{ oldText: '唯一目标', newText: '先改' }, { oldText: '重复词', newText: '后改' }])).rejects.toThrow(/ambiguous/)
    await expect(editDocx(original, [{ oldText: '唯一目标', newText: '先改' }, { oldText: '不存在', newText: '后改' }])).rejects.toThrow(/not found/)
    await expect(editDocx(original, [{ oldText: '唯一目标AB', newText: '一' }, { oldText: 'ABC', newText: '二' }])).rejects.toThrow(/overlap/)
    expect(original.equals(copy)).toBe(true)
    expect((await inspectDocx(original)).content).toContain('唯一目标ABC')
  })

  it('rejects field/revision/hyperlink/control paragraphs and cross-paragraph replacements', async () => {
    const original = await createDocx({ markdown: '受保护目标。\n\n下一段。' })
    for (const [opening, closing] of [
      ['<w:hyperlink r:id="rId99">', '</w:hyperlink>'],
      ['<w:ins w:id="1" w:author="作者">', '</w:ins>'],
      ['<w:sdt><w:sdtContent>', '</w:sdtContent></w:sdt>'],
    ]) {
      const complex = replaceMainXml(original, xml => xml.replace(/(<w:r>[^]*?<w:t[^>]*>受保护目标。<\/w:t><\/w:r>)/, `${opening}$1${closing}`))
      await expect(editDocx(complex, [{ oldText: '受保护目标', newText: '不能覆盖' }])).rejects.toThrow(/unsupported/)
    }
    const field = replaceMainXml(original, xml => xml.replace('受保护目标。', '受保护目标。').replace('<w:t xml:space="preserve">受保护目标。</w:t>', '<w:fldChar w:fldCharType="begin"/><w:t xml:space="preserve">受保护目标。</w:t>'))
    await expect(editDocx(field, [{ oldText: '受保护目标', newText: '不能覆盖' }])).rejects.toThrow(/unsupported/)
    await expect(editDocx(original, [{ oldText: '目标。\n\n下一', newText: '跨段' }])).rejects.toThrow(/breaks/)
  })

  it('rejects corruption, signed files and oversized archives rather than producing plausible output', async () => {
    await expect(inspectDocx(Buffer.from('not a zip'))).rejects.toThrow(/ZIP|invalid/)
    const original = await createDocx({ markdown: '完整内容。' })
    const brokenXml = replaceMainXml(original, xml => xml.replace('</w:body>', '</w:broken>'))
    await expect(inspectDocx(brokenXml)).rejects.toThrow(/mismatched/)
    const rich = readOfficeZip(await richFixture())
    const brokenHeader = writeOfficeZip({ ...rich, 'word/header1.xml': Buffer.from('<w:hdr><w:p></w:hdr>') })
    await expect(inspectDocx(brokenHeader)).rejects.toThrow(/mismatched/)
    const brokenEntity = replaceMainXml(original, xml => xml.replace('完整内容。', '内容 &broken;'))
    await expect(editDocx(brokenEntity, [{ oldText: '内容', newText: '新内容' }])).rejects.toThrow(/entity/)
    const signed = Buffer.from(zipSync({ ...readOfficeZip(original), '_xmlsignatures/sig1.xml': Buffer.from('<Signature/>') }))
    await expect(editDocx(signed, [{ oldText: '完整', newText: '新' }])).rejects.toThrow(/signed|signature/i)
    await expect(inspectDocx(Buffer.alloc(MAX_OFFICE_FILE_BYTES + 1))).rejects.toThrow(/32 MiB|limit|exceed/)
  })

  it('rejects invalid Markdown structure, unsafe Unicode and multiline replacement input explicitly', async () => {
    await expect(createDocx({ markdown: '| A | B |\n| --- | --- |\n| 只有一列 |' })).rejects.toThrow(/column count/)
    await expect(createDocx({ markdown: '```\n未闭合' })).rejects.toThrow(/unclosed/)
    await expect(createDocx({ markdown: '内容\u0000' })).rejects.toThrow(/XML 1.0/)
    await expect(createDocx({ markdown: '内容\ud800' })).rejects.toThrow(/XML 1.0/)
    const original = await createDocx({ markdown: '内容' })
    await expect(editDocx(original, [{ oldText: '内容', newText: '新\n内容' }])).rejects.toThrow(/breaks/)
    await expect(createDocx({ markdown: 'a'.repeat(1024 * 1024 + 1) })).rejects.toThrow(/1 MiB/)
  })
})
