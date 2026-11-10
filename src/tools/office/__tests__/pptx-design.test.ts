// Fresh coverage for the content-driven PPTX pipeline: native objects, all
// layouts, image scope, density errors and atomic create-only publication.
import fs from 'node:fs'
import path from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext } from '../../../core/agent-context/index.js'
import * as database from '../../../storage/sqlite/db.js'
import { ChangeStore } from '../../../storage/changes/index.js'
import { clearSecurityMode, setSecurityMode } from '../../../security/policy-engine.js'
import { createPptx, editPptx, inspectPptx, type PptxInput } from '../pptx.js'
import { inspectPptxImage } from '../pptx-design.js'
import { presentationSchema } from '../pptx-schema.js'
import { readOfficeZip } from '../office-zip.js'
import { officeDocumentTool } from '../index.js'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=', 'base64')
const assetPath = 'assets/diagram.png'
const fixture: PptxInput = { title: 'Design verification', slides: [
  { title: 'Design verification', layout: 'cover', subtitle: 'Synthetic test content' },
  { title: 'Evidence', layout: 'section', subtitle: 'Native and editable' },
  { title: 'Key points', layout: 'bullets', bullets: ['First point', 'Second point'] },
  { title: 'Comparison', layout: 'columns', columns: [{ title: 'Before', body: 'Repeated one-column composition.' }, { title: 'After', body: 'Content determines page structure.' }] },
  { title: 'Image evidence', layout: 'image', image: { path: assetPath, fit: 'contain', caption: 'A test pixel, not a customer asset.' } },
  { title: 'Synthetic values', layout: 'chart', chart: { type: 'bar', categories: ['Alpha', 'Beta'], series: [{ name: 'Sample', values: [3, 7] }] } },
  { title: 'Native table', layout: 'table', table: { headers: ['Item', 'Value'], rows: [['Row A', 3], ['Row B', 7]] } },
  { title: 'A quotation', layout: 'quote', quote: { text: 'Clarity follows the content.', attribution: 'Synthetic quote' } },
  { title: 'Plan', layout: 'timeline', steps: [{ title: 'Prepare', body: 'Gather evidence.' }, { title: 'Review', body: 'Render every slide.' }, { title: 'Deliver', body: 'Retain editability.' }] },
  { title: 'Custom metadata', layout: 'custom', elements: [
    { type: 'shape', shape: 'rect', x: 0.5, y: 0.5, w: 5, h: 5, fill: '123456' },
    { type: 'text', text: 'A custom composition', x: 0.8, y: 0.8, w: 4.4, h: 2, fontSize: 28, color: 'FFFFFF' },
    { type: 'image', path: assetPath, x: 7, y: 1, w: 3, h: 4, fit: 'cover' },
  ], notes: 'Speaker evidence' },
] }
const xml = (entries: Record<string, Uint8Array>, name: string) => Buffer.from(entries[name]).toString('utf8')
const emu = 914400
function textBox(slide: string, text: string) {
  const shape = [...slide.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)].map(match => match[0]).find(shape => shape.includes(`<a:t>${text}</a:t>`))
  if (!shape) throw new Error(`Missing text shape: ${text}`)
  const offset = shape.match(/<a:off x="(\d+)" y="(\d+)"/), size = shape.match(/<a:ext cx="(\d+)" cy="(\d+)"/)
  if (!offset || !size) throw new Error(`Missing native geometry: ${text}`)
  return { x: +offset[1] / emu, y: +offset[2] / emu, w: +size[1] / emu, h: +size[2] / emu, shape }
}

