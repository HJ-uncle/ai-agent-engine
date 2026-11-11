/** Actual Office packages and paging; only policy decisions and parse gates are scripted. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext, IToolRegistry, ToolResult } from '../../../core/agent-context/index.js'
import { executeToolBatch } from '../../../core/agent-loop/tool-batch.js'
import { boundedToolContext, getToolOutputLimit } from '../../../core/agent-loop/tool-output-limit.js'
import { ToolRegistry } from '../../../core/tool-registry/registry.js'
import { clearSecurityMode, setSecurityMode } from '../../../security/policy-engine.js'
import { trustBuiltinTool } from '../../../security/tool-policy.js'
import { hashFileContent } from '../../../shared/file-version.js'
import { captureOfficeEvidence } from '../../../core/utils/tool-evidence.js'
import { createSubagentToolRegistry } from '../../subagent/subagent-tool.js'
import { officeDocumentTool, officeInspectTool } from '../index.js'
import * as docx from '../docx.js'
import { createXlsx, inspectXlsx } from '../xlsx.js'
import { createPptx, inspectPptx } from '../pptx.js'
import { createPdf, inspectPdf } from '../pdf.js'

let root: string, ctx: AgentContext
const preflight = vi.fn<NonNullable<IToolRegistry['preflight']>>()
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-office-batch-'))
  vi.stubEnv('AUTH_ENABLED', 'false')
  vi.stubEnv('DATA_DIR', path.join(root, 'fixture.db'))
  vi.stubEnv('OSM_MODE', 'off')
  vi.stubEnv('TOOL_OUTPUT_MAX_CHARS', '6500')
  preflight.mockReset().mockResolvedValue(undefined)
  ctx = { tenantId: 'office-batch', sessionId: path.basename(root), workspacePaths: [root],
    projectRoot: root, cwd: root, toolProfile: 'general', tools: { preflight },
    logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
  } as unknown as AgentContext
  setSecurityMode(ctx.tenantId, ctx.sessionId, 'safe')
})
afterEach(() => {
  clearSecurityMode(ctx.tenantId, ctx.sessionId)
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  const resolved = path.resolve(root)
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('aether-office-batch-')) throw new Error('Unsafe batch fixture cleanup')
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
})
async function word(name: string, content = '第一段🙂，第二段"\\，费用与收入。'.repeat(100)) {
  const file = path.join(root, name + '.docx'), bytes = await docx.createDocx({ markdown: '# ' + name + '\n\n' + content })
  fs.writeFileSync(file, bytes)
  return { file, bytes, content: (await docx.inspectDocx(bytes)).content }
}
function receipt(result: ToolResult, limit = getToolOutputLimit(ctx.toolProfile, ctx)) {
  expect(result.output.length).toBeLessThanOrEqual(limit)
  return JSON.parse(result.output)
}
const batch = (files: Array<Record<string, unknown>>, target = ctx) => officeInspectTool.execute({ files }, target)
const batchMetadata = (result: ToolResult) => result.metadata!.files as Array<Record<string, unknown>>

describe('Office batch inspection', () => {
  it('captures bounded provenance from actual batch receipts including a failed file', async () => {
    const first = await word('receipt', 'Native Office evidence. '.repeat(30))
    const args = { files: [{ path: first.file, contentLimit: 50 }, { path: path.join(root, 'missing.docx') }] }
    const result = await officeInspectTool.execute(args, ctx)
    const parsed = receipt(result), page = parsed.files[0].output.contentPage
    expect(result.success).toBe(false)
    const captured = captureOfficeEvidence({ name: 'office_inspect', args }, result)
    expect(captured).toMatchObject({ operation: 'inspect', success: false, code: 'OFFICE_BATCH_PARTIAL_FAILURE',
      evidenceScope: 'tool-receipt', files: [
        { success: true, path: fs.realpathSync.native(first.file), expectedHash: hashFileContent(first.bytes),
          returnedRange: [page.offset, page.offset + page.returnedChars], nextOffset: page.nextOffset, sourceTruncated: false },
        { success: false, requestPath: args.files[1].path, code: 'OFFICE_FILE_MISSING' },
      ] })
    expect(JSON.stringify(captured)).not.toContain('Native Office evidence')
    expect(fs.readFileSync(first.file)).toEqual(first.bytes)
  })

  it('keeps ordered real Word/Excel/PPT/PDF receipts, warnings, versions and truthful preview metadata', async () => {
    const first = await word('说明', '短正文'), sheet = path.join(root, '台账.xlsx'), slides = path.join(root, '汇报.pptx'), pdfPath = path.join(root, '副本.pdf')
    const xlsx = await createXlsx({ sheets: [{ name: '数据', columns: [{ key: 'v', header: '值' }], rows: [{ v: 12 }, { v: { formula: 'SUM(A2:A2)' } }] }] })
    const pptx = await createPptx({ slides: [{ title: '项目汇报', bullets: ['边界明确'], notes: '验收备注' }] })
    const pdf = await createPdf({ markdown: '# Office batch\n\nA real PDF preview.' })
    fs.writeFileSync(sheet, xlsx); fs.writeFileSync(slides, pptx); fs.writeFileSync(pdfPath, pdf)
    const files = [first.file, sheet, slides, pdfPath], bytes = [first.bytes, xlsx, pptx, pdf]
    const inspections = [await docx.inspectDocx(first.bytes), await inspectXlsx(xlsx), await inspectPptx(pptx), await inspectPdf(pdf)]
    const result = await batch(files.map(path => ({ path }))), parsed = receipt(result)
    expect(result.success).toBe(true)
    expect(parsed).toMatchObject({ batch: true, totalFiles: 4, completedFiles: 4, cancelled: false, fileMutationApplied: false })
    expect(parsed.files.map((file: { path: string }) => file.path)).toEqual(files)
    for (let index = 0; index < files.length; index++) {
      expect(parsed.files[index]).toMatchObject({ success: true, executed: true, output: {
        path: fs.realpathSync.native(files[index]), expectedHash: hashFileContent(bytes[index]), warnings: inspections[index].warnings,
        summary: inspections[index].summary, contentPage: { documentComplete: false }, visualValidation: 'not-performed',
      } })
      expect(batchMetadata(result)[index]).toMatchObject({ path: fs.realpathSync.native(files[index]), expectedHash: hashFileContent(bytes[index]),
        success: true, executed: true, fileMutationApplied: false, contentPage: { documentComplete: false } })
      expect(fs.readFileSync(files[index])).toEqual(bytes[index])
    }
    expect(result.change).toBeUndefined()
    expect(fs.readdirSync(root).sort()).toEqual(['台账.xlsx', '汇报.pptx', '说明.docx', '副本.pdf'].sort())
    expect(preflight.mock.calls.slice(0, 4).map(([name, args]) => [name, args])).toEqual(files.map(path => ['office_inspect', { path }]))
  })

  it('supports the real registry and readonly child preflight without recursion or mutation capability', async () => {
    const files = [await word('真实注册甲'), await word('真实注册乙')], parent = new ToolRegistry()
    parent.register(trustBuiltinTool(officeInspectTool, 'readonly'))
    parent.register(trustBuiltinTool(officeDocumentTool))
    ctx.tools = createSubagentToolRegistry(parent, true)
    expect(ctx.tools.has('office_inspect')).toBe(true); expect(ctx.tools.has('office_document')).toBe(false)
    const args = { files: files.map(file => ({ path: file.file })) }
    expect(await ctx.tools.preflight!('office_inspect', args, ctx)).toBeUndefined()
    const result = await ctx.tools.execute('office_inspect', args, ctx)
    expect(result.success).toBe(true); expect(receipt(result).completedFiles).toBe(2)
  })

  it('uses one output allowance for all pages and preserves exact Unicode content across per-file cursors', async () => {
    vi.stubEnv('TOOL_OUTPUT_MAX_CHARS', '2800')
    const words = [await word('甲', '引号"\\🙂中文。'.repeat(70)), await word('乙', 'emoji😀\n\n费用。'.repeat(70))]
    const recovered = ['', ''], offsets = [0, 0]
    let pending = [0, 1], calls = 0
    while (pending.length) {
      const selected = [...pending], result = await batch(selected.map(index => ({ path: words[index].file,
        ...(offsets[index] ? { expectedHash: hashFileContent(words[index].bytes), contentOffset: offsets[index] } : {}) })))
      expect(result.success).toBe(true)
      const parsed = receipt(result)
      pending = []
      parsed.files.forEach((file: any, position: number) => {
        const index = selected[position], page = file.output
        expect(page.contentPage.offset).toBe(offsets[index])
        expect(page.content).not.toMatch(/[\uD800-\uDBFF]$/)
        expect(page.content).not.toMatch(/^[\uDC00-\uDFFF]/)
        recovered[index] += page.content
        if (page.contentPage.hasMore) {
          expect(page.contentPage.nextOffset).toBeGreaterThan(offsets[index])
          offsets[index] = page.contentPage.nextOffset; pending.push(index)
        }
        expect(batchMetadata(result)[position].contentPage).toEqual(page.contentPage)
        expect(page.contentPage.documentComplete).toBe(false)
      })
      expect(++calls).toBeLessThan(20)
    }
    expect(calls).toBeGreaterThan(1)
    expect(recovered).toEqual(words.map(file => file.content))
  })

  it.each([
    { files: [] }, { files: Array.from({ length: 17 }, () => ({ path: 'a.docx' })) },
    { files: [{ path: 'a.docx' }], path: 'b.docx' }, { files: [{ path: 'a.docx' }], contentLimit: 10 },
    { files: [{ path: 'a.docx', operation: 'inspect' }] }, { files: [{ path: 'a.docx', markdown: 'write' }] },
    { files: [{ path: 'a.docx', expectedHash: 'missing' }] }, { files: [{ path: 'a.docx' }], operation: 'create' },
  ])('rejects malformed/mixed/writable batch arguments without reading: %j', async args => {
    const parser = vi.spyOn(docx, 'inspectDocx')
    const result = await officeInspectTool.execute(args, ctx)
    expect(result).toMatchObject({ success: false, error: 'OFFICE_INVALID_ARGUMENTS', metadata: { batch: true, executed: false, fileMutationApplied: false } })
    receipt(result); expect(parser).not.toHaveBeenCalled(); expect(preflight).not.toHaveBeenCalled()
  })

  it('prechecks every path and continuation before reading even the first permitted file', async () => {
    const first = await word('允许'), parser = vi.spyOn(docx, 'inspectDocx')
    const cases = [
      [{ path: first.file }, { path: path.join(path.dirname(root), 'outside.docx') }],
      [{ path: first.file }, { path: 'bad.exe' }],
      [{ path: first.file }, { path: first.file, contentOffset: 1 }],
    ]
    for (const files of cases) expect(await batch(files)).toMatchObject({ success: false, metadata: { executed: false } })
    expect(parser).not.toHaveBeenCalled()
  })

  it('preflights a batch permission wait before an earlier independent write in the same model response', async () => {
    const first = await word('允许'), second = await word('需许可'), parser = vi.spyOn(docx, 'inspectDocx'), write = vi.fn()
    preflight.mockImplementation(async (name, args, context) => {
      if (name !== 'office_inspect') return undefined
      if (Object.hasOwn(args as object, 'files')) return officeInspectTool.preflight!(args, context)
      if ((args as { path: string }).path === second.file) return { success: false, status: 'waiting', needsConfirmation: true, output: 'Permission required for this path.' }
      return undefined
    })
    ctx.tools.execute = vi.fn(async (name, args, context) => {
      if (name === 'write_file') { write(); return { success: true, output: 'written' } }
      return officeInspectTool.execute(args, context)
    })
    ctx.tools.executionMode = name => name === 'office_inspect' ? 'readonly' : 'serial'
    const result = await executeToolBatch([
      { messageId: 'message', call: { id: 'write', name: 'write_file', args: { path: 'later.txt', data: 'unpublished' } } },
      { messageId: 'message', call: { id: 'inspect', name: 'office_inspect', args: { files: [{ path: first.file }, { path: second.file }] } } },
    ], ctx)
    expect(result.pending).toMatchObject({ toolName: 'office_inspect', kind: 'permission' })
    expect(result.results[1]).toMatchObject({ status: 'waiting', metadata: { batch: true, executed: false } })
    expect(write).not.toHaveBeenCalled(); expect(parser).not.toHaveBeenCalled(); expect(ctx.tools.execute).not.toHaveBeenCalled()
  })

  it('preserves successful pages alongside missing-file and stale-version failures', async () => {
    const first = await word('有效', '有效内容'), stale = await word('过期', '当前版本')
    const result = await batch([{ path: first.file }, { path: stale.file, expectedHash: 'sha256:' + '0'.repeat(64) }, { path: path.join(root, 'missing.docx') }])
    const parsed = receipt(result)
    expect(result).toMatchObject({ success: false, error: 'OFFICE_BATCH_PARTIAL_FAILURE' })
    expect(parsed).toMatchObject({ completedFiles: 1, totalFiles: 3, cancelled: false })
    expect(parsed.files[0]).toMatchObject({ success: true, output: { expectedHash: hashFileContent(first.bytes) } })
    expect(parsed.files[1]).toMatchObject({ success: false, error: 'OFFICE_VERSION_CONFLICT', output: { actualHash: hashFileContent(stale.bytes) } })
    expect(parsed.files[2]).toMatchObject({ success: false, error: 'OFFICE_FILE_MISSING' })
    expect(batchMetadata(result)[1].contentPage).toBeUndefined()
  })

  it('retains a permission wait raised after preflight and does not read the blocked or queued files', async () => {
    const files = [await word('动态甲'), await word('动态乙')], parser = vi.spyOn(docx, 'inspectDocx')
    let checks = 0
    preflight.mockImplementation(async () => ++checks === 3
      ? { success: false, status: 'waiting', needsConfirmation: true, output: 'Permission changed.' } : undefined)
    const result = await batch(files.map(file => ({ path: file.file })))
    expect(result).toMatchObject({ success: false, status: 'waiting', needsConfirmation: true })
    expect(receipt(result).files.every((file: any) => !file.executed)).toBe(true)
    expect(parser).not.toHaveBeenCalled()
  })

  it('rejects a pre-cancelled batch or missing registry preflight without reading', async () => {
    const file = await word('取消前'), parser = vi.spyOn(docx, 'inspectDocx'), controller = new AbortController()
    controller.abort(new Error('Already cancelled'))
    const result = await batch([{ path: file.file }], { ...ctx, signal: controller.signal })
    expect(result).toMatchObject({ success: false, status: 'cancelled', metadata: { executed: false, cancelled: true } })
    expect(await batch([{ path: file.file }], { ...ctx, tools: {} as IToolRegistry })).toMatchObject({ success: false,
      error: 'OFFICE_BATCH_PREFLIGHT_UNAVAILABLE', metadata: { executed: false } })
    expect(parser).not.toHaveBeenCalled()
  })

  it('reads at most two files concurrently and explicitly skips queued files on cancellation', async () => {
    const words = await Promise.all(['一', '二', '三', '四'].map(name => word(name, name)))
    const controller = new AbortController(); ctx.signal = controller.signal
    let release!: () => void, active = 0, maximum = 0
    const gate = new Promise<void>(resolve => { release = resolve }), native = docx.inspectDocx
    const parser = vi.spyOn(docx, 'inspectDocx').mockImplementation(async bytes => {
      maximum = Math.max(maximum, ++active)
      try { await gate; return await native(bytes) } finally { active-- }
    })
    const pending = batch(words.map(file => ({ path: file.file })))
    try {
      await expect.poll(() => parser.mock.calls.length).toBe(2)
      controller.abort(new Error('User cancelled')); release()
      const result = await pending, parsed = receipt(result)
      expect(result).toMatchObject({ success: false, error: 'OFFICE_INSPECT_CANCELLED', metadata: { cancelled: true } })
      expect(parsed.files.map((file: any) => [file.executed, file.error])).toEqual([
        [true, 'OFFICE_INSPECT_CANCELLED'], [true, 'OFFICE_INSPECT_CANCELLED'],
        [false, 'OFFICE_INSPECT_CANCELLED'], [false, 'OFFICE_INSPECT_CANCELLED'],
      ])
      expect(parser).toHaveBeenCalledTimes(2); expect(maximum).toBe(2)
    } finally { release(); await pending }
  })

  it.each([1, 2, 80, 500, 1500])('rejects insufficient shared allowance %i without reading and never cuts JSON', async limit => {
    const first = await word('预算'), parser = vi.spyOn(docx, 'inspectDocx')
    const limited = boundedToolContext(ctx, limit), result = await batch([{ path: first.file }, { path: first.file }], limited)
    expect(result).toMatchObject({ success: false, error: 'OFFICE_BATCH_OUTPUT_BUDGET_TOO_SMALL', metadata: { batch: true, executed: false, completedFiles: 0 } })
    receipt(result, limit); expect(parser).not.toHaveBeenCalled()
  })

  it('accounts for full escaped paths before any file read', async () => {
    vi.stubEnv('TOOL_OUTPUT_MAX_CHARS', '1800')
    const candidate = path.join(root, ...Array.from({ length: 15 }, () => '路径'.repeat(10)), 'long.docx')
    const reader = vi.spyOn(fs, 'readFileSync')
    const result = await batch([{ path: candidate }, { path: candidate }])
    expect(result).toMatchObject({ success: false, metadata: { executed: false } })
    receipt(result); expect(reader.mock.calls.some(([file]) => String(file) === candidate)).toBe(false)
  })

  it('does not turn oversized warnings into a successful or supposedly complete file read', async () => {
    const first = await word('警告', '受限预览'), second = await word('正常', '正常内容'), native = docx.inspectDocx
    const warnings = ['警告🙂'.repeat(2000), '最终警告不可遗失']
    vi.spyOn(docx, 'inspectDocx').mockImplementation(async bytes => {
      const inspected = await native(bytes)
      return inspected.content.includes('受限预览') ? { ...inspected, warnings } : inspected
    })
    const result = await batch([{ path: first.file }, { path: second.file }]), parsed = receipt(result)
    expect(parsed.files[0]).toMatchObject({ success: false, executed: true, error: 'OFFICE_OUTPUT_BUDGET_TOO_SMALL' })
    expect(parsed.files[1].success).toBe(true)
    expect(batchMetadata(result)[0]).toMatchObject({ success: false, warnings })
    expect(batchMetadata(result)[0].contentPage).toBeUndefined()
  })

  it('retains legacy single-file shape and keeps scoped budgets from leaking to later inspections', async () => {
    const file = await word('兼容')
    const limited = boundedToolContext(ctx, 1100)
    const first = await officeDocumentTool.execute({ operation: 'inspect', path: file.file }, limited)
    expect(first.success).toBe(true); receipt(first, 1100)
    const single = await officeInspectTool.execute({ path: file.file }, ctx), full = receipt(single)
    expect(single.success).toBe(true)
    expect(full.files).toBeUndefined(); expect(full.path).toBe(fs.realpathSync.native(file.file))
    expect(full.content.length).toBeGreaterThan(JSON.parse(first.output).content.length)
    expect(getToolOutputLimit(ctx.toolProfile, ctx)).toBe(6500)
  })
})
