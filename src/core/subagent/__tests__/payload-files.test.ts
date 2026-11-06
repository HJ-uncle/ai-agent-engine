// Real local files/SQLite fixture connections. No getDb(), default DATA_DIR, model or user state is used.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Client } from '@libsql/client'
import { LocalSqliteProcessClient } from '../../../storage/sqlite/local-process-client.js'
import { getSubagentPayloadFiles, isSubagentPayloadReference, SubagentPayloadFiles,
  SUBAGENT_PAYLOAD_MAX_BYTES, SUBAGENT_PAYLOAD_RANGE_MAX_BYTES, type SubagentPayloadReference } from '../payload-files.js'

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const body = JSON.stringify({ args: { path: '项目/证据.ts' }, output: '原始正文\n"引号"\t🙂'.repeat(8000), unusual: '\ud800' })
let directory: string, store: SubagentPayloadFiles
const clients: LocalSqliteProcessClient[] = []
const temporaryStores: SubagentPayloadFiles[] = []
const files = (root: string, suffix: string): string[] => fs.existsSync(root)
  ? fs.readdirSync(root, { recursive: true }).map(String).filter(file => file.endsWith(suffix)) : []
const evidenceFile = (owner: SubagentPayloadFiles, ref: SubagentPayloadReference) => path.join(owner.root, ref.tenantHash, ref.hash.slice(0, 2), ref.hash + '.gz')
function database(file: string): LocalSqliteProcessClient {
  const client = new LocalSqliteProcessClient({ url: file === ':memory:' ? 'file::memory:' : 'file:' + file.replaceAll('\\', '/') })
  clients.push(client); return client
}

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-payload-files-test-'))
  store = new SubagentPayloadFiles(path.join(directory, 'state', 'fixture.db.subagent-payloads'))
})
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  for (const client of clients) client.close()
  await Promise.all(clients.splice(0).map(client => client.whenClosed()))
  for (const transient of temporaryStores.splice(0)) await transient.dispose()
  const resolved = path.resolve(directory)
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('aether-payload-files-test-')) throw new Error('Unsafe payload fixture cleanup')
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

