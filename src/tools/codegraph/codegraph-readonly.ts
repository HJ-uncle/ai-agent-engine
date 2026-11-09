import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { projectDataPath } from '../../core/project-storage.js'
import { canonicalFilePathSync } from '../../shared/file-version.js'
import type { CgInstance, CgStatic } from './codegraph-module.js'

const readonlyQuery = new AsyncLocalStorage<boolean>()
/** Server-owned invocation scope; model arguments cannot disable this restriction. */
export const withReadonlyCodegraph = <T>(run: () => T): T => readonlyQuery.run(true, run)
export const requiresReadonlyCodegraph = (): boolean => readonlyQuery.getStore() === true

// These are disk/admission limits, not allocations proportional to database size.
export const CODEGRAPH_SNAPSHOT_MAX_BYTES = 512 * 1024 * 1024
export const CODEGRAPH_SNAPSHOT_DISK_BUDGET = 1024 * 1024 * 1024
export const CODEGRAPH_SNAPSHOT_CHUNK_BYTES = 1024 * 1024
export const CODEGRAPH_SNAPSHOT_IDLE_MS = 30_000
const MAX_SNAPSHOTS = 2
const FREE_DISK_RESERVE = 64 * 1024 * 1024
const SOURCE_NAMES = ['codegraph.db', 'codegraph.db-wal', 'codegraph.db-journal'] as const
type SourceName = typeof SOURCE_NAMES[number]
type SourceFile = { name: SourceName; size: number; identity: string }
type Manifest = { files: SourceFile[]; key: string; bytes: number }

export class CodegraphReadonlyUnavailable extends Error {
  readonly code = 'CODEGRAPH_READONLY_UNAVAILABLE'
  constructor(reason: string) { super(`无法安全读取代码图快照：${reason}。请使用 grep/read_file 查询，或由执行角色处理索引。`) }
}

const identity = (stat: fs.Stats) => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':')

