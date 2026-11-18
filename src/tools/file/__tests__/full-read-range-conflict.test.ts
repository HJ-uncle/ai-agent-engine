/** Reproduce full+range head-page loops without a model; retry actual tool receipts against isolated source files. */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext } from '../../../core/agent-context/index.js'
import { boundedToolContext, getToolOutputLimit } from '../../../core/agent-loop/tool-output-limit.js'
import { clearSecurityMode, setSecurityMode } from '../../../security/policy-engine.js'
import { hashFileContent } from '../../../shared/file-version.js'
import { JsonHandler } from '../handlers/json-handler.js'
import { TextHandler } from '../handlers/text-handler.js'
import { readFileTool } from '../super-file-tool.js'
import { readTextPage } from '../text-page.js'

const scratch = path.resolve('.e2e-tmp', 'full-read-range-conflict')
let root: string, ctx: AgentContext
beforeEach(() => {
  fs.mkdirSync(scratch, { recursive: true })
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(scratch, 'full-range-')))
  vi.stubEnv('AUTH_ENABLED', 'false')
  vi.stubEnv('TOOL_OUTPUT_MAX_CHARS', '1800')
  vi.stubEnv('CODE_TOOL_OUTPUT_MAX_CHARS', '4000')
  vi.stubEnv('OSM_MODE', 'off')
  ctx = { tenantId: 'full-range', sessionId: path.basename(root), workspacePaths: [root], projectRoot: root, cwd: root,
    toolProfile: 'general', tools: { preflight: vi.fn(async () => undefined) },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as unknown as AgentContext
  setSecurityMode(ctx.tenantId, ctx.sessionId, 'safe')
})
afterEach(() => {
  clearSecurityMode(ctx.tenantId, ctx.sessionId)
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (path.dirname(root) !== fs.realpathSync.native(scratch) || !path.basename(root).startsWith('full-range-')) throw new Error('Unsafe full-range cleanup')
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
})
function seed(name: string, source: string) {
  const file = path.join(root, name)
  fs.writeFileSync(file, source)
  return file
}
const fixtures = [
  { name: 'source.txt', source: '\uFEFFhead\r\nsecond\r\nthird\r\ntail\r\n', selected: '2 | second\n3 | third' },
  { name: 'source.json', source: '{\r\n  "label": "中🙂",\r\n  "count": 2\r\n}\r\n', selected: '2 |   "label": "中🙂",\n3 |   "count": 2' },
  { name: 'source.csv', source: '\uFEFF编号,说明\r\n001,"中\r\n🙂"\r\n002,tail\r\n', selected: '2 | 001,"中\n3 | 🙂"' },
]

