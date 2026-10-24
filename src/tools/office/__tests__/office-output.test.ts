import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext } from '../../../core/agent-context/index.js'
import { truncateToolOutput } from '../../../core/agent-loop/react.js'
import { getToolOutputLimit } from '../../../core/agent-loop/tool-output-limit.js'
import { clearSecurityMode, setSecurityMode } from '../../../security/policy-engine.js'
import { hashFileContent } from '../../../shared/file-version.js'
import { officeDocumentTool } from '../index.js'
import * as docx from '../docx.js'
import { createXlsx, inspectXlsx } from '../xlsx.js'
import { readOfficeZip, writeOfficeZip } from '../office-zip.js'
import { officeFailure, officeReceipt, type OfficeInspection } from '../output.js'

const hash = 'sha256:' + 'a'.repeat(64)
const warning = '缓存未经重新计算；结构校验不等于视觉或业务验收。'
const inspection = (content: string): OfficeInspection => ({ format: 'xlsx', content,
  summary: { cells: 70, previewTruncated: false, errorCells: 1 }, warnings: [warning, '另一个警告末尾'] })

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

describe('Office receipts through the real ReAct text limiter', () => {
  it('keeps escaped path, hashes, all warnings and summary intact while paging escaped content', () => {
    const input = inspection('引号" 反斜线\\ 换行\n制表\t 表情🙂 特殊费用$$收入\n'.repeat(90))
    const file = 'D:\\文档\\"带引号"\\费用$$收入.xlsx'
    const budget = 1100
    let offset = 0, recovered = '', pages = 0
    do {
      const result = officeReceipt(file, hash, 99, input, budget, { offset })
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error(result.code)
      expect(result.output.length).toBeLessThanOrEqual(budget)
      const delivered = truncateToolOutput(result.output, budget)
      expect(delivered).toBe(result.output)
      const page = JSON.parse(delivered)
      expect(page).toMatchObject({ path: file, expectedHash: hash, summary: input.summary, warnings: input.warnings,
        contentPage: { offset, scope: 'stored-cell-text-preview', documentComplete: false } })
      expect(page.contentPage.returnedChars).toBe(page.content.length)
      expect(page.content).not.toMatch(/[\uD800-\uDBFF]$/)
      expect(page.content).not.toMatch(/^[\uDC00-\uDFFF]/)
      recovered += page.content
      pages++
      if (!page.contentPage.hasMore) break
      expect(page.contentPage.nextOffset).toBeGreaterThan(offset)
      offset = page.contentPage.nextOffset
      expect(pages).toBeLessThan(100)
    } while (true)
    expect(pages).toBeGreaterThan(1)
    expect(recovered).toBe(input.content)
  })

  it('keeps explicit page boundaries outside emoji and rejects a cursor inside one', () => {
    const input = inspection('A🙂B')
    const first = officeReceipt('a.xlsx', hash, 1, input, 2000, { limit: 2 })
    expect(first.ok).toBe(true)
    if (!first.ok) throw new Error(first.code)
    expect(JSON.parse(first.output)).toMatchObject({ content: 'A', contentPage: { nextOffset: 1 } })
    const second = officeReceipt('a.xlsx', hash, 1, input, 2000, { offset: 1, limit: 2 })
    if (!second.ok) throw new Error(second.code)
    expect(JSON.parse(second.output)).toMatchObject({ content: '🙂', contentPage: { nextOffset: 3 } })
    expect(officeReceipt('a.xlsx', hash, 1, input, 2000, { offset: 2 })).toMatchObject({ ok: false, code: 'OFFICE_INVALID_CONTENT_OFFSET' })
    expect(officeReceipt('a.xlsx', hash, 1, input, 2000, { offset: 5 })).toMatchObject({ ok: false, code: 'OFFICE_INVALID_CONTENT_OFFSET' })
  })

  it('never labels the end of a bounded XLSX preview as full document content', () => {
    const input = inspection('仅有预览'); input.summary.previewTruncated = true
    const result = officeReceipt('a.xlsx', hash, 1, input, 2000, { offset: input.content.length })
    if (!result.ok) throw new Error(result.code)
    expect(JSON.parse(result.output)).toMatchObject({ content: '', contentTruncated: true,
      contentPage: { hasMore: false, nextOffset: null, sourceTruncated: true, documentComplete: false } })
  })

  it('refuses success when complete warnings cannot fit, and preserves every warning when they can', () => {
    const input = inspection('preview')
    input.warnings = ['警告"\\🙂'.repeat(1000), '必须保留的最后一条：#NAME?']
    const refused = officeReceipt('a.xlsx', hash, 1, input, 1000, {})
    expect(refused).toMatchObject({ ok: false, code: 'OFFICE_OUTPUT_BUDGET_TOO_SMALL' })
    const accepted = officeReceipt('a.xlsx', hash, 1, input, 20_000, {})
    if (!accepted.ok) throw new Error(accepted.code)
    expect(JSON.parse(truncateToolOutput(accepted.output, 20_000)).warnings).toEqual(input.warnings)
  })

  it.each([1, 2, 8, 90, 250, 1200])('keeps failure JSON valid at budget %i without denying a real mutation', budget => {
    const result = officeFailure('OFFICE_RECORD_FAILED', '错误"\\🙂'.repeat(1000), { fileMutationApplied: true }, budget)
    const delivered = truncateToolOutput(result.output, budget)
    expect(result.output.length).toBeLessThanOrEqual(budget)
    expect(delivered).toBe(result.output)
    expect(() => JSON.parse(delivered)).not.toThrow()
    expect(result).toMatchObject({ success: false, metadata: { fileMutationApplied: true, diagnosticsTruncated: true } })
    const parsed = JSON.parse(delivered)
    if (parsed.fileMutationApplied !== undefined) expect(parsed.fileMutationApplied).toBe(true)
  })
})