/** Filesystem-only inspector: shared construction never retains a caller's authorization closure. */
function inspectSource(root: string) {
  const directory = projectDataPath(root)
  const canonical = canonicalFilePathSync(directory)
  const rootCanonical = canonicalFilePathSync(root)
  const inside = path.relative(rootCanonical, canonical)
  if (inside === '..' || inside.startsWith('..' + path.sep) || path.isAbsolute(inside)) throw new CodegraphReadonlyUnavailable('索引目录越出工作区')
  const assertSource = () => {
    if (canonicalFilePathSync(root) !== rootCanonical || canonicalFilePathSync(directory) !== canonical) {
      throw new CodegraphReadonlyUnavailable('索引目录在读取中改变')
    }
  }
  const manifest = (limit: number): Manifest => {
    assertSource()
    const files: SourceFile[] = []
    let bytes = 0
    for (const name of SOURCE_NAMES) {
      let stat: fs.Stats
      try { stat = fs.lstatSync(path.join(directory, name)) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      if (!stat.isFile() || stat.isSymbolicLink()) throw new CodegraphReadonlyUnavailable('索引文件不是普通文件')
      if (name === 'codegraph.db-journal' && stat.size) throw new CodegraphReadonlyUnavailable('索引存在待恢复 journal')
      bytes += stat.size
      if (bytes > limit) throw new CodegraphReadonlyUnavailable(`数据库与 WAL 超过 ${limit} 字节上限`)
      files.push({ name, size: stat.size, identity: identity(stat) })
    }
    if (!files.some(file => file.name === 'codegraph.db' && file.size)) throw new CodegraphReadonlyUnavailable('索引数据库缺失或为空')
    assertSource()
    return { files, bytes, key: JSON.stringify(files) }
  }
  return { rootCanonical, directory, assertSource, manifest }
}

type Inspector = ReturnType<typeof inspectSource>
type Snapshot = {
  key: string
  source: Inspector
  manifest: Manifest
  reserved: number
  references: number
  promise: Promise<CgInstance>
  instance?: CgInstance
  temporary?: string
  temporaryParent?: string
  timer?: ReturnType<typeof setTimeout>
  failed?: boolean
}
const snapshots = new Map<string, Snapshot>()
const sdkIds = new WeakMap<CgStatic, number>()
let nextSdkId = 0
let reservedDisk = 0

function cleanupDirectory(snapshot: Snapshot) {
  if (!snapshot.temporary || !snapshot.temporaryParent || !fs.existsSync(snapshot.temporary)) return
  const { temporary, temporaryParent } = snapshot
  if (path.dirname(temporary) !== temporaryParent || !path.basename(temporary).startsWith('aether-codegraph-readonly-')
    || fs.lstatSync(temporary).isSymbolicLink() || fs.realpathSync(temporary) !== temporary) throw new Error('Unsafe codegraph snapshot cleanup')
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
}

function destroy(snapshot: Snapshot) {
  if (snapshot.references) return
  clearTimeout(snapshot.timer)
  try { snapshot.instance?.close() } finally {
    try { cleanupDirectory(snapshot) } finally {
      if (snapshots.get(snapshot.key) === snapshot) {
        snapshots.delete(snapshot.key)
        reservedDisk -= snapshot.reserved
      }
    }
  }
}

/** Used at shutdown and by isolated tests; active query leases are never evicted. */
export function disposeReadonlyCodegraphSnapshots(): void {
  for (const snapshot of snapshots.values()) if (!snapshot.references) destroy(snapshot)
}
process.once('exit', disposeReadonlyCodegraphSnapshots)

function release(snapshot: Snapshot) {
  snapshot.references--
  if (!snapshot.references && !snapshot.failed) {
    snapshot.timer = setTimeout(() => { try { destroy(snapshot) } catch { /* Best effort shutdown of this private copy. */ } }, CODEGRAPH_SNAPSHOT_IDLE_MS)
    snapshot.timer.unref()
  }
}

/** Copy/hash with one reused chunk. No whole-database Buffer or SQLite handle touches the source. */
async function readFile(snapshot: Snapshot, file: SourceFile, buffer: Buffer, destination?: string): Promise<string> {
  const { source } = snapshot
  source.assertSource()
  const filename = path.join(source.directory, file.name)
  if (identity(fs.lstatSync(filename)) !== file.identity) throw new CodegraphReadonlyUnavailable('索引文件在读取中改变')
  const input = await fs.promises.open(filename, 'r')
  let output: fs.promises.FileHandle | undefined
  try {
    if (identity(await input.stat()) !== file.identity) throw new CodegraphReadonlyUnavailable('索引文件在读取中改变')
    source.assertSource()
    if (destination) output = await fs.promises.open(destination, 'wx')
    const hash = createHash('sha256')
    for (let offset = 0; offset < file.size;) {
      const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, file.size - offset), offset)
      if (!bytesRead) throw new CodegraphReadonlyUnavailable('索引文件读取不完整')
      hash.update(buffer.subarray(0, bytesRead))
      if (output) {
        let written = 0
        while (written < bytesRead) {
          const { bytesWritten } = await output.write(buffer, written, bytesRead - written, offset + written)
          if (!bytesWritten) throw new CodegraphReadonlyUnavailable('临时快照写入不完整')
          written += bytesWritten
        }
      }
      offset += bytesRead
    }
    source.assertSource()
    if (identity(await input.stat()) !== file.identity || identity(fs.lstatSync(filename)) !== file.identity) {
      throw new CodegraphReadonlyUnavailable('索引文件在读取中改变')
    }
    return hash.digest('hex')
  } finally { try { await input.close() } finally { await output?.close() } }
}

async function buildSnapshot(snapshot: Snapshot, sdk: CgStatic, limit: number): Promise<CgInstance> {
  try {
    const parent = fs.realpathSync(os.tmpdir())
    const disk = fs.statfsSync(parent)
    if (Number(disk.bavail) * Number(disk.bsize) < reservedDisk + FREE_DISK_RESERVE) {
      throw new CodegraphReadonlyUnavailable('临时磁盘空间不足（需要快照预留及 64 MiB 余量）')
    }
    snapshot.temporaryParent = parent
    snapshot.temporary = fs.mkdtempSync(path.join(parent, `aether-codegraph-readonly-${process.pid}-`))
    const destination = projectDataPath(snapshot.temporary)
    fs.mkdirSync(destination)
    const buffer = Buffer.allocUnsafe(CODEGRAPH_SNAPSHOT_CHUNK_BYTES)
    const hashes = new Map<SourceName, string>()
    for (const file of snapshot.manifest.files) {
      hashes.set(file.name, await readFile(snapshot, file, buffer, file.name === 'codegraph.db-journal' ? undefined : path.join(destination, file.name)))
    }
    if (snapshot.source.manifest(limit).key !== snapshot.manifest.key) throw new CodegraphReadonlyUnavailable('数据库或 WAL 正在变化')
    // A second streaming pass verifies the DB/WAL pair, including same-size byte changes.
    for (const file of snapshot.manifest.files) {
      if (await readFile(snapshot, file, buffer) !== hashes.get(file.name)) throw new CodegraphReadonlyUnavailable('数据库或 WAL 正在变化')
    }
    if (snapshot.source.manifest(limit).key !== snapshot.manifest.key) throw new CodegraphReadonlyUnavailable('数据库或 WAL 正在变化')
    // SHM is mutable coordination state; SQLite rebuilds it exclusively in the private copy.
    const instance = sdk.openSync(snapshot.temporary)
    snapshot.instance = instance
    const actualBytes = fs.readdirSync(destination).reduce((total, name) => {
      const stat = fs.lstatSync(path.join(destination, name))
      if (!stat.isFile() || stat.isSymbolicLink()) throw new CodegraphReadonlyUnavailable('临时快照出现非普通文件')
      return total + stat.size
    }, 0)
    if (actualBytes > snapshot.reserved) throw new CodegraphReadonlyUnavailable('临时快照恢复后超过磁盘预留上限')
    return instance
  } catch (error) {
    snapshot.failed = true
    try { snapshot.instance?.close() } finally {
      try { cleanupDirectory(snapshot) } finally {
        if (snapshots.get(snapshot.key) === snapshot) { snapshots.delete(snapshot.key); reservedDisk -= snapshot.reserved }
      }
    }
    throw error
  }
}

