/** Native note discovery/editing must follow slide relationships and preserve the package. */
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

const note = '91 工时；来源：旧工时.xlsx'
const slides = [{ title: '工时核对', bullets: [note], notes: note }, { title: '附录', notes: '其他备注保留' }]
const notesPart = 'ppt/notesSlides/notesSlide1.xml'
const slideRelations = 'ppt/slides/_rels/slide1.xml.rels'
const xml = (parts: Record<string, Uint8Array>, name: string): string => Buffer.from(parts[name]).toString()
function notesLocators(content: string) {
  return [...content.matchAll(/^\[target=notes slide=(\d+) textRun=(\d+) editable=(true|false)\]\n([^\n]*)/gm)]
    .map(match => ({ target: 'notes' as const, slide: Number(match[1]), textRun: Number(match[2]), editable: match[3] === 'true', text: match[4] }))
}
function locator(content: string, value = note) {
  const found = notesLocators(content).find(run => run.text === value)
  expect(found).toBeDefined()
  return { target: found!.target, slide: found!.slide, textRun: found!.textRun }
}
function replaceRelation(source: string, transform: (relation: string) => string): string {
  return source.replace(/<Relationship\b[^>]*Type="[^"]*\/notesSlide"[^>]*\/>/, transform)
}
function assertOtherParts(before: Record<string, Uint8Array>, after: Record<string, Uint8Array>, changed: string[]) {
  expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort())
  for (const name of Object.keys(before)) if (!changed.includes(name)) expect(Buffer.from(after[name]), name).toEqual(Buffer.from(before[name]))
}

