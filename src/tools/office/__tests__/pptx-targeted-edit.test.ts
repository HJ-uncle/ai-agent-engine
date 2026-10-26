/** Inspect-discovered PPTX locators, single-node preservation and versioned publication fences. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext } from '../../../core/agent-context/index.js'
import { hashFileContent } from '../../../shared/file-version.js'
import * as database from '../../../storage/sqlite/db.js'
import { ChangeStore } from '../../../storage/changes/index.js'
import { clearSecurityMode, setSecurityMode } from '../../../security/policy-engine.js'
import { officeDocumentTool, officeInspectTool } from '../index.js'
import { createDocx } from '../docx.js'
import { createPptx, editPptx, inspectPptx } from '../pptx.js'
import { readOfficeZip, writeOfficeZip } from '../office-zip.js'

const deck = () => createPptx({ slides: [
  { title: 'Sales review', bullets: ['Synthetic business evidence'] },
  { title: 'Revenue', table: { headers: ['Metric', 'Amount'], rows: [['Signed', 127200], ['Forecast', 127200]] } },
  { title: 'Cash', bullets: ['127200'], notes: 'Keep notes value 127200 unchanged.' },
] })
function locators(content: string) {
  return [...content.matchAll(/^\[slide=(\d+) textRun=(\d+) editable=(true|false)\]\n([^\n]*)/gm)]
    .map(match => ({ slide: Number(match[1]), textRun: Number(match[2]), editable: match[3] === 'true', text: match[4] }))
}
function replaceNode(xml: string, textRun: number, value: string): string {
  const node = [...xml.matchAll(/<a:t>[^<]*<\/a:t>/g)][textRun - 1]
  expect(node).toBeDefined()
  return xml.slice(0, node.index) + `<a:t>${value}</a:t>` + xml.slice(node.index! + node[0].length)
}

describe('PPTX inspected text-node targets', () => {
  it('changes only the selected duplicate number, retaining every other ZIP part and same-slide node', async () => {
    const original = await deck(), before = readOfficeZip(original)
    const report = await inspectPptx(original)
    const duplicates = locators(report.content).filter(run => run.slide === 2 && run.text === '127200')
    expect(duplicates).toHaveLength(2)
    const { slide, textRun } = duplicates[1]
    const changed = await editPptx(original, [{ slide, textRun, oldText: '127200', newText: '128400' }])
    const after = readOfficeZip(changed)
    expect(Buffer.from(after['ppt/slides/slide2.xml']).toString()).toBe(replaceNode(Buffer.from(before['ppt/slides/slide2.xml']).toString(), textRun, '128400'))
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort())
    for (const name of Object.keys(before)) if (name !== 'ppt/slides/slide2.xml') expect(after[name], name).toEqual(before[name])
    const values = locators((await inspectPptx(changed)).content)
    expect(values.filter(run => run.text === '127200')).toHaveLength(2)
    expect(values.filter(run => run.text === '128400')).toEqual([{ slide, textRun, editable: true, text: '128400' }])
    await expect(editPptx(original, [{ oldText: '127200', newText: 'unsafe' }])).rejects.toThrow('全部幻灯片')
  })

  it('uses displayed slide order and keeps local numbering stable across multiple edits', async () => {
    const parts = readOfficeZip(await deck()), presentation = Buffer.from(parts['ppt/presentation.xml']).toString()
    const ids = presentation.match(/<p:sldId\b[^>]*\/>/g)!
    parts['ppt/presentation.xml'] = Buffer.from(presentation.replace(ids.join(''), [...ids].reverse().join('')))
    const original = writeOfficeZip(parts), report = await inspectPptx(original)
    const target = locators(report.content).find(run => run.slide === 1 && run.text === '127200')!
    expect(target).toBeDefined()
    const changed = await editPptx(original, [
      { slide: 1, textRun: target.textRun, oldText: '127200', newText: '128400' },
      { slide: 1, textRun: target.textRun, oldText: '128400', newText: '129600' },
    ])
    const after = readOfficeZip(changed)
    expect(Buffer.from(after['ppt/slides/slide3.xml']).toString()).toContain('<a:t>129600</a:t>')
    for (const name of Object.keys(parts)) if (name !== 'ppt/slides/slide3.xml') expect(Buffer.from(after[name]), name).toEqual(Buffer.from(parts[name]))
  })

  it('still requires a unique oldText in the targeted ordinary node and rejects fields', async () => {
    const original = await createPptx({ slides: [{ title: '127200 / 127200', bullets: ['Safe body'] }] })
    await expect(editPptx(original, [{ slide: 1, textRun: 1, oldText: '127200', newText: '128400' }])).rejects.toThrow('指定 textRun 内唯一匹配')
    await expect(editPptx(original, [{ slide: 1, textRun: 2, oldText: '127200', newText: '128400' }])).rejects.toThrow('唯一匹配')
    const parts = readOfficeZip(original), xml = Buffer.from(parts['ppt/slides/slide1.xml']).toString()
    parts['ppt/slides/slide1.xml'] = Buffer.from(xml.replace(/<a:r><a:rPr[^]*?<a:t>127200 \/ 127200<\/a:t><\/a:r>/,
      '<a:fld id="field" type="slidenum"><a:t>127200</a:t></a:fld>'))
    const fieldDeck = writeOfficeZip(parts), fields = locators((await inspectPptx(fieldDeck)).content)
    expect(fields[0]).toEqual({ slide: 1, textRun: 1, editable: false, text: '127200' })
    expect(fields[1]).toMatchObject({ slide: 1, textRun: 2, editable: true, text: 'Safe body' })
    await expect(editPptx(fieldDeck, [{ slide: 1, textRun: 1, oldText: '127200', newText: '128400' }])).rejects.toThrow('字段')
  })

  it('bounds the marked preview and accurately declares truncation', async () => {
    const parts = readOfficeZip(await deck()), xml = Buffer.from(parts['ppt/slides/slide1.xml']).toString()
    parts['ppt/slides/slide1.xml'] = Buffer.from(xml.replace('<a:t>Sales review</a:t>', `<a:t>${'x'.repeat(120_010)}</a:t>`))
    const result = await inspectPptx(writeOfficeZip(parts))
    expect(result.content).toHaveLength(120_000)
    expect(result.summary).toMatchObject({ previewTruncated: true, editLocator: expect.stringContaining('1-based') })
    expect(result.content).toMatch(/^## 第 1 页\n\[slide=1 textRun=1 editable=true\]\n/)
    expect(result.warnings.join(' ')).toContain('截断')
  })
})

describe('PPTX target tool publication', () => {
  let root: string, db: Client, ctx: AgentContext, store: ChangeStore
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-pptx-target-'))
    vi.stubEnv('AUTH_ENABLED', 'false')
    vi.stubEnv('DATA_DIR', path.join(root, 'agent.db'))
    db = createClient({ url: 'file::memory:' })
    vi.spyOn(database, 'getDb').mockReturnValue(db)
    store = new ChangeStore()
    ctx = { tenantId: 'pptx-target-test', sessionId: path.basename(root), rootSessionId: path.basename(root), rootRunId: 'pptx-run', turnId: 'pptx-turn',
      workspacePaths: [root], projectRoot: root, cwd: root, scratchDir: path.join(root, 'scratch'),
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as unknown as AgentContext
    setSecurityMode(ctx.tenantId, ctx.sessionId, 'safe')
  })
  afterEach(() => {
    clearSecurityMode(ctx.tenantId, ctx.sessionId)
    db.close(); vi.restoreAllMocks(); vi.unstubAllEnvs()
    const resolved = path.resolve(root)
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('aether-pptx-target-')) throw new Error('Unsafe PPTX fixture cleanup')
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  })

  it('discovers a target through read-only paged inspect, publishes it with a matching hash and rejects stale/missing hashes', async () => {
    const file = path.join(root, 'sales.pptx'), original = await deck()
    fs.writeFileSync(file, original)
    let offset = 0, content = '', expectedHash = ''
    for (let pageNumber = 0; pageNumber < 30; pageNumber++) {
      const result = await officeInspectTool.execute({ path: file, contentLimit: 73, ...(offset ? { contentOffset: offset, expectedHash } : {}) }, ctx)
      expect(result.success).toBe(true)
      const receipt = JSON.parse(result.output)
      expectedHash = receipt.expectedHash; content += receipt.content
      expect(expectedHash).toBe(hashFileContent(original))
      if (!receipt.contentPage.hasMore) break
      expect(receipt.contentPage.nextOffset).toBeGreaterThan(offset)
      offset = receipt.contentPage.nextOffset
    }
    expect(content).toBe((await inspectPptx(original)).content)
    const { slide, textRun } = locators(content).filter(run => run.slide === 2 && run.text === '127200')[1]
    const args = { operation: 'edit', path: file, expectedHash, edits: [{ slide, textRun, oldText: '127200', newText: '128400' }] }
    const edited = await officeDocumentTool.execute(args, ctx)
    expect(edited).toMatchObject({ success: true, metadata: { fileMutationApplied: true, rollbackAvailable: true } })
    const current = fs.readFileSync(file)
    expect(edited.metadata!.expectedHash).toBe(hashFileContent(current))
    expect(locators((await inspectPptx(current)).content).filter(run => run.text === '128400')).toEqual([{ slide, textRun, editable: true, text: '128400' }])
    expect(await officeDocumentTool.execute({ ...args, edits: [{ slide, textRun, oldText: '128400', newText: 'stale' }] }, ctx)).toMatchObject({ success: false, error: 'OFFICE_VERSION_CONFLICT' })
    expect(await officeDocumentTool.execute({ operation: 'edit', path: file, edits: args.edits }, ctx)).toMatchObject({ success: false, error: 'OFFICE_INVALID_ARGUMENTS' })
    expect(fs.readFileSync(file)).toEqual(current)
    expect(await store.list(ctx.tenantId, ctx.sessionId)).toHaveLength(1)
  })

  it('rejects invalid/missing indices and aborts the entire batch without writing any partial edit', async () => {
    const file = path.join(root, 'sales.pptx'), original = await deck()
    fs.writeFileSync(file, original)
    const base = { oldText: '127200', newText: '128400' }
    for (const selector of [
      { slide: 0, textRun: 1 }, { slide: -1, textRun: 1 }, { slide: 2.5, textRun: 1 }, { slide: '2', textRun: 1 },
      { slide: 2 }, { textRun: 1 }, { slide: 2, textRun: 0 }, { slide: 2, textRun: -1 }, { slide: 2, textRun: 1.5 },
      { slide: 2, textRun: '1' }, { slide: 41, textRun: 1 }, { slide: 4, textRun: 1 }, { slide: 2, textRun: 100_000 },
      { slide: 2, textRun: 1, hidden: true },
    ]) {
      const result = await officeDocumentTool.execute({ operation: 'edit', path: file, expectedHash: hashFileContent(original), edits: [{ ...base, ...selector }] }, ctx)
      expect(result.success, JSON.stringify(selector)).toBe(false)
      expect(result.metadata?.fileMutationApplied).toBe(false)
      expect(fs.readFileSync(file)).toEqual(original)
    }
    const target = locators((await inspectPptx(original)).content).find(run => run.slide === 2 && run.text === '127200')!
    const failedBatch = await officeDocumentTool.execute({ operation: 'edit', path: file, expectedHash: hashFileContent(original),
      edits: [{ ...base, slide: target.slide, textRun: target.textRun }, { ...base, slide: 4, textRun: 1 }] }, ctx)
    expect(failedBatch).toMatchObject({ success: false, error: 'OFFICE_FORMAT_FAILED', metadata: { fileMutationApplied: false } })
    expect(fs.readFileSync(file)).toEqual(original)
    expect(await store.list(ctx.tenantId, ctx.sessionId)).toHaveLength(0)
  })

  it('rejects PPTX selectors for DOCX instead of silently discarding them and editing a different scope', async () => {
    const file = path.join(root, 'memo.docx'), original = await createDocx({ markdown: 'Unique revenue 127200.' })
    fs.writeFileSync(file, original)
    const result = await officeDocumentTool.execute({ operation: 'edit', path: file, expectedHash: hashFileContent(original),
      edits: [{ slide: 1, textRun: 1, oldText: '127200', newText: '128400' }] }, ctx)
    expect(result).toMatchObject({ success: false, error: 'OFFICE_INVALID_ARGUMENTS', metadata: { fileMutationApplied: false } })
    expect(JSON.parse(result.output).message).toContain('only supported for PPTX')
    expect(fs.readFileSync(file)).toEqual(original)
    expect(await store.list(ctx.tenantId, ctx.sessionId)).toHaveLength(0)
  })
})
