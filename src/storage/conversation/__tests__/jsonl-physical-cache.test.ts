/** Fresh real-file/native-DB fixtures: bounded reuse, source isolation and cold/warm TOCTOU. No provider/UI. */
import fs from 'node:fs'
import path from 'node:path'
import type { FileHandle } from 'node:fs/promises'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDb, initDb } from '../../sqlite/db.js'
import { JSONLConversationHistory } from '../jsonl-history.js'
import { jsonlHistoryIdentity, type JSONLHistoryOrigin, type JSONLPhysicalSnapshot } from '../jsonl-origin.js'
import { cacheJSONLPhysicalSnapshot, estimateJSONLPhysicalSnapshotBytes, getJSONLPhysicalSnapshot,
  invalidateJSONLPhysicalSnapshot, jsonlPhysicalCacheStats, JSONL_PHYSICAL_CACHE_LIMITS, type JSONLPhysicalCacheKey } from '../jsonl-physical-cache.js'

const scratch = path.resolve('.e2e-tmp')
let directory: string, file: string, serial = 0, history: JSONLConversationHistory, origin: JSONLHistoryOrigin
let scope: { tenantId: string; sessionId: string }
beforeAll(async () => {
  await closeDb(); fs.mkdirSync(scratch, { recursive: true })
  directory = fs.mkdtempSync(path.join(scratch, 'physical-cache-'))
  vi.stubEnv('DATA_DIR', path.join(directory, 'fixture.db')); await initDb()
})
beforeEach(() => {
  scope = { tenantId: 'physical-cache', sessionId: `session-${++serial}` }
  file = path.join(directory, 'sessions', scope.tenantId, scope.sessionId + '.jsonl')
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '')
  history = new JSONLConversationHistory(); origin = jsonlHistoryIdentity(history)!
})
afterEach(() => vi.restoreAllMocks())
afterAll(async () => {
  expect((await closeDb())?.healthy).toBe(true); vi.unstubAllEnvs()
  if (path.dirname(directory) !== scratch || !path.basename(directory).startsWith('physical-cache-')) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
const inspect = () => origin.withLease(scope, () => origin.inspect(scope))
const seed = () => history.append({ id: 'input', role: 'user', content: 'source '.repeat(30_000),
  modelInputContent: [{ type: 'text', text: 'provider original' }], metadata: { nested: { values: [1] } } }, scope)

function observe(afterFirstStat?: (handle: FileHandle) => void, afterRead?: () => void) {
  const open = fs.promises.open.bind(fs.promises), stats = { opens: 0, stats: 0, bytes: 0 }
  vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args)
    if (String(args[0]) !== file || args[1] !== 'r') return handle
    stats.opens++; let handleStats = 0
    return new Proxy(handle, { get(target, property) {
      if (property === 'stat') return async () => {
        const result = await target.stat(); stats.stats++
        if (++handleStats === 1) afterFirstStat?.(target)
        return result
      }
      if (property === 'read') return async (buffer: Buffer, offset: number, length: number, position: number) => {
        const result = await target.read(buffer, offset, length, position)
        stats.bytes += result.bytesRead; afterRead?.(); return result
      }
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value
    } })
  })
  return stats
}

function mutate(kind: string, before: Buffer): void {
  if (kind === 'append') fs.appendFileSync(file, '\n')
  else if (kind === 'truncate') fs.truncateSync(file, 0)
  else if (kind === 'edit') {
    const stat = fs.statSync(file)
    fs.writeFileSync(file, before.toString().replace('source', 'SOURCE'))
    fs.utimesSync(file, stat.atime, stat.mtime)
  } else if (kind === 'delete') fs.unlinkSync(file)
  else {
    const replacement = file + '.replacement', retired = file + '.retired'
    for (const target of [file, replacement, retired]) if (path.dirname(path.resolve(target)) !== path.join(directory, 'sessions', scope.tenantId)) throw new Error('Unsafe fixture move')
    fs.writeFileSync(replacement, before.toString().replace('source', 'SOURCE'))
    fs.renameSync(file, retired); fs.renameSync(replacement, file)
  }
}

