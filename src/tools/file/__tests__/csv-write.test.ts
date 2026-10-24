/** Real write_file -> handler -> conditional publication -> change store.
 * Regresses the office run that reported success after discarding CSV text.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as database from '../../../storage/sqlite/db.js'
import { ChangeStore } from '../../../storage/changes/index.js'
import type { AgentContext } from '../../../core/agent-context/index.js'
import { clearSecurityMode, setSecurityMode } from '../../../security/policy-engine.js'
import { hashFileContent } from '../../../shared/file-version.js'
import { writeFileTool } from '../super-file-tool.js'

let root: string, db: Client, ctx: AgentContext, store: ChangeStore
beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'aether-csv-write-')))
  vi.stubEnv('AUTH_ENABLED', 'false')
  vi.stubEnv('DATA_DIR', path.join(root, 'agent.db'))
  db = createClient({ url: 'file::memory:' })
  vi.spyOn(database, 'getDb').mockReturnValue(db)
  store = new ChangeStore()
  ctx = { tenantId: 'csv-write-tenant', sessionId: path.basename(root), rootSessionId: path.basename(root), rootRunId: 'csv-run', turnId: 'csv-turn',
    workspacePaths: [root], projectRoot: root, cwd: root, scratchDir: path.join(root, 'scratch'),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as unknown as AgentContext
  setSecurityMode(ctx.tenantId, ctx.sessionId, 'safe')
})
afterEach(() => {
  clearSecurityMode(ctx.tenantId, ctx.sessionId)
  db.close(); vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (path.dirname(root) !== fs.realpathSync.native(os.tmpdir()) || !path.basename(root).startsWith('aether-csv-write-')) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
})
function stagingFiles() {
  const directory = path.join(root, '.ae/tmp/file-writes')
  return fs.existsSync(directory) ? fs.readdirSync(directory) : []
}

describe('CSV write_file preserves supplied text instead of silently publishing an empty workbook', () => {
  it.each([
    ['LF', 'customer,amount\n合成客户,1200\n'],
    ['CRLF and BOM', '\uFEFFcustomer,note\r\n合成客户,"quoted, comma"\r\n'],
    ['quoted multiline and escaped quotes', 'name,note\r\n"陈澄","first\r\nsecond ""quoted"" line"\r\n'],
    ['no final newline', 'id,amount\nC002,120000'],
    ['explicit empty text', ''],
  ])('publishes exact UTF-8 %s bytes with matching durable hashes', async (_label, text) => {
    const file = path.join(root, 'nested/customer-followups.csv')
    const result = await writeFileTool.execute({ path: file, expectedHash: 'missing', data: text }, ctx)
    expect(result, result.output).toMatchObject({ success: true, metadata: { expectedHash: hashFileContent(text), fileMutationApplied: true } })
    expect(fs.readFileSync(file)).toEqual(Buffer.from(text, 'utf8'))
    const changes = await store.list(ctx.tenantId, ctx.sessionId)
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ oldHash: 'missing', newHash: hashFileContent(text) })
    expect(stagingFiles()).toEqual([])
  })
  it('preserves exact bytes with the legacy content alias and unconditional path', async () => {
    const file = path.join(root, 'legacy.csv'), text = 'a,b\r\n"值,一","值""二"\r\n'
    fs.writeFileSync(file, 'old\n')
    const result = await writeFileTool.execute({ path: file, content: text }, ctx)
    expect(result).toMatchObject({ success: true, metadata: { compatibilityAlias: 'content', expectedHash: hashFileContent(text) } })
    expect(fs.readFileSync(file, 'utf8')).toBe(text)
  })
  it('keeps the original CSV when a stale version is submitted', async () => {
    const file = path.join(root, 'existing.csv'), original = 'id,value\r\nC002,120000\r\n'
    fs.writeFileSync(file, original)
    const result = await writeFileTool.execute({ path: file, expectedHash: hashFileContent('stale'), data: 'replacement' }, ctx)
    expect(result).toMatchObject({ success: false, error: 'WRITE_VERSION_CONFLICT', metadata: { fileMutationApplied: false } })
    expect(fs.readFileSync(file, 'utf8')).toBe(original)
    expect(await store.list(ctx.tenantId, ctx.sessionId)).toHaveLength(0)
  })
  it.each([
    ['matrix', [['name', 'amount'], ['合成客户', 1200]]],
    ['record array', [{ name: '合成客户', amount: 1200 }]],
    ['rows object', { rows: [['name', 'amount'], ['合成客户', 1200]] }],
  ])('retains the existing structured %s contract', async (_label, data) => {
    const file = path.join(root, 'structured.csv')
    const result = await writeFileTool.execute({ path: file, data, createOnly: true }, ctx)
    expect(result.success).toBe(true)
    const text = fs.readFileSync(file, 'utf8')
    expect(text).toContain('合成客户'); expect(text).toContain('1200')
    expect(result.metadata).toMatchObject({ expectedHash: hashFileContent(text) })
  })
  it.each([null, true, 42, {}, { rows: 'a,b\n1,2' }, [null], ['scalar row'], [{ a: 1 }, ['mixed']], [{}]].map(data => [data]))(
    'rejects unsupported CSV data without creating a file or damaging an existing original: %j', async data => {
      const fresh = path.join(root, 'new.csv'), original = path.join(root, 'existing.csv'), bytes = 'preserve,中文\r\n1,2\r\n'
      fs.writeFileSync(original, bytes)
      for (const request of [
        { path: fresh, expectedHash: 'missing', data },
        { path: original, expectedHash: hashFileContent(bytes), data },
        { path: original, data },
      ]) {
        const result = await writeFileTool.execute(request, ctx)
        expect(result.success).toBe(false)
        expect(fs.existsSync(fresh)).toBe(false)
        expect(fs.readFileSync(original, 'utf8')).toBe(bytes)
      }
      expect(await store.list(ctx.tenantId, ctx.sessionId)).toHaveLength(0)
      expect(stagingFiles()).toEqual([])
    })
  it('rejects spreadsheet text rather than claiming a valid but empty XLSX workbook', async () => {
    const file = path.join(root, 'text.xlsx')
    const result = await writeFileTool.execute({ path: file, expectedHash: 'missing', data: 'name,amount\n合成客户,1200' }, ctx)
    expect(result).toMatchObject({ success: false, error: 'WRITE_FORMAT_FAILED', metadata: { fileMutationApplied: false } })
    expect(fs.existsSync(file)).toBe(false)
    expect(await store.list(ctx.tenantId, ctx.sessionId)).toHaveLength(0)
  })
})