/** The SDK's facade always opens read/write and may migrate/heal. Run it only on a
 * bounded disk snapshot, reused briefly across authorized leases. Each lease keeps
 * its own permission checks; shared construction contains filesystem checks only. */
export async function openReadonlyCodegraphSnapshot(root: string, sdk: CgStatic, assertCurrent: () => void,
  options: { maxBytes?: number } = {}): Promise<CgInstance> {
  const limit = options.maxBytes ?? CODEGRAPH_SNAPSHOT_MAX_BYTES
  if (!Number.isSafeInteger(limit) || limit < 1) throw new CodegraphReadonlyUnavailable('快照字节上限无效')
  assertCurrent()
  const source = inspectSource(root)
  const manifest = source.manifest(limit)
  let sdkId = sdkIds.get(sdk)
  if (sdkId === undefined) { sdkId = ++nextSdkId; sdkIds.set(sdk, sdkId) }
  const key = JSON.stringify([sdkId, source.rootCanonical, manifest.key])
  let snapshot = snapshots.get(key)
  if (!snapshot) {
    // Reserve worst-case WAL replay growth plus SHM. Old/idle copies are discarded first.
    const reserved = Math.max(manifest.bytes * 2, manifest.bytes + CODEGRAPH_SNAPSHOT_CHUNK_BYTES)
    for (const candidate of snapshots.values()) {
      if (!candidate.references && (candidate.source.rootCanonical === source.rootCanonical
        || snapshots.size >= MAX_SNAPSHOTS || reservedDisk + reserved > CODEGRAPH_SNAPSHOT_DISK_BUDGET)) destroy(candidate)
    }
    if (snapshots.size >= MAX_SNAPSHOTS || reservedDisk + reserved > CODEGRAPH_SNAPSHOT_DISK_BUDGET) {
      throw new CodegraphReadonlyUnavailable('只读快照资源繁忙，请稍后重试')
    }
    snapshot = { key, source, manifest, reserved, references: 0, promise: undefined! }
    reservedDisk += reserved
    snapshots.set(key, snapshot)
    snapshot.promise = buildSnapshot(snapshot, sdk, limit)
  }
  clearTimeout(snapshot.timer)
  snapshot.references++
  let closed = false
  const close = () => { if (!closed) { closed = true; release(snapshot) } }
  const check = () => {
    if (closed) throw new CodegraphReadonlyUnavailable('只读查询已关闭')
    assertCurrent()
    if (source.manifest(limit).key !== manifest.key) throw new CodegraphReadonlyUnavailable('数据库或 WAL 正在变化')
  }
  try {
    const instance = await snapshot.promise
    check()
    const invoke = <T>(run: () => T): T => { check(); const result = run(); check(); return result }
    return {
      searchNodes: (...args) => invoke(() => instance.searchNodes(...args)),
      getCallers: (...args) => invoke(() => instance.getCallers(...args)),
      getCallees: (...args) => invoke(() => instance.getCallees(...args)),
      getImpactRadius: (...args) => invoke(() => instance.getImpactRadius(...args)),
      getFiles: () => invoke(() => instance.getFiles()),
      getStats: () => invoke(() => instance.getStats()),
      getIndexState: () => invoke(() => instance.getIndexState()),
      isIndexStale: () => invoke(() => instance.isIndexStale()),
      getLastIndexedAt: () => invoke(() => instance.getLastIndexedAt()),
      indexAll: async () => { throw new CodegraphReadonlyUnavailable('只读查询不能创建或更新索引') },
      close,
    }
  } catch (error) { close(); throw error }
}
