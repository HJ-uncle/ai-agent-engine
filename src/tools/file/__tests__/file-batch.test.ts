import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext, ToolResult } from '../../../core/agent-context/index.js'
import { boundedToolContext, getToolOutputLimit } from '../../../core/agent-loop/tool-output-limit.js'
import { ToolRegistry } from '../../../core/tool-registry/registry.js'
import * as database from '../../../storage/sqlite/db.js'
import { ChangeStore } from '../../../storage/changes/index.js'
import { clearSecurityMode, setSecurityMode } from '../../../security/policy-engine.js'
import { hashFileContent } from '../../../shared/file-version.js'
import { handlerRegistry } from '../handlers/registry.js'
import { readFileTool, writeFileTool } from '../super-file-tool.js'

let root: string, ctx: AgentContext, db: Client, changes: ChangeStore
beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'aether-file-batch-')))
  vi.stubEnv('AUTH_ENABLED', 'false')
  vi.stubEnv('DATA_DIR', path.join(root, 'agent.db'))
  vi.stubEnv('TOOL_OUTPUT_MAX_CHARS', '4000')
  db = createClient({ url: 'file::memory:' })
  vi.spyOn(database, 'getDb').mockReturnValue(db)
  changes = new ChangeStore()
  ctx = { tenantId: 'file-batch', sessionId: path.basename(root), rootSessionId: path.basename(root), rootRunId: 'batch-run', turnId: 'batch-turn',
    workspacePaths: [root], projectRoot: root, cwd: root, scratchDir: path.join(root, 'scratch'), toolProfile: 'general',
    tools: { preflight: vi.fn(async () => undefined) }, logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as unknown as AgentContext
  setSecurityMode(ctx.tenantId, ctx.sessionId, 'safe')
})
afterEach(() => {
  clearSecurityMode(ctx.tenantId, ctx.sessionId)
  db.close()
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (path.dirname(root) !== fs.realpathSync.native(os.tmpdir()) || !path.basename(root).startsWith('aether-file-batch-')) throw new Error('Unsafe batch fixture cleanup')
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
})
function seed(name: string, content: string | Buffer) {
  const target = path.join(root, name)
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content)
  return { path: target, expectedHash: hashFileContent(content) }
}
function decode(result: ToolResult) {
  expect(result.output.length).toBeLessThanOrEqual(getToolOutputLimit(ctx.toolProfile, ctx))
  return JSON.parse(result.output) as { batch: true; files: Array<{ path: string; success: boolean; output: any; error?: string; status?: string }> }
}
const write = (name: string, data = name) => ({ path: name, data, expectedHash: 'missing' })