describe('content-driven PPTX design', () => {
  it('produces ten distinct layouts with real media, editable native chart/table and no forced branding', async () => {
    const bytes = await createPptx(fixture, new Map([[assetPath, png]]))
    const entries = readOfficeZip(bytes), inspected = await inspectPptx(bytes)
    expect(inspected.summary.slides).toBe(10)
    expect(inspected.content).toContain('A custom composition')
    expect(inspected.content).toContain('Speaker evidence')
    expect(inspected.content).not.toContain('Custom metadata')
    expect(inspected.content).not.toContain('Aether')
    expect(xml(entries, 'ppt/slides/slide1.xml')).toContain('sz="4200"')
    expect(xml(entries, 'ppt/slides/slide2.xml')).toContain('<a:srgbClr val="202322"')
    expect(xml(entries, 'ppt/slides/slide4.xml')).toContain('After')
    expect(xml(entries, 'ppt/slides/slide7.xml')).toContain('<a:tbl>')
    expect(xml(entries, 'ppt/slides/slide7.xml')).toContain('Row B')
    expect(xml(entries, 'ppt/slides/slide6.xml')).toContain('<c:chart')
    const chartPart = Object.keys(entries).find(name => /^ppt\/charts\/chart\d+\.xml$/.test(name))!
    expect(xml(entries, chartPart)).toContain('<c:barChart>')
    expect(xml(entries, chartPart)).toContain('<c:v>7</c:v>')
    expect(Object.keys(entries).filter(name => name.startsWith('ppt/embeddings/') && name.endsWith('.xlsx'))).toHaveLength(1)
    const media = Object.entries(entries).filter(([name]) => /^ppt\/media\/.*\.png$/.test(name))
    expect(media.length).toBeGreaterThan(0)
    expect(media.every(([, bytes]) => Buffer.from(bytes).equals(png))).toBe(true)
    expect(xml(entries, 'ppt/slides/slide10.xml')).toContain('123456')
    const changed = await editPptx(bytes, [{ oldText: 'Row A', newText: 'Row C' }]), changedEntries = readOfficeZip(changed)
    expect((await inspectPptx(changed)).content).toContain('Row C')
    expect(changedEntries[chartPart]).toEqual(entries[chartPart])
    expect(changedEntries['ppt/slides/slide10.xml']).toEqual(entries['ppt/slides/slide10.xml'])
  })

  it('routes legacy fields through the same auto design and honors explicit palette/footer', async () => {
    const bytes = await createPptx({ theme: { background: '101010', foreground: 'EEEEEE', accent: '22CC88', muted: 'BBBBBB', footer: 'User brand', pageNumbers: true }, slides: [
      { title: 'Opening' }, { title: 'Transition' }, { title: 'Details', bullets: ['An editable point'] },
      { title: 'Data', table: { headers: ['Fact'], rows: [['Verified']] } },
    ] })
    const entries = readOfficeZip(bytes), inspection = await inspectPptx(bytes)
    expect(inspection.content).toContain('User brand')
    expect(inspection.content).toContain('4 / 4')
    expect(xml(entries, 'ppt/slides/slide1.xml')).toContain('22CC88')
    expect(xml(entries, 'ppt/slides/slide2.xml')).toContain('<a:srgbClr val="EEEEEE"')
    expect(xml(entries, 'ppt/slides/slide4.xml')).toContain('<a:tbl>')
    expect(presentationSchema.safeParse({ theme: { preset: 'classic' }, slides: [{ title: 'No fallback' }] }).success).toBe(false)
  })

  it('preserves line and pie data as native chart parts', async () => {
    const bytes = await createPptx({ slides: [
      { title: 'Trend', chart: { type: 'line', categories: ['A', 'B'], series: [{ name: 'One', values: [-2, 4] }, { name: 'Two', values: [2, 8] }] } },
      { title: 'Share', chart: { type: 'pie', categories: ['A', 'B'], series: [{ name: 'Share', values: [2, 4] }] } },
    ] })
    const entries = readOfficeZip(bytes)
    const charts = Object.keys(entries).filter(name => /^ppt\/charts\/chart\d+\.xml$/.test(name)).map(name => xml(entries, name))
    expect(charts).toHaveLength(2)
    expect(charts.some(content => content.includes('<c:lineChart>') && content.includes('<c:v>-2</c:v>'))).toBe(true)
    expect(charts.some(content => content.includes('<c:pieChart>'))).toBe(true)
  })

  it('centers contain images in true aspect-ratio boxes and retains cover cropping without changing media', async () => {
    const entries = readOfficeZip(await createPptx({ slides: [
      { title: 'Contained', layout: 'custom', elements: [{ type: 'image', path: assetPath, x: 1, y: 1, w: 6, h: 4, fit: 'contain' }] },
      { title: 'Covered', layout: 'custom', elements: [{ type: 'image', path: assetPath, x: 1, y: 1, w: 6, h: 4, fit: 'cover' }] },
    ] }, new Map([[assetPath, png]])))
    const contain = xml(entries, 'ppt/slides/slide1.xml'), cover = xml(entries, 'ppt/slides/slide2.xml')
    expect(contain).not.toContain('<a:srcRect')
    expect(contain).toContain('<a:off x="1828800" y="914400"/>')
    expect(contain).toContain('<a:ext cx="3657600" cy="3657600"/>')
    expect(cover).toContain('<a:off x="914400" y="914400"/>')
    expect(cover).toContain('<a:ext cx="5486400" cy="3657600"/>')
    expect(cover).toMatch(/<a:srcRect[^>]*t="16667"[^>]*b="16667"/)
    const media = Object.entries(entries).filter(([name]) => /^ppt\/media\/.*\.png$/.test(name))
    expect(media).toHaveLength(2)
    expect(media.every(([, data]) => Buffer.from(data).equals(png))).toBe(true)
  })

  it('uses a visible one-point timeline connector while preserving explicit custom line shapes', async () => {
    const entries = readOfficeZip(await createPptx({ slides: [
      { title: 'Timeline', steps: [{ title: 'Prepare' }, { title: 'Deliver' }] },
      { title: 'Custom line', layout: 'custom', elements: [{ type: 'shape', shape: 'line', x: 1, y: 1, w: 6, h: 0.02 }] },
    ] }))
    const timeline = xml(entries, 'ppt/slides/slide1.xml')
    expect(timeline).toMatch(/<a:ext cx="\d+" cy="12700"\/>[\s\S]*?<a:prstGeom prst="rect"/)
    expect(timeline).not.toContain('prst="line"')
    expect(xml(entries, 'ppt/slides/slide2.xml')).toContain('prst="line"')
  })

  it('keeps Chinese column headings and body aligned with a short semantic gap instead of a fixed empty band', async () => {
    const columns = [
      { title: '四套主题', body: '午夜、白昼、霓虹、海盐。切换主题会记住选择。' },
      { title: '触屏与鼠标的完整操作方式', body: '在棋盘上滑动即可移动。按钮提供悔棋与新游戏。' },
      { title: '存档', body: '进度与最高分保存在当前浏览器。' },
    ]
    const slide = xml(readOfficeZip(await createPptx({ slides: [{ title: '操作与主题', columns }] })), 'ppt/slides/slide1.xml')
    const headings = columns.map(column => textBox(slide, column.title)), bodies = columns.map(column => textBox(slide, column.body))
    expect(textBox(slide, '操作与主题').shape).toContain('sz="3200"')
    expect(headings[1].h).toBeGreaterThan(0.8)
    expect(new Set(headings.map(box => box.y)).size).toBe(1)
    expect(new Set(bodies.map(box => box.y)).size).toBe(1)
    for (let i = 0; i < headings.length; i++) {
      expect(bodies[i].x).toBeCloseTo(headings[i].x, 5)
      expect(bodies[i].y - headings[i].y - headings[i].h).toBeCloseTo(0.25, 5)
      expect(bodies[i].shape).toContain('sz="1900"')
    }
    expect(slide.match(/<p:sp>/g)).toHaveLength(7)
  })

  it('spaces a mixed-length Chinese list by actual wrapped height and moves content below a two-line title', async () => {
    const title = '键盘触屏与主题操作说明以及自动存档的适用范围和数据保存边界', bullets = [
      '方向键或 W A S D 移动。',
      '进度与最高分保存在当前浏览器。换浏览器、使用其他设备或者清空浏览器缓存后，原来的游戏进度不会自动同步，需要重新开始。',
      '按 Z 悔棋，按 R 开始新游戏。',
    ]
    const slide = xml(readOfficeZip(await createPptx({ slides: [{ title, bullets }] })), 'ppt/slides/slide1.xml')
    const heading = textBox(slide, title), boxes = bullets.map(bullet => textBox(slide, bullet))
    expect(heading.h).toBeGreaterThan(1)
    expect(boxes[0].y - heading.y - heading.h).toBeCloseTo(0.42, 5)
    expect(boxes[1].h).toBeGreaterThan(boxes[0].h * 1.8)
    for (let i = 1; i < boxes.length; i++) expect(boxes[i].y - boxes[i - 1].y - boxes[i - 1].h).toBeCloseTo(0.3, 5)
    expect(boxes.at(-1)!.y + boxes.at(-1)!.h).toBeLessThan(5.5)
    expect(slide).not.toContain('<a:normAutofit')
  })

  it('combines explanatory text, images and positioned native chart/table evidence on one custom page', async () => {
    const entries = readOfficeZip(await createPptx({ theme: { pageNumbers: true }, slides: [{ title: 'Metadata only', layout: 'custom', elements: [
      { type: 'text', text: '规则测试覆盖', x: 0.7, y: 0.5, w: 7, h: 0.8, fontSize: 32, bold: true },
      { type: 'chart', x: 0.7, y: 1.6, w: 7, h: 4.7, chart: { type: 'bar', categories: ['规则', '交互'], series: [{ name: '用例', values: [18, 47] }] } },
      { type: 'table', x: 8.1, y: 1.6, w: 4.5, h: 3.5, table: { headers: ['类型', '数量'], rows: [['规则', 18], ['交互', 47]], colWidths: [1, 2] } },
      { type: 'image', path: assetPath, x: 8.1, y: 5.3, w: 1, h: 1 },
      { type: 'text', text: '数量来自项目记录', x: 9.3, y: 5.3, w: 3.2, h: 0.8, fontSize: 17 },
    ] }] }, new Map([[assetPath, png]])))
    const slide = xml(entries, 'ppt/slides/slide1.xml')
    expect(slide).toContain('<c:chart')
    expect(slide).toContain('<a:tbl>')
    expect(slide).toContain('<p:pic>')
    expect(slide).not.toContain('Metadata only')
    expect(slide).not.toContain('1 / 1')
    expect(slide).toContain('<a:off x="640080" y="1463040"/>')
    expect(slide).toContain('<a:off x="7406640" y="1463040"/>')
    expect(slide).toContain('<a:ext cx="6400800" cy="4297680"/>')
    const widths = [...slide.matchAll(/<a:gridCol w="(\d+)"/g)].map(match => +match[1])
    expect(widths).toEqual([1371600, 2743200])
    const chartPart = Object.keys(entries).find(name => /^ppt\/charts\/chart\d+\.xml$/.test(name))!
    expect(xml(entries, chartPart)).toContain('<c:v>47</c:v>')
    expect(Object.keys(entries).some(name => /^ppt\/embeddings\/.*\.xlsx$/.test(name))).toBe(true)
  })

  it('inherits page backgrounds, honors explicit overrides and keeps section/custom text legible without fake background rectangles', async () => {
    const entries = readOfficeZip(await createPptx({ theme: { background: 'FAF9F6', foreground: '202322' }, slides: [
      { title: '浅色封面', layout: 'cover' },
      { title: '默认章节', layout: 'section' },
      { title: '浅色章节', layout: 'section', background: 'FFFFFF' },
      { title: '深色元信息', background: '101820', elements: [{ type: 'text', text: '深色正文', x: 1, y: 1, w: 5, h: 1 }] },
    ] }))
    const slides = [1, 2, 3, 4].map(page => xml(entries, `ppt/slides/slide${page}.xml`))
    for (const [index, color] of ['FAF9F6', '202322', 'FFFFFF', '101820'].entries()) expect(slides[index]).toContain(`<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${color}"`)
    expect(textBox(slides[1], '默认章节').shape).toContain('<a:srgbClr val="FAF9F6"')
    expect(textBox(slides[2], '浅色章节').shape).toContain('<a:srgbClr val="202322"')
    expect(textBox(slides[3], '深色正文').shape).toContain('<a:srgbClr val="FAF9F6"')
    expect(slides[3].match(/<p:sp>/g)).toHaveLength(1)
    expect(slides[3]).not.toContain('深色元信息')
  })

  it('uses relative native table columns, readable type and content-sized rows with horizontal rules', async () => {
    const entries = readOfficeZip(await createPptx({ slides: [{ title: '文件职责', table: {
      headers: ['分层', '职责'], colWidths: [1, 3], rows: [
        ['规则', '滑动与合并'],
        ['表现', '渲染模块负责棋盘节点的复用和动画处理，音效模块使用 WebAudio 合成声音，不加载外部音频文件。'],
      ],
    } }] }))
    const slide = xml(entries, 'ppt/slides/slide1.xml'), widths = [...slide.matchAll(/<a:gridCol w="(\d+)"/g)].map(match => +match[1])
    expect(widths[1] / widths[0]).toBeCloseTo(3, 5)
    expect(widths.reduce((sum, value) => sum + value, 0) / emu).toBeCloseTo(11.83, 5)
    const heights = [...slide.matchAll(/<a:tr h="(\d+)"/g)].map(match => +match[1])
    expect(heights).toHaveLength(3)
    expect(heights[2]).toBeGreaterThan(heights[1])
    expect(slide).toContain('sz="1700"')
    expect(slide).toMatch(/<a:lnL[^>]*><a:noFill\/>/)
    expect(slide).toMatch(/<a:lnR[^>]*><a:noFill\/>/)
    expect(slide).toMatch(/<a:lnB[^>]*><a:solidFill>/)
  })

  // These are the unchanged table payloads from the 2026-11-10 Work session.
  // The model could only see page three's error, then shortened both rows and
  // their box, while the second failing table remained hidden until a retry.
  const recordedTables: PptxInput = { slides: [
    { title: '操作', layout: 'custom', elements: [{ type: 'table', x: 0.8, y: 2.05, w: 6.3, h: 3.5, table: {
      headers: ['操作', '键盘', '触屏 / 鼠标'], colWidths: [1.3, 2.5, 2.5], rows: [
        ['移动', '↑ ↓ ← → 或 W A S D', '在棋盘上朝任意方向滑动'],
        ['悔棋', 'Z', '点「悔棋」'], ['新游戏', 'R', '点「新游戏」'], ['静音', 'M', '点「音效」'], ['换主题', 'T', '点主题色板'],
      ],
    } }] },
    { title: '覆盖', layout: 'custom', elements: [{ type: 'table', x: 0.8, y: 3.55, w: 11.7, h: 2.3, table: {
      headers: ['层级', '方式', '覆盖'], colWidths: [1.8, 3.6, 6.3], rows: [
        ['规则与状态', 'node:test 直接跑，无需浏览器', '滑动合并边界、四个方向、无变化回滚、判死、悔棋、存档往返与损坏容错'],
        ['端到端', '无头 Chrome + CDP 驱动真实页面', '开局渲染、计分、胜负面板、刷新恢复、手机竖屏不溢出、四套主题与主题记忆、重开确认'],
        ['视觉', '按主题与手机尺寸截图，不做断言', '四套主题桌面图 + 四种手机尺寸，供人工看图'],
      ],
    } }] },
  ] }

  it('reports all recorded overflowing tables with precise repair paths and dimensions in one preflight', async () => {
    const original = structuredClone(recordedTables)
    const error = await createPptx(recordedTables).catch(error => error as Error)
    expect(error).toBeInstanceOf(Error)
    const message = (error as Error).message
    expect(message).toContain('表格预检发现 2 处容量不足')
    expect(message).toContain('presentation.slides.0.elements.0.table: 表格超出布局容量，17pt、含表头 6 行，需 h=3.754，当前 h=3.500，差 0.254 英寸')
    expect(message).toContain('presentation.slides.1.elements.0.table: 表格超出布局容量，17pt、含表头 4 行，需 h=3.142，当前 h=2.300，差 0.842 英寸')
    expect(message).toContain('presentation.slides.0.elements.0.h 至少设为 3.754')
    expect(message).toContain('presentation.slides.1.elements.0.h 至少设为 3.142')
    expect(message).toContain('实际列宽 [1.300, 2.500, 2.500]')
    expect(message).toContain('presentation.slides.0.elements.0.table.rows.0.1')
    expect(message).toContain('增高前须核对相邻元素与画布边界')
    expect(recordedTables).toEqual(original)
  })

  it('repairs the recorded tables by changing only available height and retains every editable cell at 17pt', async () => {
    const repaired = structuredClone(recordedTables)
    repaired.slides[0].elements![0].h = 3.754
    repaired.slides[1].elements![0].h = 3.142
    const bytes = await createPptx(repaired), entries = readOfficeZip(bytes)
    for (const [index, source] of repaired.slides.entries()) {
      const element = source.elements![0]
      if (element.type !== 'table') throw new Error('Missing recorded native table')
      const slide = xml(entries, `ppt/slides/slide${index + 1}.xml`)
      expect(slide.match(/<a:tr h=/g)).toHaveLength(element.table.rows.length + 1)
      for (const value of [element.table.headers, ...element.table.rows].flat()) expect(slide).toContain(`<a:t>${value}</a:t>`)
      expect(slide).toContain('sz="1700"')
      expect(slide).not.toContain('<a:normAutofit')
      const height = [...slide.matchAll(/<a:tr h="(\d+)"/g)].reduce((sum, match) => sum + +match[1] / emu, 0)
      expect(height).toBeLessThanOrEqual(element.h + 0.0001)
    }
  })

  it('still rejects the recorded reduced rows when the model also shrinks the table box', async () => {
    await expect(createPptx({ slides: [{ title: '重试', elements: [{ type: 'table', x: 0.8, y: 2.1, w: 7, h: 2.2, table: {
      headers: ['操作', '键盘', '触屏 / 鼠标'], colWidths: [1.8, 2.3, 2.9], rows: [
        ['移动', '方向键 / WASD', '朝任意方向滑动'], ['悔棋 / 新游戏', 'Z / R', '点「悔棋」「新游戏」'], ['静音 / 换主题', 'M / T', '点「音效」或主题色板'],
      ],
    } }] }] })).rejects.toThrow('需 h=2.868，当前 h=2.200，差 0.668 英寸')
  })

  it('bounds capacity diagnostics and does not recommend extending a table beyond the slide', async () => {
    const slides: PptxInput['slides'] = Array.from({ length: 10 }, () => ({ title: '边界', elements: [{ type: 'table', x: 1, y: 7, w: 8, h: 0.4, table: { headers: ['项目'], rows: [['完整保留']] } }] }))
    const error = await createPptx({ slides }).catch(error => error as Error), message = (error as Error).message
    expect(message).toContain('表格预检发现 10 处容量不足')
    expect(message).toContain('另有 2 处')
    expect(message).not.toContain('.h 至少设为')
    expect(message).not.toContain('presentation.slides.8.')
    expect(message.length).toBeLessThan(3000)
  })

  it.each([
    { title: 'Mismatched widths', table: { headers: ['A', 'B'], rows: [], colWidths: [1] } },
    { title: 'Too narrow', table: { headers: ['A', 'B'], rows: [], colWidths: [0.001, 100] } },
    { title: 'Too short', elements: [{ type: 'table', x: 1, y: 1, w: 8, h: 0.4, table: { headers: ['类型'], rows: [['必须完整显示']] } }] },
    { title: 'Off canvas chart', elements: [{ type: 'chart', x: 12, y: 1, w: 4, h: 3, chart: { type: 'line', categories: ['A'], series: [{ name: 'B', values: [1] }] } }] },
    { title: 'Wrong nested series', elements: [{ type: 'chart', x: 1, y: 1, w: 7, h: 4, chart: { type: 'bar', categories: ['A', 'B'], series: [{ name: 'C', values: [1] }] } }] },
  ] satisfies PptxInput['slides'])('rejects composition defects without shrinking or dropping native content: $title', async slide => {
    await expect(createPptx({ slides: [slide] })).rejects.toThrow('PPTX:')
  })

  it.each([
    { title: 'Wrong field', layout: 'cover', bullets: ['Would be lost'] },
    { title: 'Missing image', layout: 'image' },
    { title: 'Mixed', table: { headers: ['A'], rows: [] }, quote: { text: 'No silent drop' } },
    { title: 'Off canvas', layout: 'custom', elements: [{ type: 'text', x: 12, y: 1, w: 3, h: 1, text: 'Outside' }] },
    { title: 'Too dense', layout: 'custom', elements: [{ type: 'text', x: 1, y: 1, w: 1, h: 0.2, text: '这是一段不应该被静默截断或缩小的长文字。', fontSize: 28 }] },
    { title: 'Wrong series', chart: { type: 'bar', categories: ['A', 'B'], series: [{ name: 'One', values: [1] }] } },
    { title: 'Invalid pie', chart: { type: 'pie', categories: ['A'], series: [{ name: 'One', values: [-1] }] } },
    { title: 'Wrong columns', table: { headers: ['A', 'B'], rows: [['One']] } },
  ] satisfies PptxInput['slides'])('rejects incompatible or overflowing input: $title', async slide => {
    await expect(createPptx({ slides: [slide] })).rejects.toThrow('PPTX:')
  })

  it('requires validated binary images and rejects URLs and corrupt/oversized assets', async () => {
    await expect(createPptx({ slides: [{ title: 'Unresolved', image: { path: assetPath } }] })).rejects.toThrow('未通过工作区授权')
    expect(presentationSchema.safeParse({ slides: [{ title: 'Remote', image: { path: 'https://example.com/image.png' } }] }).success).toBe(false)
    expect(() => inspectPptxImage(Buffer.from('<svg/>'))).toThrow('PNG/JPEG')
    expect(() => inspectPptxImage(png.subarray(0, 40))).toThrow('PNG')
    const excessive = Buffer.from(png); excessive.writeUInt32BE(20000, 16)
    expect(() => inspectPptxImage(excessive)).toThrow('尺寸')
  })
})

