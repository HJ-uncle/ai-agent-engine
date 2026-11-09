import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadCodeGraph, type CgStatic } from '../codegraph-module.js'
import { CODEGRAPH_SNAPSHOT_CHUNK_BYTES, CODEGRAPH_SNAPSHOT_IDLE_MS, disposeReadonlyCodegraphSnapshots, openReadonlyCodegraphSnapshot } from '../codegraph-readonly.js'

let fixture: string, root: string, sdk: CgStatic
const temporaryParent = fs.realpathSync(os.tmpdir())
const privateCopies = () => fs.readdirSync(temporaryParent).filter(name => name.startsWith(`aether-codegraph-readonly-${process.pid}-`)).sort()
const database = () => path.join(root, '.ae', 'codegraph.db')
async function digest(filename: string) {
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk)
  return hash.digest('hex')
}

beforeEach(async () => {
  fixture = fs.mkdtempSync(path.join(temporaryParent, 'aether-codegraph-streaming-test-'))
  root = path.join(fixture, 'project'); fs.mkdirSync(root)
  fs.writeFileSync(path.join(root, 'calc.ts'), 'export function add(a: number, b: number) { return a + b }\nexport function total() { return add(1, 2) }\n')
  sdk = await loadCodeGraph()
  const graph = await sdk.init(root, { index: true }); graph.close()
})
afterEach(() => {
  vi.useRealTimers(); vi.restoreAllMocks()
  disposeReadonlyCodegraphSnapshots()
  if (path.dirname(fixture) !== temporaryParent || !path.basename(fixture).startsWith('aether-codegraph-streaming-test-') || fs.lstatSync(fixture).isSymbolicLink()) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(fixture, { recursive: true, force: true })
})

