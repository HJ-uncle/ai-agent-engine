import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ExcelJS from 'exceljs'
import { createClient, type Client } from '@libsql/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as database from '../../../storage/sqlite/db.js'
import { ChangeStore } from '../../../storage/changes/index.js'
import type { AgentContext } from '../../../core/agent-context/index.js'
import { clearSecurityMode, setSecurityMode } from '../../../security/policy-engine.js'
import { hashFileContent } from '../../../shared/file-version.js'
import { normalizeWriteFileArgs } from '../../../shared/write-file-args.js'
import { parseXmlToolCalls } from '../../../core/llm-adapter/openai.js'
import { handlerRegistry } from '../handlers/registry.js'
import { writeFileTool } from '../super-file-tool.js'
import { MAX_FILE_SIZE } from '../constants.js'

let root: string, db: Client, ctx: AgentContext, store: ChangeStore
const fixtures: Array<{ root: string; closed: boolean; removed: boolean }> = []
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-conditional-write-'))
  fixtures.push({ root, closed: false, removed: false })
  vi.stubEnv('AUTH_ENABLED', 'false')
  vi.stubEnv('DATA_DIR', path.join(root, 'agent.db'))
  db = createClient({ url: 'file::memory:' })
  vi.spyOn(database, 'getDb').mockReturnValue(db)
  store = new ChangeStore()
  ctx = { tenantId: 'conditional-tenant', sessionId: path.basename(root), rootSessionId: path.basename(root), rootRunId: 'root-run', turnId: 'turn-a',
    workspacePaths: [root], projectRoot: root, cwd: root, scratchDir: path.join(root, 'scratch'),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as unknown as AgentContext
  setSecurityMode(ctx.tenantId, ctx.sessionId, 'safe')
})
afterEach(() => {
  clearSecurityMode(ctx.tenantId, ctx.sessionId)
  db.close()
  fixtures.at(-1)!.closed = true
  vi.restoreAllMocks()
  if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('aether-conditional-write-')) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  fixtures.at(-1)!.removed = !fs.existsSync(root)
  vi.unstubAllEnvs()
})
afterAll(() => {
  fs.writeFileSync(path.resolve('conditional-write.fixtures.json'), JSON.stringify({ at: new Date().toISOString(), fixtures }, null, 2))
})
function seed(content: string | Buffer = 'original\r\n', name = 'file.txt') {
  const file = path.join(root, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  return { file, expectedHash: hashFileContent(content) }
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
function stagingFiles() {
  const dir = path.join(root, '.ae/tmp/file-writes')
  return fs.existsSync(dir) ? fs.readdirSync(dir) : []
}

describe('whole file conditional publication', () => {
  it('allows one of two roots using the same exact version, without losing the winner or recording the loser', async () => {
    const { file, expectedHash } = seed()
    const other = { ...ctx, sessionId: 'other-session', rootSessionId: 'other-session', rootRunId: 'other-root' }
    const results = await Promise.all([
      writeFileTool.execute({ path: file, expectedHash, data: 'root-a' }, ctx),
      writeFileTool.execute({ path: file, expectedHash, data: 'root-b' }, other),
    ])
    expect(results.filter(result => result.success)).toHaveLength(1)
    expect(results.filter(result => !result.success)).toEqual([expect.objectContaining({ error: 'WRITE_VERSION_CONFLICT', metadata: expect.objectContaining({ fileMutationApplied: false }) })])
    expect(fs.readFileSync(file, 'utf8')).toBe(results[0].success ? 'root-a' : 'root-b')
    expect((await store.list(ctx.tenantId, ctx.sessionId)).length + (await store.list(ctx.tenantId, other.sessionId)).length).toBe(1)
    expect(stagingFiles()).toEqual([])
  })
  it('allows unrelated files to proceed concurrently and returns actual formatted byte hashes', async () => {
    const a = seed('a', 'a.txt'), b = seed('{}', 'b.json')
    const results = await Promise.all([
      writeFileTool.execute({ path: a.file, expectedHash: a.expectedHash, data: 'changed-a' }, ctx),
      writeFileTool.execute({ path: b.file, expectedHash: b.expectedHash, data: { name: '标题', count: 2 } }, ctx),
    ])
    expect(results.every(result => result.success)).toBe(true)
    expect(fs.readFileSync(a.file, 'utf8')).toBe('changed-a')
    expect(fs.readFileSync(b.file, 'utf8')).toBe(JSON.stringify({ name: '标题', count: 2 }, null, 2))
    for (const [index, file] of [a.file, b.file].entries()) {
      const actualHash = hashFileContent(fs.readFileSync(file))
      expect(results[index].metadata).toMatchObject({ expectedHash: actualHash, fileMutationApplied: true })
      expect(results[index].output).toContain(`expectedHash: ${actualHash}`)
    }
    expect(await store.list(ctx.tenantId, ctx.sessionId)).toHaveLength(2)
  })
  it('atomically creates one of two simultaneous createOnly writes in a new directory', async () => {
    const file = path.join(root, 'new/nested/file.txt')
    const results = await Promise.all(['first', 'second'].map(data => writeFileTool.execute({ path: file, data, createOnly: true }, ctx)))
    expect(results.filter(result => result.success)).toHaveLength(1)
    expect(results.find(result => !result.success)).toMatchObject({ error: 'WRITE_VERSION_CONFLICT', metadata: { fileMutationApplied: false } })
    expect(fs.readFileSync(file, 'utf8')).toBe(results[0].success ? 'first' : 'second')
    expect(await store.list(ctx.tenantId, ctx.sessionId)).toHaveLength(1)
  })
  it('distinguishes missing files from existing empty files', async () => {
    const { file, expectedHash } = seed('')
    const rejected = await writeFileTool.execute({ path: file, data: 'wrong', expectedHash: 'missing' }, ctx)
    expect(rejected).toMatchObject({ error: 'WRITE_VERSION_CONFLICT', metadata: { actualHash: expectedHash, fileMutationApplied: false } })
    expect(fs.readFileSync(file, 'utf8')).toBe('')
    const written = await writeFileTool.execute({ path: file, data: 'right', expectedHash }, ctx)
    expect(written.success).toBe(true)
    expect(fs.readFileSync(file, 'utf8')).toBe('right')
  })
  it('preserves an external file created in the final atomic create boundary', async () => {
    const file = path.join(root, 'raced.txt'), realLink = fs.linkSync.bind(fs)
    vi.spyOn(fs, 'linkSync').mockImplementationOnce((from, to) => {
      fs.writeFileSync(to, 'external winner')
      return realLink(from, to)
    })
    const result = await writeFileTool.execute({ path: file, data: 'generated loser', createOnly: true }, ctx)
    expect(result).toMatchObject({ error: 'WRITE_VERSION_CONFLICT', metadata: { fileMutationApplied: false } })
    expect(fs.readFileSync(file, 'utf8')).toBe('external winner')
    expect(await store.list(ctx.tenantId, ctx.sessionId)).toHaveLength(0)
    expect(stagingFiles()).toEqual([])
  })
  it('rejects external edits while an asynchronous format writer is generating bytes, and discards unpublished binary backup', async () => {
    const { file, expectedHash } = seed(Buffer.from([0, 1, 2, 3]), 'report.docx')
    const entered = deferred(), release = deferred()
    const handler = handlerRegistry.getHandler(file)
    vi.spyOn(handler, 'write').mockImplementationOnce(async temporary => {
      fs.writeFileSync(temporary, 'staged partial bytes')
      entered.resolve()
      await release.promise
      fs.writeFileSync(temporary, 'generated bytes')
    })
    const pending = writeFileTool.execute({ path: file, expectedHash, data: 'report' }, ctx)
    await entered.promise
    expect(fs.readFileSync(file)).toEqual(Buffer.from([0, 1, 2, 3]))
    fs.writeFileSync(file, 'external edit')
    release.resolve()
    const result = await pending
    expect(result).toMatchObject({ error: 'WRITE_VERSION_CONFLICT', metadata: { fileMutationApplied: false, actualHash: hashFileContent('external edit') } })
    expect(fs.readFileSync(file, 'utf8')).toBe('external edit')
    expect(await store.list(ctx.tenantId, ctx.sessionId)).toHaveLength(0)
    expect(fs.readdirSync(path.join(root, 'change-snapshots'))).toEqual([])
    expect(stagingFiles()).toEqual([])
  })
  it.each(['failure', 'abort', 'oversized'] as const)('preserves original bytes and publishes no change when stage %s occurs', async kind => {
    const { file, expectedHash } = seed(), controller = new AbortController()
    vi.spyOn(handlerRegistry.getHandler(file), 'write').mockImplementationOnce(async temporary => {
      fs.writeFileSync(temporary, 'partial')
      if (kind === 'failure') throw new Error('synthetic format failure')
      if (kind === 'abort') controller.abort(new Error('synthetic cancellation'))
      if (kind === 'oversized') fs.truncateSync(temporary, MAX_FILE_SIZE + 1)
    })
    const result = await writeFileTool.execute({ path: file, data: 'replacement', expectedHash }, { ...ctx, signal: controller.signal })
    expect(result.success).toBe(false)
    expect(fs.readFileSync(file, 'utf8')).toBe('original\r\n')
    expect(await store.list(ctx.tenantId, ctx.sessionId)).toHaveLength(0)
    expect(stagingFiles()).toEqual([])
  })
  it('reports a real mutation if recording fails after successful publication; does not roll back external bytes', async () => {
    const { file, expectedHash } = seed()
    vi.spyOn(ChangeStore.prototype, 'record').mockRejectedValueOnce(new Error('synthetic storage failure'))
    const result = await writeFileTool.execute({ path: file, data: 'published', expectedHash }, ctx)
    expect(result).toMatchObject({ success: false, metadata: { fileMutationApplied: true, rollbackAvailable: false } })
    expect(fs.readFileSync(file, 'utf8')).toBe('published')
    expect(await store.list(ctx.tenantId, ctx.sessionId)).toHaveLength(0)
    expect(stagingFiles()).toEqual([])
  })
  it('uses one lock for path/case aliases instead of recording two conflicting writes', async () => {
    const { file, expectedHash } = seed('old', 'MixedCase.txt')
    const alias = process.platform === 'win32' ? file.replace('MixedCase.txt', 'mixedcase.TXT') : path.join(root, 'sub/../MixedCase.txt')
    fs.mkdirSync(path.join(root, 'sub'))
    const results = await Promise.all([
      writeFileTool.execute({ path: file, data: 'one', expectedHash }, ctx),
      writeFileTool.execute({ path: alias, data: 'two', expectedHash }, ctx),
    ])
    expect(results.filter(result => result.success)).toHaveLength(1)
    expect(await store.list(ctx.tenantId, ctx.sessionId)).toHaveLength(1)
    expect(fs.readFileSync(file, 'utf8')).toBe(results[0].success ? 'one' : 'two')
  })
  it('produces actual Word format bytes and durable rollback references', async () => {
    const file = path.join(root, 'document.docx')
    const result = await writeFileTool.execute({ path: file, createOnly: true, data: '标题 and synthetic body' }, ctx)
    expect(result.success).toBe(true)
    const bytes = fs.readFileSync(file)
    expect(bytes.subarray(0, 2).toString()).toBe('PK')
    expect(result.metadata).toMatchObject({ expectedHash: hashFileContent(bytes), fileMutationApplied: true })
    const changes = await store.list(ctx.tenantId, ctx.sessionId)
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ oldHash: 'missing', newHash: hashFileContent(bytes), truncated: true })
    expect(fs.readdirSync(path.join(root, 'change-snapshots'))).toHaveLength(1)
  })
  it('preserves both targets when a submitted directory alias changes while the format writer is awaiting', async () => {
    const first = seed('first original', 'first/file.txt'), second = seed('second original', 'second/file.txt')
    const alias = path.join(root, 'alias')
    fs.symlinkSync(path.join(root, 'first'), alias, process.platform === 'win32' ? 'junction' : 'dir')
    const entered = deferred(), release = deferred()
    vi.spyOn(handlerRegistry.getHandler(first.file), 'write').mockImplementationOnce(async temporary => {
      entered.resolve()
      await release.promise
      fs.writeFileSync(temporary, 'staged replacement')
    })
    const pending = writeFileTool.execute({ path: path.join(alias, 'file.txt'), data: 'new', expectedHash: first.expectedHash }, ctx)
    await entered.promise
    if (process.platform === 'win32') fs.rmdirSync(alias)
    else fs.unlinkSync(alias)
    fs.symlinkSync(path.join(root, 'second'), alias, process.platform === 'win32' ? 'junction' : 'dir')
    release.resolve()
    const result = await pending
    expect(result).toMatchObject({ error: 'WRITE_PATH_CONFLICT', metadata: { fileMutationApplied: false } })
    expect(fs.readFileSync(first.file, 'utf8')).toBe('first original')
    expect(fs.readFileSync(second.file, 'utf8')).toBe('second original')
    expect(await store.list(ctx.tenantId, ctx.sessionId)).toHaveLength(0)
    expect(stagingFiles()).toEqual([])
  })
  it('generates a real Excel workbook in staging and returns the published workbook version', async () => {
    const file = path.join(root, 'synthetic.xlsx')
    const result = await writeFileTool.execute({ path: file, createOnly: true, data: { sheets: [{ name: 'Data', rows: [['项目', '数值'], ['synthetic', 42]] }] } }, ctx)
    expect(result.success).toBe(true)
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.readFile(file)
    expect(workbook.getWorksheet('Data')!.getCell('A1').value).toBe('项目')
    expect(workbook.getWorksheet('Data')!.getCell('B2').value).toBe(42)
    expect(result.metadata).toMatchObject({ expectedHash: hashFileContent(fs.readFileSync(file)), fileMutationApplied: true })
    expect(await store.list(ctx.tenantId, ctx.sessionId)).toHaveLength(1)
    expect(stagingFiles()).toEqual([])
  })
  it('preserves legacy unconditional writes and content aliases', async () => {
    const { file } = seed()
    const result = await writeFileTool.execute({ path: file, content: 'legacy' }, ctx)
    expect(result).toMatchObject({ success: true, metadata: { compatibilityAlias: 'content' } })
    expect(fs.readFileSync(file, 'utf8')).toBe('legacy')
  })
  it.each([
    { expectedHash: 'sha256:bad' }, { expectedHash: null }, { createOnly: 'false' },
    { createOnly: true, expectedHash: hashFileContent('old') },
  ])('rejects malformed/contradictory conditions before a writer can touch disk: %j', async conditions => {
    const { file } = seed(), writer = vi.spyOn(handlerRegistry.getHandler(file), 'write')
    const result = await writeFileTool.execute({ path: file, data: 'bad', ...conditions }, ctx)
    expect(result).toMatchObject({ error: 'WRITE_INVALID_ARGUMENTS', metadata: { fileMutationApplied: false } })
    expect(writer).not.toHaveBeenCalled()
    expect(fs.readFileSync(file, 'utf8')).toBe('original\r\n')
    expect(await store.list(ctx.tenantId, ctx.sessionId)).toHaveLength(0)
  })
  it('preserves write conditions through both structured JSON and parameter XML fallback', () => {
    const expectedHash = hashFileContent('old')
    const json = parseXmlToolCalls(`<tool_call>{"name":"write_file","arguments":{"path":"versioned.txt","content":"new","expectedHash":"${expectedHash}"}}</tool_call>`)
    expect(json).toHaveLength(1)
    expect(json[0].args).toEqual({ path: 'versioned.txt', data: 'new', expectedHash })
    const xml = parseXmlToolCalls('<tool_call><function=write_file><parameter=path>new.txt</parameter><parameter=data>new</parameter><parameter=expectedHash>missing</parameter><parameter=createOnly>true</parameter></function></tool_call>')
    expect(xml).toHaveLength(1)
    expect(xml[0].args).toEqual({ path: 'new.txt', data: 'new', expectedHash: 'missing', createOnly: true })
    expect(normalizeWriteFileArgs({ path: 'old.txt', data: 'new', createOnly: false })).toMatchObject({ ok: true, args: { createOnly: false } })
  })
  it('rejects an outside-workspace target without starting a writer or creating stage files', async () => {
    const outside = path.resolve(root, '../outside-conditional-target.txt'), writer = vi.spyOn(handlerRegistry.getHandler(outside), 'write')
    const result = await writeFileTool.execute({ path: outside, createOnly: true, data: 'blocked' }, ctx)
    expect(result.success).toBe(false)
    expect(writer).not.toHaveBeenCalled()
    expect(stagingFiles()).toEqual([])
  })
})
