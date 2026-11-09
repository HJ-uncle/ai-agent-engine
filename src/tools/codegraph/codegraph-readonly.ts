import { AsyncLocalStorage } from 'node:async_hooks'
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
export const CODEGRAPH_SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024
export class CodegraphReadonlyUnavailable extends Error {
  readonly code = 'CODEGRAPH_READONLY_UNAVAILABLE'
  constructor(reason: string) { super(`无法安全读取代码图快照：${reason}。请使用 grep/read_file 查询，或由执行角色处理索引。`) }
}

const identity = (stat: fs.Stats) => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':')

/** The installed SDK ignores OpenOptions.readOnly and repairs databases on open.
 * Only filesystem reads touch the project. SDK migrations/WAL recovery operate on
 * this private disposable copy; never open the source then try to undo its writes. */
export function openReadonlyCodegraphSnapshot(root: string, sdk: CgStatic, assertCurrent: () => void,
  options: { maxBytes?: number } = {}): CgInstance {
  const limit = options.maxBytes ?? CODEGRAPH_SNAPSHOT_MAX_BYTES
  const sourceDirectory = projectDataPath(root)
  const sourceCanonical = canonicalFilePathSync(sourceDirectory)
  const rootCanonical = canonicalFilePathSync(root)
  const inside = path.relative(rootCanonical, sourceCanonical)
  if (inside === '..' || inside.startsWith('..' + path.sep) || path.isAbsolute(inside)) throw new CodegraphReadonlyUnavailable('索引目录越出工作区')
  const assertSource = () => {
    assertCurrent()
    if (canonicalFilePathSync(sourceDirectory) !== sourceCanonical) throw new CodegraphReadonlyUnavailable('索引目录在读取中改变')
  }
  const read = (name: string, remaining: number): { bytes: Buffer; identity: string } | undefined => {
    assertSource()
    const source = path.join(sourceDirectory, name)
    let stat: fs.Stats
    try { stat = fs.lstatSync(source) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new CodegraphReadonlyUnavailable('索引文件不是普通文件')
    if (stat.size > remaining) throw new CodegraphReadonlyUnavailable(`数据库与 WAL 超过 ${limit} 字节上限`)
    const descriptor = fs.openSync(source, 'r')
    try {
      const opened = fs.fstatSync(descriptor)
      if (identity(stat) !== identity(opened)) throw new CodegraphReadonlyUnavailable('索引文件在读取中改变')
      const bytes = Buffer.alloc(opened.size)
      let offset = 0
      while (offset < bytes.length) {
        const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset)
        if (!count) throw new CodegraphReadonlyUnavailable('索引文件读取不完整')
        offset += count
      }
      assertSource()
      if (identity(opened) !== identity(fs.fstatSync(descriptor)) || identity(opened) !== identity(fs.lstatSync(source))) {
        throw new CodegraphReadonlyUnavailable('索引文件在读取中改变')
      }
      return { bytes, identity: identity(opened) }
    } finally { fs.closeSync(descriptor) }
  }
  const collect = () => {
    // A rollback journal needs an actual SQLite recovery transaction. Fail closed.
    const journal = read('codegraph.db-journal', limit)
    if (journal?.bytes.length) throw new CodegraphReadonlyUnavailable('索引存在待恢复 journal')
    const db = read('codegraph.db', limit)
    if (!db?.bytes.length) throw new CodegraphReadonlyUnavailable('索引数据库缺失或为空')
    const wal = read('codegraph.db-wal', limit - db.bytes.length)
    return { db, wal, journal }
  }
  const first = collect(), second = collect()
  for (const key of ['db', 'wal', 'journal'] as const) {
    const a = first[key], b = second[key]
    if (!!a !== !!b || a && b && (a.identity !== b.identity || !a.bytes.equals(b.bytes))) {
      throw new CodegraphReadonlyUnavailable('数据库或 WAL 正在变化')
    }
  }
  assertSource()
  const temporaryParent = fs.realpathSync(os.tmpdir())
  const temporary = fs.mkdtempSync(path.join(temporaryParent, 'aether-codegraph-readonly-'))
  const cleanup = () => {
    if (path.dirname(temporary) !== temporaryParent || !path.basename(temporary).startsWith('aether-codegraph-readonly-')
      || fs.lstatSync(temporary).isSymbolicLink() || fs.realpathSync(temporary) !== temporary) throw new Error('Unsafe codegraph snapshot cleanup')
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
  try {
    const destination = projectDataPath(temporary)
    fs.mkdirSync(destination)
    fs.writeFileSync(path.join(destination, 'codegraph.db'), first.db.bytes, { flag: 'wx' })
    if (first.wal) fs.writeFileSync(path.join(destination, 'codegraph.db-wal'), first.wal.bytes, { flag: 'wx' })
    // Do not copy SHM: it is a mutable SQLite coordination cache, rebuilt only in the copy.
    assertSource()
    const instance = sdk.openSync(temporary)
    const close = instance.close.bind(instance)
    let closed = false
    instance.close = () => {
      if (closed) return
      closed = true
      try { close() } finally { cleanup() }
    }
    return instance
  } catch (error) { cleanup(); throw error }
}
