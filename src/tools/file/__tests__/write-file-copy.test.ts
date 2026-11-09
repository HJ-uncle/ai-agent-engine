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
import { compactBuiltinToolDefinition } from '../../model-tool-definitions.js'
import { parseXmlToolCalls } from '../../../core/llm-adapter/openai.js'
import { handlerRegistry } from '../handlers/registry.js'
import { MAX_FILE_SIZE } from '../constants.js'
import { writeFileTool } from '../super-file-tool.js'

let root: string, db: Client, ctx: AgentContext, changes: ChangeStore
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-byte-copy-'))
  vi.stubEnv('AUTH_ENABLED', 'false')
  vi.stubEnv('DATA_DIR', path.join(root, 'agent.db'))
  db = createClient({ url: 'file::memory:' })
  vi.spyOn(database, 'getDb').mockReturnValue(db)
  changes = new ChangeStore()
  ctx = { tenantId: 'byte-copy', sessionId: path.basename(root), rootSessionId: path.basename(root), rootRunId: 'copy-run', turnId: 'copy-turn',
    workspacePaths: [root], projectRoot: root, cwd: root, scratchDir: path.join(root, 'scratch'), toolProfile: 'general',
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as unknown as AgentContext
  setSecurityMode(ctx.tenantId, ctx.sessionId, 'safe')
})
afterEach(() => {
  clearSecurityMode(ctx.tenantId, ctx.sessionId)
  db.close()
  vi.restoreAllMocks()
  if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('aether-byte-copy-')) throw new Error('Unsafe copy fixture cleanup')
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  vi.unstubAllEnvs()
})

function seed(name: string, content: string | Buffer) {
  const file = path.join(root, name), bytes = Buffer.from(content)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, bytes)
  return { path: file, expectedHash: hashFileContent(bytes), bytes }
}
function tree() {
  return fs.readdirSync(root, { recursive: true, withFileTypes: true }).map(entry => {
    const file = path.join(entry.parentPath, entry.name)
    return { path: path.relative(root, file), hash: entry.isFile() ? hashFileContent(fs.readFileSync(file)) : 'directory' }
  }).sort((a, b) => a.path.localeCompare(b.path))
}
const from = (source: ReturnType<typeof seed>) => ({ path: source.path, expectedHash: source.expectedHash })

