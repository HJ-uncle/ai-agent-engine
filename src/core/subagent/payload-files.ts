import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { gzip, createGunzip } from 'node:zlib'
import { promisify } from 'node:util'
import { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Client } from '@libsql/client'

export const SUBAGENT_PAYLOAD_MAX_BYTES = 128 * 1024 * 1024
export const SUBAGENT_PAYLOAD_RANGE_MAX_BYTES = 4 * 1024 * 1024
const compress = promisify(gzip)
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const hashPattern = /^[a-f0-9]{64}$/
const temporaryPrefix = 'aether-subagent-payloads-'
const noFollow = fs.constants.O_NOFOLLOW ?? 0

export interface SubagentPayloadReference {
  format: 'aether-subagent-payload'
  version: 1
  tenantHash: string
  hash: string
  bytes: number
  codec: 'gzip'
}
export interface SubagentPayloadRange {
  /** Byte ranges can split a UTF-8 character; consumers must retain decoder state across pages. */
  chunk: Buffer
  offsetBytes: number
  nextOffsetBytes: number | null
  totalBytes: number
}
export type SubagentPayloadErrorCode = 'SUBAGENT_PAYLOAD_INVALID_REFERENCE' | 'SUBAGENT_PAYLOAD_TENANT_MISMATCH'
  | 'SUBAGENT_PAYLOAD_TOO_LARGE' | 'SUBAGENT_PAYLOAD_MISSING' | 'SUBAGENT_PAYLOAD_CORRUPT'
  | 'SUBAGENT_PAYLOAD_UNSAFE_PATH' | 'SUBAGENT_PAYLOAD_IO' | 'SUBAGENT_PAYLOAD_DATABASE_LOCATION'
  | 'SUBAGENT_PAYLOAD_DISPOSED'

export class SubagentPayloadFileError extends Error {
  constructor(readonly code: SubagentPayloadErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'SubagentPayloadFileError'
  }
}
function fail(code: SubagentPayloadErrorCode, message: string, cause?: unknown): never {
  throw new SubagentPayloadFileError(code, message, cause)
}
const nonnegative = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0
function tenantHash(tenantId: string): string {
  if (typeof tenantId !== 'string' || !tenantId.length || Buffer.byteLength(tenantId) > 8192)
    fail('SUBAGENT_PAYLOAD_INVALID_REFERENCE', 'Invalid subagent payload tenant')
  return hash(tenantId)
}
export function isSubagentPayloadReference(value: unknown): value is SubagentPayloadReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const ref = value as Record<string, unknown>
  return Object.keys(ref).length === 6 && ['format', 'version', 'tenantHash', 'hash', 'bytes', 'codec'].every(key => Object.hasOwn(ref, key))
    && ref.format === 'aether-subagent-payload' && ref.version === 1 && ref.codec === 'gzip'
    && typeof ref.tenantHash === 'string' && hashPattern.test(ref.tenantHash)
    && typeof ref.hash === 'string' && hashPattern.test(ref.hash) && nonnegative(ref.bytes) && ref.bytes <= SUBAGENT_PAYLOAD_MAX_BYTES
}

/** Check every ancestor, including an operator-supplied root, before using a generated hash path. */
async function directoryChain(directory: string, create: boolean): Promise<string[]> {
  const absolute = path.resolve(directory), volume = path.parse(absolute).root
  const directories = [volume]
  for (const part of absolute.slice(volume.length).split(path.sep).filter(Boolean)) directories.push(path.join(directories.at(-1)!, part))
  for (const item of directories) {
    let info: fs.Stats
    try { info = await fs.promises.lstat(item) }
    catch (error) {
      if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      try { await fs.promises.mkdir(item, { mode: 0o700 }) }
      catch (mkdirError) { if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError }
      info = await fs.promises.lstat(item)
    }
    if (info.isSymbolicLink() || !info.isDirectory()) fail('SUBAGENT_PAYLOAD_UNSAFE_PATH', 'Subagent payload directories must not be symbolic links or files')
  }
  return directories
}
async function regularFile(file: string): Promise<fs.Stats> {
  const info = await fs.promises.lstat(file)
  if (info.isSymbolicLink() || !info.isFile()) fail('SUBAGENT_PAYLOAD_UNSAFE_PATH', 'Subagent payload must be a regular file')
  return info
}
function sameFile(a: fs.Stats, b: fs.Stats): boolean {
  // Publishing/removing another hard link changes ctime without changing immutable content.
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs
}
async function syncPublished(file: string): Promise<void> {
  const before = await regularFile(file)
  // FlushFileBuffers needs a writable handle on Windows even though the CAS bytes never change.
  const handle = await fs.promises.open(file, fs.constants.O_RDWR | noFollow)
  try {
    if (!sameFile(before, await handle.stat())) fail('SUBAGENT_PAYLOAD_UNSAFE_PATH', 'Subagent payload changed while opening it for sync')
    await handle.sync()
  } finally { await handle.close() }
  const directories = await directoryChain(path.dirname(file), false)
  // Node has no portable directory fsync on Windows. Files are flushed; directory power-loss guarantees remain platform-dependent.
  if (process.platform !== 'win32') for (const directory of directories.reverse()) {
    const parent = await fs.promises.open(directory, 'r')
    try { await parent.sync() } finally { await parent.close() }
  }
}