describe('Office live-tool inspection contract', () => {
  let root: string, ctx: AgentContext
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-office-output-'))
    vi.stubEnv('AUTH_ENABLED', 'false')
    vi.stubEnv('OSM_MODE', 'off')
    vi.stubEnv('TOOL_OUTPUT_MAX_CHARS', '1600')
    ctx = { tenantId: 'office-output-test', sessionId: path.basename(root), workspacePaths: [root],
      projectRoot: root, cwd: root, logger: { warn: vi.fn(), error: vi.fn() } } as unknown as AgentContext
    setSecurityMode(ctx.tenantId, ctx.sessionId, 'safe')
  })
  afterEach(() => {
    clearSecurityMode(ctx.tenantId, ctx.sessionId)
    const resolved = path.resolve(root)
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('aether-office-output-')) throw new Error('Unsafe fixture cleanup')
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  })

  it('returns a real DOCX in progressing pinned pages without corrupting JSON at the channel', async () => {
    const file = path.join(root, '正文.docx')
    const bytes = await docx.createDocx({ markdown: '# 真实正文\n\n' + '引号" 费用$$收入 🙂 反斜线\\\n\n'.repeat(200) })
    fs.writeFileSync(file, bytes)
    const expected = await docx.inspectDocx(bytes)
    const expectedHash = hashFileContent(bytes)
    let contentOffset = 0, recovered = '', count = 0
    do {
      const result = await officeDocumentTool.execute({ operation: 'inspect', path: file, contentOffset,
        ...(contentOffset ? { expectedHash } : {}) }, ctx)
      expect(result).toMatchObject({ success: true, metadata: { expectedHash, fileMutationApplied: false } })
      const delivered = truncateToolOutput(result.output, getToolOutputLimit(ctx.toolProfile))
      expect(delivered).toBe(result.output)
      const page = JSON.parse(delivered)
      recovered += page.content
      expect(page.warnings).toEqual(expected.warnings)
      expect(page.summary).toEqual(expected.summary)
      count++
      if (!page.contentPage.hasMore) break
      expect(page.contentPage.nextOffset).toBeGreaterThan(contentOffset)
      contentOffset = page.contentPage.nextOffset
      expect(count).toBeLessThan(100)
    } while (true)
    expect(count).toBeGreaterThan(1)
    expect(recovered).toBe(expected.content)
    expect(fs.readFileSync(file)).toEqual(bytes)
  })

  it('requires a version on continuation and rejects actual external changes before reading another page', async () => {
    const file = path.join(root, '版本.docx')
    fs.writeFileSync(file, await docx.createDocx({ markdown: '# 初始\n\n第一版正文' }))
    const first = await officeDocumentTool.execute({ operation: 'inspect', path: file }, ctx)
    const expectedHash = first.metadata!.expectedHash
    expect(await officeDocumentTool.execute({ operation: 'inspect', path: file, contentOffset: 1 }, ctx))
      .toMatchObject({ success: false, error: 'OFFICE_INSPECT_VERSION_REQUIRED' })
    const newer = await docx.createDocx({ markdown: '# 改后\n\n第二版正文' })
    fs.writeFileSync(file, newer)
    const stale = await officeDocumentTool.execute({ operation: 'inspect', path: file, contentOffset: 1, expectedHash }, ctx)
    expect(stale).toMatchObject({ success: false, error: 'OFFICE_VERSION_CONFLICT', metadata: { fileMutationApplied: false, actualHash: hashFileContent(newer) } })
    expect(JSON.parse(truncateToolOutput(stale.output, getToolOutputLimit(ctx.toolProfile))).code).toBe('OFFICE_VERSION_CONFLICT')
    expect(fs.readFileSync(file)).toEqual(newer)
  })

  it('continues beyond 2 MiB when valid DOCX paragraph separators extend its text preview', async () => {
    const file = path.join(root, '多段落.docx')
    const parts = readOfficeZip(await docx.createDocx({ markdown: '# 基础' }))
    const paragraph = '<w:p><w:r><w:t>' + 'a'.repeat(104) + '</w:t></w:r></w:p>'
    parts['word/document.xml'] = Buffer.from('<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
      + paragraph.repeat(20_000) + '</w:body></w:document>')
    const bytes = writeOfficeZip(parts), expectedHash = hashFileContent(bytes)
    fs.writeFileSync(file, bytes)
    const first = await officeDocumentTool.execute({ operation: 'inspect', path: file, expectedHash, contentOffset: 2_097_100 }, ctx)
    expect(first.success).toBe(true)
    const page = JSON.parse(first.output)
    expect(page.contentPage.totalPreviewChars).toBe(2_119_998)
    expect(page.contentPage.nextOffset).toBeGreaterThan(2 * 1024 * 1024)
    const next = await officeDocumentTool.execute({ operation: 'inspect', path: file, expectedHash, contentOffset: page.contentPage.nextOffset }, ctx)
    expect(next.success).toBe(true)
    expect(JSON.parse(truncateToolOutput(next.output, getToolOutputLimit(ctx.toolProfile))).contentPage.offset).toBe(page.contentPage.nextOffset)
    expect(fs.readFileSync(file)).toEqual(bytes)
  })

  it('exposes the real XLSX source preview cap even after consuming its last page', async () => {
    const file = path.join(root, '大表.xlsx')
    const bytes = await createXlsx({ sheets: [{ name: '真实表', columns: [{ header: '值', key: 'v' }],
      rows: Array.from({ length: 2100 }, (_, index) => ({ v: index })) }] })
    fs.writeFileSync(file, bytes)
    const source = await inspectXlsx(bytes)
    expect(source.summary.previewTruncated).toBe(true)
    const result = await officeDocumentTool.execute({ operation: 'inspect', path: file, expectedHash: hashFileContent(bytes), contentOffset: source.content.length }, ctx)
    expect(result.success).toBe(true)
    const page = JSON.parse(truncateToolOutput(result.output, getToolOutputLimit(ctx.toolProfile)))
    expect(page).toMatchObject({ contentTruncated: true, contentPage: { sourceTruncated: true, hasMore: false, documentComplete: false } })
    expect(page.warnings).toEqual(source.warnings)
  })

  it('refuses creation before publication rather than silently dropping oversized warnings', async () => {
    const file = path.join(root, '不应发布.docx')
    const warnings = ['警告：缓存不能当作验收。'.repeat(500), '最后一条必须保留']
    const original = docx.inspectDocx
    vi.spyOn(docx, 'inspectDocx').mockImplementation(async bytes => ({ ...await original(bytes), warnings }))
    const result = await officeDocumentTool.execute({ operation: 'create', path: file, expectedHash: 'missing', markdown: '# 测试' }, ctx)
    expect(result).toMatchObject({ success: false, error: 'OFFICE_OUTPUT_BUDGET_TOO_SMALL', metadata: { fileMutationApplied: false, warnings } })
    expect(() => JSON.parse(truncateToolOutput(result.output, getToolOutputLimit(ctx.toolProfile)))).not.toThrow()
    expect(fs.existsSync(file)).toBe(false)
    expect(fs.readdirSync(root)).toEqual([])
  })
})

