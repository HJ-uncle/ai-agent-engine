import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeFileTool } from '../super-file-tool.js'
import { deleteFileTool } from '../basic.js'
import { handlerRegistry } from '../handlers/registry.js'
import { moveToSystemTrash } from '../trash.js'
import { hashFileContent } from '../../../shared/file-version.js'
import type { AgentContext } from '../../../core/agent-context/index.js'
import type { RecordChangeInput } from '../../../storage/changes/index.js'

const { record, records } = vi.hoisted(() => ({ record: vi.fn(), records: [] as RecordChangeInput[] }))
vi.mock('../../../storage/changes/index.js', () => ({ ChangeStore: class { record = record } }))
vi.mock('../../../workspace/index.js', () => ({ workspaceManager: {
  resolveSafePath: (ctx: AgentContext, file: string) => path.resolve(ctx.cwd!, file),
} }))
vi.mock('../trash.js', () => ({ moveToSystemTrash: vi.fn() }))
vi.mock('../handlers/registry.js', async () => {
  const { TextHandler } = await import('../handlers/text-handler.js')
  const { JsonHandler } = await import('../handlers/json-handler.js')
  const text = new TextHandler()
  const json = new JsonHandler()
  return { handlerRegistry: { getHandler: vi.fn((file: string) => file.endsWith('.json') ? json : text) } }
})

let root: string
let ctx: AgentContext
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-producer-'))
  ctx = { tenantId: 'test', sessionId: 'parent', cwd: root, logger: { warn: vi.fn() } } as unknown as AgentContext
  records.length = 0
  record.mockReset().mockImplementation(async (_tenant, input: RecordChangeInput) => {
    records.push(input)
    return { ...input, id: `change-${records.length}`, status: 'pending' }
  })
  vi.mocked(moveToSystemTrash).mockReset().mockImplementation(async file => { fs.renameSync(file, `${file}.trash`) })
})
afterEach(() => {
  vi.restoreAllMocks()
  const resolved = path.resolve(root)
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('aether-producer-')) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(resolved, { recursive: true, force: true })
})

function gate() {
  let open!: () => void
  const promise = new Promise<void>(resolve => { open = resolve })
  return { promise, open }
}

