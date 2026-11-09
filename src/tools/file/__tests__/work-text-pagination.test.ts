import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext } from '../../../core/agent-context/index.js'
import { getToolOutputLimit } from '../../../core/agent-loop/tool-output-limit.js'
import { truncateToolOutput } from '../../../core/agent-loop/react.js'
import { clearSecurityMode, setSecurityMode } from '../../../security/policy-engine.js'
import { hashFileContent } from '../../../shared/file-version.js'
import { listFilesTool } from '../basic.js'
import { readFileTool } from '../super-file-tool.js'
import { readTextPage } from '../text-page.js'

let root: string, ctx: AgentContext
beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'aether-work-page-')))
  vi.stubEnv('AUTH_ENABLED', 'false')
  vi.stubEnv('TOOL_OUTPUT_MAX_CHARS', '1200')
  ctx = { tenantId: 'work-page', sessionId: path.basename(root), workspacePaths: [root], projectRoot: root, cwd: root, toolProfile: 'general',
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as unknown as AgentContext
  setSecurityMode(ctx.tenantId, ctx.sessionId, 'safe')
})
afterEach(() => {
  clearSecurityMode(ctx.tenantId, ctx.sessionId)
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (path.dirname(root) !== fs.realpathSync.native(os.tmpdir()) || !path.basename(root).startsWith('aether-work-page-')) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
})

function seed(value: string, name = 'source.txt') {
  const file = path.join(root, name)
  fs.writeFileSync(file, value)
  return file
}
async function readPage(file: string, range: Record<string, unknown> = {}) {
  const result = await readFileTool.execute({ path: file, ...range }, ctx)
  expect(result.success, result.output).toBe(true)
  expect(result.output.length).toBeLessThanOrEqual(getToolOutputLimit(ctx.toolProfile))
  expect(truncateToolOutput(result.output, getToolOutputLimit(ctx.toolProfile))).toBe(result.output)
  return JSON.parse(result.output)
}

