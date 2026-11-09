import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext } from '../../../core/agent-context/index.js'
import * as database from '../../../storage/sqlite/db.js'
import { ChangeStore } from '../../../storage/changes/index.js'
import { clearSecurityMode, setSecurityMode } from '../../../security/policy-engine.js'
import { hashFileContent } from '../../../shared/file-version.js'
import { commitWriteChangeWithReceipt, decodeEditableText, readOldSnapshot } from '../change-recorder.js'
import { describeFileBytes, formatWriteReceipt } from '../write-receipt.js'
import { readFileTool, writeFileTool } from '../super-file-tool.js'
import { editFileTool } from '../edit-file.js'

let root: string, ctx: AgentContext, db: Client
beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'aether-write-receipt-')))
  vi.stubEnv('AUTH_ENABLED', 'false')
  vi.stubEnv('DATA_DIR', path.join(root, 'agent.db'))
  db = createClient({ url: 'file::memory:' })
  vi.spyOn(database, 'getDb').mockReturnValue(db)
  ctx = { tenantId: 'write-receipt', sessionId: path.basename(root), workspacePaths: [root], projectRoot: root, cwd: root,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as unknown as AgentContext
  setSecurityMode(ctx.tenantId, ctx.sessionId, 'safe')
})
afterEach(() => {
  clearSecurityMode(ctx.tenantId, ctx.sessionId)
  db.close(); vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (path.dirname(root) !== fs.realpathSync.native(os.tmpdir()) || !path.basename(root).startsWith('aether-write-receipt-')) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
})

function facts(filePath: string, value: string | Buffer) {
  const content = Buffer.from(value)
  return describeFileBytes(filePath, { content, hash: hashFileContent(content) }, decodeEditableText(filePath, content))
}
function parseReceipt(output: string) {
  return { expectedHash: /^expectedHash: (.+)$/m.exec(output)?.[1], sha256: /^sha256: (.+)$/m.exec(output)?.[1],
    ...JSON.parse(/^fileFacts: (.+)$/m.exec(output)![1]) }
}