describe('authorized PPTX image publication', () => {
  let root: string, ctx: AgentContext, db: Client, store: ChangeStore
  const base = path.resolve('.e2e-tmp')
  beforeEach(() => {
    fs.mkdirSync(base, { recursive: true }); root = fs.mkdtempSync(path.join(base, 'pptx-design-'))
    fs.mkdirSync(path.join(root, 'assets')); fs.writeFileSync(path.join(root, assetPath), png)
    vi.stubEnv('AUTH_ENABLED', 'false'); vi.stubEnv('DATA_DIR', path.join(root, 'data'))
    db = createClient({ url: 'file::memory:' }); vi.spyOn(database, 'getDb').mockReturnValue(db); store = new ChangeStore()
    ctx = { tenantId: 'pptx-design', sessionId: path.basename(root), rootSessionId: path.basename(root), rootRunId: 'design', turnId: 'design',
      workspacePaths: [root], projectRoot: root, cwd: root, scratchDir: path.join(root, 'scratch'), logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as unknown as AgentContext
    setSecurityMode(ctx.tenantId, ctx.sessionId, 'safe')
  })
  afterEach(() => {
    clearSecurityMode(ctx.tenantId, ctx.sessionId); db.close(); vi.restoreAllMocks(); vi.unstubAllEnvs()
    if (path.dirname(path.resolve(root)) !== base || !path.basename(root).startsWith('pptx-design-')) throw new Error('Unsafe fixture cleanup')
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 })
  })
  it('embeds authorized workspace bytes, refuses overwrites and records one rollback snapshot', async () => {
    const args = { operation: 'create', path: 'designed.pptx', expectedHash: 'missing', presentation: { slides: [{ title: 'Asset', image: { path: assetPath } }] } }
    const created = await officeDocumentTool.execute(args, ctx)
    expect(created).toMatchObject({ success: true, metadata: { format: 'pptx', rollbackAvailable: true, visualValidation: 'not-performed' } })
    const bytes = fs.readFileSync(path.join(root, 'designed.pptx'))
    expect(Object.entries(readOfficeZip(bytes)).filter(([name]) => name.startsWith('ppt/media/')).some(([, data]) => Buffer.from(data).equals(png))).toBe(true)
    expect(await officeDocumentTool.execute(args, ctx)).toMatchObject({ success: false, error: 'OFFICE_VERSION_CONFLICT' })
    expect(fs.readFileSync(path.join(root, 'designed.pptx'))).toEqual(bytes)
    expect(await store.list(ctx.tenantId, ctx.sessionId)).toHaveLength(1)
  })
  it('refuses unauthorized paths and fake images before publishing a document or snapshot', async () => {
    fs.writeFileSync(path.join(root, 'assets', 'fake.png'), 'not an image')
    for (const file of ['../outside.png', 'assets/fake.png', 'assets']) {
      const result = await officeDocumentTool.execute({ operation: 'create', path: 'rejected.pptx', expectedHash: 'missing', presentation: { slides: [{ title: 'Rejected', image: { path: file } }] } }, ctx)
      expect(result).toMatchObject({ success: false, metadata: { fileMutationApplied: false } })
      expect(fs.existsSync(path.join(root, 'rejected.pptx'))).toBe(false)
    }
    expect(await store.list(ctx.tenantId, ctx.sessionId)).toHaveLength(0)
  })
})
