/** Real files through the readonly child: full-sheet diagnostics, versioned pages, no write/receipt side effects. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ExcelJS from 'exceljs'
import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext, IToolRegistry } from '../../../core/agent-context/index.js'
import { hashFileContent } from '../../../shared/file-version.js'
import * as database from '../../../storage/sqlite/db.js'
import { ChangeStore } from '../../../storage/changes/index.js'
import { clearSecurityMode, setSecurityMode } from '../../../security/policy-engine.js'
import { createToolRegistry } from '../../registry-factory.js'
import { createSubagentToolRegistry } from '../../subagent/subagent-tool.js'
import { officeInspectTool } from '../index.js'
import * as docx from '../docx.js'
import { MAX_OFFICE_FILE_BYTES } from '../office-zip.js'

let root: string, db: Client, ctx: AgentContext, child: IToolRegistry, store: ChangeStore
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-office-inspect-'))
  vi.stubEnv('AUTH_ENABLED', 'false')
  vi.stubEnv('DATA_DIR', path.join(root, 'agent.db'))
  db = createClient({ url: 'file::memory:' })
  vi.spyOn(database, 'getDb').mockReturnValue(db)
  store = new ChangeStore()
  ctx = { tenantId: 'office-inspect-test', sessionId: path.basename(root), rootSessionId: 'parent', rootRunId: 'inspect-run', turnId: 'inspect-turn',
    workspacePaths: [root], projectRoot: root, cwd: root, scratchDir: path.join(root, 'scratch'), toolProfile: 'general',
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as unknown as AgentContext
  setSecurityMode(ctx.tenantId, ctx.sessionId, 'safe')
  const parent = await createToolRegistry({ toolProfile: 'general', allowedTools: ['office_inspect', 'office_document'], allowedMcpServers: [], allowedSkills: [], memoryScopes: [] })
  child = createSubagentToolRegistry(parent.registry, true)
})
afterEach(() => {
  clearSecurityMode(ctx.tenantId, ctx.sessionId)
  db.close()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  const resolved = path.resolve(root)
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('aether-office-inspect-')) throw new Error('Unsafe inspection fixture cleanup')
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
})
const inspect = (args: unknown) => child.execute('office_inspect', args, ctx)
async function word(markdown = '# 审查文档\n\n多页检查😀。\n\n' + '本段需要逐页核对。'.repeat(60)) {
  const file = path.join(root, '审查.docx'), bytes = await docx.createDocx({ markdown })
  fs.writeFileSync(file, bytes)
  return { file, bytes }
}

describe('readonly office inspection capability', () => {
  it('lets a safe readonly child inspect second-sheet formulas and saved errors without touching file or change records', async () => {
    const book = new ExcelJS.Workbook()
    book.addWorksheet('封面').getCell('A1').value = '不是目标表'
    const target = book.addWorksheet('预算明细')
    target.getCell('A1').value = '需要核验的第二张表'
    target.getCell('B2').value = { formula: 'SUM(B3:B4)', result: 42 }
    target.getCell('C2').value = { formula: 'UNKNOWN()', result: { error: '#NAME?' } }
    const file = path.join(root, '多表审查.xlsx'), bytes = Buffer.from(await book.xlsx.writeBuffer())
    fs.writeFileSync(file, bytes)
    expect(child.has('office_document')).toBe(false)
    expect(child.executionMode?.('office_inspect', {})).toBe('readonly')
    expect(await child.preflight?.('office_inspect', { path: file }, ctx)).toBeUndefined()
    const result = await inspect({ path: file })
    expect(result).toMatchObject({ success: true, metadata: { expectedHash: hashFileContent(bytes), fileMutationApplied: false, format: 'xlsx' } })
    const receipt = JSON.parse(result.output)
    expect(receipt.content).toContain('## 预算明细')
    expect(receipt.content).toContain('需要核验的第二张表')
    expect(receipt.content).toContain('公式 =SUM(B3:B4)')
    expect(receipt.summary).toMatchObject({ sheets: 2, formulas: 2, errorCells: 1, formulaErrorCells: 1 })
    expect(receipt.warnings.join('\n')).toContain('"预算明细"!C2')
    expect(receipt).toMatchObject({ visualValidation: 'not-performed', contentPage: { documentComplete: false } })
    expect(fs.readFileSync(file)).toEqual(bytes)
    expect(result.change).toBeUndefined()
    expect(await store.list(ctx.tenantId, ctx.sessionId)).toEqual([])
    expect(fs.readdirSync(root)).toEqual(['多表审查.xlsx'])
  })

  it('reports hidden-sheet saved errors after the preview cap while disclosing missing preview content', async () => {
    const book = new ExcelJS.Workbook(), first = book.addWorksheet('大表')
    for (let row = 1; row <= 2001; row++) first.getCell(row, 1).value = row
    book.addWorksheet('隐藏错误', { state: 'hidden' }).getCell('F9').value = { formula: '1/0', result: { error: '#DIV/0!' } }
    const file = path.join(root, '上限.xlsx'), bytes = Buffer.from(await book.xlsx.writeBuffer())
    fs.writeFileSync(file, bytes)
    const result = await inspect({ path: file })
    expect(result.success).toBe(true)
    const receipt = JSON.parse(result.output)
    expect(receipt.summary).toMatchObject({ sheets: 2, cells: 2002, previewCells: 2000, previewTruncated: true, errorCells: 1, formulaErrorCells: 1 })
    expect(receipt.warnings.join('\n')).toContain('"隐藏错误"!F9')
    expect(receipt.content).not.toContain('公式 =1/0')
    expect(receipt.contentPage).toMatchObject({ sourceTruncated: true, documentComplete: false })
    expect(hashFileContent(fs.readFileSync(file))).toBe(hashFileContent(bytes))
  })

  it('returns progressing version-pinned Word pages and rejects stale/missing versions or invalid offsets', async () => {
    const { file, bytes } = await word()
    const first = await inspect({ path: file, contentLimit: 31 })
    expect(first.success).toBe(true)
    const page = JSON.parse(first.output), expectedHash = page.expectedHash
    expect(page.contentPage).toMatchObject({ offset: 0, hasMore: true, documentComplete: false })
    expect(page.contentPage.nextOffset).toBeGreaterThan(0)
    const next = await inspect({ path: file, expectedHash, contentOffset: page.contentPage.nextOffset, contentLimit: 31 })
    expect(next.success).toBe(true)
    const nextPage = JSON.parse(next.output)
    expect(nextPage.contentPage.offset).toBe(page.contentPage.nextOffset)
    expect(nextPage.contentPage.nextOffset).toBeGreaterThan(page.contentPage.nextOffset)
    expect(page.content + nextPage.content).toBe((await docx.inspectDocx(bytes)).content.slice(0, nextPage.contentPage.nextOffset))
    expect(await inspect({ path: file, contentOffset: page.contentPage.nextOffset })).toMatchObject({ success: false, error: 'OFFICE_INSPECT_VERSION_REQUIRED' })
    expect(await inspect({ path: file, expectedHash, contentOffset: page.contentPage.totalPreviewChars + 1 })).toMatchObject({ success: false, error: 'OFFICE_INVALID_CONTENT_OFFSET' })
    fs.writeFileSync(file, await docx.createDocx({ markdown: '用户更新后的版本' }))
    expect(await inspect({ path: file, expectedHash, contentOffset: page.contentPage.nextOffset })).toMatchObject({ success: false, error: 'OFFICE_VERSION_CONFLICT' })
    expect(await store.list(ctx.tenantId, ctx.sessionId)).toEqual([])
  })

  it.each([
    { operation: 'inspect' }, { operation: 'create', markdown: 'unexpected' }, { operation: 'edit', edits: [] },
    { operation: 'append_sheets', workbook: { sheets: [] } }, { markdown: 'unexpected' }, { expectedHash: 'missing' },
  ])('rejects mutation or unsupported fields before execution: %j', async fields => {
    const { file, bytes } = await word()
    expect(await inspect({ path: file, ...fields })).toMatchObject({ success: false, error: 'OFFICE_INVALID_ARGUMENTS', metadata: { fileMutationApplied: false } })
    expect(fs.readFileSync(file)).toEqual(bytes)
    expect(await store.list(ctx.tenantId, ctx.sessionId)).toEqual([])
  })

  it('keeps workspace and byte bounds on the readonly path', async () => {
    const outside = path.join(path.dirname(root), 'outside-office-inspect.docx')
    const readSpy = vi.spyOn(fs, 'readFileSync')
    const denied = await inspect({ path: outside })
    expect(denied).toMatchObject({ success: false, metadata: { fileMutationApplied: false } })
    expect(readSpy.mock.calls.some(([file]) => file === outside)).toBe(false)
    const file = path.join(root, 'oversized.docx'), fd = fs.openSync(file, 'w')
    try { fs.ftruncateSync(fd, MAX_OFFICE_FILE_BYTES + 1) } finally { fs.closeSync(fd) }
    const oversized = await inspect({ path: file })
    expect(oversized).toMatchObject({ success: false, error: 'OFFICE_FAILED' })
    expect(oversized.output).toContain('32 MiB')
    expect(readSpy.mock.calls.some(([candidate]) => candidate === file)).toBe(false)
  })

  it('revalidates bytes changed while inspection was parsing', async () => {
    const { file } = await word(), replacement = await docx.createDocx({ markdown: '并发更新' }), originalInspect = docx.inspectDocx
    vi.spyOn(docx, 'inspectDocx').mockImplementationOnce(async bytes => {
      const inspected = await originalInspect(bytes)
      fs.writeFileSync(file, replacement)
      return inspected
    })
    expect(await inspect({ path: file })).toMatchObject({ success: false, error: 'OFFICE_VERSION_CONFLICT', metadata: { fileMutationApplied: false } })
    expect(fs.readFileSync(file)).toEqual(replacement)
    expect(await store.list(ctx.tenantId, ctx.sessionId)).toEqual([])
  })

  it('advertises only readonly arguments and states preview/recalculation limits', () => {
    expect(officeInspectTool.parameters).toMatchObject({ additionalProperties: false, required: ['path'] })
    expect(Object.keys(officeInspectTool.parameters.properties ?? {}).sort()).toEqual(['contentLimit', 'contentOffset', 'expectedHash', 'path'])
    expect(officeInspectTool.description).toContain('2000')
    expect(officeInspectTool.description).toContain('600')
    expect(officeInspectTool.description).toContain('不重算公式')
  })
})
