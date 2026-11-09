/** Real JSON source bytes through the batch budget and public read tool; isolated DB and workspace. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as XLSX from 'xlsx'
import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext, ToolResult } from '../../../core/agent-context/index.js'
import { getToolOutputLimit } from '../../../core/agent-loop/tool-output-limit.js'
import * as database from '../../../storage/sqlite/db.js'
import { ChangeStore } from '../../../storage/changes/index.js'
import { clearSecurityMode, setSecurityMode } from '../../../security/policy-engine.js'
import { hashFileContent } from '../../../shared/file-version.js'
import { createDocx } from '../../office/docx.js'
import { handlerRegistry } from '../handlers/registry.js'
import { readFileTool } from '../super-file-tool.js'

interface Page {
  path: string; expectedHash: string; byteLength: number; numberedContent: string
  startLine: number; endLine: number; totalLines: number; requestedEndLine: number
  startColumn: number; endColumn: number; partialLine: boolean; columnUnit: string
  hasMore: boolean; nextStartLine: number | null; nextStartColumn: number | null
  contentIsComplete: boolean; rangeIsComplete: boolean
}
interface BatchReceipt { batch: true; files: Array<{ path: string; success: boolean; output: Page | string; error?: string }> }
let root: string, ctx: AgentContext, db: Client, changes: ChangeStore
beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'aether-json-page-')))
  vi.stubEnv('AUTH_ENABLED', 'false'); vi.stubEnv('DATA_DIR', path.join(root, 'fixture.db'))
  vi.stubEnv('OSM_MODE', 'off'); vi.stubEnv('TOOL_OUTPUT_MAX_CHARS', '4000'); vi.stubEnv('CODE_TOOL_OUTPUT_MAX_CHARS', '4000')
  db = createClient({ url: 'file::memory:' }); vi.spyOn(database, 'getDb').mockReturnValue(db)
  changes = new ChangeStore()
  ctx = { tenantId: 'json-batch-page', sessionId: path.basename(root), workspacePaths: [root], projectRoot: root, cwd: root,
    toolProfile: 'general', tools: { preflight: vi.fn(async () => undefined), has: () => true },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as unknown as AgentContext
  setSecurityMode(ctx.tenantId, ctx.sessionId, 'safe')
})
afterEach(() => {
  clearSecurityMode(ctx.tenantId, ctx.sessionId); db.close(); vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (path.dirname(root) !== fs.realpathSync.native(os.tmpdir()) || !path.basename(root).startsWith('aether-json-page-')) throw new Error('Unsafe JSON fixture cleanup')
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
})
function seed(name: string, raw: string | Buffer) {
  const file = path.join(root, name); fs.writeFileSync(file, raw)
  return { path: file, expectedHash: hashFileContent(raw), bytes: Buffer.isBuffer(raw) ? raw : Buffer.from(raw) }
}
function decodeBatch(result: ToolResult, target = ctx): BatchReceipt {
  expect(result.output.length).toBeLessThanOrEqual(getToolOutputLimit(target.toolProfile, target))
  expect(() => JSON.parse(result.output)).not.toThrow()
  const decoded = JSON.parse(result.output) as BatchReceipt
  expect(decoded.batch).toBe(true)
  return decoded
}
function decodePage(result: ToolResult, target = ctx): Page {
  expect(result.success, result.output).toBe(true)
  expect(result.output.length).toBeLessThanOrEqual(getToolOutputLimit(target.toolProfile, target))
  const page = JSON.parse(result.output) as Page
  expect(typeof page.numberedContent).toBe('string')
  return page
}
function assertSourcePage(page: Page, source: string, startLine = 1, startColumn = 1) {
  const lines = source.split(/\r\n|\r|\n/)
  expect(page).toMatchObject({ startLine, startColumn, totalLines: lines.length, columnUnit: 'utf16', expectedHash: hashFileContent(source), byteLength: Buffer.byteLength(source) })
  expect(page.endLine).toBeGreaterThanOrEqual(startLine)
  expect(page.endLine).toBeLessThanOrEqual(page.requestedEndLine)
  const actual = page.numberedContent.split('\n')
  expect(actual).toHaveLength(page.endLine - startLine + 1)
  actual.forEach((line, index) => {
    const number = startLine + index, from = index === 0 ? startColumn - 1 : 0
    const end = number === page.endLine ? page.endColumn : lines[number - 1].length
    expect(line).toBe(`${number} | ${lines[number - 1].slice(from, end)}`)
  })
  if (page.hasMore) {
    expect(page.nextStartLine).toBe(page.endColumn < lines[page.endLine - 1].length ? page.endLine : page.endLine + 1)
    expect(page.nextStartColumn).toBe(page.endColumn < lines[page.endLine - 1].length ? page.endColumn + 1 : 1)
    expect(page.contentIsComplete).toBe(false); expect(page.rangeIsComplete).toBe(false)
  } else {
    expect(page.nextStartLine).toBeNull(); expect(page.nextStartColumn).toBeNull(); expect(page.rangeIsComplete).toBe(true)
  }
}
function packageSource(): string {
  const data = { name: 'aether-web-2048', version: '1.0.0', private: true,
    scripts: { dev: 'vite', build: 'tsc && vite build', test: 'vitest run' },
    dependencies: Object.fromEntries(Array.from({ length: 110 }, (_, index) => [`workspace-component-${index}`, `^1.${index}.0`])),
    description: '' }
  data.description = 'x'.repeat(8192 - Buffer.byteLength(JSON.stringify(data, null, 2)))
  return JSON.stringify(data, null, 2)
}

describe('JSON participates in the raw text batch page contract', () => {
  it.each([4000, 8000].flatMap(limit => ['auto', 'full'].map(mode => ({ limit, mode }))))('returns 3 Markdown files plus an 8 KiB package.json inside $limit chars in $mode mode', async ({ limit, mode }) => {
    vi.stubEnv('TOOL_OUTPUT_MAX_CHARS', String(limit))
    const md = ['README.md', 'AGENTS.md', 'NOTES.md'].map(name => seed(name, `# ${name}\n\nProject facts and boundaries.\n`))
    const source = packageSource(), json = seed('package.json', source)
    expect(json.bytes.length).toBe(8192)
    const result = await readFileTool.execute({ files: [...md.map(file => ({ path: file.path })), { path: json.path, mode }] }, ctx)
    expect(result.success, result.output).toBe(true)
    const receipt = decodeBatch(result)
    expect(receipt.files.map(file => file.success)).toEqual([true, true, true, true])
    for (let index = 0; index < md.length; index++) expect(receipt.files[index].output).toMatchObject({ expectedHash: md[index].expectedHash, contentIsComplete: true })
    const page = receipt.files[3].output as Page
    assertSourcePage(page, source)
    expect(page.hasMore).toBe(true)
    expect(page.numberedContent).toContain('"name": "aether-web-2048"')
    expect(result.output).not.toContain('FILE_BATCH_REQUIRES_SINGLE_READ')
    expect((result.metadata?.files as Record<string, unknown>[])[3]).toMatchObject({ startLine: page.startLine, endLine: page.endLine, nextStartLine: page.nextStartLine, nextStartColumn: page.nextStartColumn })
    expect(fs.readFileSync(json.path)).toEqual(json.bytes)
    expect(await changes.list(ctx.tenantId, ctx.sessionId)).toEqual([])
  })

  it.each(['general', 'code'] as const)('honors explicit original-source line ranges for a %s JSON batch and single continuation', async profile => {
    const source = JSON.stringify({ name: 'source-lines', nested: { key: 'kept', count: 2 }, values: [1, 2, 3] }, null, 4).replaceAll('\n', '\r\n')
    const json = seed('source.json', source), target = { ...ctx, toolProfile: profile }
    const result = await readFileTool.execute({ files: [{ path: json.path, start_line: 3, end_line: 6 }] }, target)
    expect(result.success, result.output).toBe(true)
    const page = decodeBatch(result, target).files[0].output as Page
    assertSourcePage(page, source, 3)
    expect(page).toMatchObject({ endLine: 6, requestedEndLine: 6, hasMore: false, contentIsComplete: false })
    const single = decodePage(await readFileTool.execute({ path: json.path, start_line: 3, end_line: 6 }, target), target)
    expect(single.numberedContent).toBe(page.numberedContent)
  })

  it.each(['general', 'code'] as const)('recovers every Unicode character of minified long JSON via %s batch-to-single column continuation', async profile => {
    const source = JSON.stringify({ key: '中🙂"\\\t'.repeat(1600), tail: ['完毕', 42] }), json = seed('minified.json', source)
    const target = { ...ctx, toolProfile: profile }
    const first = await readFileTool.execute({ files: [{ path: json.path }, { path: seed('short.md', '# Shared facts').path }] }, target)
    expect(first.success, first.output).toBe(true)
    let page = decodeBatch(first, target).files[0].output as Page, recovered = '', startColumn = 1, pages = 0
    for (;;) {
      assertSourcePage(page, source, 1, startColumn)
      const piece = page.numberedContent.slice('1 | '.length)
      expect(piece.length).toBeGreaterThan(0)
      expect(piece).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u)
      recovered += piece
      expect(++pages).toBeLessThan(50)
      if (!page.hasMore) break
      expect(page.nextStartLine).toBe(1); expect(page.nextStartColumn).toBe(startColumn + piece.length)
      startColumn = page.nextStartColumn!
      const result = await readFileTool.execute({ path: json.path, start_line: page.nextStartLine, start_column: startColumn }, target)
      page = decodePage(result, target)
    }
    expect(pages).toBeGreaterThan(2)
    expect(recovered).toBe(source); expect(JSON.parse(recovered)).toEqual(JSON.parse(source))
    expect(fs.readFileSync(json.path)).toEqual(json.bytes)
    expect(await changes.list(ctx.tenantId, ctx.sessionId)).toEqual([])
  })

  it('reads invalid JSON as bounded original source instead of requiring successful JSON parsing', async () => {
    const source = '{\n  "broken": "unterminated,\n' + '  invalid 🙂 source line\n'.repeat(130), json = seed('broken.json', source)
    expect(() => JSON.parse(source)).toThrow()
    const result = await readFileTool.execute({ files: [{ path: json.path }] }, ctx)
    expect(result.success, result.output).toBe(true)
    const page = decodeBatch(result).files[0].output as Page
    assertSourcePage(page, source)
    expect(page.hasMore).toBe(true)
    expect(fs.readFileSync(json.path)).toEqual(json.bytes)
  })

  it.each(['general', 'code'] as const)('recovers quoted 8 KiB UTF-8 CSV source through a mixed %s batch and column continuations', async profile => {
    const prefix = '\uFEFF编号,描述\r\n001,"' + '中🙂,""'.repeat(500), suffix = '"\r\n'
    const source = prefix + 'x'.repeat(8192 - Buffer.byteLength(prefix + suffix)) + suffix
    const csv = seed('quoted.CSV', source), target = { ...ctx, toolProfile: profile }
    const readme = seed('README.md', '# CSV facts'), config = seed('package.json', '{"private":true}')
    expect(csv.bytes.length).toBe(8192)
    const first = await readFileTool.execute({ files: [{ path: readme.path }, { path: csv.path }, { path: config.path }] }, target)
    expect(first.success, first.output).toBe(true)
    const receipt = decodeBatch(first, target)
    expect(receipt.files.map(file => file.success)).toEqual([true, true, true])
    let page = receipt.files[1].output as Page, startLine = 1, startColumn = 1, pages = 0, sawColumnContinuation = false
    const recovered = source.split('\r\n').map(() => '')
    for (;;) {
      assertSourcePage(page, source, startLine, startColumn)
      for (const [index, line] of page.numberedContent.split('\n').entries()) {
        const number = startLine + index
        recovered[number - 1] += line.slice(`${number} | `.length)
      }
      expect(++pages).toBeLessThan(30)
      if (!page.hasMore) break
      startLine = page.nextStartLine!
      startColumn = page.nextStartColumn!
      sawColumnContinuation ||= startColumn > 1
      page = decodePage(await readFileTool.execute({ path: csv.path, start_line: startLine, start_column: startColumn }, target), target)
    }
    expect(pages).toBeGreaterThan(2)
    expect(sawColumnContinuation).toBe(true)
    expect(recovered.join('\r\n')).toBe(source)
    expect(fs.readFileSync(csv.path)).toEqual(csv.bytes)
    expect(await changes.list(ctx.tenantId, ctx.sessionId)).toEqual([])
  })
})

describe('JSON paging preserves format-specific and legacy single-file behavior', () => {
  it.each(['auto', 'full', 'summary'] as const)('keeps legacy standalone JSON %s formatting when no range was requested', async mode => {
    const data = { b: 2, a: { message: '中文🙂', list: [3, 4] } }, source = JSON.stringify(data, null, 4)
    const json = seed('legacy.json', source)
    const result = await readFileTool.execute({ path: json.path, mode }, ctx)
    expect(result.success, result.output).toBe(true)
    expect(result.output).toMatch(/^\[读取监控\]/)
    expect(result.output.split('\n\n').slice(1).join('\n\n')).toBe(JSON.stringify(data, null, mode === 'full' ? 2 : undefined))
    expect(result.metadata).toMatchObject({ expectedHash: json.expectedHash })
    expect(fs.readFileSync(json.path)).toEqual(json.bytes)
  })

  it('retains exact UTF-8 source bytes and BOM/CRLF for standalone and fitting batch exact reads', async () => {
    const source = '\uFEFF{\r\n  "a": "中🙂"\r\n}\r\n', json = seed('exact.json', source)
    for (const args of [{ path: json.path, mode: 'exact' }, { files: [{ path: json.path, mode: 'exact' }] }]) {
      const result = await readFileTool.execute(args, ctx)
      expect(result.success, result.output).toBe(true)
      const receipt = 'files' in args ? decodeBatch(result).files[0].output : JSON.parse(result.output)
      expect(receipt).toMatchObject({ content: source, expectedHash: json.expectedHash, contentIsComplete: true, utf8Bom: true, lineEnding: 'CRLF' })
      expect(receipt).not.toHaveProperty('numberedContent')
    }
    expect(fs.readFileSync(json.path)).toEqual(json.bytes)
  })

  it('does not route Office package bytes through JSON raw-source line paging', async () => {
    const word = seed('document.docx', await createDocx({ markdown: '# Office\n\nActual document body.' }))
    const reader = vi.spyOn(handlerRegistry.getHandler(word.path), 'read')
    const result = await readFileTool.execute({ files: [{ path: word.path }] }, ctx)
    expect(result.success, result.output).toBe(true)
    expect(reader).toHaveBeenCalledTimes(1)
    const output = decodeBatch(result).files[0].output
    expect(typeof output).toBe('string')
    expect(output).toContain('Actual document body.')
    expect(output).not.toContain('numberedContent')
    expect((result.metadata?.files as Record<string, unknown>[])[0]).not.toHaveProperty('startLine')
    expect(fs.readFileSync(word.path)).toEqual(word.bytes)
  })

  it('keeps XLSX on the spreadsheet reader while CSV uses raw source pages', async () => {
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['编号', '说明'], ['001', '中🙂,"引号"']]), '实际表格')
    const xlsx = seed('actual.xlsx', XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }))
    const reader = vi.spyOn(handlerRegistry.getHandler(xlsx.path), 'read')
    const result = await readFileTool.execute({ files: [{ path: xlsx.path }] }, ctx)
    expect(result.success, result.output).toBe(true)
    expect(reader).toHaveBeenCalledTimes(1)
    const output = decodeBatch(result).files[0].output
    expect(typeof output).toBe('string')
    expect(output).toContain('[Excel(.xlsx) Sheet:实际表格,Rows:2]')
    expect(output).toContain('中🙂,"引号"')
    expect(output).not.toContain('numberedContent')
    expect(fs.readFileSync(xlsx.path)).toEqual(xlsx.bytes)
  })

  it('does not claim numbered source pages for binary bytes renamed as JSON', async () => {
    const json = seed('binary.json', Buffer.from([0xff, 0xfe, 0x00, 0x7b, 0x80, 0x00, 0x7d]))
    const result = await readFileTool.execute({ files: [{ path: json.path }] }, ctx)
    const output = decodeBatch(result).files[0].output
    expect(typeof output === 'object' && output !== null && 'numberedContent' in output).toBe(false)
    const continued = await readFileTool.execute({ path: json.path, start_line: 1, start_column: 2 }, ctx)
    expect(continued.success).toBe(false)
    expect(continued.metadata ?? {}).not.toHaveProperty('nextStartLine')
    expect(fs.readFileSync(json.path)).toEqual(json.bytes)
  })
})
