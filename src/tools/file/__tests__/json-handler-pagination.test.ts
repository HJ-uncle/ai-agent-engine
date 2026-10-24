/** Source-line JSON pages, compatibility and real read_file full-byte identity. No engine/UI/model. */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext } from '../../../core/agent-context/index.js'
import { clearSecurityMode, setSecurityMode } from '../../../security/policy-engine.js'
import { hashFileContent } from '../../../shared/file-version.js'
import { JsonHandler } from '../handlers/json-handler.js'
import { readFileTool } from '../super-file-tool.js'

const scratch = path.resolve('.e2e-tmp'), handler = new JsonHandler()
let directory: string, file: string, ctx: AgentContext
beforeEach(() => {
  fs.mkdirSync(scratch, { recursive: true })
  directory = fs.realpathSync.native(fs.mkdtempSync(path.join(scratch, 'json-source-page-')))
  file = path.join(directory, 'source.json')
  vi.stubEnv('AUTH_ENABLED', 'false')
  ctx = { tenantId: 'json-source-page', sessionId: path.basename(directory), workspacePaths: [directory], projectRoot: directory, cwd: directory,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as unknown as AgentContext
  setSecurityMode(ctx.tenantId, ctx.sessionId, 'safe')
})
afterEach(() => {
  clearSecurityMode(ctx.tenantId, ctx.sessionId); vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (path.dirname(directory) !== fs.realpathSync.native(scratch) || !path.basename(directory).startsWith('json-source-page-')) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
})
const seed = (raw: string) => { fs.writeFileSync(file, raw); return raw }

describe('JSON explicit pagination uses original source lines', () => {
  it.each(['auto', 'summary'] as const)('returns distinct source pages without JSON reformatting in %s', async mode => {
    seed('{\n  "role" : "sales",\n\n  "revision": "v002"\n}\n')
    const first = await handler.read(file, ctx, { mode, startLine: 2, endLine: 3 })
    const second = await handler.read(file, ctx, { mode, startLine: 4, endLine: 5 })
    expect(first).toMatchObject({ type: 'text', data: '  "role" : "sales",\n' })
    expect(first.content).toContain('第 2-3 行，共 6 行')
    expect(first.content?.split('\n').slice(1)).toEqual(['2 |   "role" : "sales",', '3 | '])
    expect(second.content?.split('\n').slice(1)).toEqual(['4 |   "revision": "v002"', '5 | }'])
    expect(second.content).not.toContain('sales')
  })

  it.each(['\n', '\r\n', '\r'])('counts %j as one source separator and preserves BOM, whitespace and trailing blank line', async ending => {
    seed('\ufeff{' + ending + '\t"value": "界🙂"' + ending + '}' + ending)
    const first = await handler.read(file, ctx, { startLine: 1, endLine: 2 })
    const tail = await handler.read(file, ctx, { startLine: 3, endLine: 4 })
    expect(first.data).toBe('\ufeff{\n\t"value": "界🙂"')
    expect(first.content?.split('\n').slice(1)).toEqual(['1 | \ufeff{', '2 | \t"value": "界🙂"'])
    expect(tail.content).toContain('第 3-4 行，共 4 行')
    expect(tail.content?.split('\n').slice(1)).toEqual(['3 | }', '4 | '])
  })

  it('supports mixed endings without inventing lines for CRLF', async () => {
    seed('{\r\n"a": 1,\r"b": 2\n}')
    const page = await handler.read(file, ctx, { startLine: 2, endLine: 3 })
    expect(page.content?.split('\n').slice(1)).toEqual(['2 | "a": 1,', '3 | "b": 2'])
    expect(page.content).toContain('共 4 行')
  })

  it('defaults an omitted start to 1 and an omitted end to at most 300 source lines', async () => {
    seed(Array.from({ length: 401 }, (_, index) => 'source-' + (index + 1)).join('\n'))
    expect((await handler.read(file, ctx, { endLine: 1 })).content?.split('\n').slice(1)).toEqual(['1 | source-1'])
    const page = await handler.read(file, ctx, { startLine: 3 })
    expect(page.content).toContain('第 3-302 行，共 401 行')
    expect(page.content?.split('\n')).toHaveLength(301)
    expect(page.content?.split('\n').at(-1)).toBe('302 | source-302')
  })

  it('clamps an end beyond EOF, returns the last actual line, and rejects a start beyond EOF', async () => {
    seed('{\n"a":1\n}')
    const page = await handler.read(file, ctx, { startLine: 3, endLine: 100 })
    expect(page.content).toContain('第 3-3 行，共 3 行')
    expect(page.data).toBe('}')
    await expect(handler.read(file, ctx, { startLine: 4 })).rejects.toThrow('beyond the file')
  })

  it('treats an empty file as one empty source line, matching exact reading', async () => {
    seed('')
    const page = await handler.read(file, ctx, { startLine: 1, endLine: 1 })
    expect(page.data).toBe('')
    expect(page.content).toContain('第 1-1 行，共 1 行')
    expect(page.content?.split('\n').at(-1)).toBe('1 | ')
  })

  it('pages malformed JSON without returning the entire file through the parse fallback', async () => {
    seed('{\n invalid input\n private tail')
    const page = await handler.read(file, ctx, { startLine: 2, endLine: 2 })
    expect(page.data).toBe(' invalid input')
    expect(page.content).not.toContain('private tail')
  })

  it('keeps sparse long lines intact instead of applying the legacy 30000-character JSON cut', async () => {
    const large = 'x'.repeat(35000)
    seed('{\n\n "large":"' + large + '",\n\n "last":1\n}')
    const empty = await handler.read(file, ctx, { startLine: 2, endLine: 2 })
    const page = await handler.read(file, ctx, { startLine: 3, endLine: 3 })
    expect(empty.data).toBe('')
    expect(page.data).toBe(' "large":"' + large + '",')
    expect(page.content).toContain('第 3-3 行，共 6 行')
    expect(page.content).not.toContain('截断')
    expect(page.content).not.toContain('"last"')
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])('rejects invalid line argument %s instead of falling back to full content', async value => {
    seed('{"secret":"not a fallback"}')
    await expect(handler.read(file, ctx, { startLine: value })).rejects.toThrow('positive safe integers')
    await expect(handler.read(file, ctx, { endLine: value })).rejects.toThrow('positive safe integers')
  })

  it('rejects a reversed explicit interval', async () => {
    seed('{\n"a":1\n}')
    await expect(handler.read(file, ctx, { startLine: 3, endLine: 2 })).rejects.toThrow('must not be before')
  })
})

describe('unpaged JSON compatibility and outer file identity', () => {
  it.each([{ startLine: 2, endLine: 2 }, { startLine: -1, endLine: Number.NaN }])('keeps full mode authoritative over range %j', async range => {
    const value = { role: 'sales', revision: 'v002' }; seed(JSON.stringify(value, null, 4))
    expect(await handler.read(file, ctx, { mode: 'full', ...range })).toEqual({ type: 'json', data: value, content: JSON.stringify(value, null, 2) })
  })

  it('keeps unpaged auto/summary minified and full pretty-printed', async () => {
    const value = { role: 'sales', rows: [{ id: 1 }] }
    seed(JSON.stringify(value, null, 4))
    for (const mode of ['auto', 'summary'] as const)
      expect(await handler.read(file, ctx, { mode })).toEqual({ type: 'json', data: value, content: JSON.stringify(value) })
    expect(await handler.read(file, ctx, { mode: 'full' })).toEqual({ type: 'json', data: value, content: JSON.stringify(value, null, 2) })
  })

  it('preserves the existing unpaged auto size guard and full output', async () => {
    const value = { content: 'x'.repeat(35000) }; seed(JSON.stringify(value))
    expect((await handler.read(file, ctx)).content).toContain('JSON内容过长已截断')
    expect((await handler.read(file, ctx, { mode: 'full' })).content).toBe(JSON.stringify(value, null, 2))
  })

  it('returns full raw-byte expectedHash on every real read_file page including CRLF/BOM', async () => {
    const raw = seed('\ufeff{\r\n  "role":"sales",\r\n  "revision":"v002"\r\n}\r\n')
    const expectedHash = hashFileContent(raw)
    for (const [start, end] of [[1, 2], [3, 5]]) {
      const result = await readFileTool.execute({ path: file, mode: 'auto', start_line: start, end_line: end }, ctx)
      expect(result).toMatchObject({ success: true, metadata: { path: file, expectedHash, lineEnding: 'CRLF', utf8Bom: true } })
      expect(result.output).toContain(`第 ${start}-${end} 行，共 5 行`)
      expect(result.output).toContain(expectedHash)
    }
    expect(fs.readFileSync(file, 'utf8')).toBe(raw)
    const invalid = await readFileTool.execute({ path: file, mode: 'auto', start_line: -1, end_line: 1 }, ctx)
    expect(invalid.success).toBe(false)
    expect(invalid.output).toContain('positive safe integers')
    expect(invalid.output).not.toContain('sales')
  })
})
