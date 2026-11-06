import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HistoryBlobStore } from '../history-blobs.js'

let directory: string, store: HistoryBlobStore
const body = '原始正文\n"引号"\t🙂'.repeat(100)
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const row = () => ({ tenantId: 'tenant-a', sessionId: 'session', uuid: 'message', type: 'tool', dbSeq: 1, payload: { id: 'message', role: 'tool', content: body } })
const blobFiles = () => fs.existsSync(store.root) ? fs.readdirSync(store.root, { recursive: true }).filter(file => String(file).endsWith('.gz')).map(String) : []
const temporaryFiles = () => fs.existsSync(store.root) ? fs.readdirSync(store.root, { recursive: true }).filter(file => String(file).endsWith('.tmp')) : []
const clone = <T>(value: T): T => structuredClone(value)

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-history-blobs-'))
  store = new HistoryBlobStore(path.join(directory, 'state', 'agent.db'), 64)
})

afterEach(() => {
  vi.restoreAllMocks()
  const resolved = path.resolve(directory)
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('aether-history-blobs-')) throw new Error('Unsafe blob fixture cleanup')
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

describe('private history evidence blobs', () => {
  it('round-trips all supported bodies, shares immutable payloads, and leaves projection identities inline', async () => {
    const input = { ...row(), payload: {
      id: body, role: 'assistant', content: [{ type: 'text', text: body }], modelInputContent: body, reasoningContent: body,
      metadata: { outputPreview: body, nested: [body] }, toolCall: { id: body, name: body, args: { script: body } },
      toolCallId: body, toolName: body, modelId: body, conversationId: body, extensionIdentity: body,
    } }
    const original = clone(input), encoded = JSON.parse(await store.encode(input))
    expect(input).toEqual(original)
    expect(encoded.storageBlobs).toMatchObject({ version: 1, tenant: hash(input.tenantId) })
    expect(encoded.payload).toMatchObject({ id: body, toolCallId: body, toolName: body, modelId: body, conversationId: body, extensionIdentity: body,
      toolCall: { id: body, name: body, args: { script: null } } })
    expect(encoded.storageBlobs.refs.every((ref: any) => ref.hash === hash(body))).toBe(true)
    expect(blobFiles()).toHaveLength(1)
    expect(store.hydrate(encoded)).toEqual(original)
    expect(encoded.storageBlobs).toBeDefined()
    expect(store.hydrate(encoded)).not.toHaveProperty('storageBlobs')
  })

  it('preserves legacy rows and application values resembling a storage reference', async () => {
    const input = { ...row(), payload: { id: 'm', content: 'short', metadata: { hash: 'not-a-storage-ref', path: ['content'], codec: 'gzip', storageBlobs: 'app-owned' } } }
    expect(store.hydrate(input)).toBe(input)
    const encoded = JSON.parse(await store.encode(input))
    expect(encoded).not.toHaveProperty('storageBlobs')
    expect(store.hydrate(encoded)).toEqual(input)
  })

  it('externalizes edit and legacy archive bodies while retaining their row identities', async () => {
    const input = { tenantId: 'tenant-a', type: 'update', targetUuid: body, content: body, modelInputContent: body, archiveContent: [body], metadata: { preview: body } }
    const encoded = JSON.parse(await store.encode(input))
    expect(encoded.targetUuid).toBe(body)
    expect(encoded.content).toBeNull()
    expect(store.hydrate(encoded)).toEqual(input)
  })

  it('isolates identical bytes by tenant and rejects a forged or foreign trusted scope', async () => {
    const a = JSON.parse(await store.encode(row()))
    const b = JSON.parse(await store.encode({ ...row(), tenantId: 'tenant-b' }))
    expect(blobFiles()).toHaveLength(2)
    expect(a.storageBlobs.refs[0].hash).toBe(b.storageBlobs.refs[0].hash)
    expect(a.storageBlobs.tenant).not.toBe(b.storageBlobs.tenant)
    expect(() => store.hydrate({ ...a, tenantId: 'tenant-b' })).toThrow(/envelope/)
    expect(() => store.hydrate(a, 'tenant-b')).toThrow(/tenant/)
    expect(() => store.hydrate(row(), 'tenant-b')).toThrow(/tenant/)
    expect(store.hydrate(a, 'tenant-a')).toEqual(row())
  })

  it('leaves excessive nesting inline and never publishes an envelope the reader rejects', async () => {
    const nested = (depth: number) => { let value: unknown = body; for (let i = 0; i < depth; i++) value = { next: value }; return value }
    const atLimit = { ...row(), payload: { metadata: nested(126) } }
    const encoded = JSON.parse(await store.encode(atLimit))
    expect(encoded.storageBlobs.refs[0].path).toHaveLength(128)
    expect(store.hydrate(encoded)).toEqual(atLimit)
    const tooDeep = { ...row(), payload: { metadata: nested(127) } }
    const inline = JSON.parse(await store.encode(tooDeep))
    expect(inline).not.toHaveProperty('storageBlobs')
    expect(store.hydrate(inline)).toEqual(tooDeep)
  })

  it.each(['\uD800', '\uDC00'])('preserves an isolated UTF-16 surrogate %j exactly instead of replacing it through UTF-8', async surrogate => {
    const content = body + surrogate + body
    const input = { ...row(), payload: { content, metadata: { invalid: content, valid: body } } }
    const encoded = JSON.parse(await store.encode(input))
    expect(encoded.payload.content).toBe(content)
    expect(encoded.payload.metadata.invalid).toBe(content)
    expect(encoded.payload.metadata.valid).toBeNull()
    expect(encoded.storageBlobs.refs).toHaveLength(1)
    expect(store.hydrate(encoded)).toEqual(input)
  })

  it('deduplicates concurrent publishers and removes temporary files', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => store.encode(row())))
    expect(new Set(results).size).toBe(1)
    expect(blobFiles()).toHaveLength(1)
    expect(temporaryFiles()).toHaveLength(0)
    expect(store.hydrate(JSON.parse(results[0]))).toEqual(row())
  })

  it('fails explicitly for missing, damaged and same-size substituted evidence', async () => {
    const encoded = JSON.parse(await store.encode(row()))
    const file = path.join(store.root, blobFiles()[0])
    const original = fs.readFileSync(file)
    fs.unlinkSync(file)
    expect(() => store.hydrate(encoded)).toThrow(/ENOENT/)
    fs.writeFileSync(file, 'corrupt gzip')
    expect(() => store.hydrate(encoded)).toThrow()
    await expect(store.encode(row())).rejects.toThrow()
    expect(fs.readFileSync(file, 'utf8')).toBe('corrupt gzip')
    fs.writeFileSync(file, original)
    const forged = clone(encoded)
    forged.storageBlobs.refs[0].bytes++
    expect(() => store.hydrate(forged)).toThrow(/integrity/)
    expect(store.hydrate(encoded)).toEqual(row())
  })

  it('rejects symbolic directory indirection without writing into another directory', async () => {
    fs.mkdirSync(path.dirname(store.root), { recursive: true })
    const other = path.join(directory, 'other')
    fs.mkdirSync(other)
    fs.symlinkSync(other, store.root, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(store.encode(row())).rejects.toThrow(/real directory/)
    expect(fs.readdirSync(other)).toHaveLength(0)
  })

  it('removes a temporary file after a failed write and keeps future appends usable', async () => {
    const originalOpen = fs.promises.open.bind(fs.promises)
    const open = vi.spyOn(fs.promises, 'open').mockImplementation(async (file, flags, mode) => {
      const handle = await originalOpen(file, flags, mode)
      if (flags === 'wx') vi.spyOn(handle, 'writeFile').mockRejectedValueOnce(new Error('fixture write failure'))
      return handle
    })
    await expect(store.encode(row())).rejects.toThrow(/fixture write failure/)
    expect(blobFiles()).toHaveLength(0)
    expect(temporaryFiles()).toHaveLength(0)
    open.mockRestore()
    expect(store.hydrate(JSON.parse(await store.encode(row())))).toEqual(row())
  })

  it('re-establishes durability when retrying an already published file after a failed sync', async () => {
    const originalOpen = fs.promises.open.bind(fs.promises)
    let attempts = 0
    const open = vi.spyOn(fs.promises, 'open').mockImplementation(async (file, flags, mode) => {
      const handle = await originalOpen(file, flags, mode)
      if (flags === 'r+' && String(file).endsWith('.gz')) {
        attempts++
        vi.spyOn(handle, 'sync').mockRejectedValueOnce(new Error('fixture sync failure'))
      }
      return handle
    })
    await expect(store.encode(row())).rejects.toThrow(/fixture sync failure/)
    await expect(store.encode(row())).rejects.toThrow(/fixture sync failure/)
    expect(attempts).toBe(2)
    expect(blobFiles()).toHaveLength(1)
    expect(temporaryFiles()).toHaveLength(0)
    open.mockRestore()
    expect(store.hydrate(JSON.parse(await store.encode(row())))).toEqual(row())
  })
})

