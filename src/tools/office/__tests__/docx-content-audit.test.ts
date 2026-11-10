import { describe, expect, it } from 'vitest'
import { Document, Footer, Packer, Paragraph } from 'docx'
import mammoth from 'mammoth'
import { createDocx, inspectDocx } from '../docx.js'
import { readOfficeZip } from '../office-zip.js'

// New DOCX audit only: preserve authored line breaks and loose-list numbering,
// and disclose fields outside the body without pretending to validate pages.
const documentXml = (buffer: Buffer): string =>
  Buffer.from(readOfficeZip(buffer)['word/document.xml']).toString('utf8')

describe('DOCX content and inspection audit', () => {
  it.each([
    ['two trailing spaces', '收件人：项目组  \n日期：2026年11月10日'],
    ['an unescaped backslash', '收件人：项目组\\\n日期：2026年11月10日'],
    ['a break inside bold text', '**收件人：项目组  \n日期：2026年11月10日**'],
  ])('preserves an explicit Markdown break from %s', async (_name, markdown) => {
    const buffer = await createDocx({ markdown })
    const external = await mammoth.extractRawText({ buffer })
    expect(external.value.trim()).toBe('收件人：项目组\n日期：2026年11月10日')
    expect(documentXml(buffer).match(/<w:br\b/g)).toHaveLength(1)
    expect((await inspectDocx(buffer)).content).toBe('收件人：项目组\n日期：2026年11月10日')
  })

  it('keeps soft wrapping and escaped backslashes distinct from hard breaks', async () => {
    const buffer = await createDocx({ markdown: '路径：C:\\\\\n下一行\n普通续行\n\n结尾反斜杠\\' })
    const external = await mammoth.extractRawText({ buffer })
    expect(external.value.trim()).toBe('路径：C:\\ 下一行 普通续行\n\n结尾反斜杠\\')
    expect(documentXml(buffer)).not.toMatch(/<w:br\b/)
  })

  it('continues loose ordered lists across blanks and restarts after a real paragraph', async () => {
    const buffer = await createDocx({ markdown: '1. 收集问题\n\n1. 完成修复\n\n1. 复核成果\n\n下一阶段\n\n3. 上线验收' })
    const xml = documentXml(buffer)
    const listIds = [...xml.matchAll(/<w:numId w:val="(\d+)"/g)].map(match => match[1])
    expect(listIds).toHaveLength(4)
    expect(listIds[0]).toBe(listIds[1])
    expect(listIds[1]).toBe(listIds[2])
    expect(listIds[3]).not.toBe(listIds[2])
    const external = await mammoth.convertToHtml({ buffer })
    expect(external.value).toContain('<ol><li>收集问题</li><li>完成修复</li><li>复核成果</li></ol>')
    const numbering = Buffer.from(readOfficeZip(buffer)['word/numbering.xml']).toString('utf8')
    expect(numbering).toContain('<w:start w:val="3"/>')
  })

  it('reports default page-number fields in the footer and unverified pagination', async () => {
    const buffer = await createDocx({ markdown: '检查页脚字段。' })
    expect(documentXml(buffer)).not.toMatch(/w:(?:fldChar|instrText|fldSimple)/)
    const inspected = await inspectDocx(buffer)
    expect(inspected.warnings).toContain('Text inspection does not verify pagination or visual layout.')
    expect(inspected.warnings.some(warning => warning.includes('header/footer page numbers'))).toBe(true)
    expect(inspected.summary.layoutVerified).toBe(false)
  })

  it('does not invent field warnings for a plain-text footer', async () => {
    const buffer = await Packer.toBuffer(new Document({ sections: [{
      footers: { default: new Footer({ children: [new Paragraph('内部审核稿')] }) },
      children: [new Paragraph('无字段的正文。')],
    }] }))
    const inspected = await inspectDocx(buffer)
    expect(inspected.warnings).toEqual(['Text inspection does not verify pagination or visual layout.'])
  })
})
