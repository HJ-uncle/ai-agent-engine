/** Native binaries, searchable CJK PDFs, ordered slide inspection and preserving edits without external Office. */
import fs from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { createPdf, inspectPdf } from '../pdf.js'
import { createPptx, editPptx, inspectPptx, type PptxSlide } from '../pptx.js'
import { readOfficeZip, writeOfficeZip } from '../office-zip.js'

describe('native PDF office delivery', () => {
  it('generates a real searchable multi-page Chinese document with a title and page footer', async () => {
    const buffer = await createPdf({ title: '星澜科技经营分析', author: '财务部',
      markdown: '# 本月结论\n\n收入 120000 元，成本 80000 元。\n\n' + Array.from({ length: 85 }, (_, i) => `第 ${i + 1} 项：需要核验项目交付、收入确认和现金回款。`).join('\n') })
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-')
    const report = await inspectPdf(buffer)
    expect(report.format).toBe('pdf')
    expect(report.summary.pages).toBeGreaterThan(1)
    expect(report.content).toContain('星澜科技经营分析')
    expect(report.content).toContain('收入 120000 元')
    expect(report.content).toContain('第 85 项')
    expect(report.content).toContain('Aether')
    expect(report.summary.previewTruncated).toBe(false)
  })

  it('fails explicitly without a CJK font and still supports an ASCII document', async () => {
    const exists = vi.spyOn(fs, 'existsSync').mockReturnValue(false)
    try { await expect(createPdf({ markdown: '中文报告' })).rejects.toThrow('CJK_FONT_UNAVAILABLE') }
    finally { exists.mockRestore() }
    const report = await inspectPdf(await createPdf({ markdown: 'Quarterly report: 42 approved items.' }))
    expect(report.content).toContain('42 approved items.')
  })

  it('rejects invalid, empty and oversized sources before publishing anything', async () => {
    await expect(createPdf({ markdown: ' ' })).rejects.toThrow('正文为空')
    await expect(createPdf({ markdown: 'a'.repeat(256 * 1024 + 1) })).rejects.toThrow('markdown')
    await expect(createPdf({ markdown: 'invalid\u0000text' })).rejects.toThrow('markdown')
    await expect(inspectPdf(Buffer.from('pretend PDF'))).rejects.toThrow('无效 PDF')
  })

  it('lays out real multi-column tables and repeats the header on each page', async () => {
    const rows = Array.from({ length: 90 }, (_, index) => `| 项目 ${index + 1} | 运营部 | ${1000 + index} |`)
    const report = await inspectPdf(await createPdf({ title: '分页财务表', markdown: '| 项目名称 | 责任部门 | 已批准金额 |\n| --- | --- | ---: |\n' + rows.join('\n') }))
    expect(report.summary.pages).toBeGreaterThan(1)
    expect(report.content).toContain('项目 90')
    expect(report.content).toContain('1089')
    expect(report.content.match(/已批准金额/g)?.length).toBe(report.summary.pages)
    expect(report.content).not.toContain('|')
    expect(report.content).not.toContain('---')
    await expect(createPdf({ markdown: '| 一 | 二 |\n| --- | --- |\n| 只有一列 |' })).rejects.toThrow('列数')
    await expect(createPdf({ markdown: '| 一 | 二 |\n| --- | --- |\n| ' + '长'.repeat(501) + ' | 数据 |' })).rejects.toThrow('500')
  })
})

const presentation = () => createPptx({ title: '经营评审', author: '星澜科技', slides: [
  { title: '经营评审第一版', bullets: ['收入与回款需要分别核验', '本季度形成五项行动'], notes: '仅使用合成业务数据。' },
  { title: '行动清单', table: { headers: ['事项', '负责人', '预算'], rows: [['交付验收', '运营', 3000], ['合同复核', '法务', 5000]] } },
] })

