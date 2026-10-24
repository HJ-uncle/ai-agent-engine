import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClient, type Client } from '@libsql/client'
import ExcelJS from 'exceljs'
import { strToU8, zipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext } from '../../../core/agent-context/index.js'
import { hashFileContent } from '../../../shared/file-version.js'
import * as database from '../../../storage/sqlite/db.js'
import { ChangeStore } from '../../../storage/changes/index.js'
import { clearSecurityMode, setSecurityMode } from '../../../security/policy-engine.js'
import { officeDocumentTool } from '../index.js'
import * as docx from '../docx.js'
import { MAX_OFFICE_EXPANDED_BYTES, MAX_OFFICE_FILE_BYTES, decodeXml, encodeXml, readOfficeZip, writeOfficeZip } from '../office-zip.js'

let root: string, db: Client, ctx: AgentContext, store: ChangeStore
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-office-'))
  vi.stubEnv('AUTH_ENABLED', 'false')
  vi.stubEnv('DATA_DIR', path.join(root, 'agent.db'))
  db = createClient({ url: 'file::memory:' })
  vi.spyOn(database, 'getDb').mockReturnValue(db)
  store = new ChangeStore()
  ctx = { tenantId: 'office-test', sessionId: path.basename(root), rootSessionId: path.basename(root), rootRunId: 'office-run', turnId: 'office-turn',
    workspacePaths: [root], projectRoot: root, cwd: root, scratchDir: path.join(root, 'scratch'),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as unknown as AgentContext
  setSecurityMode(ctx.tenantId, ctx.sessionId, 'safe')
})
afterEach(() => {
  clearSecurityMode(ctx.tenantId, ctx.sessionId)
  db.close()
  vi.restoreAllMocks()
  const resolved = path.resolve(root)
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('aether-office-')) throw new Error('Unsafe Office fixture cleanup')
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  vi.unstubAllEnvs()
})
const createWord = (file = '周报.docx', markdown = '# 项目周报\n\n## 进展\n\n接口联调已完成。\n\n| 事项 | 状态 |\n| --- | --- |\n| 验证 | 进行中 |') =>
  officeDocumentTool.execute({ operation: 'create', path: file, expectedHash: 'missing', markdown }, ctx)
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