describe('file mutation producers', () => {
  it('records the actual JSON formatter output and preserves prior UTF-8/CRLF bytes', async () => {
    const file = path.join(root, 'example.json')
    const before = '{"文字":"原值"}\r\n'
    fs.writeFileSync(file, before)
    const result = await writeFileTool.execute({ path: file, data: { 文字: '新值' } }, ctx)
    const after = fs.readFileSync(file)
    expect(result.success).toBe(true)
    expect(records[0]).toMatchObject({ oldContent: before, newContent: after.toString('utf8'), oldHash: hashFileContent(Buffer.from(before)), newHash: hashFileContent(after), truncated: false })
    expect(after.toString('utf8')).toBe('{\n  "文字": "新值"\n}')
  })

  it('distinguishes a newly created empty file from an existing empty file', async () => {
    const first = await writeFileTool.execute({ path: 'empty.txt', data: '' }, ctx)
    const second = await writeFileTool.execute({ path: 'empty.txt', data: 'content' }, ctx)
    expect(first.change).toMatchObject({ isNew: true, oldHash: 'missing', newHash: hashFileContent(''), oldContent: null, newContent: '' })
    expect(second.change).toMatchObject({ isNew: false, oldHash: hashFileContent(''), oldContent: '', newContent: 'content' })
    expect(hashFileContent('')).not.toBe(hashFileContent(null))
  })

  it.each([
    ['large.txt', Buffer.from('中文'.repeat(50_001))],
    ['invalid.txt', Buffer.from([0xff, 0xfe, 0x61])],
    ['binary.txt', Buffer.from([0, 1, 2])],
  ])('retains complete before/after hashes for an unrecoverable snapshot: %s', async (name, before) => {
    fs.writeFileSync(path.join(root, name), before)
    const result = await writeFileTool.execute({ path: name, data: 'new' }, ctx)
    expect(result.success).toBe(true)
    expect(records[0]).toMatchObject({ oldContent: null, newContent: 'new', oldHash: hashFileContent(before), newHash: hashFileContent('new'), truncated: true })
  })

  it('hashes large newly written bytes even though the text snapshot is omitted', async () => {
    const data = '中文'.repeat(50_001)
    const result = await writeFileTool.execute({ path: 'large.txt', data }, ctx)
    expect(result.change).toMatchObject({ isNew: true, oldHash: 'missing', newHash: hashFileContent(Buffer.from(data)), oldContent: null, newContent: null, truncated: true })
    expect(fs.readFileSync(path.join(root, 'large.txt'), 'utf8')).toBe(data)
  })

  it('records a failed writer\'s partial mutation and retains its failed outcome', async () => {
    const file = path.join(root, 'partial.txt')
    fs.writeFileSync(file, 'before')
    vi.mocked(handlerRegistry.getHandler).mockReturnValueOnce({
      extensions: ['.txt'], read: vi.fn(),
      write: async destination => { fs.writeFileSync(destination, 'partial'); throw new Error('writer crashed') },
    })
    const result = await writeFileTool.execute({ path: file, data: 'wanted' }, ctx)
    expect(result).toMatchObject({ success: false, metadata: { fileMutationApplied: true, rollbackAvailable: true } })
    expect(result.change).toMatchObject({ oldContent: 'before', newContent: 'partial', oldHash: hashFileContent('before'), newHash: hashFileContent('partial') })
    expect(fs.readFileSync(file, 'utf8')).toBe('partial')
  })

  it('serializes parent/subagent writes through directory aliases until the first record is committed', async () => {
    const real = path.join(root, 'real')
    const alias = path.join(root, 'alias')
    fs.mkdirSync(real)
    fs.symlinkSync(real, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const file = path.join(real, 'code.txt')
    fs.writeFileSync(file, 'A')
    const entered = gate()
    const release = gate()
    const baseRecord = record.getMockImplementation()!
    record.mockImplementationOnce(async (...args) => { entered.open(); await release.promise; return baseRecord(...args) })
    const first = writeFileTool.execute({ path: file, data: 'B' }, ctx)
    await entered.promise
    const second = writeFileTool.execute({ path: path.join(alias, 'code.txt'), data: 'C' }, { ...ctx, sessionId: 'child' })
    try {
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(fs.readFileSync(file, 'utf8')).toBe('B')
      expect(record).toHaveBeenCalledTimes(1)
    } finally { release.open() }
    expect((await Promise.all([first, second])).every(result => result.success)).toBe(true)
    expect(records.map(r => [r.oldContent, r.newContent])).toEqual([['A', 'B'], ['B', 'C']])
    expect(records[0].path).toBe(records[1].path)
    expect(records[1].oldHash).toBe(records[0].newHash)
    expect(fs.readFileSync(file, 'utf8')).toBe('C')
  })

  it.skipIf(process.platform !== 'win32')('serializes Windows case aliases of an existing file', async () => {
    const file = path.join(root, 'mixed.txt')
    fs.writeFileSync(file, 'A')
    const results = await Promise.all([
      writeFileTool.execute({ path: file, data: 'B' }, ctx),
      writeFileTool.execute({ path: file.toUpperCase(), data: 'C' }, { ...ctx, sessionId: 'child' }),
    ])
    expect(results.every(result => result.success)).toBe(true)
    expect(records[1].oldHash).toBe(records[0].newHash)
    expect(records[0].path).toBe(records[1].path)
    expect(fs.readFileSync(file, 'utf8')).toBe(records[1].newContent)
  })

  it('orders a concurrent delete after the write snapshot and records only after trash succeeds', async () => {
    const file = path.join(root, 'code.txt')
    fs.writeFileSync(file, 'A')
    const entered = gate()
    const release = gate()
    const baseRecord = record.getMockImplementation()!
    record.mockImplementationOnce(async (...args) => { entered.open(); await release.promise; return baseRecord(...args) })
    const writing = writeFileTool.execute({ path: file, data: 'B' }, ctx)
    await entered.promise
    const deleting = deleteFileTool.execute({ path: file }, { ...ctx, sessionId: 'child' })
    try {
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(moveToSystemTrash).not.toHaveBeenCalled()
    } finally { release.open() }
    expect((await Promise.all([writing, deleting])).every(result => result.success)).toBe(true)
    expect(records[1]).toMatchObject({ kind: 'delete', oldContent: 'B', newContent: null, oldHash: hashFileContent('B'), newHash: 'missing' })
    expect(fs.existsSync(file)).toBe(false)
    expect(fs.readFileSync(`${file}.trash`, 'utf8')).toBe('B')
  })

  it('does not record a failed trash operation or mutate the original file', async () => {
    const file = path.join(root, 'code.txt')
    fs.writeFileSync(file, 'A')
    vi.mocked(moveToSystemTrash).mockRejectedValueOnce(new Error('trash unavailable'))
    const result = await deleteFileTool.execute({ path: file }, ctx)
    expect(result).toMatchObject({ success: false, output: 'trash unavailable' })
    expect(record).not.toHaveBeenCalled()
    expect(fs.readFileSync(file, 'utf8')).toBe('A')
  })

  it('rejects directory and direct link deletion without touching their targets', async () => {
    const dir = path.join(root, 'folder')
    const link = path.join(root, 'link')
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, 'kept.txt'), 'keep')
    fs.symlinkSync(dir, link, process.platform === 'win32' ? 'junction' : 'dir')
    for (const file of [dir, link]) expect((await deleteFileTool.execute({ path: file }, ctx)).success).toBe(false)
    expect(fs.readFileSync(path.join(dir, 'kept.txt'), 'utf8')).toBe('keep')
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
    expect(moveToSystemTrash).not.toHaveBeenCalled()
    expect(record).not.toHaveBeenCalled()
  })

  it.each(['write', 'delete'])('reports actual %s side effects when recording fails', async operation => {
    const file = path.join(root, 'code.txt')
    fs.writeFileSync(file, 'A')
    record.mockRejectedValueOnce(new Error('database unavailable'))
    const result = operation === 'write'
      ? await writeFileTool.execute({ path: file, data: 'B' }, ctx)
      : await deleteFileTool.execute({ path: file }, ctx)
    expect(result).toMatchObject({ success: false, metadata: { fileMutationApplied: true, rollbackAvailable: false } })
    expect(result.output).toContain('文件已变更')
    expect(result.change).toBeUndefined()
    if (operation === 'write') expect(fs.readFileSync(file, 'utf8')).toBe('B')
    else expect(fs.existsSync(file)).toBe(false)
  })
})