describe('write_file byte-preserving copyFrom', () => {
  it('copies text, empty files, JSON and arbitrary binary exactly on the first call without format writers', async () => {
    const samples = [
      { name: 'lf.txt', bytes: Buffer.from('38\n') },
      { name: 'crlf.txt', bytes: Buffer.from('\uFEFF标题\r\n尾部 \t\r\n\r\n') },
      { name: 'no-eol.txt', bytes: Buffer.from('last line \t') },
      { name: 'empty.txt', bytes: Buffer.alloc(0) },
      { name: 'source.json', bytes: Buffer.from('{  "b": 2,\r\n "a": 1 } \t\n') },
      { name: 'arbitrary.bin', bytes: Buffer.from([0, 255, 128, 13, 10, 0, 239, 187, 191, 32]) },
      { name: 'opaque.docx', bytes: Buffer.from([0x50, 0x4b, 3, 4, 0, 255, 128, 13, 10]) },
    ]
    const handlers = new Set(samples.map(sample => handlerRegistry.getHandler(sample.name)))
    for (const handler of handlers) vi.spyOn(handler, 'write').mockImplementation(async () => { throw new Error('Copy must never invoke a format writer') })
    for (const [index, sample] of samples.entries()) {
      const source = seed(`sources/${sample.name}`, sample.bytes), target = path.join(root, 'copies', sample.name)
      const result = await writeFileTool.execute({ path: target, copyFrom: from(source), ...(index % 2 ? { trailingNewline: 'preserve' } : {}) }, ctx)
      expect(result.success, result.output).toBe(true)
      const actual = fs.readFileSync(target)
      expect(actual.equals(sample.bytes)).toBe(true)
      expect(fs.readFileSync(source.path).equals(sample.bytes)).toBe(true)
      expect(result.metadata).toMatchObject({ expectedHash: source.expectedHash, sha256: source.expectedHash.slice(7),
        byteLength: sample.bytes.length, sourceExpectedHash: source.expectedHash, copyVerified: true, fileMutationApplied: true })
      expect(result.output).toContain(`expectedHash: ${source.expectedHash}`)
      expect(result.output).toMatch(new RegExp(`byteLength["']?\\s*:\\s*${sample.bytes.length}(?:\\D|$)`))
      const record = (await changes.list(ctx.tenantId, ctx.sessionId)).find(change => change.id === result.change?.id)
      expect(record).toMatchObject({ oldHash: 'missing', newHash: source.expectedHash })
    }
    for (const handler of handlers) expect(handler.write).not.toHaveBeenCalled()
    expect(await changes.list(ctx.tenantId, ctx.sessionId)).toHaveLength(samples.length)
  })

  it('requires the current destination version before replacing an existing file and supports actual rollback', async () => {
    const source = seed('source.bin', Buffer.from([0, 255, 13, 10, 32]))
    const target = seed('target.bin', Buffer.from([80, 75, 3, 4, 129, 0]))
    const before = tree()
    for (const conditions of [{}, { expectedHash: 'missing' }, { expectedHash: hashFileContent('stale') }, { createOnly: true }]) {
      const rejected = await writeFileTool.execute({ path: target.path, copyFrom: from(source), ...conditions }, ctx)
      expect(rejected).toMatchObject({ success: false, error: 'WRITE_VERSION_CONFLICT', metadata: { fileMutationApplied: false } })
      expect(tree()).toEqual(before)
    }
    const result = await writeFileTool.execute({ path: target.path, expectedHash: target.expectedHash, copyFrom: from(source) }, ctx)
    expect(result.success, result.output).toBe(true)
    expect(fs.readFileSync(target.path).equals(source.bytes)).toBe(true)
    const rollback = await changes.revertBatch(ctx.tenantId, { sessionId: ctx.sessionId, ids: [String(result.change!.id)] })
    expect(rollback.results).toEqual([expect.objectContaining({ status: 'reverted' })])
    expect(fs.readFileSync(target.path).equals(target.bytes)).toBe(true)
    expect(fs.readFileSync(source.path).equals(source.bytes)).toBe(true)
  })

  it('rejects a stale or missing source before creating a target or staging directories', async () => {
    const source = seed('source.txt', 'current source\n'), before = tree()
    for (const copyFrom of [{ path: source.path, expectedHash: hashFileContent('previous source') },
      { path: path.join(root, 'absent.txt'), expectedHash: source.expectedHash }]) {
      const result = await writeFileTool.execute({ path: path.join(root, 'never-created/target.txt'), copyFrom }, ctx)
      expect(result).toMatchObject({ success: false, metadata: { fileMutationApplied: false } })
      expect(['COPY_SOURCE_VERSION_CONFLICT', 'COPY_SOURCE_MISSING']).toContain(result.error)
      expect(tree()).toEqual(before)
    }
    expect(await changes.list(ctx.tenantId, ctx.sessionId)).toHaveLength(0)
  })

  it('rejects the same canonical path and a different hard-link name for the same source inode', async () => {
    const source = seed('Source.txt', 'same file\r\n'), alias = path.join(root, 'hardlink.txt')
    fs.linkSync(source.path, alias)
    const before = tree()
    const samePath = process.platform === 'win32' ? path.join(root, 'source.TXT') : path.join(root, '.', 'Source.txt')
    for (const target of [source.path, samePath, alias]) {
      const result = await writeFileTool.execute({ path: target, expectedHash: source.expectedHash, copyFrom: from(source) }, ctx)
      expect(result).toMatchObject({ success: false, error: 'COPY_SAME_FILE', metadata: { fileMutationApplied: false } })
      expect(tree()).toEqual(before)
    }
  })

  it('binds both source and destination to the workspace, including an escaping directory alias', async () => {
    const workspace = path.join(root, 'workspace'), outside = seed('outside/source.txt', 'private fixture\n')
    fs.mkdirSync(workspace)
    const internal = seed('workspace/source.txt', 'allowed fixture\n')
    const alias = path.join(workspace, 'external')
    fs.symlinkSync(path.dirname(outside.path), alias, process.platform === 'win32' ? 'junction' : 'dir')
    const bounded = { ...ctx, workspacePaths: [workspace], projectRoot: workspace, cwd: workspace, scratchDir: path.join(workspace, 'scratch') }
    const before = tree()
    for (const args of [
      { path: path.join(workspace, 'new/result.txt'), copyFrom: from(outside) },
      { path: path.join(root, 'outside/new.txt'), copyFrom: from(internal) },
      { path: path.join(workspace, 'new/result.txt'), copyFrom: { path: path.join(alias, 'source.txt'), expectedHash: outside.expectedHash } },
    ]) {
      const result = await writeFileTool.execute(args, bounded)
      expect(result.success).toBe(false)
      expect(tree()).toEqual(before)
    }
  })

  it('rejects ambiguous payloads, absent source versions and newline transformations without filesystem changes', async () => {
    const source = seed('source.txt', 'exact \r\n\n'), before = tree()
    const invalid = [
      { data: 'replacement', copyFrom: from(source) }, { content: 'legacy replacement', copyFrom: from(source) },
      { data: null, copyFrom: from(source) }, { copyFrom: { path: source.path } },
      { copyFrom: { path: source.path, expectedHash: 'missing' } },
      { copyFrom: { path: source.path, expectedHash: 'sha256:short' } },
      { copyFrom: null }, { copyFrom: [] }, { copyFrom: 'source.txt' },
      ...['LF', 'CRLF', 'none'].map(trailingNewline => ({ copyFrom: from(source), trailingNewline })),
    ]
    for (const payload of invalid) {
      const result = await writeFileTool.execute({ path: path.join(root, 'never-created/nested/copy.txt'), ...payload }, ctx)
      expect(result).toMatchObject({ success: false, error: 'WRITE_INVALID_ARGUMENTS', metadata: { fileMutationApplied: false } })
      expect(tree()).toEqual(before)
    }
    expect(await changes.list(ctx.tenantId, ctx.sessionId)).toHaveLength(0)
  })

  it('checks source size and regular-file status before reading or creating any target', async () => {
    const huge = seed('huge.bin', ''), directory = path.join(root, 'source-directory')
    fs.truncateSync(huge.path, MAX_FILE_SIZE + 1)
    fs.mkdirSync(directory)
    const before = fs.readdirSync(root).sort()
    const originalRead = fs.readFileSync.bind(fs)
    const read = vi.spyOn(fs, 'readFileSync').mockImplementation((file: any, options?: any) => {
      if (path.resolve(String(file)) === huge.path) throw new Error('Oversized source must be rejected before materializing it')
      return originalRead(file, options)
    })
    for (const [file, code] of [[huge.path, 'COPY_SOURCE_TOO_LARGE'], [directory, 'COPY_SOURCE_NOT_FILE']]) {
      const result = await writeFileTool.execute({ path: path.join(root, 'new/target.bin'), copyFrom: { path: file, expectedHash: hashFileContent('unused') } }, ctx)
      expect(result).toMatchObject({ success: false, error: code, metadata: { fileMutationApplied: false } })
      expect(fs.readdirSync(root).sort()).toEqual(before)
    }
    read.mockRestore()
    expect(fs.statSync(huge.path).size).toBe(MAX_FILE_SIZE + 1)
  })

  it('serializes opposite-direction copies with both file versions and does not deadlock', async () => {
    const a = seed('a.txt', 'original A\n'), b = seed('b.txt', 'original B\r\n')
    const results = await Promise.all([
      writeFileTool.execute({ path: b.path, expectedHash: b.expectedHash, copyFrom: from(a) }, ctx),
      writeFileTool.execute({ path: a.path, expectedHash: a.expectedHash, copyFrom: from(b) }, ctx),
    ])
    expect(results.filter(result => result.success)).toHaveLength(1)
    expect(results.filter(result => !result.success)).toHaveLength(1)
    expect(fs.readFileSync(a.path).equals(fs.readFileSync(b.path))).toBe(true)
    expect([a.expectedHash, b.expectedHash]).toContain(hashFileContent(fs.readFileSync(a.path)))
    expect(await changes.list(ctx.tenantId, ctx.sessionId)).toHaveLength(1)
  })

  it('does not publish cancelled copies, including cancellation after staging has written bytes', async () => {
    const source = seed('source.txt', 'new bytes\n'), target = seed('target.txt', 'keep original\r\n')
    const alreadyCancelled = new AbortController(); alreadyCancelled.abort()
    const before = tree()
    const first = await writeFileTool.execute({ path: target.path, expectedHash: target.expectedHash, copyFrom: from(source) },
      { ...ctx, signal: alreadyCancelled.signal })
    expect(first.success).toBe(false)
    expect(tree()).toEqual(before)
    const controller = new AbortController(), originalWrite = fs.writeFileSync.bind(fs)
    let stageObserved = false
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file: any, data: any, options?: any) => {
      originalWrite(file, data, options)
      const candidate = String(file)
      if (candidate.includes(`${path.sep}file-writes${path.sep}`)) { stageObserved = true; controller.abort() }
    })
    const second = await writeFileTool.execute({ path: target.path, expectedHash: target.expectedHash, copyFrom: from(source) },
      { ...ctx, signal: controller.signal })
    expect(stageObserved).toBe(true)
    expect(second.success).toBe(false)
    expect(fs.readFileSync(target.path).equals(target.bytes)).toBe(true)
    expect(fs.readFileSync(source.path).equals(source.bytes)).toBe(true)
    expect(await changes.list(ctx.tenantId, ctx.sessionId)).toHaveLength(0)
    const stages = fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.name.startsWith('write-'))
    expect(stages).toEqual([])
  })

  it('rejects a source changed by an external writer after staging but before publication', async () => {
    const source = seed('source.txt', 'initial source\n'), target = seed('target.txt', 'keep target\r\n')
    const external = Buffer.from('external source winner\r\n'), originalWrite = fs.writeFileSync.bind(fs)
    let stageObserved = false
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file: any, data: any, options?: any) => {
      originalWrite(file, data, options)
      if (String(file).includes(`${path.sep}file-writes${path.sep}`)) {
        stageObserved = true
        originalWrite(source.path, external)
      }
    })
    const result = await writeFileTool.execute({ path: target.path, expectedHash: target.expectedHash, copyFrom: from(source) }, ctx)
    expect(stageObserved).toBe(true)
    expect(result).toMatchObject({ success: false, error: 'COPY_SOURCE_VERSION_CONFLICT', metadata: { fileMutationApplied: false } })
    expect(fs.readFileSync(source.path).equals(external)).toBe(true)
    expect(fs.readFileSync(target.path).equals(target.bytes)).toBe(true)
    expect(await changes.list(ctx.tenantId, ctx.sessionId)).toHaveLength(0)
    expect(fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.name.startsWith('write-'))).toEqual([])
  })

  it('keeps the copy alternative model-visible and preserves it through JSON/XML fallback', async () => {
    const source = seed('source.txt', 'precise\r\n\n')
    const definition = compactBuiltinToolDefinition(writeFileTool)
    expect(definition.parameters.properties?.copyFrom).toBeDefined()
    expect(definition.parameters.required ?? []).not.toContain('data')
    const singleShape = (definition.parameters.oneOf as Array<{ oneOf?: unknown[] }>).find(shape => shape.oneOf)
    expect(singleShape?.oneOf).toEqual(expect.arrayContaining([
      expect.objectContaining({ required: ['data'], not: { required: ['copyFrom'] } }),
      expect.objectContaining({ required: ['copyFrom'], not: { required: ['data'] } }),
    ]))
    const json = parseXmlToolCalls(`<tool_call>${JSON.stringify({ name: 'write_file', arguments: { path: 'json-copy.txt', copyFrom: from(source) } })}</tool_call>`)
    const xml = parseXmlToolCalls(`<tool_call><function=write_file><parameter=path>xml-copy.txt</parameter><parameter=copyFrom>${JSON.stringify(from(source))}</parameter></function></tool_call>`)
    for (const invocation of [json[0], xml[0]]) {
      expect(invocation.args.copyFrom).toEqual(from(source))
      expect(invocation.args).not.toHaveProperty('data')
      const result = await writeFileTool.execute(invocation.args, ctx)
      expect(result.success, result.output).toBe(true)
      expect(fs.readFileSync(path.join(root, String(invocation.args.path))).equals(source.bytes)).toBe(true)
    }
  })
})
