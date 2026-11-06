import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { gzip, gunzipSync } from 'node:zlib'
import { promisify } from 'node:util'

const compress = promisify(gzip)
const digest = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex')
const bodyFields = new Set(['content', 'modelInputContent', 'reasoningContent', 'metadata'])
const updateFields = new Set([...bodyFields, 'archiveContent'])
const unsafe = new Set(['__proto__', 'constructor', 'prototype'])
const MAX_BYTES = 128 * 1024 * 1024
const MAX_ROW_BYTES = 256 * 1024 * 1024
const MAX_DEPTH = 128
interface BlobReference { path: Array<string | number>; hash: string; bytes: number; codec: 'gzip' }
interface Envelope { version: 1; tenant: string; refs: BlobReference[] }
type Row = { tenantId: string; storageBlobs?: Envelope; [key: string]: unknown }
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const validKey = (key: unknown): key is string | number => typeof key === 'string' ? !unsafe.has(key)
  : typeof key === 'number' && Number.isSafeInteger(key) && key >= 0

function bodyPath(location: Array<string | number>): boolean {
  if (location[0] !== 'payload') return typeof location[0] === 'string' && updateFields.has(location[0])
  return typeof location[1] === 'string' && bodyFields.has(location[1])
    || location[1] === 'toolCall' && location[2] === 'args'
}

async function syncBlob(file: string): Promise<void> {
  // Windows FlushFileBuffers requires a writable handle even when bytes remain unchanged.
  const handle = await fs.promises.open(file, 'r+')
  try { await handle.sync() } finally { await handle.close() }
  if (process.platform === 'win32') return // Node does not expose directory fsync on Windows.
  // Include newly created parent directories, not only the last content-addressed shard.
  let directory = path.dirname(file)
  for (;;) {
    const parent = await fs.promises.open(directory, 'r')
    try { await parent.sync() } finally { await parent.close() }
    const next = path.dirname(directory)
    if (next === directory) break
    directory = next
  }
}

/** Private on-disk envelope. Public Message values never contain storage references. */
export class HistoryBlobStore {
  readonly root: string
  constructor(dataPath: string, private readonly threshold = 16 * 1024) {
    this.root = path.join(path.dirname(path.resolve(dataPath)), 'blobs')
  }