describe('bounded reusable codegraph disk snapshots', () => {
  it('queries a real database above 64 MiB with fixed-size copy buffers and leaves every source byte unchanged', async () => {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')
    const writer = new DatabaseSync(database())
    writer.exec('CREATE TABLE snapshot_padding (data BLOB); INSERT INTO snapshot_padding VALUES(zeroblob(68 * 1024 * 1024))'); writer.close()
    const before = fs.statSync(database()), hash = await digest(database()), copies = privateCopies()
    const allocations = vi.spyOn(Buffer, 'allocUnsafe'), open = vi.spyOn(sdk, 'openSync')
    const graph = await openReadonlyCodegraphSnapshot(root, sdk, () => {})
    try {
      expect(before.size).toBeGreaterThan(64 * 1024 * 1024)
      expect(graph.searchNodes('add', { limit: 5 }).some(hit => hit.node.name === 'add')).toBe(true)
      expect(graph.getIndexState()).toBe('complete')
      expect(graph.getStats().fileCount).toBe(1)
      expect(Math.max(...allocations.mock.calls.map(args => args[0]))).toBeLessThanOrEqual(CODEGRAPH_SNAPSHOT_CHUNK_BYTES)
      expect(open).toHaveBeenCalledTimes(1)
      expect(open.mock.calls[0][0]).not.toBe(root)
    } finally { graph.close() }
    expect(await digest(database())).toBe(hash)
    expect(fs.statSync(database()).mtimeMs).toBe(before.mtimeMs)
    expect(fs.readdirSync(path.join(root, '.ae')).some(name => /-wal$|-shm$/.test(name))).toBe(false)
    disposeReadonlyCodegraphSnapshots()
    expect(privateCopies()).toEqual(copies)
  }, 30_000)

  it('deduplicates concurrent and sequential acquisitions while enforcing each lease authorization independently', async () => {
    const open = vi.spyOn(sdk, 'openSync')
    let allowed = true
    const checkA = () => { if (!allowed) throw new Error('Workspace changed for A') }
    const [a, b] = await Promise.all([
      openReadonlyCodegraphSnapshot(root, sdk, checkA),
      openReadonlyCodegraphSnapshot(root, sdk, () => {}),
    ])
    try {
      expect(open).toHaveBeenCalledTimes(1)
      allowed = false
      expect(() => a.getStats()).toThrow('Workspace changed for A')
      expect(b.getStats().fileCount).toBe(1)
      a.close()
      const c = await openReadonlyCodegraphSnapshot(root, sdk, () => {})
      try { expect(c.searchNodes('add').length).toBeGreaterThan(0); expect(open).toHaveBeenCalledTimes(1) }
      finally { c.close() }
      expect(b.getStats().fileCount).toBe(1)
    } finally { a.close(); b.close() }
  })

  it('does not let a revoked first caller poison another caller sharing construction', async () => {
    let allowed = true
    const a = openReadonlyCodegraphSnapshot(root, sdk, () => { if (!allowed) throw new Error('Revoked A') })
    const b = openReadonlyCodegraphSnapshot(root, sdk, () => {})
    allowed = false
    await expect(a).rejects.toThrow('Revoked A')
    const graph = await b
    try { expect(graph.getStats().fileCount).toBe(1) } finally { graph.close() }
  })

  it('invalidates cached and active leases when a WAL appears and reads the committed live-WAL state in a new snapshot', async () => {
    const first = await openReadonlyCodegraphSnapshot(root, sdk, () => {})
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')
    const writer = new DatabaseSync(database())
    try {
      writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; UPDATE project_metadata SET value='partial' WHERE key='index_state'")
      expect(() => first.getIndexState()).toThrow('正在变化')
      first.close()
      const current = await openReadonlyCodegraphSnapshot(root, sdk, () => {})
      try { expect(current.getIndexState()).toBe('partial') } finally { current.close() }
    } finally { first.close(); writer.close() }
  })

  it('evicts idle copies but refuses to evict active leases when the two-copy admission limit is reached', async () => {
    const otherRoots = [0, 1].map(index => {
      const other = path.join(fixture, `other-${index}`); fs.mkdirSync(other)
      fs.cpSync(path.join(root, '.ae'), path.join(other, '.ae'), { recursive: true })
      return other
    })
    const a = await openReadonlyCodegraphSnapshot(root, sdk, () => {})
    const b = await openReadonlyCodegraphSnapshot(otherRoots[0], sdk, () => {})
    try {
      await expect(openReadonlyCodegraphSnapshot(otherRoots[1], sdk, () => {})).rejects.toThrow('资源繁忙')
      a.close()
      const c = await openReadonlyCodegraphSnapshot(otherRoots[1], sdk, () => {})
      try { expect(b.getStats().fileCount).toBe(1); expect(c.getStats().fileCount).toBe(1) } finally { c.close() }
    } finally { a.close(); b.close() }
  })

  it('expires an idle copy and releases it after thirty seconds', async () => {
    const copies = privateCopies(), graph = await openReadonlyCodegraphSnapshot(root, sdk, () => {})
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    graph.close()
    expect(privateCopies().length).toBe(copies.length + 1)
    await vi.advanceTimersByTimeAsync(CODEGRAPH_SNAPSHOT_IDLE_MS)
    expect(privateCopies()).toEqual(copies)
  })

  it('cleans failed SDK opens and refuses insufficient temporary disk before copying', async () => {
    const copies = privateCopies(), probe = vi.spyOn(sdk, 'openSync')
    const statfs = vi.spyOn(fs, 'statfsSync').mockReturnValue({ bavail: 1, bsize: 4096 } as fs.StatsFs)
    await expect(openReadonlyCodegraphSnapshot(root, sdk, () => {})).rejects.toThrow('磁盘空间不足')
    expect(probe).not.toHaveBeenCalled()
    expect(privateCopies()).toEqual(copies)
    statfs.mockRestore()
    probe.mockImplementationOnce(() => { throw new Error('Fixture SDK open failed') })
    await expect(openReadonlyCodegraphSnapshot(root, sdk, () => {})).rejects.toThrow('Fixture SDK open failed')
    expect(privateCopies()).toEqual(copies)
    const graph = await openReadonlyCodegraphSnapshot(root, sdk, () => {})
    try { expect(graph.getStats().fileCount).toBe(1) } finally { graph.close() }
  })

  it('accounts for private SDK recovery growth and cleans copies that exceed their disk reservation', async () => {
    const copies = privateCopies(), original = sdk.openSync.bind(sdk)
    vi.spyOn(sdk, 'openSync').mockImplementationOnce(temporary => {
      const instance = original(temporary)
      const extra = fs.openSync(path.join(temporary, '.ae', 'unexpected-recovery-growth'), 'wx')
      try { fs.ftruncateSync(extra, 8 * 1024 * 1024) } finally { fs.closeSync(extra) }
      return instance
    })
    await expect(openReadonlyCodegraphSnapshot(root, sdk, () => {})).rejects.toThrow('恢复后超过磁盘预留上限')
    expect(privateCopies()).toEqual(copies)
    expect(fs.readdirSync(path.join(root, '.ae'))).not.toContain('unexpected-recovery-growth')
  })

  it('rechecks path identity for cached leases and refuses an index-directory junction replacement', async () => {
    const graph = await openReadonlyCodegraphSnapshot(root, sdk, () => {})
    const moved = path.join(fixture, 'moved-index')
    fs.renameSync(path.join(root, '.ae'), moved)
    fs.symlinkSync(moved, path.join(root, '.ae'), process.platform === 'win32' ? 'junction' : 'dir')
    try { expect(() => graph.getStats()).toThrow('索引目录在读取中改变') }
    finally { graph.close(); fs.unlinkSync(path.join(root, '.ae')); fs.renameSync(moved, path.join(root, '.ae')) }
  })
})
