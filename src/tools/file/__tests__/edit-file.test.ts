import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as database from '../../../storage/sqlite/db.js'
import { ChangeStore } from '../../../storage/changes/index.js'
import type { AgentContext } from '../../../core/agent-context/index.js'
import { clearSecurityMode, setSecurityMode } from '../../../security/policy-engine.js'
import { hashFileContent, withFileLocks } from '../../../shared/file-version.js'
import { editFileTool } from '../edit-file.js'
import { readFileTool, writeFileTool } from '../super-file-tool.js'
import { MAX_FILE_SIZE } from '../constants.js'

let root: string
let db: Client
let ctx: AgentContext
let store: ChangeStore
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-d6-edit-'))
  vi.stubEnv('AUTH_ENABLED', 'false')
  vi.stubEnv('DATA_DIR', path.join(root, 'agent.db'))
  db = createClient({ url: 'file::memory:' })
  vi.spyOn(database, 'getDb').mockReturnValue(db)
  store = new ChangeStore()
  ctx = { tenantId: 'd6-tenant', sessionId: path.basename(root), rootSessionId: path.basename(root), rootRunId: 'root-run', turnId: 'root-turn',
    workspacePaths: [root], projectRoot: root, cwd: root, scratchDir: path.join(root, 'scratch'),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as unknown as AgentContext
  setSecurityMode(ctx.tenantId, ctx.sessionId, 'safe')
})

afterEach(() => {
  clearSecurityMode(ctx.tenantId, ctx.sessionId)
  db.close()
  vi.restoreAllMocks()
  if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('aether-d6-edit-')) throw new Error('Unsafe fixture path')
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  vi.unstubAllEnvs()
})