describe('physical snapshots reuse only complete, unchanged scoped bytes', () => {
  it('reads once and independently opens/stats every hit without sharing caller mutations', async () => {
    await seed()
    const measured = observe(), first = await inspect(), expected = structuredClone(first)
    expect(measured.bytes).toBe(fs.statSync(file).size)
    first.rows[0].message.content = 'caller change'
    first.active[0].content = 'caller change'
    const hit = await inspect()
    expect(hit).toEqual(expected)
    ;(hit.rows[0].message.metadata!.nested as { values: number[] }).values.push(2)
    hit.active[0].modelInputContent = 'caller change'
    expect(await inspect()).toEqual(expected)
    expect(measured).toEqual({ opens: 3, stats: 6, bytes: fs.statSync(file).size })
  })

  it.each(['append', 'compress', 'microcompact'] as const)('rescans after normal %s and then reuses the new revision', async operation => {
    await seed()
    for (let index = 0; index < 5; index++) await history.append({ id: 'exchange-' + index, role: index % 2 ? 'user' : 'assistant', content: 'later ' + index }, scope)
    await history.append({ id: 'tool', role: 'tool', toolCallId: 'call', content: 'large '.repeat(300) }, scope)
    const before = await inspect()
    if (operation === 'append') await history.append({ id: 'new', role: 'assistant', content: 'new value' }, scope)
    else if (operation === 'compress') await history.compress(scope, async () => 'local fixture summary', 2)
    else await history.microCompactToolResults(scope, { keepRecent: 0 })
    await history.getFullHistory(scope)
    const measured = observe(), after = await inspect()
    expect(after.revision).not.toBe(before.revision)
    expect(after.contentHash).not.toBe(before.contentHash)
    expect(after.active).toEqual(await history.getFullHistory(scope))
    expect(await inspect()).toEqual(after)
    expect(measured.bytes).toBe(fs.statSync(file).size)
  })

  it('invalidates same-length external edits even when mtime is restored', async () => {
    await seed(); const before = await inspect(), original = fs.readFileSync(file), previous = fs.statSync(file)
    mutate('edit', original)
    const current = fs.statSync(file)
    expect(current.size).toBe(previous.size)
    expect(Math.abs(current.mtimeMs - previous.mtimeMs)).toBeLessThan(1)
    expect(current.ctimeMs).not.toBe(previous.ctimeMs)
    await history.getFullHistory(scope)
    const measured = observe(), after = await inspect()
    expect(after.contentHash).not.toBe(before.contentHash)
    expect(after.rows[0].message.content).toMatch(/^SOURCE /)
    expect(measured.bytes).toBe(current.size)
  })

  it.each(['replace', 'delete-recreate', 'truncate'] as const)('does not reuse a snapshot after %s', async operation => {
    await seed(); const first = await inspect(), before = fs.readFileSync(file)
    if (operation === 'delete-recreate') { fs.unlinkSync(file); fs.writeFileSync(file, before.toString().replace('source', 'SOURCE')) }
    else mutate(operation, before)
    await history.getFullHistory(scope)
    const measured = observe(), after = await inspect()
    expect(after.contentHash).not.toBe(first.contentHash)
    expect(after.rows.length).toBe(operation === 'truncate' ? 0 : 1)
    expect(measured.bytes).toBe(fs.statSync(file).size)
  })

  it('cannot publish or cache a partial failed scan', async () => {
    await seed(); let fail = true
    observe(undefined, () => { if (fail) { fail = false; throw new Error('injected read failure') } })
    await expect(inspect()).rejects.toThrow('injected read failure')
    vi.restoreAllMocks()
    const measured = observe(), after = await inspect()
    expect(after.rows).toHaveLength(1)
    expect(measured.bytes).toBe(fs.statSync(file).size)
  })

  it('keeps tenant and session histories distinct in the same owner', async () => {
    await seed(); await inspect()
    for (const other of [{ ...scope, tenantId: 'other-tenant' }, { ...scope, sessionId: 'other-session' }]) {
      await history.append({ id: 'input', role: 'user', content: 'private ' + other.tenantId + other.sessionId }, other)
      const result = await origin.withLease(other, () => origin.inspect(other))
      expect(result.active.map(message => message.content)).toEqual(['private ' + other.tenantId + other.sessionId])
    }
    expect((await inspect()).active[0].content).toMatch(/^source /)
  })

  it('rejects a changed data source even with a warm physical snapshot', async () => {
    await seed(); await inspect()
    process.env.DATA_DIR = path.join(directory, 'different.db')
    try { await expect(inspect()).rejects.toThrow('projection source changed') }
    finally { process.env.DATA_DIR = path.join(directory, 'fixture.db') }
  })
})

