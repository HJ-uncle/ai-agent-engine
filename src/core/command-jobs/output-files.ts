import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { Client } from '@libsql/client'

export interface CommandOutputIdentity { tenantId: string; sessionId: string; jobId: string }
export interface CommandOutputReader { read(offset: number, length: number): Promise<Buffer>; close(): Promise<void> }
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const noFollow = fs.constants.O_NOFOLLOW ?? 0
const fail = (code: string, message: string) => Object.assign(new Error(message), { code })
const sameInode = (a: fs.Stats, b: fs.Stats) => a.dev === b.dev && a.ino === b.ino

async function directoryChain(directory: string, create: boolean): Promise<void> {
  const absolute = path.resolve(directory), volume = path.parse(absolute).root
  let current = volume
  for (const part of absolute.slice(volume.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    let info: fs.Stats
    try { info = await fs.promises.lstat(current) }
    catch (error) {
      if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      try { await fs.promises.mkdir(current, { mode: 0o700 }) }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause }
      info = await fs.promises.lstat(current)
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw fail('COMMAND_OUTPUT_UNSAFE_PATH', 'Command log directories must be real directories')
  }
}

/** Raw UTF-8 bytes, in event order. SQLite owns every committed byte range.
 * append() is called inside the manager's write transaction so two connections
 * cannot truncate a newer committed tail. Files must be backed up with the DB.
 */
export class CommandOutputFiles {
  readonly root: string
  constructor(root: string, readonly transient = false) { this.root = path.resolve(root) }

  private file(identity: CommandOutputIdentity): string {
    for (const value of [identity.tenantId, identity.sessionId, identity.jobId]) {
      if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 8192) throw fail('COMMAND_OUTPUT_INVALID_IDENTITY', 'Invalid command log identity')
    }
    return path.join(this.root, digest(identity.tenantId), digest(identity.sessionId), digest(identity.jobId) + '.log')
  }

  private async checked(file: string): Promise<fs.Stats> {
    await directoryChain(path.dirname(file), false)
    const info = await fs.promises.lstat(file)
    if (info.isSymbolicLink() || !info.isFile()) throw fail('COMMAND_OUTPUT_UNSAFE_PATH', 'Command log must be a regular file')
    return info
  }

  async append(identity: CommandOutputIdentity, committedBytes: number, chunks: readonly Buffer[]): Promise<number> {
    if (!Number.isSafeInteger(committedBytes) || committedBytes < 0) throw fail('COMMAND_OUTPUT_INVALID_RANGE', 'Invalid committed command log length')
    const file = this.file(identity)
    await directoryChain(path.dirname(file), true)
    let before: fs.Stats | undefined
    try { before = await this.checked(file) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (!before && committedBytes) throw fail('COMMAND_OUTPUT_MISSING', 'Committed command log is missing')
    const handle = await fs.promises.open(file, fs.constants.O_RDWR | fs.constants.O_CREAT | noFollow, 0o600)
    try {
      const opened = await handle.stat()
      if (!opened.isFile() || before && !sameInode(before, opened)) throw fail('COMMAND_OUTPUT_UNSAFE_PATH', 'Command log changed while opening')
      if (opened.size < committedBytes) throw fail('COMMAND_OUTPUT_CORRUPT', 'Command log is shorter than its committed index')
      // A failed/unknown DB commit can leave unindexed bytes. The transaction's
      // current output_bytes is authoritative; replay never duplicates a tail.
      if (opened.size > committedBytes) await handle.truncate(committedBytes)
      let position = committedBytes, index = 0, offset = 0
      while (index < chunks.length) {
        while (index < chunks.length && offset === chunks[index].length) { index++; offset = 0 }
        if (index === chunks.length) break
        // Bound both the scatter list and retained references. No whole-flush
        // concat: a 512 KiB flush normally needs two writes instead of 128.
        const buffers = chunks.slice(index, index + 64)
        if (offset) buffers[0] = buffers[0].subarray(offset)
        const bytes = buffers.reduce((sum, buffer) => sum + buffer.length, 0)
        const { bytesWritten } = await handle.writev(buffers, position)
        if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > bytes)
          throw fail('COMMAND_OUTPUT_IO', 'Command log write made no progress or returned an invalid length')
        position += bytesWritten
        let remaining = bytesWritten
        while (remaining > 0) {
          const available = chunks[index].length - offset
          if (remaining < available) { offset += remaining; remaining = 0 }
          else { remaining -= available; index++; offset = 0 }
        }
      }
      await handle.sync()
      if (!sameInode(opened, await this.checked(file))) throw fail('COMMAND_OUTPUT_UNSAFE_PATH', 'Command log path changed before publication')
      // Windows has no portable directory fsync; FlushFileBuffers above still
      // precedes every SQLite reference commit.
      if (!before && process.platform !== 'win32') {
        let directory = path.dirname(file)
        while (directory.startsWith(this.root)) {
          const parent = await fs.promises.open(directory, 'r')
          try { await parent.sync() } finally { await parent.close() }
          if (directory === this.root) break
          directory = path.dirname(directory)
        }
      }
      return position
    } finally { await handle.close() }
  }

  async read(identity: CommandOutputIdentity, offset: number, length: number): Promise<Buffer> {
    const reader = await this.openReader(identity)
    try { return await reader.read(offset, length) } finally { await reader.close() }
  }

  /** One lease per page, rather than repeating open/ancestor checks per 4 KiB entry. */
  async openReader(identity: CommandOutputIdentity): Promise<CommandOutputReader> {
    const file = this.file(identity)
    let before: fs.Stats
    try { before = await this.checked(file) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw fail('COMMAND_OUTPUT_MISSING', 'Committed command log is missing')
      throw error
    }
    const handle = await fs.promises.open(file, fs.constants.O_RDONLY | noFollow)
    try {
      if (!sameInode(before, await handle.stat())) throw fail('COMMAND_OUTPUT_UNSAFE_PATH', 'Command log changed while opening')
    } catch (error) { await handle.close(); throw error }
    return {
      read: async (offset, length) => {
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || length > 256 * 1024)
          throw fail('COMMAND_OUTPUT_INVALID_RANGE', 'Command log read exceeds its bounded range')
        if (before.size < offset + length) throw fail('COMMAND_OUTPUT_CORRUPT', 'Command log is shorter than the requested committed range')
        const result = Buffer.allocUnsafe(length)
        let copied = 0
        while (copied < length) {
          const { bytesRead } = await handle.read(result, copied, length - copied, offset + copied)
          if (!bytesRead) throw fail('COMMAND_OUTPUT_CORRUPT', 'Command log was truncated while reading')
          copied += bytesRead
        }
        return result
      },
      close: async () => {
        try { if (!sameInode(before, await this.checked(file))) throw fail('COMMAND_OUTPUT_UNSAFE_PATH', 'Command log path changed while reading') }
        finally { await handle.close() }
      },
    }
  }

  async remove(identity: CommandOutputIdentity): Promise<void> {
    const file = this.file(identity)
    try { await this.checked(file); await fs.promises.unlink(file) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    // Remove only generated, currently empty ancestors. Never follow links or
    // recursively remove a data directory shared by other jobs/databases.
    let directory = path.dirname(file)
    while (directory === this.root || directory.startsWith(this.root + path.sep)) {
      try {
        const info = await fs.promises.lstat(directory)
        if (info.isSymbolicLink() || !info.isDirectory() || (await fs.promises.readdir(directory)).length) break
        await fs.promises.rmdir(directory)
      } catch (error) {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
        break
      }
      if (directory === this.root) break
      directory = path.dirname(directory)
    }
  }
}