describe('tool output configuration', () => {
  it.each([undefined, '', '0', '-10', 'NaN', 'Infinity'])('falls back for general budget %s before the real limiter', value => {
    vi.stubEnv('OSM_MODE', 'off')
    vi.stubEnv('TOOL_OUTPUT_MAX_CHARS', value)
    expect(getToolOutputLimit('general')).toBe(4000)
    expect(JSON.parse(truncateToolOutput('{"code":"failure"}'))).toEqual({ code: 'failure' })
  })
  it.each(['1', '2', '83'])('preserves valid small configured budgets %s', value => {
    vi.stubEnv('OSM_MODE', 'off')
    vi.stubEnv('TOOL_OUTPUT_MAX_CHARS', value)
    const budget = getToolOutputLimit('general')
    expect(budget).toBe(Number(value))
    const result = officeFailure('OFFICE_OUTPUT_BUDGET_TOO_SMALL', 'Increase output budget.', {}, budget)
    expect(() => JSON.parse(truncateToolOutput(result.output))).not.toThrow()
  })
  it('preserves Code default and custom limit independently of general fallback', () => {
    vi.stubEnv('TOOL_OUTPUT_MAX_CHARS', 'NaN')
    vi.stubEnv('CODE_TOOL_OUTPUT_MAX_CHARS', '0')
    expect(getToolOutputLimit('code')).toBe(64 * 1024)
    vi.stubEnv('CODE_TOOL_OUTPUT_MAX_CHARS', '1234')
    expect(getToolOutputLimit('code')).toBe(1234)
  })
})