describe('PPTX related notes and independent locators', () => {
  it('reads ordinary notes and immutable page fields, and keeps default edits limited to body', async () => {
    const original = await createPptx({ slides }), before = readOfficeZip(original), report = await inspectPptx(original)
    expect(notesLocators(report.content)).toContainEqual({ target: 'notes', slide: 1, textRun: 1, editable: true, text: note })
    expect(notesLocators(report.content)).toContainEqual({ target: 'notes', slide: 1, textRun: 2, editable: false, text: '1' })
    expect(report.summary).toMatchObject({ notesSlides: 2, notesTextRuns: 4 })
    expect(report.warnings.join('')).not.toContain('备注及母版未提取')
    const bodyOnly = readOfficeZip(await editPptx(original, [{ oldText: note, newText: '正文更新' }]))
    expect(xml(bodyOnly, 'ppt/slides/slide1.xml')).toContain('<a:t>正文更新</a:t>')
    assertOtherParts(before, bodyOnly, ['ppt/slides/slide1.xml'])
    const selected = locator(report.content)
    const edited = readOfficeZip(await editPptx(original, [{ ...selected, oldText: '91', newText: '96' }, { ...selected, oldText: '旧工时.xlsx', newText: '新工时 & 核对.xlsx' }]))
    expect(xml(edited, notesPart)).toBe(xml(before, notesPart).replace('<a:t>91 工时；来源：旧工时.xlsx</a:t>', '<a:t>96 工时；来源：新工时 &amp; 核对.xlsx</a:t>'))
    assertOtherParts(before, edited, [notesPart])
  })

  it('resolves notes from displayed slide order and the actual internal relationship, ignoring orphan notes', async () => {
    const parts = readOfficeZip(await createPptx({ slides })), presentation = xml(parts, 'ppt/presentation.xml')
    const ids = presentation.match(/<p:sldId\b[^>]*\/>/g)!
    parts['ppt/presentation.xml'] = Buffer.from(presentation.replace(ids.join(''), [...ids].reverse().join('')))
    const renamed = 'ppt/notesSlides/review-notes.xml'
    // Namespace prefixes and note filenames are not locators.
    parts[renamed] = Buffer.from(xml(parts, notesPart).replace(/\ba:/g, 'drawing:').replace('xmlns:a=', 'xmlns:drawing='))
    parts[notesPart] = Buffer.from(xml(parts, notesPart).replace(note, 'ORPHAN must not be inspected'))
    parts[slideRelations] = Buffer.from(replaceRelation(xml(parts, slideRelations), relation => relation.replace('Target="../notesSlides/notesSlide1.xml"', `Target="/${renamed}" TargetMode="Internal"`)))
    const original = writeOfficeZip(parts), report = await inspectPptx(original)
    const selected = locator(report.content)
    expect(selected.slide).toBe(2)
    expect(report.content).not.toContain('ORPHAN')
    const after = readOfficeZip(await editPptx(original, [{ ...selected, oldText: '91', newText: '96' }]))
    expect(xml(after, renamed)).toContain('<drawing:t>96 工时；来源：旧工时.xlsx</drawing:t>')
    assertOtherParts(parts, after, [renamed])
  })

  it('never falls back from notes to body, and rejects fields, missing notes, ambiguity and split runs', async () => {
    const original = await createPptx({ slides }), report = await inspectPptx(original), selected = locator(report.content)
    await expect(editPptx(original, [{ ...selected, oldText: '工时核对', newText: '错误范围' }])).rejects.toThrow('唯一匹配')
    const field = notesLocators(report.content).find(run => !run.editable)!
    await expect(editPptx(original, [{ target: 'notes', slide: field.slide, textRun: field.textRun, oldText: field.text, newText: '9' }])).rejects.toThrow('字段')
    const parts = readOfficeZip(original)
    parts[slideRelations] = Buffer.from(replaceRelation(xml(parts, slideRelations), () => ''))
    const withoutNotes = writeOfficeZip(parts)
    expect(notesLocators((await inspectPptx(withoutNotes)).content).some(run => run.slide === 1)).toBe(false)
    await expect(editPptx(withoutNotes, [{ ...selected, oldText: note, newText: '不能改正文' }])).rejects.toThrow('范围')
    const duplicate = await createPptx({ slides: [{ title: '重复', notes: '91 / 91' }] })
    await expect(editPptx(duplicate, [{ target: 'notes', slide: 1, textRun: 1, oldText: '91', newText: '96' }])).rejects.toThrow('唯一匹配')
    const split = readOfficeZip(original)
    split[notesPart] = Buffer.from(xml(split, notesPart).replace('<a:t>91 工时；来源：旧工时.xlsx</a:t>', '<a:t>91 工时；来源：</a:t></a:r><a:r><a:t>旧工时.xlsx</a:t>'))
    await expect(editPptx(writeOfficeZip(split), [{ ...selected, oldText: note, newText: '不能合并格式' }])).rejects.toThrow('唯一匹配')
  })

  it.each([
    ['external mode', (r: string) => r.replace('/>', ' TargetMode="External"/>')],
    ['unknown mode', (r: string) => r.replace('/>', ' TargetMode="external"/>')],
    ['URL', (r: string) => r.replace('../notesSlides/notesSlide1.xml', 'https://example.test/notes.xml')],
    ['outside notes directory', (r: string) => r.replace('../notesSlides/notesSlide1.xml', '../slides/slide1.xml')],
    ['package root traversal', (r: string) => r.replace('../notesSlides/notesSlide1.xml', '../../../ppt/notesSlides/notesSlide1.xml')],
    ['encoded traversal', (r: string) => r.replace('../notesSlides/notesSlide1.xml', '../notesSlides/%2e%2e/notesSlide1.xml')],
    ['missing target', (r: string) => r.replace('../notesSlides/notesSlide1.xml', '../notesSlides/missing.xml')],
    ['duplicate relation', (r: string) => r + r],
    ['multiple notes', (r: string) => r + r.replace('Id="rId2"', 'Id="rId3"')],
    ['missing id', (r: string) => r.replace('Id="rId2"', '')],
  ])('rejects %s before inspection or editing', async (_label, transform) => {
    const parts = readOfficeZip(await createPptx({ slides }))
    parts[slideRelations] = Buffer.from(replaceRelation(xml(parts, slideRelations), transform))
    const malformed = writeOfficeZip(parts)
    await expect(inspectPptx(malformed)).rejects.toThrow()
    await expect(editPptx(malformed, [{ target: 'notes', slide: 1, textRun: 1, oldText: '91', newText: '96' }])).rejects.toThrow()
  })

  it('rejects a shared notes part, an invalid relationship tree and a non-notes root', async () => {
    const parts = readOfficeZip(await createPptx({ slides }))
    const second = 'ppt/slides/_rels/slide2.xml.rels'
    const secondOriginal = parts[second]
    parts[second] = Buffer.from(xml(parts, second).replace('notesSlide2.xml', 'notesSlide1.xml'))
    await expect(inspectPptx(writeOfficeZip(parts))).rejects.toThrow('共享')
    parts[second] = secondOriginal
    const relationsOriginal = parts[slideRelations]
    parts[slideRelations] = Buffer.from(xml(parts, slideRelations).replace('<Relationships ', '<Other ').replace('</Relationships>', '</Other>'))
    await expect(inspectPptx(writeOfficeZip(parts))).rejects.toThrow('关系根节点')
    parts[slideRelations] = relationsOriginal
    parts[notesPart] = Buffer.from(xml(parts, 'ppt/slides/slide1.xml'))
    await expect(inspectPptx(writeOfficeZip(parts))).rejects.toThrow('备注根节点')
  })
})