describe('explicit read_file files batch', () => {
  it('returns three independent small files completely in one bounded JSON receipt', async () => {
    const files = ['a.txt', 'b.txt', 'c.txt'].map(name => seed(name, `完整-${name}\r\n尾行`))
    const result = await readFileTool.execute({ files: files.map(file => ({ path: file.path })) }, ctx)
    expect(result.success, result.output).toBe(true)
    const body = decode(result)
    expect(body.files).toHaveLength(3)
    body.files.forEach((item, index) => {
      expect(item).toMatchObject({ path: files[index].path, success: true,
        output: { expectedHash: files[index].expectedHash, contentIsComplete: true, hasMore: false } })
      expect(item.output.numberedContent).toContain(`完整-${path.basename(files[index].path)}`)
    })
    expect(result.metadata?.files).toHaveLength(3)
  })

  it('pages large files independently without slicing JSON or losing Unicode source', async () => {
    const original = '中文😀"\\'.repeat(500)
    const a = seed('long-a.txt', original), b = seed('long-b.txt', 'second'.repeat(800))
    const result = await readFileTool.execute({ files: [{ path: a.path }, { path: b.path }] }, ctx)
    const body = decode(result)
    expect(body.files.every(item => item.success)).toBe(true)
    for (const item of body.files) expect(item.output).toMatchObject({ contentIsComplete: false, hasMore: true, nextStartLine: 1 })
    const page = body.files[0].output
    const next = await readFileTool.execute({ files: [{ path: a.path, start_line: page.nextStartLine, start_column: page.nextStartColumn }, { path: b.path }] }, ctx)
    const nextPage = decode(next).files[0].output
    const prefix = page.numberedContent.slice(4), continued = nextPage.numberedContent.slice(4)
    expect(prefix + continued).toBe(original.slice(0, prefix.length + continued.length))
    expect(prefix).not.toMatch(/[\uD800-\uDBFF]$/)
    expect(nextPage.expectedHash).toBe(a.expectedHash)
  })

  it('supports bounded batch paging in Code without changing legacy single-file reads', async () => {
    const file = seed('code.txt', 'x'.repeat(10_000))
    const code = boundedToolContext({ ...ctx, toolProfile: 'code' }, 3000)
    const result = await readFileTool.execute({ files: [{ path: file.path }, { path: file.path }] }, code)
    expect(result.output.length).toBeLessThanOrEqual(3000)
    expect(JSON.parse(result.output).files[0].output).toMatchObject({ hasMore: true, contentIsComplete: false })
  })

  it('keeps a missing item separate from a successful item', async () => {
    const exists = seed('exists.txt', 'keep me')
    const result = await readFileTool.execute({ files: [{ path: exists.path }, { path: 'missing.txt' }] }, ctx)
    const body = decode(result)
    expect(result.success).toBe(false)
    expect(body.files[0].success).toBe(true)
    expect(body.files[1]).toMatchObject({ success: false, error: 'FILE_NOT_FOUND' })
  })

  it('returns an explicit single-file requirement instead of hiding image pixels in nested JSON', async () => {
    const file = seed('image.png', Buffer.from([137, 80, 78, 71]))
    const reader = vi.spyOn(handlerRegistry.getHandler(file.path), 'read')
    const result = await readFileTool.execute({ files: [{ path: file.path }, { path: file.path, mode: 'vision' }] }, ctx)
    expect(decode(result).files.every(item => item.error === 'FILE_BATCH_REQUIRES_SINGLE_READ' && item.success === false)).toBe(true)
    expect(reader).not.toHaveBeenCalled()
    expect(result.output).not.toContain('base64')
  })

  it('preflights all read permissions before any read begins and preserves waiting', async () => {
    const a = seed('a.txt', 'one'), b = seed('b.txt', 'two')
    ctx.tools.preflight = vi.fn(async (_name, args): Promise<ToolResult | undefined> => (args as any).path === b.path
      ? { success: false, needsConfirmation: true, status: 'waiting', pendingAction: { type: 'approval' }, output: 'Waiting' } : undefined)
    const args = { files: [{ path: a.path }, { path: b.path }] }
    expect(await readFileTool.preflight!(args, ctx)).toMatchObject({ needsConfirmation: true })
    expect(await readFileTool.execute(args, ctx)).toMatchObject({ needsConfirmation: true, pendingAction: { type: 'approval' } })
    expect(ctx.logger.info).not.toHaveBeenCalled()
  })

  it('retains exact bytes when they fit and refuses oversized exact output without a false complete receipt', async () => {
    const small = seed('small.txt', '\uFEFFa\r\n'), large = seed('large.txt', 'q'.repeat(9000))
    const result = await readFileTool.execute({ files: [{ path: small.path, mode: 'exact' }, { path: large.path, mode: 'exact' }] }, ctx)
    const body = decode(result)
    expect(body.files[0].output).toMatchObject({ content: '\uFEFFa\r\n', contentIsComplete: true })
    expect(body.files[1]).toMatchObject({ success: false, error: 'FILE_BATCH_REQUIRES_SINGLE_READ' })
    expect((result.metadata?.files as any[])[1].contentIsComplete).toBe(false)
  })

  it.each([{ files: [] }, { files: [{ path: 'a' }], path: 'b' }, { files: Array.from({ length: 17 }, () => ({ path: 'a' })) },
    { files: [{ files: [{ path: 'a' }] }] }, { files: [{ path: 'a', start_line: 0 }] }])('rejects malformed batch %j', async args => {
    expect(await readFileTool.execute(args, ctx)).toMatchObject({ success: false, error: 'FILE_BATCH_INVALID_ARGUMENTS' })
    expect(ctx.tools.preflight).not.toHaveBeenCalled()
  })

  it('rejects an impossible shared budget before invoking any file reader', async () => {
    const limited = boundedToolContext(ctx, 100)
    const result = await readFileTool.execute({ files: [{ path: 'a' }, { path: 'b' }] }, limited)
    expect(result).toMatchObject({ success: false, error: 'FILE_BATCH_OUTPUT_BUDGET' })
    expect(result.output.length).toBeLessThanOrEqual(100)
    expect(() => JSON.parse(result.output)).not.toThrow()
    expect(ctx.tools.preflight).not.toHaveBeenCalled()
  })
})