describe('history blob envelope validation', () => {
  const malformedRefs: Array<[string, (ref: any) => unknown]> = [
    ['null reference', () => null],
    ['non-array path', ref => ({ ...ref, path: 'payload.content' })],
    ['empty path', ref => ({ ...ref, path: [] })],
    ['unsafe key', ref => ({ ...ref, path: ['payload', 'metadata', '__proto__', 'polluted'] })],
    ['identity replacement', ref => ({ ...ref, path: ['payload', 'id'] })],
    ['tool identity replacement', ref => ({ ...ref, path: ['payload', 'toolCall', 'id'] })],
    ['negative index', ref => ({ ...ref, path: ['payload', 'content', -1] })],
    ['fractional index', ref => ({ ...ref, path: ['payload', 'content', 0.5] })],
    ['non-finite index', ref => ({ ...ref, path: ['payload', 'content', Infinity] })],
    ['null bytes', ref => ({ ...ref, bytes: null })],
    ['string bytes', ref => ({ ...ref, bytes: String(ref.bytes) })],
    ['oversized bytes', ref => ({ ...ref, bytes: 128 * 1024 * 1024 + 1 })],
    ['negative bytes', ref => ({ ...ref, bytes: -1 })],
    ['invalid codec', ref => ({ ...ref, codec: 'raw' })],
    ['path-like hash', ref => ({ ...ref, hash: '../../outside' })],
  ]
  it.each(malformedRefs)('rejects %s before touching evidence files', async (_name, mutate) => {
    const encoded = JSON.parse(await store.encode(row()))
    encoded.storageBlobs.refs[0] = mutate(encoded.storageBlobs.refs[0])
    expect(() => store.hydrate(encoded)).toThrow(/Invalid history blob/)
  })

  it('rejects malformed envelopes, duplicate references, reference floods and excessive total bytes', async () => {
    const encoded = JSON.parse(await store.encode(row()))
    for (const invalid of [null, [], 'bad', { ...encoded.storageBlobs, version: 2 }, { ...encoded.storageBlobs, refs: [] }]) {
      expect(() => store.hydrate({ ...encoded, storageBlobs: invalid })).toThrow(/Invalid history blob/)
    }
    expect(() => store.hydrate({ ...encoded, storageBlobs: { ...encoded.storageBlobs, refs: Array(4097).fill(encoded.storageBlobs.refs[0]) } })).toThrow(/envelope/)
    expect(() => store.hydrate({ ...encoded, storageBlobs: { ...encoded.storageBlobs, refs: [encoded.storageBlobs.refs[0], encoded.storageBlobs.refs[0]] } })).toThrow(/field/)
    const oversized = clone(encoded)
    oversized.storageBlobs.refs = ['content', 'modelInputContent', 'reasoningContent'].map(name => ({ ...encoded.storageBlobs.refs[0], path: ['payload', name], bytes: 128 * 1024 * 1024 }))
    expect(() => store.hydrate(oversized)).toThrow(/field/)
    expect(() => store.hydrate(null as never)).toThrow(/tenant/)
    await expect(store.encode({ ...row(), storageBlobs: encoded.storageBlobs })).rejects.toThrow(/already externalized/)
  })

  it('requires canonical array indexes and a present null placeholder without mutating input', async () => {
    const source = { ...row(), payload: { content: [body] } }
    const encoded = JSON.parse(await store.encode(source))
    const alias = clone(encoded)
    alias.storageBlobs.refs[0].path[2] = '0'
    expect(() => store.hydrate(alias)).toThrow(/placeholder/)
    const missing = clone(encoded)
    delete missing.payload.content[0]
    expect(() => store.hydrate(missing)).toThrow(/placeholder/)
    const present = clone(encoded)
    present.payload.content[0] = 'already occupied'
    expect(() => store.hydrate(present)).toThrow(/placeholder/)
    expect(encoded.payload.content[0]).toBeNull()
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})