describe('native office tool publication and artifact evidence', () => {
  it('creates a real Word ZIP, returns matching complete-byte versions and records an inspectable artifact', async () => {
    const result = await createWord()
    expect(result).toMatchObject({ success: true, metadata: { format: 'docx', fileMutationApplied: true, rollbackAvailable: true, validation: 'structure-checked', visualValidation: 'not-performed' } })
    const file = path.join(root, '周报.docx'), bytes = fs.readFileSync(file)
    expect(bytes.subarray(0, 4)).toEqual(Buffer.from([80, 75, 3, 4]))
    expect(result.change).toMatchObject({ path: fs.realpathSync.native(file), kind: 'write', isNew: true, oldHash: 'missing', newHash: hashFileContent(bytes), runId: 'office-run', turnId: 'office-turn', newSnapshotRef: expect.any(String) })
    const parts = readOfficeZip(bytes)
    expect(Object.keys(parts)).toContain('word/document.xml')
    expect(Buffer.from(parts['word/document.xml']).toString('utf8')).toContain('接口联调已完成')
    const inspected = await officeDocumentTool.execute({ operation: 'inspect', path: file }, ctx)
    expect(inspected.success).toBe(true)
    expect(JSON.parse(inspected.output)).toMatchObject({ path: fs.realpathSync.native(file), expectedHash: hashFileContent(bytes), format: 'docx', content: expect.stringContaining('接口联调已完成') })
    expect(await store.list(ctx.tenantId, ctx.sessionId)).toHaveLength(1)
    expect(fs.readdirSync(root).filter(name => name.startsWith('.aether-office-'))).toEqual([])
  })

  it('edits a real Word document with a read version, preserves unrelated parts and reverts its exact binary snapshot', async () => {
    const created = await createWord()
    const file = path.join(root, '周报.docx'), before = fs.readFileSync(file), partsBefore = readOfficeZip(before)
    const inspected = await officeDocumentTool.execute({ operation: 'inspect', path: file }, ctx)
    const edited = await officeDocumentTool.execute({ operation: 'edit', path: file, expectedHash: inspected.metadata!.expectedHash,
      edits: [{ oldText: '接口联调已完成。', newText: '接口联调已完成，异常恢复待验证。' }] }, ctx)
    expect(created.success && edited.success).toBe(true)
    const after = fs.readFileSync(file), partsAfter = readOfficeZip(after)
    expect(edited.change).toMatchObject({ oldHash: hashFileContent(before), newHash: hashFileContent(after), oldSnapshotRef: expect.any(String), newSnapshotRef: expect.any(String) })
    for (const [name, bytes] of Object.entries(partsBefore)) if (name !== 'word/document.xml') expect(partsAfter[name]).toEqual(bytes)
    expect((await docx.inspectDocx(after)).content).toContain('异常恢复待验证')
    const reverted = await store.revertBatch(ctx.tenantId, { sessionId: ctx.sessionId, ids: [String(edited.change!.id)] })
    expect(reverted).toMatchObject({ total: 1, reverted: 1, failed: 0, unavailable: 0 })
    expect(fs.readFileSync(file)).toEqual(before)
  })

  it('writes an Excel workbook with real numeric cells, formatting and formula data then patches only the specified cell', async () => {
    const file = path.join(root, '预算.xlsx')
    const created = await officeDocumentTool.execute({ operation: 'create', path: file, expectedHash: 'missing', workbook: { sheets: [{ name: '预算', columns: [
      { header: '事项', key: 'item', type: 'text' }, { header: '预算', key: 'budget', type: 'number' },
    ], rows: [{ item: '开发', budget: 12 }, { item: '验证', budget: 8 }, { item: '合计', budget: { formula: 'SUM(B2:B3)' } }] }] } }, ctx)
    expect(created).toMatchObject({ success: true, metadata: { fileMutationApplied: true, rollbackAvailable: true, format: 'xlsx' } })
    const book = new ExcelJS.Workbook()
    await book.xlsx.readFile(file)
    expect(book.getWorksheet('预算')!.getCell('B2').value).toBe(12)
    expect(book.getWorksheet('预算')!.getCell('B4').value).toMatchObject({ formula: 'SUM(B2:B3)', result: 20 })
    expect(book.getWorksheet('预算')!.getCell('A1').font.bold).toBe(true)
    const inspected = await officeDocumentTool.execute({ operation: 'inspect', path: file }, ctx)
    const edited = await officeDocumentTool.execute({ operation: 'edit', path: file, expectedHash: inspected.metadata!.expectedHash, edits: [{ sheet: '预算', cell: 'B2', value: 15 }] }, ctx)
    expect(edited.success).toBe(true)
    const changed = new ExcelJS.Workbook()
    await changed.xlsx.readFile(file)
    expect(changed.getWorksheet('预算')!.getCell('A2').value).toBe('开发')
    expect(changed.getWorksheet('预算')!.getCell('B2').value).toBe(15)
    expect(changed.getWorksheet('预算')!.getCell('B4').value).toMatchObject({ formula: 'SUM(B2:B3)', result: 23 })
    expect(edited.metadata!.expectedHash).toBe(hashFileContent(fs.readFileSync(file)))
  })

  it('appends one sheet with a real version, preserves old worksheet bytes and supports exact binary rollback', async () => {
    const file = path.join(root, '增量台账.xlsx')
    const created = await officeDocumentTool.execute({ operation: 'create', path: file, expectedHash: 'missing', workbook: {
      sheets: [{ name: '文档主表', columns: [{ header: '文件', key: 'file' }], rows: [{ file: '保留.docx' }] }],
    } }, ctx)
    expect(created.success).toBe(true)
    const before = fs.readFileSync(file), beforeParts = readOfficeZip(before)
    const appended = await officeDocumentTool.execute({ operation: 'append_sheets', path: file, expectedHash: created.metadata!.expectedHash,
      workbook: { sheets: [{ name: '校验表', columns: [{ header: '项', key: 'item' }], rows: [{ item: '实际追加' }] }] } }, ctx)
    expect(appended).toMatchObject({ success: true, metadata: { fileMutationApplied: true, rollbackAvailable: true, format: 'xlsx' } })
    expect(appended.change).toMatchObject({ isNew: false, oldHash: hashFileContent(before), newHash: hashFileContent(fs.readFileSync(file)) })
    expect(JSON.parse(appended.output).warnings.join('\n')).toContain('旧公式缓存未经重新计算')
    const afterParts = readOfficeZip(fs.readFileSync(file))
    expect(afterParts['xl/worksheets/sheet1.xml']).toEqual(beforeParts['xl/worksheets/sheet1.xml'])
    const book = new ExcelJS.Workbook(); await book.xlsx.readFile(file)
    expect(book.getWorksheet('文档主表')!.getCell('A2').value).toBe('保留.docx')
    expect(book.getWorksheet('校验表')!.getCell('A2').value).toBe('实际追加')
    const reverted = await store.revertBatch(ctx.tenantId, { sessionId: ctx.sessionId, ids: [String(appended.change!.id)] })
    expect(reverted.reverted).toBe(1)
    expect(fs.readFileSync(file)).toEqual(before)
  })

  it('admits only one concurrent append for a version and preserves bytes on stale, duplicate and oversized-sheet retries', async () => {
    const file = path.join(root, '并发追加.xlsx')
    const definition = (name: string) => ({ name, columns: [{ header: '值', key: 'v' }], rows: [{ v: name }] })
    const created = await officeDocumentTool.execute({ operation: 'create', path: file, expectedHash: 'missing', workbook: { sheets: [definition('原表')] } }, ctx)
    expect(created.success).toBe(true)
    const results = await Promise.all(['角色甲', '角色乙'].map(name => officeDocumentTool.execute({ operation: 'append_sheets', path: file,
      expectedHash: created.metadata!.expectedHash, workbook: { sheets: [definition(name)] } }, ctx)))
    expect(results.filter(result => result.success)).toHaveLength(1)
    expect(results.filter(result => !result.success)).toMatchObject([{ error: 'OFFICE_VERSION_CONFLICT', metadata: { fileMutationApplied: false } }])
    const before = fs.readFileSync(file), expectedHash = hashFileContent(before)
    for (const input of [
      { operation: 'append_sheets', path: file, expectedHash, workbook: { sheets: [definition('原表')] } },
      { operation: 'append_sheets', path: file, expectedHash: 'missing', workbook: { sheets: [definition('新表')] } },
      { operation: 'append_sheets', path: file, expectedHash, workbook: { sheets: Array.from({ length: 5 }, (_, index) => definition('批次' + index)) } },
      { operation: 'append_sheets', path: '不支持.docx', expectedHash, workbook: { sheets: [definition('新表')] } },
    ]) expect(await officeDocumentTool.execute(input, ctx)).toMatchObject({ success: false, metadata: { fileMutationApplied: false } })
    expect(fs.readFileSync(file)).toEqual(before)
    expect(await store.list(ctx.tenantId, ctx.sessionId)).toHaveLength(2)
    expect(fs.readdirSync(root).filter(name => name.startsWith('.aether-office-'))).toEqual([])
  })

  it('refuses stale edits and create collisions without replacing bytes or recording a change', async () => {
    const created = await createWord()
    const file = path.join(root, '周报.docx'), before = fs.readFileSync(file)
    const collision = await createWord('周报.docx', '# 错误覆盖')
    expect(collision).toMatchObject({ success: false, error: 'OFFICE_VERSION_CONFLICT', metadata: { fileMutationApplied: false } })
    const newer = await docx.createDocx({ markdown: '# 用户修改\n\n接口联调已完成。' })
    fs.writeFileSync(file, newer)
    const stale = await officeDocumentTool.execute({ operation: 'edit', path: file, expectedHash: created.metadata!.expectedHash,
      edits: [{ oldText: '接口联调已完成。', newText: '不应发布' }] }, ctx)
    expect(stale).toMatchObject({ success: false, error: 'OFFICE_VERSION_CONFLICT', metadata: { fileMutationApplied: false, actualHash: hashFileContent(newer) } })
    expect(fs.readFileSync(file)).toEqual(newer)
    expect(newer.equals(before)).toBe(false)
    expect(await store.list(ctx.tenantId, ctx.sessionId)).toHaveLength(1)
  })

  it('serializes root/child path aliases so only one change of the same document version is published', async () => {
    fs.mkdirSync(path.join(root, 'real'))
    await createWord('real/周报.docx')
    fs.symlinkSync(path.join(root, 'real'), path.join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
    const file = path.join(root, 'real', '周报.docx'), expectedHash = hashFileContent(fs.readFileSync(file))
    const results = await Promise.all([
      officeDocumentTool.execute({ operation: 'edit', path: file, expectedHash, edits: [{ oldText: '接口联调已完成。', newText: '主任务完成。' }] }, ctx),
      officeDocumentTool.execute({ operation: 'edit', path: path.join(root, 'alias', '周报.docx'), expectedHash, edits: [{ oldText: '接口联调已完成。', newText: '子任务完成。' }] }, { ...ctx, sessionId: 'office-child' }),
    ])
    expect(results.filter(item => item.success)).toHaveLength(1)
    expect(results.filter(item => !item.success)).toMatchObject([{ error: 'OFFICE_VERSION_CONFLICT' }])
    const records = await store.list(ctx.tenantId, ctx.sessionId)
    expect(records).toHaveLength(2)
    expect(records.filter(record => record.oldHash === expectedHash)).toHaveLength(1)
  })

  it('blocks workspace escape, malformed inputs and mismatched formats with no output file', async () => {
    const outside = path.join(root, '..', path.basename(root) + '-outside.docx')
    const escaped = await createWord(outside)
    expect(escaped.success).toBe(false)
    expect(escaped.output).toContain('outside any bound workspace')
    expect(fs.existsSync(outside)).toBe(false)
    for (const input of [
      { operation: 'create', path: 'bad.docx', expectedHash: 'missing', markdown: '# 标题', hidden: true },
      { operation: 'create', path: 'bad.xlsx', expectedHash: 'missing', markdown: '# 不是Excel' },
      { operation: 'create', path: 'bad.pdf', expectedHash: 'missing', markdown: '# 不是PDF' },
      { operation: 'edit', path: 'bad.docx', expectedHash: 'missing', edits: [{ oldText: 'a', newText: 'b' }] },
    ]) expect((await officeDocumentTool.execute(input, ctx)).success).toBe(false)
    expect(fs.readdirSync(root)).toEqual([])
    expect(await store.list(ctx.tenantId, ctx.sessionId)).toEqual([])
  })

  it('does not publish when generation fails, an edit is ambiguous or cancellation arrives during generation', async () => {
    await createWord('ambiguous.docx', '# 标题\n\n相同 相同')
    const file = path.join(root, 'ambiguous.docx'), before = fs.readFileSync(file)
    const ambiguous = await officeDocumentTool.execute({ operation: 'edit', path: file, expectedHash: hashFileContent(before), edits: [{ oldText: '相同', newText: '冲突' }] }, ctx)
    expect(ambiguous).toMatchObject({ success: false, error: 'OFFICE_FORMAT_FAILED', metadata: { fileMutationApplied: false } })
    expect(fs.readFileSync(file)).toEqual(before)
    const originalCreate = docx.createDocx, started = deferred(), release = deferred(), controller = new AbortController()
    vi.spyOn(docx, 'createDocx').mockImplementationOnce(async args => { started.resolve(); await release.promise; return originalCreate(args) })
    const writing = officeDocumentTool.execute({ operation: 'create', path: 'cancelled.docx', expectedHash: 'missing', markdown: '# 取消测试' }, { ...ctx, signal: controller.signal })
    await started.promise
    controller.abort()
    release.resolve()
    const cancelled = await writing
    expect(cancelled).toMatchObject({ success: false, metadata: { fileMutationApplied: false } })
    expect(fs.existsSync(path.join(root, 'cancelled.docx'))).toBe(false)
    expect(await store.list(ctx.tenantId, ctx.sessionId)).toHaveLength(1)
  })

  it('protects a destination created by an external writer while format generation is suspended', async () => {
    const originalCreate = docx.createDocx, started = deferred(), release = deferred()
    vi.spyOn(docx, 'createDocx').mockImplementationOnce(async args => { started.resolve(); await release.promise; return originalCreate(args) })
    const writing = createWord('raced.docx')
    await started.promise
    const file = path.join(root, 'raced.docx'), external = Buffer.from('external writer bytes')
    fs.writeFileSync(file, external)
    release.resolve()
    expect(await writing).toMatchObject({ success: false, error: 'OFFICE_VERSION_CONFLICT', metadata: { fileMutationApplied: false } })
    expect(fs.readFileSync(file)).toEqual(external)
    expect(await store.list(ctx.tenantId, ctx.sessionId)).toEqual([])
  })

  it('reports the actual applied write if change persistence fails', async () => {
    vi.spyOn(ChangeStore.prototype, 'record').mockRejectedValueOnce(new Error('database unavailable'))
    const result = await createWord('record-failure.docx')
    expect(result).toMatchObject({ success: false, error: 'OFFICE_RECORD_FAILED', metadata: { fileMutationApplied: true, rollbackAvailable: false } })
    expect(JSON.parse(result.output)).toMatchObject({ code: 'OFFICE_RECORD_FAILED', fileMutationApplied: true, rollbackAvailable: false })
    expect(JSON.parse(result.output).message).toContain('文件已变更')
    const bytes = fs.readFileSync(path.join(root, 'record-failure.docx'))
    expect((await docx.inspectDocx(bytes)).content).toContain('接口联调已完成')
  })
})

describe('bounded Office ZIP and XML evidence', () => {
  it('checks a genuine package round trip including Chinese names and rejects damaged payloads by CRC', () => {
    const entries = { '[Content_Types].xml': strToU8('<Types/>'), '资料/内容.xml': strToU8('<text>中文 &amp; 数据</text>') }
    expect(readOfficeZip(writeOfficeZip(entries))).toEqual(entries)
    const stored = Buffer.from(zipSync(entries, { level: 0 }))
    const content = stored.indexOf(Buffer.from('<text>'))
    expect(content).toBeGreaterThan(0)
    stored[content + 1] ^= 1
    expect(() => readOfficeZip(stored)).toThrow(/CRC/)
  })

  it('rejects declared ZIP bombs before extraction, signed packages, traversal and DTD', () => {
    const small = Buffer.from(zipSync({ 'doc.xml': strToU8('<doc/>') }))
    const directory = small.indexOf(Buffer.from([80, 75, 1, 2]))
    small.writeUInt32LE(MAX_OFFICE_FILE_BYTES + 1, directory + 24)
    expect(() => readOfficeZip(small)).toThrow(/size limit/)
    const many = Object.fromEntries(Array.from({ length: 3 }, (_, index) => [`part${index}.xml`, strToU8('<doc/>')]))
    const fakeTotal = Buffer.from(zipSync(many))
    let offset = 0
    for (let index = 0; index < 3; index++) { offset = fakeTotal.indexOf(Buffer.from([80, 75, 1, 2]), offset); fakeTotal.writeUInt32LE(MAX_OFFICE_EXPANDED_BYTES / 2, offset + 24); offset += 46 }
    expect(() => readOfficeZip(fakeTotal)).toThrow()
    const rejectedPackages: Array<Record<string, Uint8Array>> = [
      { '_xmlsignatures/sig1.xml': strToU8('<Signature/>') },
      { '../escape.xml': strToU8('<doc/>') },
      { 'doc.xml': strToU8('<!DOCTYPE x [<!ENTITY x SYSTEM "file:///secret">]><x>&x;</x>') },
    ]
    for (const entries of rejectedPackages) expect(() => readOfficeZip(zipSync(entries))).toThrow()
    expect(() => readOfficeZip(Buffer.from('not an office archive'))).toThrow()
  })

  it('preserves XML special characters, numeric entities and emoji without admitting illegal control text', () => {
    const sample = '中文 < > & " \' 😀'
    expect(decodeXml(encodeXml(sample))).toBe(sample)
    expect(decodeXml('&#x1F600; &#13;')).toBe('😀 \r')
    expect(() => decodeXml('&#0;')).toThrow()
    expect(() => decodeXml('&external;')).toThrow()
    expect(() => encodeXml('\0')).toThrow()
  })
})
