import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as XLSX from 'xlsx'
import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext } from '../../../core/agent-context/index.js'
import * as database from '../../../storage/sqlite/db.js'
import { ChangeStore } from '../../../storage/changes/index.js'
import { clearSecurityMode, setSecurityMode } from '../../../security/policy-engine.js'
import { hashFileContent } from '../../../shared/file-version.js'
import { readFileTool } from '../super-file-tool.js'
import { editFileTool } from '../edit-file.js'

let root: string, db: Client, ctx: AgentContext, store: ChangeStore
beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'aether-csv-read-')))
  vi.stubEnv('AUTH_ENABLED', 'false')
  vi.stubEnv('DATA_DIR', path.join(root, 'agent.db'))
  db = createClient({ url: 'file::memory:' })
  vi.spyOn(database, 'getDb').mockReturnValue(db)
  store = new ChangeStore()
  ctx = { tenantId: 'csv-read-tenant', sessionId: path.basename(root), rootSessionId: path.basename(root), rootRunId: 'csv-run', turnId: 'csv-turn',
    workspacePaths: [root], projectRoot: root, cwd: root, scratchDir: path.join(root, 'scratch'),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as unknown as AgentContext
  setSecurityMode(ctx.tenantId, ctx.sessionId, 'safe')
})
afterEach(() => {
  clearSecurityMode(ctx.tenantId, ctx.sessionId)
  db.close(); vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (path.dirname(root) !== fs.realpathSync.native(os.tmpdir()) || !path.basename(root).startsWith('aether-csv-read-')) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
})

// Strip only display numbering; the line bytes (including BOM/CR/quotes) remain.
function displayedSource(output: string): string {
  const marker = output.indexOf('[文件: ')
  expect(marker).toBeGreaterThanOrEqual(0)
  return output.slice(output.indexOf('\n', marker) + 1).replace(/^ *\d+ \| /gm, '')
}

describe('delimited text reading keeps source bytes and a usable edit contract', () => {
  for (const extension of ['.csv', '.tsv']) {
    const delimiter = extension === '.csv' ? ',' : '\t'
    const contents = [
      ['Chinese, quotes and literals', `编号${delimiter}说明${delimiter}值\nFR-11${delimiter}"死子,确认"${delimiter}001.00\nFR-12${delimiter}"含""引号"""${delimiter}2026-11-03`],
      ['BOM, CRLF and quoted multiline', `\uFEFF编号${delimiter}说明\r\nFR-11${delimiter}"死子\r\n确认"\r\n`],
      ['empty file', ''],
    ]
    for (const [label, original] of contents) {
      it.each(['auto', 'summary', 'full'])(`${extension} ${label} preserves UTF-8 text in %s mode`, async mode => {
        const file = path.join(root, `source${extension}`)
        const bytes = Buffer.from(original)
        fs.writeFileSync(file, bytes)
        const result = await readFileTool.execute({ path: file, mode }, ctx)
        expect(result, result.output).toMatchObject({ success: true, metadata: { expectedHash: hashFileContent(bytes), encoding: 'utf-8', utf8Bom: original.startsWith('\uFEFF') } })
        expect(displayedSource(result.output)).toBe(original)
        expect(result.output).not.toContain('[Excel(')
        expect(fs.readFileSync(file)).toEqual(bytes)
        expect(await store.list(ctx.tenantId, ctx.sessionId)).toHaveLength(0)
      })
    }
    it(`${extension} pages physical source lines without reparsing multiline fields`, async () => {
      const file = path.join(root, `page${extension}`)
      const original = `编号${delimiter}说明\r\nFR-11${delimiter}"死子\r\n确认"\r\nFR-12${delimiter}悔棋\r\n`
      fs.writeFileSync(file, original)
      const result = await readFileTool.execute({ path: file, start_line: 2, end_line: 3 }, ctx)
      expect(result.success).toBe(true)
      if (extension === '.csv') {
        expect(JSON.parse(result.output)).toMatchObject({
          numberedContent: '2 | FR-11,"死子\n3 | 确认"', startLine: 2, endLine: 3,
          totalLines: 5, hasMore: false, rangeIsComplete: true, contentIsComplete: false,
        })
      } else {
        expect(result.output).toContain(`   2 | FR-11${delimiter}"死子\r\n   3 | 确认"\r`)
      }
      expect(result.output).not.toContain('FR-12')
      expect(result.metadata).toMatchObject({ expectedHash: hashFileContent(original), lineEnding: 'CRLF' })
      expect(fs.readFileSync(file, 'utf8')).toBe(original)
      expect(await store.list(ctx.tenantId, ctx.sessionId)).toEqual([])
    })
    it(`${extension} supports exact read -> conditional edit without losing BOM or CRLF`, async () => {
      const file = path.join(root, `edit${extension}`)
      const original = `\uFEFF编号${delimiter}说明\r\nFR-11${delimiter}"死子,确认"\r\nFR-12${delimiter}"悔棋"\r\n`
      fs.writeFileSync(file, original)
      const read = await readFileTool.execute({ path: file, mode: 'exact', start_line: 2, end_line: 2 }, ctx)
      const page = JSON.parse(read.output)
      expect(page).toMatchObject({ content: `FR-11${delimiter}"死子,确认"\r\n`, expectedHash: hashFileContent(original), utf8Bom: true, lineEnding: 'CRLF' })
      const replacement = `FR-11${delimiter}"确认后重算归属"\r\n`
      const edit = await editFileTool.execute({ path: file, expectedHash: page.expectedHash, edits: [{ oldText: page.content, newText: replacement }] }, ctx)
      expect(edit, edit.output).toMatchObject({ success: true })
      const expected = original.replace(page.content, replacement)
      expect(fs.readFileSync(file)).toEqual(Buffer.from(expected))
      expect(await store.list(ctx.tenantId, ctx.sessionId)).toHaveLength(1)
      const fresh = await readFileTool.execute({ path: file, mode: 'full' }, ctx)
      expect(displayedSource(fresh.output)).toBe(expected)
      expect(fresh.metadata).toMatchObject({ expectedHash: hashFileContent(expected) })
    })
    it(`${extension} refuses invalid UTF-8 instead of returning replacement characters`, async () => {
      const file = path.join(root, `legacy${extension}`), bytes = Buffer.from([0xb1, 0xe0, 0xba, 0xc5, 0x2c, 0x31])
      fs.writeFileSync(file, bytes)
      const result = await readFileTool.execute({ path: file }, ctx)
      expect(result).toMatchObject({ success: false, error: 'TEXT_ENCODING_UNSUPPORTED', metadata: { expectedHash: hashFileContent(bytes), fileMutationApplied: false } })
      expect(result.output).not.toContain('\uFFFD')
      expect(fs.readFileSync(file)).toEqual(bytes)
    })
  }
  it.each(['xls', 'xlsx'] as const)('still reads real binary %s workbooks through spreadsheet parsing', async bookType => {
    const file = path.join(root, `workbook.${bookType}`), workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['需求', '值'], ['死子确认', 7.5]]), '规则')
    XLSX.writeFile(workbook, file, { bookType })
    const bytes = fs.readFileSync(file)
    const result = await readFileTool.execute({ path: file }, ctx)
    expect(result.success).toBe(true)
    expect(result.output).toContain(`[Excel(.${bookType}) Sheet:规则,Rows:2]`)
    expect(result.output).toContain('死子确认,7.5')
    expect(result.metadata).toMatchObject({ expectedHash: hashFileContent(bytes), encoding: 'binary-or-non-utf8' })
    expect(fs.readFileSync(file)).toEqual(bytes)
  })
})
