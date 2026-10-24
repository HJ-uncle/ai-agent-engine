/** Real files/native store: legacy byte hashes, bounded reads, recovery prefix and snapshot isolation. No provider/listener. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '../../../core/agent-context/types.js'
import { JSONLConversationHistory } from '../jsonl-history.js'
import { jsonlHistoryIdentity, type JSONLHistoryOrigin } from '../jsonl-origin.js'
import { readJSONLBytes } from '../jsonl-byte-reader.js'
import { closeDb, initDb } from '../../sqlite/db.js'

const scratch = path.resolve('.e2e-tmp')
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
let directory: string, file: string, serial = 0, history: JSONLConversationHistory, origin: JSONLHistoryOrigin
let scope: { tenantId: string; sessionId: string }
beforeAll(async () => {
  await closeDb()
  fs.mkdirSync(scratch, { recursive: true }); directory = fs.mkdtempSync(path.join(scratch, 'physical-stream-'))
  vi.stubEnv('DATA_DIR', path.join(directory, 'fixture.db'))
  await initDb()
})
beforeEach(() => {
  scope = { tenantId: 'physical-stream', sessionId: `session-${++serial}` }
  file = path.join(directory, 'sessions', scope.tenantId, scope.sessionId + '.jsonl')
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '')
  history = new JSONLConversationHistory(); origin = jsonlHistoryIdentity(history)!
})
afterEach(() => { vi.restoreAllMocks() })
afterAll(async () => {
  const closed = await closeDb(); expect(closed?.healthy).toBe(true)
  vi.unstubAllEnvs()
  if (path.dirname(directory) !== scratch || !path.basename(directory).startsWith('physical-stream-')) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
const inspect = () => origin.withLease(scope, () => origin.inspect(scope))
const row = (id: string, sequence: number, content: Message['content'], extra: Record<string, unknown> = {}) => ({
  ...scope, uuid: id, parentUuid: sequence > 1 ? `message-${sequence - 1}` : null, type: 'user', dbSeq: sequence,
  payload: { id, role: 'user', content, modelInputContent: [{ type: 'text', text: '原始输入🙂' }], metadata: { nested: [1, 2] } }, ...extra,
})

function interceptReads(mode: 'r' | 'r+', afterRead?: (handle: FileHandle, position: number, bytesRead: number) => Promise<void>) {
  const open = fs.promises.open.bind(fs.promises), lengths: number[] = []
  vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args)
    if (String(args[0]) !== file || args[1] !== mode) return handle
    return new Proxy(handle, { get(target, property) {
      if (property === 'read') return async (buffer: Buffer, offset: number, length: number, position: number) => {
        lengths.push(length)
        const result = await target.read(buffer, offset, length, position)
        await afterRead?.(target, position, result.bytesRead)
        return result
      }
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value
    } })
  })
  return lengths
}

describe('JSONL physical streaming compatibility', () => {
  it('matches legacy SHA256(base64(prefix)) across empty, triple and 64 KiB boundaries, including short reads', async () => {
    const data = Buffer.from(Array.from({ length: 131_077 }, (_, index) => index * 137 & 255))
    fs.writeFileSync(file, data)
    const handle = await fs.promises.open(file, 'r')
    try {
      const partial = new Proxy(handle, { get(target, property) {
        if (property === 'read') return (buffer: Buffer, offset: number, length: number, position: number) => target.read(buffer, offset, Math.min(length, 997), position)
        const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value
      } })
      for (const size of [0, 1, 2, 3, 4, 5, 65534, 65535, 65536, 65537, 65538, 131071, 131072, 131073, data.length])
        expect(await readJSONLBytes(partial, size), `prefix ${size}`).toBe(digest(data.subarray(0, size).toString('base64')))
    } finally { await handle.close() }
  })

  it('keeps exact physical bytes, UTF-8 payloads, duplicate IDs and order without accepting a tail lacking LF', async () => {
    const first = row('same', 7, '界🙂'.repeat(12_000)), second = row('same', 2, [{ type: 'text', text: 'escaped\nline' }])
    const lines = [JSON.stringify(first) + '\r\n', '\n', 'invalid-json\n',
      JSON.stringify(row('foreign', 3, 'other tenant', { tenantId: 'foreign' })) + '\n', JSON.stringify(second) + '\n']
    const data = Buffer.from(lines.join('') + JSON.stringify(row('tail-only', 8, 'not LF committed')))
    fs.writeFileSync(file, data); vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await history.getFullHistory(scope)
    const lengths = interceptReads('r'), snapshot = await inspect()
    expect(snapshot.contentHash).toBe(digest(data.toString('base64')))
    expect(snapshot.rows).toHaveLength(2)
    const secondOffset = Buffer.byteLength(lines.slice(0, 4).join(''))
    expect(snapshot.rows.map(actual => ({ id: actual.id, offset: actual.offset, bytes: actual.bytes, hash: actual.hash, sequence: actual.sequence }))).toEqual([
      { id: 'same', offset: 0, bytes: Buffer.byteLength(lines[0]), hash: digest(lines[0]), sequence: 7 },
      { id: 'same', offset: secondOffset, bytes: Buffer.byteLength(lines[4]), hash: digest(lines[4]), sequence: 2 },
    ])
    expect(snapshot.rows.map(actual => actual.message)).toEqual([
      { ...first.payload, dbId: 7 }, { ...second.payload, dbId: 2 },
    ])
    expect(lengths.length).toBeGreaterThan(1); expect(Math.max(...lengths)).toBeLessThanOrEqual(64 * 1024)
  })

  it('preserves complete legacy giant lines without imposing a new rejection limit', async () => {
    const content = 'Legacy image payload '.repeat(110_000)
    await history.append({ id: 'giant-tool', role: 'tool', content, toolCallId: 'call-1' }, scope)
    const lengths = interceptReads('r'), snapshot = await inspect()
    expect(snapshot.rows[0].message).toMatchObject({ id: 'giant-tool', content, toolCallId: 'call-1' })
    expect(snapshot.contentHash).toBe(digest(fs.readFileSync(file).toString('base64')))
    expect(Math.max(...lengths)).toBeLessThanOrEqual(64 * 1024)
  })

  it('returns deep-cloned active content, model snapshots and nested tool metadata without altering cache or prior snapshot', async () => {
    await history.append({ id: 'input', role: 'user', content: [{ type: 'text', text: 'original' }],
      modelInputContent: [{ type: 'text', text: 'provider original' }], metadata: { nested: { values: [1] } } }, scope)
    const first = await inspect(), expected = structuredClone(first.active), second = await inspect()
    Object.assign(second.active[0], { content: 'changed', modelInputContent: 'changed' })
    const nested = second.active[0].metadata?.nested as { values: number[] }
    nested.values.push(2)
    expect(first.active).toEqual(expected)
    expect((await inspect()).active).toEqual(expected)
    expect(await history.getFullHistory(scope)).toEqual(expected)
  })

  it('persists a plan carrying the exact legacy prefix hash with bounded prefix reads', async () => {
    await history.append({ id: 'input', role: 'user', content: 'input '.repeat(30_000) }, scope)
    const snapshot = await inspect(), before = fs.readFileSync(file)
    const plan = { ...origin.plan(scope, snapshot, { id: 'result', role: 'assistant', content: 'result' }), prefixHash: digest(before.toString('base64')) }
    const lengths = interceptReads('r+')
    await origin.withLease(scope, () => origin.persist(scope, plan))
    expect(fs.readFileSync(file)).toEqual(Buffer.concat([before, Buffer.from(plan.encoded)]))
    expect((await inspect()).active.at(-1)).toMatchObject({ id: 'result', content: 'result' })
    expect(lengths.length).toBeGreaterThan(2); expect(Math.max(...lengths)).toBeLessThanOrEqual(64 * 1024)
  })

  it('rejects same-size prefix tampering before writing any reserved bytes', async () => {
    await history.append({ id: 'input', role: 'user', content: 'original input' }, scope)
    const snapshot = await inspect(), before = fs.readFileSync(file)
    const plan = { ...origin.plan(scope, snapshot, { id: 'result', role: 'assistant', content: 'result' }), prefixHash: digest(before.toString('base64')) }
    const changed = Buffer.from(before.toString().replace('original input', 'tampered input'))
    expect(changed.length).toBe(before.length); fs.writeFileSync(file, changed)
    await expect(origin.persist(scope, plan)).rejects.toThrow('maintenance source prefix changed')
    expect(fs.readFileSync(file)).toEqual(changed)
  })
})

describe.each(['inspect', 'prefix'] as const)('%s detects concurrent physical changes', operation => {
  it.each(['append', 'truncate', 'replace', 'edit'] as const)('rejects %s before publishing a snapshot or reserved append', async mutation => {
    await history.append({ id: 'input', role: 'user', content: 'source '.repeat(30_000) }, scope)
    const snapshot = await inspect()
    // Force a real cold scan; a warm hit intentionally has no byte-read hook.
    // Warm handle/path races have separate coverage in jsonl-physical-cache.
    if (operation === 'inspect') fs.appendFileSync(file, '\n')
    const before = fs.readFileSync(file), previousStat = fs.statSync(file)
    const plan = { ...origin.plan(scope, snapshot, { id: 'reserved', role: 'assistant', content: 'must not persist' }), prefixHash: digest(before.toString('base64')) }
    let changed = false
    interceptReads(operation === 'inspect' ? 'r' : 'r+', async () => {
      if (changed) return
      changed = true
      if (mutation === 'append') fs.appendFileSync(file, '\n')
      else if (mutation === 'truncate') fs.truncateSync(file, 3)
      else if (mutation === 'replace') {
        const replacement = file + '.replacement', retired = file + '.retired'
        for (const target of [file, replacement, retired]) if (path.dirname(path.resolve(target)) !== path.join(directory, 'sessions', scope.tenantId)) throw new Error('Unsafe fixture move')
        fs.writeFileSync(replacement, before); fs.utimesSync(replacement, previousStat.atime, previousStat.mtime)
        fs.renameSync(file, retired); fs.renameSync(replacement, file)
      } else {
        fs.writeFileSync(file, Buffer.from(before.toString().replace('source', 'SOURCE')))
        fs.utimesSync(file, previousStat.atime, new Date(previousStat.mtimeMs + 1000))
      }
    })
    await expect(operation === 'inspect' ? inspect() : origin.persist(scope, plan)).rejects.toMatchObject({ code: 'conflict' })
    expect(changed).toBe(true)
    expect(fs.readFileSync(file, 'utf8')).not.toContain('must not persist')
  })
})