describe('immutable subagent payload files', () => {
  it('publishes exact serialized evidence before returning a small reference, with no inline body', async () => {
    const ref = await store.put('tenant-a', body)
    expect(ref).toEqual({ format: 'aether-subagent-payload', version: 1, tenantHash: digest('tenant-a'), hash: digest(body), bytes: Buffer.byteLength(body), codec: 'gzip' })
    expect(isSubagentPayloadReference(ref)).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(ref))).toBeLessThan(300)
    expect(files(store.root, '.gz')).toHaveLength(1)
    expect(files(store.root, '.tmp')).toHaveLength(0)
    const reopened = new SubagentPayloadFiles(store.root)
    expect(await reopened.read('tenant-a', ref)).toBe(body)
    expect(JSON.parse(await reopened.read('tenant-a', ref)).unusual).toBe('\ud800')
  })

  it('deduplicates concurrent same-tenant publishers without replacing their immutable file', async () => {
    const references = await Promise.all(Array.from({ length: 12 }, () => store.put('tenant-a', body)))
    expect(new Set(references.map(ref => JSON.stringify(ref))).size).toBe(1)
    const file = evidenceFile(store, references[0]), before = fs.statSync(file)
    await store.put('tenant-a', body)
    const after = fs.statSync(file)
    expect({ ino: after.ino, size: after.size, mtimeMs: after.mtimeMs }).toEqual({ ino: before.ino, size: before.size, mtimeMs: before.mtimeMs })
    expect(files(store.root, '.gz')).toHaveLength(1)
    expect(files(store.root, '.tmp')).toHaveLength(0)
  })

  it('isolates identical content across tenants and rejects cross-tenant references before reading files', async () => {
    const first = await store.put('tenant-a', body), second = await store.put('tenant-b', body)
    expect(first.hash).toBe(second.hash); expect(first.tenantHash).not.toBe(second.tenantHash)
    expect(files(store.root, '.gz')).toHaveLength(2)
    const read = vi.spyOn(fs.promises, 'lstat')
    await expect(store.read('tenant-b', first)).rejects.toMatchObject({ code: 'SUBAGENT_PAYLOAD_TENANT_MISMATCH' })
    expect(read).not.toHaveBeenCalled()
    read.mockRestore()
    expect(await store.read('tenant-b', second)).toBe(body)
  })

  it('streams verified byte ranges without readFile or a decoded-body cache, including UTF-8 boundaries', async () => {
    const ref = await store.put('tenant-a', body), bytes = Buffer.from(body)
    const readFile = vi.spyOn(fs.promises, 'readFile'), readFileSync = vi.spyOn(fs, 'readFileSync')
    for (const offset of [0, 21, bytes.length - 17, bytes.length]) {
      const result = await store.readRange('tenant-a', ref, { offsetBytes: offset, limitBytes: 17 })
      expect(result.chunk).toEqual(bytes.subarray(offset, offset + 17))
      expect(result.totalBytes).toBe(bytes.length)
      expect(result.nextOffsetBytes).toBe(offset + 17 < bytes.length ? offset + 17 : null)
    }
    expect(readFile).not.toHaveBeenCalled(); expect(readFileSync).not.toHaveBeenCalled()
  })

  it('enforces caller read limits before file access and rejects invalid ranges', async () => {
    const ref = await store.put('tenant-a', body), read = vi.spyOn(fs.promises, 'lstat')
    await expect(store.read('tenant-a', ref, { maxBytes: 64 })).rejects.toMatchObject({ code: 'SUBAGENT_PAYLOAD_TOO_LARGE' })
    expect(read).not.toHaveBeenCalled()
    read.mockRestore()
    for (const options of [{ offsetBytes: -1 }, { offsetBytes: ref.bytes + 1 }, { limitBytes: 0 }, { limitBytes: SUBAGENT_PAYLOAD_RANGE_MAX_BYTES + 1 }, { limitBytes: 1.5 }]) {
      await expect(store.readRange('tenant-a', ref, options)).rejects.toThrow(/Invalid.*range/)
    }
  })

  it('verifies the whole payload even when the requested page is at the beginning', async () => {
    const text = JSON.stringify({ output: 'a'.repeat(200_000) }), ref = await store.put('tenant-a', text)
    fs.writeFileSync(evidenceFile(store, ref), gzipSync(text.slice(0, -2) + 'b}'))
    await expect(store.readRange('tenant-a', ref, { limitBytes: 8 })).rejects.toMatchObject({ code: 'SUBAGENT_PAYLOAD_CORRUPT' })
  })

  it('reports missing, damaged, substituted and oversized decoded evidence without overwriting it', async () => {
    const ref = await store.put('tenant-a', body), file = evidenceFile(store, ref), original = fs.readFileSync(file)
    fs.unlinkSync(file)
    await expect(store.read('tenant-a', ref)).rejects.toMatchObject({ code: 'SUBAGENT_PAYLOAD_MISSING' })
    for (const invalid of [Buffer.from('not gzip'), gzipSync('x'.repeat(ref.bytes)), gzipSync('x'.repeat(ref.bytes + 1))]) {
      fs.writeFileSync(file, invalid)
      await expect(store.read('tenant-a', ref)).rejects.toMatchObject({ code: 'SUBAGENT_PAYLOAD_CORRUPT' })
      await expect(store.put('tenant-a', body)).rejects.toMatchObject({ code: 'SUBAGENT_PAYLOAD_CORRUPT' })
      expect(fs.readFileSync(file)).toEqual(invalid)
    }
    fs.writeFileSync(file, original)
    expect(await store.read('tenant-a', ref)).toBe(body)
  })

  it('refuses oversized compressed files and invalid UTF-8 after decompression', async () => {
    const small = new SubagentPayloadFiles(store.root, { maxPayloadBytes: 64 }), ref = await small.put('tenant-a', '"ok"')
    fs.writeFileSync(evidenceFile(small, ref), Buffer.alloc(64 + 65537))
    await expect(small.read('tenant-a', ref)).rejects.toMatchObject({ code: 'SUBAGENT_PAYLOAD_TOO_LARGE' })
    const invalid = Buffer.from([0xff, 0xfe, 0xff, 0xfe])
    fs.writeFileSync(evidenceFile(small, ref), gzipSync(invalid))
    await expect(small.read('tenant-a', ref)).rejects.toMatchObject({ code: 'SUBAGENT_PAYLOAD_CORRUPT' })
  })

  it('rejects oversized inputs and unescaped UTF-16 surrogates before creating storage', async () => {
    const small = new SubagentPayloadFiles(store.root, { maxPayloadBytes: 32 })
    await expect(small.put('tenant-a', 'x'.repeat(33))).rejects.toMatchObject({ code: 'SUBAGENT_PAYLOAD_TOO_LARGE' })
    await expect(small.put('tenant-a', '\ud800')).rejects.toMatchObject({ code: 'SUBAGENT_PAYLOAD_INVALID_REFERENCE' })
    expect(fs.existsSync(store.root)).toBe(false)
    const ref = await small.put('tenant-a', '')
    expect(await small.read('tenant-a', ref, { maxBytes: 0 })).toBe('')
    expect((await small.readRange('tenant-a', ref)).chunk).toHaveLength(0)
  })

  it('rejects root-directory indirection without writing into the link target', async () => {
    fs.mkdirSync(path.dirname(store.root), { recursive: true })
    const outside = path.join(directory, 'outside'); fs.mkdirSync(outside)
    fs.symlinkSync(outside, store.root, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(store.put('tenant-a', body)).rejects.toMatchObject({ code: 'SUBAGENT_PAYLOAD_UNSAFE_PATH' })
    expect(fs.readdirSync(outside)).toEqual([])
  })

  it('does not return a reference before the temporary inode is synced, and cleans failed writes', async () => {
    const original = fs.promises.open.bind(fs.promises)
    const open = vi.spyOn(fs.promises, 'open').mockImplementation(async (file, flags, mode) => {
      const handle = await original(file, flags, mode)
      if (flags === 'wx') vi.spyOn(handle, 'sync').mockRejectedValueOnce(new Error('fixture sync failure'))
      return handle
    })
    const publish = vi.spyOn(fs.promises, 'link')
    await expect(store.put('tenant-a', body)).rejects.toMatchObject({ code: 'SUBAGENT_PAYLOAD_IO', cause: { message: 'fixture sync failure' } })
    expect(publish).not.toHaveBeenCalled(); expect(files(store.root, '.gz')).toHaveLength(0); expect(files(store.root, '.tmp')).toHaveLength(0)
    open.mockRestore(); publish.mockRestore()
    expect(await store.read('tenant-a', await store.put('tenant-a', body))).toBe(body)
  })

  it('retains a published orphan after sync failure and re-establishes durability on retry', async () => {
    const original = fs.promises.open.bind(fs.promises)
    const open = vi.spyOn(fs.promises, 'open').mockImplementation(async (file, flags, mode) => {
      const handle = await original(file, flags, mode)
      if (typeof flags === 'number' && (flags & fs.constants.O_RDWR) === fs.constants.O_RDWR) vi.spyOn(handle, 'sync').mockRejectedValueOnce(new Error('fixture published sync failure'))
      return handle
    })
    await expect(store.put('tenant-a', body)).rejects.toMatchObject({ code: 'SUBAGENT_PAYLOAD_IO' })
    await expect(store.put('tenant-a', body)).rejects.toMatchObject({ code: 'SUBAGENT_PAYLOAD_IO' })
    expect(files(store.root, '.gz')).toHaveLength(1); expect(files(store.root, '.tmp')).toHaveLength(0)
    open.mockRestore()
    expect(await store.read('tenant-a', await store.put('tenant-a', body))).toBe(body)
  })
})