  private file(tenant: string, hash: string, create = false): string {
    if (!/^[a-f0-9]{64}$/.test(tenant) || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid history blob identity')
    const directory = path.join(this.root, tenant, hash.slice(0, 2))
    if (create) fs.mkdirSync(path.dirname(this.root), { recursive: true, mode: 0o700 })
    for (const item of [this.root, path.join(this.root, tenant), directory]) {
      try {
        const stat = fs.lstatSync(item)
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('History blob directory must be a real directory')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        if (create) {
          try { fs.mkdirSync(item, { mode: 0o700 }) }
          catch (mkdirError) { if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError }
          const stat = fs.lstatSync(item)
          if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('History blob directory must be a real directory')
        }
      }
    }
    const file = path.join(directory, hash + '.gz')
    try { const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid history blob file') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    return file
  }

  private read(tenant: string, ref: BlobReference): string {
    if (ref.codec !== 'gzip' || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0 || ref.bytes > MAX_BYTES) throw new Error('Invalid history blob size or codec')
    const file = this.file(tenant, ref.hash)
    if (fs.statSync(file).size > MAX_BYTES + 65536) throw new Error('History blob exceeds its storage bound')
    const decoded = gunzipSync(fs.readFileSync(file), { maxOutputLength: Math.max(1, ref.bytes) })
    if (decoded.length !== ref.bytes || digest(decoded) !== ref.hash) throw new Error('History blob integrity check failed')
    return decoded.toString('utf8')
  }

  private async put(tenant: string, value: string): Promise<Omit<BlobReference, 'path'>> {
    const bytes = Buffer.byteLength(value), hash = digest(value)
    if (bytes > MAX_BYTES) throw new Error('History content exceeds the 128 MiB blob limit')
    const ref = { hash, bytes, codec: 'gzip' as const }, file = this.file(tenant, hash, true)
    if (fs.existsSync(file)) { this.read(tenant, { ...ref, path: [] }); await syncBlob(file); return ref }
    const encoded = await compress(Buffer.from(value), { level: 6 })
    const temporary = file + '.' + crypto.randomUUID() + '.tmp'
    let handle: Awaited<ReturnType<typeof fs.promises.open>> | undefined
    try {
      handle = await fs.promises.open(temporary, 'wx', 0o600)
      await handle.writeFile(encoded)
      await handle.sync()
      await handle.close(); handle = undefined
      // Publishing a fully synced immutable inode avoids exposing partial files
      // and avoids replacing another writer's same-hash content.
      try { await fs.promises.link(temporary, file) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      this.read(tenant, { ...ref, path: [] })
      await syncBlob(file)
    } finally { try { await handle?.close() } finally { await fs.promises.unlink(temporary).catch(() => undefined) } }
    return ref
  }

  async encode<T extends object>(input: T & { tenantId: string }): Promise<string> {
    const row = JSON.parse(JSON.stringify(input)) as Row
    if (!record(row) || typeof row.tenantId !== 'string') throw new Error('Invalid history blob row tenant')
    if (row.storageBlobs !== undefined) throw new Error('Cannot encode an already externalized history row')
    const tenant = digest(row.tenantId), refs: BlobReference[] = []
    let total = 0
    const visit = async (value: unknown, location: Array<string | number>): Promise<unknown> => {
      // Preserve deeper legacy/extension metadata inline instead of writing references our reader rejects.
      if (location.length > MAX_DEPTH) return value
      if (typeof value === 'string' && Buffer.byteLength(value) >= this.threshold) {
        // JSON can preserve isolated UTF-16 surrogates; UTF-8 would replace them with U+FFFD.
        // Keep those uncommon strings inline rather than changing their evidence bytes.
        if (Buffer.from(value, 'utf8').toString('utf8') !== value) return value
        if (refs.length >= 4096 || (total += Buffer.byteLength(value)) > MAX_ROW_BYTES) throw new Error('History blob row exceeds its storage bound')
        refs.push({ path: location, ...await this.put(tenant, value) })
        return null
      }
      if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index++) value[index] = await visit(value[index], [...location, index])
      } else if (value && typeof value === 'object') {
        for (const key of Object.keys(value)) {
          if (unsafe.has(key)) continue
          ;(value as Record<string, unknown>)[key] = await visit((value as Record<string, unknown>)[key], [...location, key])
        }
      }
      return value
    }
    for (const key of updateFields) if (Object.hasOwn(row, key)) row[key] = await visit(row[key], [key])
    if (record(row.payload)) {
      for (const key of bodyFields) if (Object.hasOwn(row.payload, key)) row.payload[key] = await visit(row.payload[key], ['payload', key])
      if (record(row.payload.toolCall) && Object.hasOwn(row.payload.toolCall, 'args')) {
        row.payload.toolCall.args = await visit(row.payload.toolCall.args, ['payload', 'toolCall', 'args'])
      }
    }
    if (refs.length) row.storageBlobs = { version: 1, tenant, refs }
    return JSON.stringify(row)
  }

  /** Synchronous decoding also serves the exact-byte physical scanner. No decoded-body cache is retained. */
  hydrate<T extends object>(input: T & { tenantId: string }, expectedTenant?: string): T {
    const row = input as unknown as Row
    if (!record(row) || typeof row.tenantId !== 'string' || expectedTenant !== undefined && row.tenantId !== expectedTenant) throw new Error('Invalid history blob row tenant')
    const envelope = row.storageBlobs
    if (envelope === undefined) return input
    if (!record(envelope) || envelope.version !== 1 || envelope.tenant !== digest(row.tenantId) || !Array.isArray(envelope.refs)
      || !envelope.refs.length || envelope.refs.length > 4096) throw new Error('Invalid history blob envelope')
    const result = structuredClone(row), seen = new Set<string>()
    let total = 0
    for (const ref of envelope.refs) {
      if (!record(ref) || !Array.isArray(ref.path) || !ref.path.length || ref.path.some(key => !validKey(key))
        || !bodyPath(ref.path) || ref.path.length > MAX_DEPTH || ref.codec !== 'gzip'
        || typeof ref.hash !== 'string' || !/^[a-f0-9]{64}$/.test(ref.hash)
        || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0 || ref.bytes > MAX_BYTES
        || seen.has(JSON.stringify(ref.path)) || (total += ref.bytes) > MAX_ROW_BYTES) throw new Error('Invalid history blob field')
      seen.add(JSON.stringify(ref.path))
    }
    for (const ref of envelope.refs) {
      let parent: any = result
      for (const key of ref.path.slice(0, -1)) {
        if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, key)
          || Array.isArray(parent) && (typeof key !== 'number' || key >= parent.length)
          || !Array.isArray(parent) && typeof key !== 'string') throw new Error('Invalid history blob path')
        parent = parent[key]
      }
      const key = ref.path.at(-1)!
      if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, key) || parent[key] !== null
        || Array.isArray(parent) && (typeof key !== 'number' || key >= parent.length)
        || !Array.isArray(parent) && typeof key !== 'string') throw new Error('Invalid history blob placeholder')
      parent[key] = this.read(envelope.tenant, ref)
    }
    delete result.storageBlobs
    return result as unknown as T
  }
}