function seed(content: string | Buffer = 'alpha=1\r\nbeta=2\r\n', name = 'file.txt') {
  const file = path.join(root, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  return { file, expectedHash: hashFileContent(Buffer.from(content)) }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

describe('D6 exact text edits with full byte versions', () => {
  it('chains write and edits using the model-visible versions without a redundant read', async () => {
    const file = path.join(root, '.ae', 'tmp', 'test-gomoku.mjs')
    const content = '\uFEFFconst 标题 = "旧😀";\r\nconst value = 1;\r\n'
    const written = await writeFileTool.execute({ path: file, data: content }, ctx)
    expect(written.success).toBe(true)
    const version = written.output.match(/^expectedHash: (sha256:[a-f0-9]{64})$/m)?.[1]
    expect(version).toBe(hashFileContent(fs.readFileSync(file)))
    expect(written.metadata).toMatchObject({ path: file, expectedHash: version, fileMutationApplied: true })

    const edited = await editFileTool.execute({ path: file, expectedHash: version,
      edits: [{ oldText: '"旧😀"', newText: '"新✨"' }] }, ctx)
    expect(edited.success).toBe(true)
    const nextVersion = edited.output.match(/^expectedHash: (sha256:[a-f0-9]{64})$/m)?.[1]
    expect(nextVersion).toBe(hashFileContent(fs.readFileSync(file)))
    expect(edited.metadata).toMatchObject({ path: file, expectedHash: nextVersion })
    expect(nextVersion).not.toBe(version)

    const second = await editFileTool.execute({ path: file, expectedHash: nextVersion,
      edits: [{ oldText: 'value = 1', newText: 'value = 2' }] }, ctx)
    expect(second.success).toBe(true)
    expect(fs.readFileSync(file)).toEqual(Buffer.from('\uFEFFconst 标题 = "新✨";\r\nconst value = 2;\r\n'))
    expect(await store.list(ctx.tenantId, ctx.sessionId)).toHaveLength(3)
  })

  it('returns the actual formatted file version rather than hashing write input', async () => {
    const file = path.join(root, 'settings.json')
    const data = { title: '标题', value: 1 }
    const written = await writeFileTool.execute({ path: file, data }, ctx)
    expect(written.success).toBe(true)
    const actual = fs.readFileSync(file)
    expect(actual.toString('utf8')).toBe(JSON.stringify(data, null, 2))
    const version = written.output.match(/^expectedHash: (sha256:[a-f0-9]{64})$/m)?.[1]
    expect(version).toBe(hashFileContent(actual))
    expect(version).not.toBe(hashFileContent(JSON.stringify(data)))
    expect(written.change).toMatchObject({ newHash: version })
    const edited = await editFileTool.execute({ path: file, expectedHash: version,
      edits: [{ oldText: '"value": 1', newText: '"value": 2' }] }, ctx)
    expect(edited.success).toBe(true)
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ title: '标题', value: 2 })
  })

  it('rejects external changes after write even if the expected replacement still matches', async () => {
    const file = path.join(root, 'versioned.mjs')
    const written = await writeFileTool.execute({ path: file, data: 'const value = 1;\n// original\n' }, ctx)
    expect(written.success).toBe(true)
    const expectedHash = written.output.match(/^expectedHash: (sha256:[a-f0-9]{64})$/m)?.[1]
    fs.writeFileSync(file, 'const value = 1;\n// user changes\n')
    const edited = await editFileTool.execute({ path: file, expectedHash,
      edits: [{ oldText: 'value = 1', newText: 'value = 2' }] }, ctx)
    expect(edited).toMatchObject({ success: false, error: 'EDIT_VERSION_CONFLICT',
      metadata: { expectedHash, fileMutationApplied: false } })
    expect(fs.readFileSync(file, 'utf8')).toBe('const value = 1;\n// user changes\n')
    expect(await store.list(ctx.tenantId, ctx.sessionId)).toHaveLength(1)
  })

  it('still rejects incorrect original text with a current write version', async () => {
    const file = path.join(root, 'exact.mjs')
    const written = await writeFileTool.execute({ path: file, data: 'const value = 1;\n' }, ctx)
    expect(written.success).toBe(true)
    const expectedHash = written.output.match(/^expectedHash: (sha256:[a-f0-9]{64})$/m)?.[1]
    const edited = await editFileTool.execute({ path: file, expectedHash,
      edits: [{ oldText: 'const value = 999;', newText: 'const value = 2;' }] }, ctx)
    expect(edited).toMatchObject({ success: false, error: 'EDIT_NO_MATCH', metadata: { fileMutationApplied: false } })
    expect(fs.readFileSync(file, 'utf8')).toBe('const value = 1;\n')
    expect(await store.list(ctx.tenantId, ctx.sessionId)).toHaveLength(1)
  })

  it('edits JSON without formatting and records the root identity and exact bytes for successful rollback', async () => {
    const original = '{ "保留":  "值", "target": 1 }\r\n'
    const { file, expectedHash } = seed(original, 'settings.json')
    const result = await editFileTool.execute({ path: file, expectedHash, edits: [{ oldText: '"target": 1', newText: '"target": 2' }] }, ctx)
    const modified = '{ "保留":  "值", "target": 2 }\r\n'
    expect(result.success).toBe(true)
    expect(fs.readFileSync(file)).toEqual(Buffer.from(modified))
    expect(result.change).toMatchObject({ sessionId: ctx.sessionId, runId: 'root-run', turnId: 'root-turn',
      oldContent: original, newContent: modified, oldHash: expectedHash, newHash: hashFileContent(modified), truncated: false })
    const rollback = await store.revertBatch(ctx.tenantId, { sessionId: ctx.sessionId, ids: [String(result.change!.id)] })
    expect(rollback).toMatchObject({ total: 1, reverted: 1, conflicts: 0, failed: 0 })
    expect(fs.readFileSync(file)).toEqual(Buffer.from(original))
  })

  it('locates multiple replacements against the same original text rather than cascading new matches', async () => {
    const { file, expectedHash } = seed()
    const result = await editFileTool.execute({ path: file, expectedHash, edits: [
      { oldText: 'beta', newText: 'alpha' }, { oldText: 'alpha', newText: 'beta' },
    ] }, ctx)
    expect(result.success).toBe(true)
    expect(fs.readFileSync(file, 'utf8')).toBe('beta=1\r\nalpha=2\r\n')
    expect(await store.list(ctx.tenantId, ctx.sessionId)).toHaveLength(1)
  })

  it('gets a model-visible hash and exact CRLF/Unicode/BOM text from read_file and preserves all untouched bytes', async () => {
    const original = '\uFEFF标题😀\r\n值=旧\r\n末尾\r\n'
    const { file, expectedHash } = seed(original)
    const read = await readFileTool.execute({ path: file, mode: 'exact' }, ctx)
    expect(read.success).toBe(true)
    const parsed = JSON.parse(read.output)
    expect(parsed).toMatchObject({ expectedHash, encoding: 'utf-8', lineEnding: 'CRLF', utf8Bom: true, content: original })
    const page = await readFileTool.execute({ path: file, mode: 'exact', start_line: 2, end_line: 2 }, ctx)
    expect(JSON.parse(page.output)).toMatchObject({ content: '值=旧\r\n', expectedHash, startLine: 2, endLine: 2 })
    const result = await editFileTool.execute({ path: parsed.path, expectedHash: parsed.expectedHash,
      edits: [{ oldText: '值=旧\r\n', newText: '值=新✨\r\n' }] }, ctx)
    expect(result.success).toBe(true)
    expect(fs.readFileSync(file)).toEqual(Buffer.from('\uFEFF标题😀\r\n值=新✨\r\n末尾\r\n'))
    const numbered = await readFileTool.execute({ path: file }, ctx)
    expect(numbered.output).toContain('   2 | 值=新✨\r')
    expect(numbered.output).toContain('行号和格式化内容不是原文')
    expect(numbered.output).toContain(String(result.change!.newHash))
  })

  it.each([
    { name: 'missing match', content: 'alpha', edits: [{ oldText: 'absent', newText: 'updated' }], code: 'EDIT_NO_MATCH' },
    { name: 'repeated match', content: 'alpha alpha', edits: [{ oldText: 'alpha', newText: 'updated' }], code: 'EDIT_AMBIGUOUS_MATCH' },
    { name: 'overlapping repeated match', content: 'aaa', edits: [{ oldText: 'aa', newText: 'updated' }], code: 'EDIT_AMBIGUOUS_MATCH' },
    { name: 'overlapping edits', content: 'abcdef', edits: [{ oldText: 'abc', newText: 'updated' }, { oldText: 'bcd', newText: 'other' }], code: 'EDIT_OVERLAPPING_MATCHES' },
    { name: 'identical edits', content: 'abcdef', edits: [{ oldText: 'abc', newText: 'first' }, { oldText: 'abc', newText: 'second' }], code: 'EDIT_OVERLAPPING_MATCHES' },
    { name: 'later invalid edit', content: 'alpha beta', edits: [{ oldText: 'alpha', newText: 'would change' }, { oldText: 'missing', newText: 'invalid' }], code: 'EDIT_NO_MATCH' },
    { name: 'empty oldText', content: 'alpha', edits: [{ oldText: '', newText: 'updated' }], code: 'EDIT_INVALID_ARGUMENTS' },
    { name: 'empty edit list', content: 'alpha', edits: [], code: 'EDIT_INVALID_ARGUMENTS' },
    { name: 'binary replacement', content: 'alpha', edits: [{ oldText: 'alpha', newText: 'new\0value' }], code: 'EDIT_NOT_TEXT' },
    { name: 'invalid unicode replacement', content: 'alpha', edits: [{ oldText: 'alpha', newText: '\ud800' }], code: 'EDIT_NOT_TEXT' },
  ])('rejects $name before any file or record mutation', async ({ content, edits, code }) => {
    const { file, expectedHash } = seed(content)
    const before = fs.statSync(file)
    const result = await editFileTool.execute({ path: file, expectedHash, edits }, ctx)
    expect(result).toMatchObject({ success: false, error: code, metadata: { code, fileMutationApplied: false } })
    expect(fs.readFileSync(file)).toEqual(Buffer.from(content))
    expect(fs.statSync(file).mtimeMs).toBe(before.mtimeMs)
    expect(await store.list(ctx.tenantId, ctx.sessionId)).toEqual([])
  })

  it('refuses a stale full-file hash even when the selected oldText still matches', async () => {
    const { file, expectedHash } = seed('alpha\r\nold footer')
    fs.writeFileSync(file, 'alpha\r\nmanual footer')
    const result = await editFileTool.execute({ path: file, expectedHash, edits: [{ oldText: 'alpha', newText: 'beta' }] }, ctx)
    expect(result).toMatchObject({ success: false, error: 'EDIT_VERSION_CONFLICT', metadata: {
      expectedHash, actualHash: hashFileContent('alpha\r\nmanual footer'), fileMutationApplied: false,
    } })
    expect(fs.readFileSync(file, 'utf8')).toBe('alpha\r\nmanual footer')
    expect(await store.list(ctx.tenantId, ctx.sessionId)).toEqual([])
  })

  it.each([
    { name: 'invalid.txt', content: Buffer.from([0xff, 0xfe, 0x61]), code: 'EDIT_NOT_TEXT' },
    { name: 'binary.txt', content: Buffer.from([0x61, 0x00, 0x62]), code: 'EDIT_NOT_TEXT' },
    { name: 'pretend.pdf', content: Buffer.from('alpha'), code: 'EDIT_NOT_TEXT' },
  ])('rejects unsupported source $name with no mutation', async ({ name, content, code }) => {
    const { file, expectedHash } = seed(content, name)
    const result = await editFileTool.execute({ path: file, expectedHash, edits: [{ oldText: 'a', newText: 'b' }] }, ctx)
    expect(result).toMatchObject({ success: false, error: code })
    expect(fs.readFileSync(file)).toEqual(content)
    expect(await store.list(ctx.tenantId, ctx.sessionId)).toEqual([])
  })

  it('edits and reverts a text file larger than the legacy 100KB snapshot limit', async () => {
    const original = `${'x'.repeat(100_000)}\nUNIQUE_TARGET\n${'y'.repeat(10_000)}`
    const { file, expectedHash } = seed(original, 'large.txt')
    const result = await editFileTool.execute({ path: file, expectedHash,
      edits: [{ oldText: 'UNIQUE_TARGET', newText: 'UPDATED_TARGET' }] }, ctx)
    expect(result.success).toBe(true)
    expect(result.change).toMatchObject({ truncated: true, oldContent: null, newContent: null,
      oldHash: expectedHash, newHash: hashFileContent(fs.readFileSync(file)), oldSnapshotRef: expect.any(String) })
    const rollback = await store.revertBatch(ctx.tenantId, { sessionId: ctx.sessionId, ids: [String(result.change!.id)] })
    expect(rollback).toMatchObject({ total: 1, reverted: 1, failed: 0, unavailable: 0 })
    expect(fs.readFileSync(file, 'utf8')).toBe(original)
  })

  it('rejects missing files, directories and traversal outside the safe workspace', async () => {
    const args = { expectedHash: hashFileContent('alpha'), edits: [{ oldText: 'alpha', newText: 'beta' }] }
    const missing = await editFileTool.execute({ path: path.join(root, 'missing.txt'), ...args }, ctx)
    expect(missing).toMatchObject({ success: false, error: 'EDIT_FILE_MISSING' })
    expect((await editFileTool.execute({ path: root, ...args }, ctx)).success).toBe(false)
    const outside = await editFileTool.execute({ path: path.join(root, '..', 'outside.txt'), ...args }, ctx)
    expect(outside.success).toBe(false)
    expect(outside.output).toContain('outside any bound workspace')
    expect(fs.existsSync(path.join(root, 'missing.txt'))).toBe(false)
    expect(await store.list(ctx.tenantId, ctx.sessionId)).toEqual([])
  })

  it('does not create a duplicate change for a no-op replacement', async () => {
    const { file, expectedHash } = seed('alpha')
    const result = await editFileTool.execute({ path: file, expectedHash, edits: [{ oldText: 'alpha', newText: 'alpha' }] }, ctx)
    expect(result).toMatchObject({ success: true, metadata: { noChange: true, newHash: expectedHash } })
    expect(result.change).toBeUndefined()
    expect(await store.list(ctx.tenantId, ctx.sessionId)).toEqual([])
  })

  it('serializes parent and child aliases so only one edit of an expected version succeeds', async () => {
    const { file, expectedHash } = seed('alpha', 'real/file.txt')
    const alias = path.join(root, 'alias')
    fs.symlinkSync(path.dirname(file), alias, process.platform === 'win32' ? 'junction' : 'dir')
    const child = { ...ctx, sessionId: 'child', rootSessionId: ctx.sessionId }
    const results = await Promise.all([
      editFileTool.execute({ path: file, expectedHash, edits: [{ oldText: 'alpha', newText: 'parent' }] }, ctx),
      editFileTool.execute({ path: path.join(alias, 'file.txt'), expectedHash, edits: [{ oldText: 'alpha', newText: 'child' }] }, child),
    ])
    expect(results.filter(result => result.success)).toHaveLength(1)
    expect(results.filter(result => !result.success)).toMatchObject([{ error: 'EDIT_VERSION_CONFLICT' }])
    const records = await store.list(ctx.tenantId, ctx.sessionId)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ oldHash: expectedHash, newHash: hashFileContent(fs.readFileSync(file)), runId: 'root-run', turnId: 'root-turn' })
  })

  it('waits for a shared file lock before reading the exact text and corresponding version', async () => {
    const { file } = seed('original')
    const locked = deferred(), release = deferred()
    const writer = withFileLocks([file], async () => { locked.resolve(); await release.promise; fs.writeFileSync(file, 'manual\r\n更新') })
    await locked.promise
    let readFinished = false
    const reading = readFileTool.execute({ path: file, mode: 'exact' }, ctx).then(result => { readFinished = true; return result })
    try { await new Promise(resolve => setImmediate(resolve)); expect(readFinished).toBe(false) }
    finally { release.resolve(); await writer }
    const read = await reading
    expect(JSON.parse(read.output)).toMatchObject({ content: 'manual\r\n更新', expectedHash: hashFileContent('manual\r\n更新') })
  })

  it('reports an applied edit when change persistence fails instead of pretending the file was untouched', async () => {
    const { file, expectedHash } = seed('alpha')
    vi.spyOn(ChangeStore.prototype, 'record').mockRejectedValueOnce(new Error('database unavailable'))
    const result = await editFileTool.execute({ path: file, expectedHash, edits: [{ oldText: 'alpha', newText: 'beta' }] }, ctx)
    expect(result).toMatchObject({ success: false, error: 'EDIT_RECORD_FAILED', metadata: { fileMutationApplied: true, rollbackAvailable: false } })
    expect(fs.readFileSync(file, 'utf8')).toBe('beta')
  })

  it('never guesses a similarly named file for an exact read', async () => {
    const { file } = seed('wrong target must not be read', 'newest/file.txt')
    const read = await readFileTool.execute({ path: 'missing/file.txt', mode: 'exact' }, ctx)
    expect(read.success).toBe(false)
    expect(read.output).toContain('does not guess another path')
    expect(read.output).not.toContain('wrong target must not be read')
    expect(fs.readFileSync(file, 'utf8')).toBe('wrong target must not be read')
  })

  it.each(['auto', 'exact', 'edit'])('rejects an oversized %s file before reading its contents into memory', async mode => {
    const { file, expectedHash } = seed('alpha')
    fs.truncateSync(file, Math.max(MAX_FILE_SIZE, 100_000) + 1)
    const read = vi.spyOn(fs, 'readFileSync')
    const result = mode === 'edit'
      ? await editFileTool.execute({ path: file, expectedHash, edits: [{ oldText: 'alpha', newText: 'beta' }] }, ctx)
      : await readFileTool.execute({ path: file, mode }, ctx)
    expect(result.success).toBe(false)
    expect(result.output).toMatch(/too large|at most/i)
    expect(read).not.toHaveBeenCalled()
  })
})