describe('actual written byte receipts', () => {
  it.each([
    { text: '', ending: 'none', count: 0 },
    { text: 'one', ending: 'none', count: 0 },
    { text: 'one\n\n', ending: 'LF', count: 2 },
    { text: 'one\r\n\r\n\r\n', ending: 'CRLF', count: 3 },
    { text: 'one\r\r', ending: 'CR', count: 2 },
    { text: 'one\n\r\n\r', ending: 'CR', count: 3 },
    { text: 'one\n ', ending: 'none', count: 0 },
    { text: '\uFEFF中文🙂\r\n', ending: 'CRLF', count: 1 },
  ])('reports complete byte facts without trimming $text', ({ text, ending, count }) => {
    const receipt = facts('text.txt', text)
    expect(receipt).toMatchObject({ expectedHash: hashFileContent(text), sha256: hashFileContent(text).slice(7), byteLength: Buffer.byteLength(text),
      encoding: 'utf-8', utf8Bom: text.startsWith('\uFEFF'), trailingLineEnding: ending, trailingNewlineCount: count,
      textPreview: text, textPreviewIsComplete: true })
    expect(parseReceipt(formatWriteReceipt(receipt))).toMatchObject({ trailingNewlineCount: count, textPreview: text })
  })

  it('includes only complete previews within 256 UTF-16 code units', () => {
    expect(facts('text.txt', '🙂'.repeat(128))).toMatchObject({ textPreview: '🙂'.repeat(128), textPreviewIsComplete: true })
    for (const value of ['x'.repeat(257), '🙂'.repeat(129)]) {
      expect(facts('text.txt', value)).not.toHaveProperty('textPreview')
      expect(facts('text.txt', value)).not.toHaveProperty('textPreviewIsComplete')
    }
  })

  it.each(['.docx', '.xlsx', '.pptx', '.ppt'])('does not label Office bytes as UTF-8 or return text facts for %s', ext => {
    const receipt = facts(`report${ext}`, 'ASCII-like bytes\r\n\r\n')
    expect(receipt).toMatchObject({ encoding: 'binary-or-non-utf8', byteLength: 20 })
    for (const key of ['utf8Bom', 'trailingLineEnding', 'trailingNewlineCount', 'textPreview']) expect(receipt).not.toHaveProperty(key)
  })

  it('does not label malformed UTF-8 or NUL bytes as text', () => {
    for (const bytes of [Buffer.from([0xff, 0x0a]), Buffer.from([0, 0x0a])]) {
      const receipt = facts('file.txt', bytes)
      expect(receipt.encoding).toBe('binary-or-non-utf8')
      expect(receipt).not.toHaveProperty('trailingNewlineCount')
      expect(receipt).not.toHaveProperty('textPreview')
    }
  })

  it('uses the formatted JSON on disk for conditional writes, not the input object serialization', async () => {
    const file = path.join(root, 'settings.json'), data = { title: '中🙂', value: 2 }
    const result = await writeFileTool.execute({ path: file, data, expectedHash: 'missing' }, ctx)
    expect(result.success, result.output).toBe(true)
    const actual = fs.readFileSync(file), receipt = parseReceipt(result.output)
    expect(receipt).toMatchObject({ byteLength: actual.byteLength, expectedHash: hashFileContent(actual), sha256: hashFileContent(actual).slice(7),
      encoding: 'utf-8', textPreview: actual.toString('utf8'), trailingLineEnding: 'none', trailingNewlineCount: 0 })
    expect(receipt.byteLength).not.toBe(Buffer.byteLength(JSON.stringify(data)))
    expect(result.metadata).toMatchObject(receipt)
    expect(result.change).not.toHaveProperty('receipt')
    expect(result.change).not.toHaveProperty('textPreview')
    const changes = await new ChangeStore().list(ctx.tenantId, ctx.sessionId)
    expect(changes[0]).not.toHaveProperty('receipt')
    expect(changes[0]).not.toHaveProperty('textPreview')
  })

  it('allows write/edit/noChange receipt chaining without extra reads', async () => {
    const file = path.join(root, 'values.txt')
    const written = await writeFileTool.execute({ path: file, data: '\uFEFFvalue=1\r\n\r\n', expectedHash: 'missing' }, ctx)
    const first = parseReceipt(written.output)
    expect(first).toMatchObject({ trailingNewlineCount: 2, trailingLineEnding: 'CRLF' })
    const edited = await editFileTool.execute({ path: file, expectedHash: first.expectedHash, edits: [{ oldText: 'value=1', newText: 'value=2' }] }, ctx)
    const second = parseReceipt(edited.output)
    expect(second).toMatchObject({ expectedHash: hashFileContent(fs.readFileSync(file)), textPreview: '\uFEFFvalue=2\r\n\r\n', trailingNewlineCount: 2 })
    expect(edited.metadata).toMatchObject(second)
    const noChange = await editFileTool.execute({ path: file, expectedHash: second.expectedHash, edits: [{ oldText: 'value=2', newText: 'value=2' }] }, ctx)
    expect(parseReceipt(noChange.output)).toEqual(second)
    expect(noChange.metadata).toMatchObject({ noChange: true, fileMutationApplied: false })
    expect(await new ChangeStore().list(ctx.tenantId, ctx.sessionId)).toHaveLength(2)
  })

  it('keeps hash and facts from one snapshot even if an external writer changes bytes during SQLite recording', async () => {
    const file = path.join(root, 'concurrent.txt')
    fs.writeFileSync(file, 'old')
    const before = await readOldSnapshot(file)
    fs.writeFileSync(file, 'observed\r\n\r\n')
    const record = ChangeStore.prototype.record
    const spy = vi.spyOn(ChangeStore.prototype, 'record').mockImplementation(async function (this: ChangeStore, ...args) {
      fs.writeFileSync(file, 'external-after-snapshot')
      return record.apply(this, args)
    })
    const { change, receipt } = await commitWriteChangeWithReceipt(ctx, file, file, before)
    expect(receipt).toMatchObject({ expectedHash: change.newHash, sha256: String(change.newHash).slice(7),
      byteLength: Buffer.byteLength('observed\r\n\r\n'), textPreview: 'observed\r\n\r\n', trailingNewlineCount: 2 })
    expect(receipt.expectedHash).not.toBe(hashFileContent(fs.readFileSync(file)))
    expect(spy.mock.calls[0][1]).not.toHaveProperty('receipt')
    expect(spy.mock.calls[0][1]).not.toHaveProperty('textPreview')
    const current = await readFileTool.execute({ path: file, mode: 'exact' }, ctx)
    expect(JSON.parse(current.output).content).toBe('external-after-snapshot')
  })

  it('keeps facts for large text even when the rollback snapshot is stored outside SQLite', async () => {
    const file = path.join(root, 'large.txt')
    const text = '中'.repeat(40000) + '\r\n\r\n'
    const result = await writeFileTool.execute({ path: file, data: text, expectedHash: 'missing' }, ctx)
    const receipt = parseReceipt(result.output)
    expect(result.success, result.output).toBe(true)
    expect(receipt).toMatchObject({ byteLength: Buffer.byteLength(text), encoding: 'utf-8', trailingLineEnding: 'CRLF', trailingNewlineCount: 2 })
    expect(receipt).not.toHaveProperty('textPreview')
    expect(result.change).toMatchObject({ newContent: null, truncated: true })
  })
})