describe('Work text pages keep every source line inside the runtime output cap', () => {
  it('reads a small file completely with its byte identity and no default 300-line split', async () => {
    vi.stubEnv('TOOL_OUTPUT_MAX_CHARS', '10000')
    const raw = Array.from({ length: 309 }, (_, i) => String(i)).join('\n')
    const page = await readPage(seed(raw))
    expect(page).toMatchObject({ startLine: 1, endLine: 309, totalLines: 309, hasMore: false, nextStartLine: null,
      nextStartColumn: null, rangeIsComplete: true, contentIsComplete: true, byteLength: Buffer.byteLength(raw), expectedHash: hashFileContent(raw) })
    expect(page.numberedContent.split('\n').at(-1)).toBe('309 | 308')
  })

  it('returns continuous whole-line pages without hidden middle sections or repeated lines', async () => {
    const lines = Array.from({ length: 309 }, (_, i) => `line-${i + 1} ${'中🙂"\\'.repeat(8)}`)
    const raw = lines.join('\r\n'), file = seed(raw)
    const received: string[] = []
    let startLine = 1, count = 0
    do {
      const page = await readPage(file, { start_line: startLine })
      expect(page).toMatchObject({ startLine, startColumn: 1, partialLine: false, utf8Bom: false,
        lineEnding: 'CRLF', byteLength: Buffer.byteLength(raw), expectedHash: hashFileContent(raw) })
      received.push(...page.numberedContent.split('\n').map((line: string) => line.replace(/^\d+ \| /, '')))
      count++
      expect(count).toBeLessThan(100)
      if (!page.hasMore) break
      expect(page.nextStartLine).toBe(page.endLine + 1)
      expect(page.nextStartColumn).toBe(1)
      startLine = page.nextStartLine
    } while (true)
    expect(count).toBeGreaterThan(1)
    expect(received).toEqual(lines)
  })

  it('distinguishes a completed requested range from the whole file and validates offsets', async () => {
    const file = seed('\uFEFFalpha\r\nbeta\rgamma\nlast\n')
    expect(await readPage(file, { start_line: 2, end_line: 3 })).toMatchObject({ numberedContent: '2 | beta\n3 | gamma',
      totalLines: 5, requestedEndLine: 3, hasMore: false, rangeIsComplete: true, contentIsComplete: false, utf8Bom: true, lineEnding: 'mixed' })
    for (const range of [{ start_line: 0 }, { start_line: 6 }, { end_line: 1.5 }, { start_line: 3, end_line: 2 }, { start_column: 100 }]) {
      expect(await readFileTool.execute({ path: file, ...range }, ctx)).toMatchObject({ success: false, error: 'INVALID_READ_RANGE' })
    }
  })

  it('resumes a long line containing Chinese, emoji and JSON escapes without splitting surrogate pairs', async () => {
    const raw = '\uFEFF' + '中🙂"\\\t'.repeat(1200), file = seed(raw)
    let content = '', startColumn = 1, count = 0
    do {
      const page = await readPage(file, { start_line: 1, start_column: startColumn })
      const piece = page.numberedContent.replace(/^1 \| /, '')
      expect(page).toMatchObject({ startLine: 1, startColumn, columnUnit: 'utf16', partialLine: true, expectedHash: hashFileContent(raw) })
      expect(piece).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u)
      content += piece
      count++
      expect(count).toBeLessThan(100)
      if (!page.hasMore) break
      expect(page.nextStartLine).toBe(1)
      expect(page.nextStartColumn).toBe(startColumn + piece.length)
      startColumn = page.nextStartColumn
    } while (true)
    expect(content).toBe(raw)
    expect(count).toBeGreaterThan(1)
    expect(await readFileTool.execute({ path: file, start_column: 4 }, ctx)).toMatchObject({ success: false, error: 'INVALID_READ_RANGE' })
  })

  it('returns the preceding complete line before beginning a long line, then reads its suffix and following lines', async () => {
    const long = '🙂'.repeat(1800), file = seed(`first\n${long}\nlast`)
    const first = await readPage(file)
    expect(first).toMatchObject({ numberedContent: '1 | first', endLine: 1, nextStartLine: 2, nextStartColumn: 1, partialLine: false })
    const partial = await readPage(file, { start_line: 2 })
    expect(partial).toMatchObject({ startLine: 2, endLine: 2, partialLine: true, nextStartLine: 2 })
    const tail = await readPage(file, { start_line: 2, start_column: long.length - 3 })
    expect(tail).toMatchObject({ numberedContent: '2 | 🙂🙂\n3 | last', partialLine: true, hasMore: false, rangeIsComplete: true })
  })

  it('keeps full as a request from the beginning and resumes subsequent pages with auto', async () => {
    const file = seed(Array.from({ length: 60 }, (_, i) => `${i}: ${'x'.repeat(150)}`).join('\n'))
    const full = await readPage(file, { mode: 'full', start_line: 20, end_line: 20 })
    expect(full).toMatchObject({ startLine: 1, requestedEndLine: 60, hasMore: true })
    const next = await readPage(file, { start_line: full.nextStartLine, start_column: full.nextStartColumn })
    expect(next.startLine).toBe(full.endLine + 1)
  })

  it('keeps exact bytes and Code behavior, rejecting unsupported column paging explicitly', async () => {
    const raw = '\uFEFFa\r\nb\r\n', file = seed(raw)
    const exact = await readFileTool.execute({ path: file, mode: 'exact' }, ctx)
    expect(JSON.parse(exact.output)).toMatchObject({ content: raw, contentIsComplete: true, expectedHash: hashFileContent(raw) })
    const code = { ...ctx, toolProfile: 'code' } as AgentContext
    expect((await readFileTool.execute({ path: file, mode: 'full' }, code)).output).toContain('   2 | b\r')
    for (const mode of ['exact', 'full', 'summary']) {
      expect(await readFileTool.execute({ path: file, mode, start_column: 1 }, ctx)).toMatchObject({ success: false, error: 'COLUMN_PAGING_UNSUPPORTED' })
    }
    expect(await readFileTool.execute({ path: file, start_column: 1 }, code)).toMatchObject({ success: false, error: 'COLUMN_PAGING_UNSUPPORTED' })
    const json = seed('{"a":1}', 'data.json')
    expect(await readFileTool.execute({ path: json, start_column: 1 }, ctx)).toMatchObject({ success: false, error: 'COLUMN_PAGING_UNSUPPORTED' })
    expect((await readFileTool.execute({ path: json }, ctx)).output).toContain('[读取监控]')
  })

  it('reports an impossibly small output budget without a false success or non-progress cursor', () => {
    for (const maxChars of [1, 2, 40, 200]) {
      const result = readTextPage({ text: '🙂'.repeat(500), version: { path: 'test', expectedHash: 'sha256:' + 'a'.repeat(64) }, maxChars, mode: 'auto' })
      expect(result).toMatchObject({ success: false, error: 'OUTPUT_BUDGET_TOO_SMALL' })
      expect(result.output.length).toBeLessThanOrEqual(maxChars)
      expect(() => JSON.parse(result.output)).not.toThrow()
      expect(result.metadata).not.toHaveProperty('nextStartLine')
    }
  })

  it('makes bounded Unicode progress even when only a few characters fit beside the receipt', () => {
    const raw = '🙂中"\\\t'.repeat(10)
    let startColumn = 1, received = '', pages = 0
    do {
      const result = readTextPage({ text: raw, version: { path: 'test', expectedHash: 'sha256:' + 'a'.repeat(64) },
        maxChars: 450, mode: 'auto', startColumn })
      expect(result.success, result.output).toBe(true)
      expect(result.output.length).toBeLessThanOrEqual(450)
      const page = JSON.parse(result.output), piece = page.numberedContent.replace(/^1 \| /, '')
      expect(piece.length).toBeGreaterThan(0)
      expect(piece).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u)
      received += piece
      expect(++pages).toBeLessThan(100)
      if (!page.hasMore) break
      expect(page.nextStartColumn).toBeGreaterThan(startColumn)
      startColumn = page.nextStartColumn
    } while (true)
    expect(received).toBe(raw)
    expect(pages).toBeGreaterThan(1)
  })

  it('exposes actual byte sizes for batch planning without changing the default listing', async () => {
    seed('中🙂', 'unicode.txt')
    seed('', 'empty.txt')
    const ordinary = await listFilesTool.execute({ path: root }, ctx)
    expect(ordinary.output.split('\n').sort()).toEqual(['empty.txt', 'unicode.txt'])
    const sized = await listFilesTool.execute({ path: root, includeSizes: true }, ctx)
    expect(sized.output.split('\n').sort()).toEqual(['empty.txt\t0 B', 'unicode.txt\t7 B'])
  })
})