describe('explicit write_file files batch', () => {
  it('runs through the actual registry without nested execute calls or pool recursion', async () => {
    const registry = new ToolRegistry()
    registry.register(writeFileTool); registry.register(readFileTool)
    ctx.tools = registry
    const execute = vi.spyOn(registry, 'execute')
    const result = await registry.execute('write_file', { files: [write('registry-a.txt'), write('registry-b.txt')] }, ctx)
    expect(result.success, result.output).toBe(true)
    expect(execute).toHaveBeenCalledTimes(1)
    const read = await registry.execute('read_file', { files: [{ path: 'registry-a.txt' }, { path: 'registry-b.txt' }] }, ctx)
    expect(read.success, read.output).toBe(true)
    expect(execute).toHaveBeenCalledTimes(2)
  })
  it('writes three independent files with every hash, byte receipt and durable change retained', async () => {
    const files = [write('a.txt', 'one\r\n'), write('b.txt', '二😀'), write('c.txt', '')]
    const result = await writeFileTool.execute({ files }, ctx)
    expect(result.success, result.output).toBe(true)
    const body = decode(result)
    expect(result.changes).toHaveLength(3)
    expect(await changes.list(ctx.tenantId, ctx.sessionId)).toHaveLength(3)
    body.files.forEach((item, index) => {
      const bytes = fs.readFileSync(path.join(root, files[index].path))
      expect(bytes.toString('utf8')).toBe(files[index].data)
      expect(item.output).toMatchObject({ expectedHash: hashFileContent(bytes), byteLength: bytes.length, fileMutationApplied: true })
      expect(item.output).toMatchObject({ textPreview: files[index].data, textPreviewIsComplete: true, changeId: expect.any(String) })
    })
    expect(ctx.tools.preflight).toHaveBeenCalledTimes(6)
  })

  it('normalizes legacy content per item while preserving old single-file shape', async () => {
    expect((await writeFileTool.execute({ path: 'old.txt', content: 'old' }, ctx)).success).toBe(true)
    const result = await writeFileTool.execute({ files: [{ path: 'alias.txt', content: 'new' }, write('normal.txt')] }, ctx)
    expect(result.success).toBe(true)
    expect(fs.readFileSync(path.join(root, 'alias.txt'), 'utf8')).toBe('new')
    expect((result.metadata?.files as any[])[0].compatibilityAlias).toBe('content')
  })

  it('checks the entire batch before writing when a later item requires permission', async () => {
    ctx.tools.preflight = vi.fn(async (_name, args): Promise<ToolResult | undefined> => (args as any).path === 'approval.txt'
      ? { success: false, needsConfirmation: true, status: 'waiting', pendingAction: { type: 'approval' }, output: 'Permission required' } : undefined)
    const args = { files: [write('first.txt'), write('approval.txt')] }
    expect(await writeFileTool.preflight!(args, ctx)).toMatchObject({ needsConfirmation: true, metadata: { fileMutationApplied: false } })
    expect(await writeFileTool.execute(args, ctx)).toMatchObject({ needsConfirmation: true })
    expect(fs.existsSync(path.join(root, 'first.txt'))).toBe(false)
    expect(await changes.list(ctx.tenantId, ctx.sessionId)).toHaveLength(0)
  })

  it('keeps already-written receipts when a later policy changes, without parking partial writes as waiting', async () => {
    let seen = 0
    ctx.tools.preflight = vi.fn(async (): Promise<ToolResult | undefined> => ++seen === 4
      ? { success: false, needsConfirmation: true, status: 'waiting', output: 'Policy changed' } : undefined)
    const result = await writeFileTool.execute({ files: [write('first.txt'), write('blocked.txt')] }, ctx)
    const body = decode(result)
    expect(body.files[0].success).toBe(true)
    expect(body.files[1]).toMatchObject({ success: false, error: 'FILE_BATCH_POLICY_CHANGED' })
    expect(result.needsConfirmation).not.toBe(true)
    expect(result.changes).toHaveLength(1)
    expect(fs.existsSync(path.join(root, 'blocked.txt'))).toBe(false)
  })

  it.each([
    { files: [write('good.txt'), { path: 'bad.txt' }] },
    { files: [write('same.txt'), write('./same.txt')] },
    { files: [write('parent'), write('parent/child.txt')] },
    { files: [write('good.txt'), write('../outside.txt')] },
    { files: [write('good.txt'), { path: 'bad.json', data: {}, trailingNewline: 'LF' }] },
    { files: [write('good.txt'), { path: 'copy.txt', copyFrom: { path: 'good.txt', expectedHash: hashFileContent('old') } }] },
  ])('rejects invalid/dependent batch before any mutation: %j', async args => {
    expect((await writeFileTool.execute(args, ctx)).success).toBe(false)
    expect(await changes.list(ctx.tenantId, ctx.sessionId)).toHaveLength(0)
    expect(fs.readdirSync(root).filter(name => name.endsWith('.txt'))).toHaveLength(0)
  })

  it('rejects hard-link destination aliases before any write', async () => {
    const source = seed('one.txt', 'old')
    fs.linkSync(source.path, path.join(root, 'two.txt'))
    expect(await writeFileTool.execute({ files: [write('one.txt'), write('two.txt')] }, ctx)).toMatchObject({ error: 'FILE_BATCH_TARGET_CONFLICT' })
    expect(fs.readFileSync(source.path, 'utf8')).toBe('old')
  })

  it('preserves copy source bytes and each independent copy verification receipt', async () => {
    const source = seed('source.bin', Buffer.from([0, 255, 13, 10]))
    const result = await writeFileTool.execute({ files: [
      { path: 'one.bin', copyFrom: source }, { path: 'two.bin', copyFrom: source },
    ] }, ctx)
    expect(result.success, result.output).toBe(true)
    expect(decode(result).files.every(item => item.output.copyVerified === true && item.output.expectedHash === source.expectedHash)).toBe(true)
  })

  it('keeps successful siblings when a version conflict fails one file', async () => {
    const old = seed('existing.txt', 'old')
    const result = await writeFileTool.execute({ files: [write('first.txt'), write('existing.txt'), write('last.txt')] }, ctx)
    const body = decode(result)
    expect(body.files.map(item => item.success)).toEqual([true, false, true])
    expect(body.files[1].output).toMatchObject({ actualHash: old.expectedHash, fileMutationApplied: false })
    expect(result.changes).toHaveLength(2)
    expect(fs.readFileSync(old.path, 'utf8')).toBe('old')
  })

  it('records a partial format failure instead of losing the changed file', async () => {
    const handler = handlerRegistry.getHandler('partial.txt')
    const original = handler.write.bind(handler)
    vi.spyOn(handler, 'write').mockImplementation(async (target, data, context) => {
      if (path.basename(target) === 'partial.txt') { fs.writeFileSync(target, 'actually written'); throw new Error('format failure') }
      return original(target, data, context)
    })
    const result = await writeFileTool.execute({ files: [{ path: 'partial.txt', data: 'requested' }, write('good.txt')] }, ctx)
    expect(result.changes).toHaveLength(2)
    expect(decode(result).files[0].output).toMatchObject({ fileMutationApplied: true, expectedHash: hashFileContent('actually written') })
    expect(fs.readFileSync(path.join(root, 'partial.txt'), 'utf8')).toBe('actually written')
  })

  it('retains the first mutation if cancellation arrives before the next write', async () => {
    const controller = new AbortController(); ctx.signal = controller.signal
    const handler = handlerRegistry.getHandler('first.txt'), original = handler.write.bind(handler)
    vi.spyOn(handler, 'write').mockImplementation(async (target, data, context) => {
      await original(target, data, context)
      if (path.basename(target) === 'first.txt') controller.abort()
    })
    const result = await writeFileTool.execute({ files: [{ path: 'first.txt', data: 'one' }, write('second.txt')] }, ctx)
    const body = decode(result)
    expect(body.files[0].success).toBe(true)
    expect(body.files[1]).toMatchObject({ success: false, status: 'cancelled' })
    expect(result.changes).toHaveLength(1)
    expect(fs.existsSync(path.join(root, 'second.txt'))).toBe(false)
  })

  it('rechecks a destination replaced during the final permission hook', async () => {
    let calls = 0
    ctx.tools.preflight = vi.fn(async () => {
      if (++calls === 3) fs.writeFileSync(path.join(root, 'first.txt'), 'external writer')
      return undefined
    })
    const result = await writeFileTool.execute({ files: [write('first.txt'), write('second.txt')] }, ctx)
    expect(decode(result).files[0]).toMatchObject({ success: false, error: 'FILE_BATCH_PATH_CHANGED' })
    expect(fs.readFileSync(path.join(root, 'first.txt'), 'utf8')).toBe('external writer')
    expect(result.changes).toHaveLength(1)
  })

  it('refuses a batch whose receipt budget is too small before creating files', async () => {
    const limited = boundedToolContext(ctx, 100)
    const result = await writeFileTool.execute({ files: [write('first.txt'), write('second.txt')] }, limited)
    expect(result).toMatchObject({ success: false, error: 'FILE_BATCH_OUTPUT_BUDGET' })
    expect(result.output.length).toBeLessThanOrEqual(100)
    expect(() => JSON.parse(result.output)).not.toThrow()
    expect(fs.existsSync(path.join(root, 'first.txt'))).toBe(false)
  })

  it('omits complete previews that do not fit without truncating the receipt or claiming preview completeness', async () => {
    ctx = boundedToolContext(ctx, 4000)
    const controlText = '\u0001'.repeat(256)
    const result = await writeFileTool.execute({ files: [write('a.txt', controlText), write('b.txt', controlText), write('c.txt', controlText)] }, ctx)
    const body = decode(result)
    expect(result.success).toBe(true)
    expect(body.files.some(item => item.output.textPreviewOmitted === true)).toBe(true)
    for (const item of body.files) {
      expect(item.output.expectedHash).toBe(hashFileContent(controlText))
      if (item.output.textPreviewIsComplete) expect(item.output.textPreview).toBe(controlText)
      else expect(item.output).not.toHaveProperty('textPreview')
    }
    expect(result.changes).toHaveLength(3)
  })
})