const transientRoots = new WeakMap<SubagentPayloadFiles, string>()

/**
 * Immutable, tenant-scoped CAS. put() must finish before SQLite commits a reference.
 * A failed DB commit can leave an orphan; deleting files during row deletion/rollback is unsafe.
 * Back up this complete directory together with its database. Existing history-blob GC does not own it.
 */
export class SubagentPayloadFiles {
  readonly root: string
  readonly maxPayloadBytes: number
  private disposed = false
  private disposal?: Promise<boolean>
  private readonly active = new Set<Promise<unknown>>()
  /** Verification metadata only; decoded正文 never stays resident. */
  private readonly verified = new Map<string, { dev: number; ino: number; size: number; mtimeMs: number }>()

  constructor(root: string, options: { maxPayloadBytes?: number } = {}) {
    if (typeof root !== 'string' || !root.trim()) fail('SUBAGENT_PAYLOAD_DATABASE_LOCATION', 'Subagent payload root is required')
    this.root = path.resolve(root)
    this.maxPayloadBytes = options.maxPayloadBytes ?? SUBAGENT_PAYLOAD_MAX_BYTES
    if (!Number.isSafeInteger(this.maxPayloadBytes) || this.maxPayloadBytes < 1 || this.maxPayloadBytes > SUBAGENT_PAYLOAD_MAX_BYTES)
      throw new RangeError('Invalid subagent payload byte limit')
  }