const stores = new WeakMap<Client, Promise<CommandOutputFiles>>()
/** Bind the connection's actual database; never guess an injected client's path from DATA_DIR. */
export function getCommandOutputFiles(db: Client, isolatedRoot?: string): Promise<CommandOutputFiles> {
  const existing = stores.get(db)
  if (existing) return existing
  const pending = (async () => {
    if (db.protocol !== 'file') throw fail('COMMAND_OUTPUT_DATABASE_LOCATION', 'Command log files require a local SQLite connection')
    const rows = (await db.execute('PRAGMA database_list')).rows.filter(row => row.name === 'main')
    if (rows.length !== 1 || typeof rows[0].file !== 'string') throw fail('COMMAND_OUTPUT_DATABASE_LOCATION', 'SQLite main database location is unavailable')
    const file = rows[0].file
    if (!file || file === ':memory:') return new CommandOutputFiles(isolatedRoot ?? path.resolve('.e2e-tmp/command-output', randomUUID()), true)
    if (!path.isAbsolute(file)) throw fail('COMMAND_OUTPUT_DATABASE_LOCATION', 'SQLite database path must be absolute')
    if (isolatedRoot) throw fail('COMMAND_OUTPUT_DATABASE_LOCATION', 'Only an in-memory fixture may override its log directory')
    return new CommandOutputFiles(path.resolve(file) + '.command-output')
  })()
  stores.set(db, pending)
  void pending.catch(() => { if (stores.get(db) === pending) stores.delete(db) })
  return pending
}