describe('PPTX notes native tool publication', () => {
  let root: string, db: Client, ctx: AgentContext, store: ChangeStore
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-pptx-notes-'))
    vi.stubEnv('AUTH_ENABLED', 'false')
    vi.stubEnv('DATA_DIR', path.join(root, 'agent.db'))
    db = createClient({ url: 'file::memory:' })
    vi.spyOn(database, 'getDb').mockReturnValue(db)
    store = new ChangeStore()
    ctx = { tenantId: 'pptx-notes-test', sessionId: path.basename(root), rootSessionId: path.basename(root), rootRunId: 'notes-run', turnId: 'notes-turn',
      workspacePaths: [root], projectRoot: root, cwd: root, scratchDir: path.join(root, 'scratch'),
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as unknown as AgentContext
    setSecurityMode(ctx.tenantId, ctx.sessionId, 'safe')
  })
  afterEach(() => {
    clearSecurityMode(ctx.tenantId, ctx.sessionId)
    db.close(); vi.restoreAllMocks(); vi.unstubAllEnvs()
    const resolved = path.resolve(root)
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('aether-pptx-notes-')) throw new Error('Unsafe PPTX notes fixture cleanup')
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  })

  it('creates, discovers paged note locators, updates hours and source path, records rollback and fences stale hashes', async () => {
    const file = path.join(root, 'review.pptx')
    const created = await officeDocumentTool.execute({ operation: 'create', path: file, expectedHash: 'missing', presentation: { slides } }, ctx)
    expect(created.success).toBe(true)
    const original = fs.readFileSync(file), before = readOfficeZip(original)
    let offset = 0, content = '', expectedHash = ''
    for (let pageNumber = 0; pageNumber < 60; pageNumber++) {
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
    const selected = locator(content)
    const edits = [{ ...selected, oldText: '91', newText: '96' }, { ...selected, oldText: '旧工时.xlsx', newText: '新工时.xlsx' }]
    const edited = await officeDocumentTool.execute({ operation: 'edit', path: file, expectedHash, edits }, ctx)
    expect(edited).toMatchObject({ success: true, metadata: { fileMutationApplied: true, rollbackAvailable: true } })
    const current = fs.readFileSync(file)
    expect(edited.metadata!.expectedHash).toBe(hashFileContent(current))
    const after = readOfficeZip(current)
    expect(xml(after, notesPart)).toBe(xml(before, notesPart).replace(note, '96 工时；来源：新工时.xlsx'))
    assertOtherParts(before, after, [notesPart])
    const inspected = await officeInspectTool.execute({ path: file }, ctx)
    expect(inspected.success).toBe(true)
    expect(notesLocators(JSON.parse(inspected.output).content)).toContainEqual({ ...selected, editable: true, text: '96 工时；来源：新工时.xlsx' })
    expect(await officeDocumentTool.execute({ operation: 'edit', path: file, expectedHash, edits }, ctx)).toMatchObject({ success: false, error: 'OFFICE_VERSION_CONFLICT' })
    expect(await officeDocumentTool.execute({ operation: 'edit', path: file, edits }, ctx)).toMatchObject({ success: false, error: 'OFFICE_INVALID_ARGUMENTS' })
    expect(fs.readFileSync(file)).toEqual(current)
    expect(await store.list(ctx.tenantId, ctx.sessionId)).toHaveLength(2)
  })

  it('rejects invalid note selectors and aborts mixed body/notes batches without publishing partial content', async () => {
    const file = path.join(root, 'review.pptx'), original = await createPptx({ slides })
    fs.writeFileSync(file, original)
    const common = { operation: 'edit', path: file, expectedHash: hashFileContent(original) }
    for (const selector of [
      { target: 'notes' }, { target: 'notes', slide: 1 }, { target: 'notes', textRun: 1 },
      { target: 'body', slide: 1, textRun: 1 }, { target: 'notes', slide: 0, textRun: 1 },
      { target: 'notes', slide: 3, textRun: 1 }, { target: 'notes', slide: 1, textRun: 100_000 },
    ]) {
      const result = await officeDocumentTool.execute({ ...common, edits: [{ ...selector, oldText: '91', newText: '96' }] }, ctx)
      expect(result.success, JSON.stringify(selector)).toBe(false)
      expect(result.metadata?.fileMutationApplied).toBe(false)
      expect(fs.readFileSync(file)).toEqual(original)
    }
    const report = await inspectPptx(original), selected = locator(report.content)
    const field = notesLocators(report.content).find(run => !run.editable)!
    const failed = await officeDocumentTool.execute({ ...common, edits: [
      { oldText: note, newText: '正文的暂存修改' }, { ...selected, oldText: '91', newText: '96' },
      { target: 'notes', slide: field.slide, textRun: field.textRun, oldText: field.text, newText: '9' },
    ] }, ctx)
    expect(failed).toMatchObject({ success: false, error: 'OFFICE_FORMAT_FAILED', metadata: { fileMutationApplied: false } })
    expect(fs.readFileSync(file)).toEqual(original)
    expect(await store.list(ctx.tenantId, ctx.sessionId)).toHaveLength(0)
    expect(fs.readdirSync(root).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('rejects note targeting for Word without discarding its scope', async () => {
    const file = path.join(root, 'memo.docx'), original = await createDocx({ markdown: note })
    fs.writeFileSync(file, original)
    const result = await officeDocumentTool.execute({ operation: 'edit', path: file, expectedHash: hashFileContent(original),
      edits: [{ target: 'notes', slide: 1, textRun: 1, oldText: '91', newText: '96' }] }, ctx)
    expect(result).toMatchObject({ success: false, error: 'OFFICE_INVALID_ARGUMENTS', metadata: { fileMutationApplied: false } })
    expect(fs.readFileSync(file)).toEqual(original)
    expect(await store.list(ctx.tenantId, ctx.sessionId)).toHaveLength(0)
  })
})