describe.each(['cold', 'warm'] as const)('%s physical snapshot TOCTOU', temperature => {
  it.each(['append', 'truncate', 'replace', 'edit', 'delete'] as const)('rejects a concurrent %s without accepting stale cached evidence', async operation => {
    await seed(); if (temperature === 'warm') await inspect()
    const before = fs.readFileSync(file); let changed = false
    const change = () => { if (!changed) { changed = true; mutate(operation, before) } }
    observe(temperature === 'warm' ? change : undefined, temperature === 'cold' ? change : undefined)
    await expect(inspect()).rejects.toMatchObject({ code: 'conflict' })
    expect(changed).toBe(true)
  })
})

describe('one bounded process-wide cache', () => {
  const snapshot = (): JSONLPhysicalSnapshot => ({ fileIdentity: '1:2:3', revision: '1:2:3:4:5', size: 100,
    contentHash: 'hash', nextSequence: 2, lastId: 'input', rows: [], active: [{ id: 'input', role: 'user', content: 'private' }] })
  const key = (): JSONLPhysicalCacheKey => ({ owner: {}, database: {}, databaseEpoch: 1, dataPath: 'fixture.db',
    tenantId: 't', sessionId: 's', fileIdentity: '1:2:3', revision: '1:2:3:4:5' })

  it.each(['owner', 'database', 'databaseEpoch', 'dataPath', 'tenantId', 'sessionId', 'fileIdentity', 'revision'] as const)('never shares snapshots across %s', field => {
    const original = key(), changed = { ...original }, value = snapshot()
    cacheJSONLPhysicalSnapshot(original, value)
    if (field === 'owner' || field === 'database') changed[field] = {}
    else if (field === 'databaseEpoch') changed[field] = 2
    else changed[field] = 'different'
    expect(getJSONLPhysicalSnapshot(changed)).toBeUndefined()
    invalidateJSONLPhysicalSnapshot(original)
  })

  it('evicts least-recently-used entries at four across distinct owners', () => {
    const keys = Array.from({ length: 5 }, key)
    for (const item of keys.slice(0, 4)) cacheJSONLPhysicalSnapshot(item, snapshot())
    expect(getJSONLPhysicalSnapshot(keys[0])).toEqual(snapshot())
    cacheJSONLPhysicalSnapshot(keys[4], snapshot())
    expect(getJSONLPhysicalSnapshot(keys[1])).toBeUndefined()
    expect(getJSONLPhysicalSnapshot(keys[0])).toEqual(snapshot())
    expect(jsonlPhysicalCacheStats().entries).toBe(4)
    for (const item of keys) invalidateJSONLPhysicalSnapshot(item)
  })

  it('charges repeated rows/active strings and refuses oversized snapshots', () => {
    const value = snapshot(), text = 'a'.repeat(9 * 1024 * 1024), original = key()
    value.active[0].content = text
    value.rows.push({ id: 'input', offset: 0, bytes: text.length, hash: 'hash', sequence: 1, message: { ...value.active[0] } })
    expect(estimateJSONLPhysicalSnapshotBytes(value)).toBeGreaterThan(36 * 1024 * 1024)
    cacheJSONLPhysicalSnapshot(original, value)
    expect(getJSONLPhysicalSnapshot(original)).toBeUndefined()
    expect(jsonlPhysicalCacheStats().estimatedBytes).toBeLessThanOrEqual(JSONL_PHYSICAL_CACHE_LIMITS.estimatedBytes)
  })

  it('evicts by estimated retained bytes before reaching the entry limit', () => {
    const keys = Array.from({ length: 3 }, key), value = snapshot()
    value.active[0].content = 'x'.repeat(6 * 1024 * 1024)
    for (const item of keys) cacheJSONLPhysicalSnapshot(item, value)
    expect(getJSONLPhysicalSnapshot(keys[0])).toBeUndefined()
    expect(getJSONLPhysicalSnapshot(keys[1])).toEqual(value)
    expect(jsonlPhysicalCacheStats().estimatedBytes).toBeLessThanOrEqual(JSONL_PHYSICAL_CACHE_LIMITS.estimatedBytes)
    for (const item of keys) invalidateJSONLPhysicalSnapshot(item)
  })
})