describe('full reading cannot silently discard an explicit range', () => {
  it.each(fixtures)('rejects a single $name conflict and supplies an executable source-page retry', async ({ name, source, selected }) => {
    const file = seed(name, source)
    const args = { path: file, mode: 'full', start_line: 2, end_line: 3 }
    expect(await readFileTool.preflight!(args, ctx)).toMatchObject({ success: false, error: 'FULL_READ_RANGE_CONFLICT' })
    const result = await readFileTool.execute(args, ctx)
    expect(result).toMatchObject({ success: false, error: 'FULL_READ_RANGE_CONFLICT', metadata: { fileMutationApplied: false } })
    const error = JSON.parse(result.output)
    expect(error).toMatchObject({ code: 'FULL_READ_RANGE_CONFLICT', retryWith: { path: file, mode: 'auto', start_line: 2, end_line: 3 } })
    expect(error).not.toHaveProperty('numberedContent')
    const retry = await readFileTool.execute(error.retryWith, ctx)
    expect(retry.success, retry.output).toBe(true)
    expect(JSON.parse(retry.output)).toMatchObject({ numberedContent: selected, startLine: 2, endLine: 3, hasMore: false,
      rangeIsComplete: true, contentIsComplete: false, expectedHash: hashFileContent(source) })
    expect(fs.readFileSync(file, 'utf8')).toBe(source)
  })

  it.each(fixtures)('rejects a batch $name conflict before reading any sibling', async ({ name, source, selected }) => {
    const file = seed(name, source), sibling = seed('sibling.txt', 'SIBLING_MUST_NOT_BE_READ')
    const args = { files: [{ path: sibling }, { path: file, mode: 'full', start_line: 2, end_line: 3 }] }
    const versionReads = vi.spyOn(fs, 'readFileSync')
    expect(await readFileTool.preflight!(args, ctx)).toMatchObject({ success: false, error: 'FULL_READ_RANGE_CONFLICT', metadata: { batch: true, itemIndex: 1 } })
    const result = await readFileTool.execute(args, ctx)
    expect(result).toMatchObject({ success: false, error: 'FULL_READ_RANGE_CONFLICT', metadata: { batch: true, itemIndex: 1 } })
    expect(versionReads).not.toHaveBeenCalled()
    versionReads.mockRestore()
    expect(result.output).not.toContain('SIBLING_MUST_NOT_BE_READ')
    const { retryWith } = JSON.parse(result.output)
    const retry = await readFileTool.execute({ files: [retryWith] }, ctx)
    expect(retry.success, retry.output).toBe(true)
    expect(JSON.parse(retry.output).files[0].output).toMatchObject({ numberedContent: selected, startLine: 2, endLine: 3 })
  })

  it.each([{ start_line: 2 }, { end_line: 2 }, { start_column: 2 }])('rejects full with just %j and preserves the explicit value in its retry', async range => {
    const file = seed('range.txt', 'first\nsecond\nthird')
    const result = await readFileTool.execute({ path: file, mode: 'full', ...range }, ctx)
    expect(result).toMatchObject({ success: false, error: 'FULL_READ_RANGE_CONFLICT' })
    expect(JSON.parse(result.output).retryWith).toEqual({ path: file, mode: 'auto', ...range })
    const retry = await readFileTool.execute(JSON.parse(result.output).retryWith, ctx)
    expect(retry.success, retry.output).toBe(true)
  })

  it('also rejects the ambiguous legacy single-text call without expanding its output contract', async () => {
    const file = seed('legacy.txt', 'first\nsecond\nthird'), code = { ...ctx, toolProfile: 'code' } as AgentContext
    const conflict = await readFileTool.execute({ path: file, mode: 'full', start_line: 2, end_line: 2 }, code)
    expect(conflict).toMatchObject({ success: false, error: 'FULL_READ_RANGE_CONFLICT' })
    const retry = await readFileTool.execute(JSON.parse(conflict.output).retryWith, code)
    expect(retry.output).toContain('   2 | second')
    expect(retry.output).not.toContain('   1 | first')
    expect(() => JSON.parse(retry.output)).toThrow()
    expect(await readFileTool.execute({ path: file, mode: 'auto', start_column: 2 }, code)).toMatchObject({ success: false, error: 'COLUMN_PAGING_UNSUPPORTED' })
  })

  it('recovers a long Unicode source after the first full page without replaying its head', async () => {
    const lines = Array.from({ length: 22 }, (_, index) => `${index}: ${'中🙂"\\'.repeat(18)}`)
    const file = seed('large.txt', lines.join('\r\n'))
    const first = await readFileTool.execute({ path: file, mode: 'full' }, ctx)
    expect(first.success, first.output).toBe(true)
    let page = JSON.parse(first.output)
    const received = [...page.numberedContent.split('\n').map((line: string) => line.replace(/^\d+ \| /, ''))]
    expect(page.hasMore).toBe(true)
    let count = 1
    while (page.hasMore) {
      const conflict = await readFileTool.execute({ path: file, mode: 'full', start_line: page.nextStartLine, start_column: page.nextStartColumn }, ctx)
      expect(conflict).toMatchObject({ success: false, error: 'FULL_READ_RANGE_CONFLICT' })
      const retry = await readFileTool.execute(JSON.parse(conflict.output).retryWith, ctx)
      expect(retry.success, retry.output).toBe(true)
      const next = JSON.parse(retry.output)
      expect(next.startLine).toBe(page.nextStartLine)
      expect(next.startColumn).toBe(page.nextStartColumn)
      expect(retry.output.length).toBeLessThanOrEqual(getToolOutputLimit(ctx.toolProfile, ctx))
      received.push(...next.numberedContent.split('\n').map((line: string) => line.replace(/^\d+ \| /, '')))
      page = next
      expect(++count).toBeLessThan(30)
    }
    expect(count).toBeGreaterThan(1)
    expect(received).toEqual(lines)
  })

  it('keeps conflict JSON valid inside tiny budgets instead of cutting executable arguments', async () => {
    const file = seed('tiny.txt', 'source')
    for (const limit of [1, 2, 60, 200, 600]) {
      const bounded = boundedToolContext(ctx, limit)
      const result = await readFileTool.execute({ path: file, mode: 'full', start_line: 1 }, bounded)
      expect(result).toMatchObject({ success: false, error: 'FULL_READ_RANGE_CONFLICT' })
      expect(result.output.length).toBeLessThanOrEqual(limit)
      expect(() => JSON.parse(result.output)).not.toThrow()
    }
  })

  it.each([{ start_line: 0 }, { end_line: 1.5 }, { start_line: 3, end_line: 2 }])('never suggests an invalid executable retry for %j', async range => {
    const file = seed('invalid.txt', 'MUST_NOT_READ')
    const result = await readFileTool.execute({ path: file, mode: 'full', ...range }, ctx)
    expect(result).toMatchObject({ success: false, error: 'FULL_READ_RANGE_CONFLICT' })
    expect(JSON.parse(result.output)).not.toHaveProperty('retryWith')
    expect(result.output).not.toContain('MUST_NOT_READ')
  })

  it('rejects a direct source-page conflict without fabricating a successful page or cursor', () => {
    const result = readTextPage({ text: 'first\nsecond', version: { path: 'direct', expectedHash: hashFileContent('first\nsecond') },
      maxChars: 1200, mode: 'full', startLine: 2 })
    expect(result).toMatchObject({ success: false, error: 'FULL_READ_RANGE_CONFLICT' })
    expect(result.metadata).not.toHaveProperty('nextStartLine')
    expect(JSON.parse(result.output)).not.toHaveProperty('numberedContent')
  })

  it('does not preserve a silent full override inside the source handlers either', async () => {
    const text = seed('handler.txt', 'first\nsecond'), json = seed('handler.json', '{\n"a":1\n}')
    await expect(new TextHandler().read(text, ctx, { mode: 'full', startLine: 2 })).rejects.toThrow('mode="auto"')
    await expect(new JsonHandler().read(json, ctx, { mode: 'full', endLine: 2 })).rejects.toThrow('mode="auto"')
  })
})