describe('native PPTX office delivery', () => {
  it('creates real editable Chinese text, tables and notes and inspects actual ordered source', async () => {
    const buffer = await presentation(), pkg = readOfficeZip(buffer), result = await inspectPptx(buffer)
    expect(result.summary.slides).toBe(2)
    expect(result.content.indexOf('经营评审第一版')).toBeLessThan(result.content.indexOf('行动清单'))
    expect(result.content).toContain('交付验收')
    expect(result.content).toContain('5000')
    expect(Object.keys(pkg)).toContain('ppt/notesSlides/notesSlide1.xml')
    expect(Buffer.from(pkg['ppt/notesSlides/notesSlide1.xml']).toString()).toContain('仅使用合成业务数据')
    expect(result.warnings.join('')).toContain('未提取')
  })

  it('honors presentation relationships when display order differs from ZIP filename order', async () => {
    const pkg = readOfficeZip(await presentation())
    const original = Buffer.from(pkg['ppt/presentation.xml']).toString()
    const ids = original.match(/<p:sldId\b[^>]*\/>/g)!
    expect(ids).toHaveLength(2)
    pkg['ppt/presentation.xml'] = Buffer.from(original.replace(ids.join(''), [...ids].reverse().join('')))
    const result = await inspectPptx(writeOfficeZip(pkg))
    expect(result.content.indexOf('行动清单')).toBeLessThan(result.content.indexOf('经营评审第一版'))
  })

  it('edits a unique text run and preserves all other uncompressed package parts', async () => {
    const original = await presentation(), before = readOfficeZip(original)
    const changed = await editPptx(original, [
      { oldText: '经营评审第一版', newText: '经营评审修订版' },
      { oldText: '本季度形成五项行动', newText: '本季度形成六项行动' },
    ])
    const after = readOfficeZip(changed), result = await inspectPptx(changed)
    expect(result.content).toContain('经营评审修订版')
    expect(result.content).toContain('本季度形成六项行动')
    expect(result.content).not.toContain('经营评审第一版')
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort())
    for (const name of Object.keys(before)) if (name !== 'ppt/slides/slide1.xml') expect(after[name], name).toEqual(before[name])
    expect((await inspectPptx(original)).content).toContain('经营评审第一版')
  })

  it('rejects ambiguous, missing, split-format or field matches instead of guessing', async () => {
    const buffer = await presentation()
    await expect(editPptx(buffer, [{ oldText: '不存在', newText: '新内容' }])).rejects.toThrow('唯一匹配')
    await expect(editPptx(buffer, [{ oldText: 'Aether', newText: 'Other' }])).rejects.toThrow('唯一匹配')
    const pkg = readOfficeZip(buffer)
    const xml = Buffer.from(pkg['ppt/slides/slide1.xml']).toString()
    pkg['ppt/slides/slide1.xml'] = Buffer.from(xml.replace('<a:t>经营评审第一版</a:t>', '<a:t>经营评审</a:t></a:r><a:r><a:t>第一版</a:t>'))
    await expect(editPptx(writeOfficeZip(pkg), [{ oldText: '经营评审第一版', newText: '修订' }])).rejects.toThrow('唯一匹配')
    pkg['ppt/slides/slide1.xml'] = Buffer.from(xml.replace(/<a:r><a:rPr([^]*?)<a:t>经营评审第一版<\/a:t><\/a:r>/,
      '<a:fld id="field" type="slidenum"><a:t>经营评审第一版</a:t></a:fld>'))
    await expect(editPptx(writeOfficeZip(pkg), [{ oldText: '经营评审第一版', newText: '修订' }])).rejects.toThrow('字段')
  })

  it('locates an overflowing table cell and distinguishes forbidden line breaks', async () => {
    await expect(createPptx({ slides: [{ title: '正常页' }, { title: '预算',
      table: { headers: ['项目', '说明'], rows: [['物料', '长'.repeat(26)]] } }] })).rejects.toThrow('第 2 页表格第 2 行第 2 列（表头为第 1 行）内容过长：宽度 52/50')
    await expect(createPptx({ slides: [{ title: '预算',
      table: { headers: ['项目\n名称', '说明'], rows: [['物料', '短']] } }] })).rejects.toThrow('第 1 页表格第 1 行第 1 列（表头为第 1 行）不支持换行')
  })

  it.each<{ name: string; slide: PptxSlide; message: string }>([
    { name: 'plain slide bullet count', slide: { title: '要点', bullets: Array(7).fill('item') }, message: '第 3 页要点数量 7/6，最多 6 条' },
    { name: 'table slide bullet count', slide: { title: '表格', bullets: ['一', '二', '三'], table: { headers: ['项目'], rows: [['值']] } }, message: '第 3 页含表格，要点数量 3/2，最多 2 条' },
    { name: 'second bullet width', slide: { title: '要点', bullets: ['正常', '宽'.repeat(71)] }, message: '第 3 页第 2 条要点过长：宽度 142/140' },
    { name: 'second bullet newline', slide: { title: '要点', bullets: ['正常', '需\n拆分'] }, message: '第 3 页第 2 条要点不支持换行' },
    { name: 'second bullet character limit', slide: { title: '要点', bullets: ['正常', 'a'.repeat(161)] }, message: '第 3 页第 2 条要点 文本为空或超过 160 字符' },
    { name: 'title width', slide: { title: '宽'.repeat(48) }, message: '第 3 页标题过长：宽度 96/94' },
    { name: 'title newline', slide: { title: '需\n拆分' }, message: '第 3 页标题不支持换行' },
    { name: 'table columns', slide: { title: '表格', table: { headers: Array(7).fill('列'), rows: [] } }, message: '第 3 页表格列数 7/6，需要 1–6 列' },
    { name: 'table without columns', slide: { title: '表格', table: { headers: [], rows: [] } }, message: '第 3 页表格列数 0/6，需要 1–6 列' },
    { name: 'plain table rows', slide: { title: '表格', table: { headers: ['列'], rows: Array.from({ length: 9 }, () => ['值']) } }, message: '第 3 页表格数据行数 9/8，最多 8 行（不含表头）' },
    { name: 'table with bullets rows', slide: { title: '表格', bullets: ['要点'], table: { headers: ['列'], rows: Array.from({ length: 6 }, () => ['值']) } }, message: '第 3 页表格含要点，数据行数 6/5，最多 5 行（不含表头）' },
    { name: 'second data row columns', slide: { title: '表格', table: { headers: ['一', '二'], rows: [[1, 2], [3]] } }, message: '第 3 页表格第 3 行（表头为第 1 行）单元格数量 1/2，必须与表头一致' },
    { name: 'slide notes', slide: { title: '备注', notes: 'a'.repeat(4001) }, message: '第 3 页备注 notes 文本为空或超过 4000 字符' },
  ])('locates $name on a later slide without echoing the presentation', async ({ slide, message }) => {
    await expect(createPptx({ slides: [{ title: '正常第一页' }, { title: '正常第二页' }, slide] })).rejects.toThrow(message)
  })

  it('keeps exact layout limits valid without truncating text or table rows', async () => {
    const title = 'A'.repeat(94), bullet = 'B'.repeat(140), cell = 'C'.repeat(16)
    const result = await inspectPptx(await createPptx({ slides: [
      { title, bullets: Array(6).fill(bullet) },
      { title: '含要点表格', bullets: ['要点一', '要点二'], table: { headers: Array(6).fill(cell), rows: Array.from({ length: 5 }, () => Array(6).fill(cell)) } },
      { title: '纯表格', table: { headers: ['列'], rows: Array.from({ length: 8 }, (_, index) => [`保留第${index + 1}行`]) } },
    ] }))
    expect(result.summary.slides).toBe(3)
    expect(result.content).toContain(title)
    expect(result.content.match(new RegExp(bullet, 'g'))).toHaveLength(6)
    expect(result.content).toContain(cell)
    expect(result.content).toContain('保留第8行')
  })

  it('rejects layout overloads, malformed rows and corrupted slide relationships', async () => {
    await expect(createPptx({ slides: [{ title: 'Too much', bullets: Array(7).fill('item') }] })).rejects.toThrow('最多 6')
    await expect(createPptx({ slides: [{ title: 'Invalid', table: { headers: ['一', '二'], rows: [[1]] } }] })).rejects.toThrow('数量')
    await expect(createPptx({ slides: [{ title: 'Overload', table: { headers: ['一', '二'], rows: [['长'.repeat(80), 2]] } }] })).rejects.toThrow('过长')
    const pkg = readOfficeZip(await presentation())
    pkg['ppt/_rels/presentation.xml.rels'] = Buffer.from(Buffer.from(pkg['ppt/_rels/presentation.xml.rels']).toString().replace('Target="slides/slide1.xml"', 'Target="../../outside.xml"'))
    await expect(inspectPptx(writeOfficeZip(pkg))).rejects.toThrow('幻灯片路径')
  })
})
