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