describe('subagent payload reference validation', () => {
  it('rejects unknown formats, extra fields, unsafe hashes, invalid byte counts and tenant mismatches before I/O', async () => {
    const ref = await store.put('tenant-a', body), read = vi.spyOn(fs.promises, 'lstat')
    const invalid = [null, [], 'bad', { ...ref, format: 'history-blob' }, { ...ref, version: 2 }, { ...ref, codec: 'raw' },
      { ...ref, hash: '../../outside' }, { ...ref, tenantHash: '../tenant' }, { ...ref, bytes: -1 }, { ...ref, bytes: '4' },
      { ...ref, bytes: Infinity }, { ...ref, bytes: SUBAGENT_PAYLOAD_MAX_BYTES + 1 }, { ...ref, path: 'outside' }]
    for (const value of invalid) {
      expect(isSubagentPayloadReference(value)).toBe(false)
      await expect(store.read('tenant-a', value)).rejects.toMatchObject({ code: 'SUBAGENT_PAYLOAD_INVALID_REFERENCE' })
    }
    expect(read).not.toHaveBeenCalled()
  })
})

describe('database-bound subagent payload location', () => {
  it('uses this connection main file rather than DATA_DIR or attached databases, and survives reopening', async () => {
    const actual = path.join(directory, 'actual.db'), attached = path.join(directory, 'attached.db')
    vi.stubEnv('DATA_DIR', path.join(directory, 'wrong.db'))
    const db = database(actual)
    await db.execute({ sql: 'ATTACH DATABASE ? AS extra', args: [attached] })
    const owner = await getSubagentPayloadFiles(db), ref = await owner.put('tenant-a', body)
    expect(owner.root).toBe(actual + '.subagent-payloads')
    expect(await getSubagentPayloadFiles(db)).toBe(owner)
    expect(fs.existsSync(path.join(directory, 'wrong.db.subagent-payloads'))).toBe(false)
    expect(await owner.dispose()).toBe(false); expect(await owner.read('tenant-a', ref)).toBe(body)
    await db.closeWithReceipt()
    const reopened = await getSubagentPayloadFiles(database(actual))
    expect(await reopened.read('tenant-a', ref)).toBe(body)
  })

  it('isolates two databases in one directory', async () => {
    const a = await getSubagentPayloadFiles(database(path.join(directory, 'a.db')))
    const b = await getSubagentPayloadFiles(database(path.join(directory, 'b.db')))
    const ref = await a.put('tenant-a', body)
    expect(a.root).not.toBe(b.root)
    await expect(b.read('tenant-a', ref)).rejects.toMatchObject({ code: 'SUBAGENT_PAYLOAD_MISSING' })
  })

  it('keeps :memory: clients in independent temporary file stores and disposes only those stores', async () => {
    vi.stubEnv('DATA_DIR', path.join(directory, 'must-not-be-used.db'))
    const a = await getSubagentPayloadFiles(database(':memory:')), b = await getSubagentPayloadFiles(database(':memory:'))
    temporaryStores.push(a, b)
    expect(a.root).not.toBe(b.root); expect(path.dirname(a.root)).toBe(path.resolve(os.tmpdir()))
    const ref = await a.put('tenant-a', body)
    await expect(b.read('tenant-a', ref)).rejects.toMatchObject({ code: 'SUBAGENT_PAYLOAD_MISSING' })
    expect(fs.existsSync(path.join(directory, 'must-not-be-used.db.subagent-payloads'))).toBe(false)
    expect(await a.dispose()).toBe(true); expect(await a.dispose()).toBe(true); expect(fs.existsSync(a.root)).toBe(false)
    await expect(a.read('tenant-a', ref)).rejects.toMatchObject({ code: 'SUBAGENT_PAYLOAD_DISPOSED' })
  })

  it('rejects nonlocal or ambiguous DB locations without a DATA_DIR fallback', async () => {
    for (const db of [
      { protocol: 'https', execute: vi.fn() },
      { protocol: 'file', execute: vi.fn().mockResolvedValue({ rows: [] }) },
      { protocol: 'file', execute: vi.fn().mockResolvedValue({ rows: [{ name: 'main', file: '../relative.db' }] }) },
    ]) await expect(getSubagentPayloadFiles(db as unknown as Client)).rejects.toMatchObject({ code: 'SUBAGENT_PAYLOAD_DATABASE_LOCATION' })
  })
})