  private operation<T>(action: () => Promise<T>): Promise<T> {
    if (this.disposed) return Promise.reject(new SubagentPayloadFileError('SUBAGENT_PAYLOAD_DISPOSED', 'Temporary subagent payload storage has been disposed'))
    const promise = action().catch(error => {
      if (error instanceof SubagentPayloadFileError || error instanceof RangeError) throw error
      fail((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'SUBAGENT_PAYLOAD_MISSING' : 'SUBAGENT_PAYLOAD_IO',
        'Subagent payload file operation failed', error)
    })
    this.active.add(promise)
    void promise.finally(() => this.active.delete(promise)).catch(() => undefined)
    return promise
  }

  private validate(tenantId: string, value: unknown): SubagentPayloadReference {
    if (!isSubagentPayloadReference(value)) fail('SUBAGENT_PAYLOAD_INVALID_REFERENCE', 'Invalid subagent payload reference')
    if (value.tenantHash !== tenantHash(tenantId)) fail('SUBAGENT_PAYLOAD_TENANT_MISMATCH', 'Subagent payload reference belongs to another tenant')
    if (value.bytes > this.maxPayloadBytes) fail('SUBAGENT_PAYLOAD_TOO_LARGE', 'Subagent payload exceeds the configured byte limit')
    return { ...value }
  }

  private async file(ref: SubagentPayloadReference, create = false): Promise<string> {
    const directory = path.join(this.root, ref.tenantHash, ref.hash.slice(0, 2))
    await directoryChain(directory, create)
    return path.join(directory, ref.hash + '.gz')
  }

  /** Input is already serialized JSON text. UTF-8 must preserve it exactly, including escaped lone surrogates. */
  put(tenantId: string, serializedText: string): Promise<SubagentPayloadReference> {
    return this.operation(async () => {
      const tenant = tenantHash(tenantId)
      if (typeof serializedText !== 'string') fail('SUBAGENT_PAYLOAD_INVALID_REFERENCE', 'Subagent payload must be serialized text')
      const bytes = Buffer.byteLength(serializedText)
      if (bytes > this.maxPayloadBytes) fail('SUBAGENT_PAYLOAD_TOO_LARGE', 'Subagent payload exceeds the configured byte limit')
      const raw = Buffer.from(serializedText, 'utf8')
      if (raw.toString('utf8') !== serializedText) fail('SUBAGENT_PAYLOAD_INVALID_REFERENCE', 'Serialize lone UTF-16 surrogates before storing subagent payloads')
      const ref: SubagentPayloadReference = { format: 'aether-subagent-payload', version: 1, tenantHash: tenant, hash: hash(raw), bytes, codec: 'gzip' }
      const file = await this.file(ref, true)
      try {
        const info = await regularFile(file), prior = this.verified.get(ref.hash)
        // The content-addressed name is immutable. Repeated writes of the same
        // body still sync the inode, while a changed inode is fully verified.
        if (!prior || prior.dev !== info.dev || prior.ino !== info.ino || prior.size !== info.size || prior.mtimeMs !== info.mtimeMs)
          await this.readVerified(ref, 0, 0)
        await syncPublished(file)
        const synced = await regularFile(file)
        this.verified.set(ref.hash, { dev: synced.dev, ino: synced.ino, size: synced.size, mtimeMs: synced.mtimeMs })
        return ref
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      const encoded = await compress(raw, { level: 6 })
      const temporary = file + '.' + randomUUID() + '.tmp'
      let handle: Awaited<ReturnType<typeof fs.promises.open>> | undefined
      try {
        handle = await fs.promises.open(temporary, 'wx', 0o600)
        await handle.writeFile(encoded)
        await handle.sync()
        await handle.close(); handle = undefined
        // A hard link publishes only a complete inode and cannot overwrite another publisher's evidence.
        try { await fs.promises.link(temporary, file) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
        await this.readVerified(ref, 0, 0)
        await syncPublished(file)
        const synced = await regularFile(file)
        this.verified.set(ref.hash, { dev: synced.dev, ino: synced.ino, size: synced.size, mtimeMs: synced.mtimeMs })
        return ref
      } finally {
        try { await handle?.close() }
        finally { await fs.promises.unlink(temporary).catch(() => undefined) }
      }
    })
  }

  read(tenantId: string, reference: unknown, options: { maxBytes?: number } = {}): Promise<string> {
    return this.operation(async () => {
      const ref = this.validate(tenantId, reference), max = options.maxBytes ?? this.maxPayloadBytes
      if (!nonnegative(max) || max > this.maxPayloadBytes) throw new RangeError('Invalid subagent payload read limit')
      if (ref.bytes > max) fail('SUBAGENT_PAYLOAD_TOO_LARGE', 'Subagent payload exceeds the caller read limit; use bounded ranges')
      return (await this.readVerified(ref, 0, ref.bytes)).toString('utf8')
    })
  }

  /** Every page checks the entire checksum; memory holds only this page and bounded stream buffers, with no body cache. */
  readRange(tenantId: string, reference: unknown, options: { offsetBytes?: number; limitBytes?: number } = {}): Promise<SubagentPayloadRange> {
    return this.operation(async () => {
      const ref = this.validate(tenantId, reference), offset = options.offsetBytes ?? 0, limit = options.limitBytes ?? 512 * 1024
      if (!nonnegative(offset) || offset > ref.bytes || !nonnegative(limit) || limit < 1 || limit > SUBAGENT_PAYLOAD_RANGE_MAX_BYTES)
        throw new RangeError('Invalid subagent payload byte range')
      const end = Math.min(ref.bytes, offset + limit)
      return { chunk: await this.readVerified(ref, offset, end - offset), offsetBytes: offset,
        nextOffsetBytes: end < ref.bytes ? end : null, totalBytes: ref.bytes }
    })
  }

  private async readVerified(ref: SubagentPayloadReference, offset: number, length: number): Promise<Buffer> {
    const file = await this.file(ref), before = await regularFile(file)
    if (before.size > this.maxPayloadBytes + 65536) fail('SUBAGENT_PAYLOAD_TOO_LARGE', 'Compressed subagent payload exceeds its storage limit')
    const handle = await fs.promises.open(file, fs.constants.O_RDONLY | noFollow)
    try {
      if (!sameFile(before, await handle.stat())) fail('SUBAGENT_PAYLOAD_UNSAFE_PATH', 'Subagent payload changed while opening it')
      const digest = createHash('sha256'), decoder = new TextDecoder('utf-8', { fatal: true }), parts: Buffer[] = []
      let decodedBytes = 0
      const sink = new Writable({ write(chunk: Buffer, _encoding, callback) {
        try {
          const start = decodedBytes
          decodedBytes += chunk.length
          if (decodedBytes > ref.bytes) fail('SUBAGENT_PAYLOAD_CORRUPT', 'Subagent payload exceeds its declared decoded length')
          digest.update(chunk); decoder.decode(chunk, { stream: true })
          const from = Math.max(0, offset - start), to = Math.min(chunk.length, offset + length - start)
          if (to > from) parts.push(Buffer.from(chunk.subarray(from, to)))
          callback()
        } catch (error) { callback(error as Error) }
      } })
      try {
        await pipeline(handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 }), createGunzip({ chunkSize: 64 * 1024 }), sink)
        decoder.decode()
      } catch (error) {
        if (error instanceof SubagentPayloadFileError) throw error
        fail('SUBAGENT_PAYLOAD_CORRUPT', 'Subagent payload is not valid gzip/UTF-8 evidence', error)
      }
      if (decodedBytes !== ref.bytes || digest.digest('hex') !== ref.hash) fail('SUBAGENT_PAYLOAD_CORRUPT', 'Subagent payload checksum or byte length mismatch')
      if (!sameFile(before, await handle.stat()) || !sameFile(before, await regularFile(file)))
        fail('SUBAGENT_PAYLOAD_CORRUPT', 'Subagent payload changed during verification')
      return Buffer.concat(parts, length)
    } finally { await handle.close() }
  }

  /** Only factory-created :memory: fixtures are removable; durable databases never get an online delete API. */
  dispose(): Promise<boolean> {
    const temporary = transientRoots.get(this)
    if (!temporary) return Promise.resolve(false)
    if (this.disposal) return this.disposal
    this.disposed = true
    return this.disposal = (async () => {
      await Promise.allSettled([...this.active])
      const resolved = path.resolve(temporary)
      if (resolved !== this.root || path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith(temporaryPrefix))
        fail('SUBAGENT_PAYLOAD_UNSAFE_PATH', 'Refusing unsafe temporary payload cleanup')
      await directoryChain(resolved, false)
      await fs.promises.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      return true
    })()
  }
}

const stores = new WeakMap<Client, Promise<SubagentPayloadFiles>>()

/** Query this connection, never DATA_DIR: tests and attached databases may differ from the application's default DB. */
export function getSubagentPayloadFiles(db: Client): Promise<SubagentPayloadFiles> {
  const existing = stores.get(db)
  if (existing) return existing
  const pending = (async () => {
    if (db.protocol !== 'file') fail('SUBAGENT_PAYLOAD_DATABASE_LOCATION', 'Local subagent payload files require a local SQLite connection')
    const rows = (await db.execute('PRAGMA database_list')).rows.filter(row => row.name === 'main')
    if (rows.length !== 1 || typeof rows[0].file !== 'string') fail('SUBAGENT_PAYLOAD_DATABASE_LOCATION', 'SQLite main database location is unavailable')
    const file = rows[0].file
    if (!file || file === ':memory:') {
      const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), temporaryPrefix))
      const store = new SubagentPayloadFiles(temporary)
      transientRoots.set(store, temporary)
      return store
    }
    if (!path.isAbsolute(file)) fail('SUBAGENT_PAYLOAD_DATABASE_LOCATION', 'SQLite main database path must be absolute')
    return new SubagentPayloadFiles(path.resolve(file) + '.subagent-payloads')
  })()
  stores.set(db, pending)
  void pending.catch(() => { if (stores.get(db) === pending) stores.delete(db) })
  return pending
}
