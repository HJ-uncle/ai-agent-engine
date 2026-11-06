import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createClient } from '@libsql/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SubagentPayloadFiles, type SubagentPayloadReference } from '../payload-files.js'
import { SUBAGENT_PAYLOAD_CHUNK_BYTES, SUBAGENT_PAYLOAD_FIELDS, SubagentPayloadCodec } from '../payload-codec.js'

type TestValueReference = { bytes: number; chunks: SubagentPayloadReference[] }
const refsOf = (stored: Record<string, unknown>) =>
  (stored[SUBAGENT_PAYLOAD_FIELDS] as { refs: Record<string, TestValueReference> }).refs

const tenant = 'codec-test-tenant'
let root: string, files: SubagentPayloadFiles, codec: SubagentPayloadCodec
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'aether-payload-codec-'))
  files = new SubagentPayloadFiles(root)
  codec = new SubagentPayloadCodec(files)
})
afterEach(async () => {
  vi.restoreAllMocks()
  const resolved = path.resolve(root)
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('aether-payload-codec-'))
    throw new Error('Unsafe payload fixture cleanup')
  await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

describe('subagent storage payload codec', () => {
  it('roundtrips state while retaining every SQL authority scalar and deduplicating repeated bodies', async () => {
    const state = { status: 'running', lastSeq: 18, usage: { totalTokens: 30, unknown: false }, finishedAt: 19,
      partialOutput: '结论🙂'.repeat(800), resultSummary: '摘要'.repeat(800),
      latestActivity: { id: 'tool', name: 'read_file', status: 'succeeded', output: '资料'.repeat(800) } }
    const stored = await codec.encodeState(tenant, state), repeated = await codec.encodeState(tenant, state)
    expect(stored).toMatchObject({ status: state.status, lastSeq: state.lastSeq, usage: state.usage, finishedAt: state.finishedAt })
    expect(JSON.stringify(stored)).not.toContain(state.partialOutput)
    expect(stored[SUBAGENT_PAYLOAD_FIELDS]).toEqual(repeated[SUBAGENT_PAYLOAD_FIELDS])
    expect(await codec.decodeState(tenant, JSON.stringify(stored))).toEqual(state)
    expect(state.partialOutput).toContain('结论🙂')
  })

  it('roundtrips summary args and previews without interpreting user-owned nested marker names', async () => {
    const summary = { id: 'tool-1', name: 'custom', revisionSeq: 7, ordinal: 2, status: 'succeeded', detailRef: '/tools/1?atSeq=7',
      args: { [SUBAGENT_PAYLOAD_FIELDS]: 'user content', text: 'argument'.repeat(300) },
      output: 'output'.repeat(300), outputPreview: 'preview'.repeat(300), argsPreview: 'args'.repeat(300),
      error: { code: 'FAILED', message: 'reason'.repeat(300), retryable: false } }
    const stored = await codec.encodeSummary(tenant, summary)
    expect(stored).toMatchObject({ id: 'tool-1', name: 'custom', revisionSeq: 7, ordinal: 2, status: 'succeeded' })
    expect(await codec.decodeSummary(tenant, stored)).toEqual(summary)
    expect(await codec.decodeSummary(tenant, await codec.encodeSummary(tenant, { id: 'small', args: null }))).toEqual({ id: 'small', args: null })
  })

  it('honors a file store configured with a smaller byte limit when hydrating a valid fragment', async () => {
    const bounded = new SubagentPayloadCodec(new SubagentPayloadFiles(root, { maxPayloadBytes: 2048 }), { thresholdBytes: 16 })
    const detail = { args: 'valid'.repeat(100) }
    expect(await bounded.decodeDetail(tenant, await bounded.encodeDetail(tenant, detail))).toEqual(detail)
  })

  it('encodes only v2 event bodies and preserves identity, sequence, usage and indexed tool identity', async () => {
    const summary = { id: 'tool-2', name: 'read_file', args: { path: 'a' }, status: 'succeeded', output: '正文'.repeat(800) }
    const event = { schemaVersion: 2, kind: 'tool.completed', runId: 'run', seq: 9, baseSeq: 8,
      identity: { tenantId: tenant, childSessionId: 'child', parentSessionId: 'parent' },
      header: { status: 'running', task: 'task', partialOutput: '输出'.repeat(800) },
      headerPatch: { lastSeq: 9, usage: { totalTokens: 20 }, latestActivity: summary }, toolUpsert: summary }
    const stored = await codec.encodeEvent(tenant, event)
    expect(stored).toMatchObject({ schemaVersion: 2, seq: 9, baseSeq: 8, identity: event.identity,
      headerPatch: { usage: event.headerPatch.usage }, toolUpsert: { id: summary.id, name: summary.name, status: summary.status } })
    expect(await codec.decodeEvent(tenant, stored)).toEqual(event)
    const snapshot = { schemaVersion: 2, kind: 'snapshot', seq: 9, runId: 'run', view: { ...event.headerPatch, toolCalls: [summary] } }
    expect(await codec.decodeEvent(tenant, await codec.encodeEvent(tenant, snapshot))).toEqual(snapshot)
    const legacy = { schemaVersion: 1, kind: 'finished', snapshot: { toolCalls: [summary], partialOutput: '原文'.repeat(800) } }
    expect(await codec.encodeEvent(tenant, legacy)).toEqual(legacy)
    expect(await codec.decodeEvent(tenant, legacy)).toEqual(legacy)
  })

  it('reassembles exactly the original JSON bytes in bounded UTF-8 chunks without hydrating arguments', async () => {
    const detail = { args: { text: '参数🙂\ufeff\\\n'.repeat(1300), lone: '\ud800', nested: { end: 'END' } },
      id: 'tool', name: 'custom', status: 'succeeded', output: '输出🚀'.repeat(1700), startedAt: 10, finishedAt: 20,
      constructor: 'user metadata', toString: 'also user metadata' }
    const original = JSON.stringify(detail), encoded = await codec.encodeDetail(tenant, original)
    expect(await codec.decodeDetail(tenant, encoded)).toEqual(detail)
    vi.spyOn(files, 'read').mockImplementation(async () => { throw new Error('Detail pagination must not hydrate full fields') })
    let offset = 0, actual = ''
    for (;;) {
      const chunk = await codec.getDetailChunk(tenant, JSON.stringify(encoded), offset, 4096)
      expect(chunk.totalBytes).toBe(Buffer.byteLength(original))
      expect(Buffer.byteLength(chunk.text)).toBeLessThanOrEqual(4096)
      expect(chunk.text).not.toContain('\ufffd')
      actual += chunk.text
      if (!chunk.hasMore) break
      expect(chunk.nextOffset).toBe(offset + Buffer.byteLength(chunk.text))
      offset = chunk.nextOffset!
    }
    expect(actual).toBe(original)
    const emoji = Buffer.from(original).indexOf(Buffer.from('🙂'))
    await expect(codec.getDetailChunk(tenant, encoded, emoji + 1, 8)).rejects.toThrow('UTF-8 boundary')
    const bom = Buffer.from(original).indexOf(Buffer.from('\ufeff'))
    expect(await codec.getDetailChunk(tenant, encoded, bom, 4)).toMatchObject({ text: '\ufeff\\', nextOffset: bom + 4 })
    await expect(codec.getDetailChunk(tenant, encoded, Buffer.byteLength(original) + 1, 8)).rejects.toThrow('exceeds length')
    expect(await codec.getDetailChunk(tenant, encoded, Buffer.byteLength(original), 8)).toMatchObject({ text: '', hasMore: false })
  })

  it('retains noncanonical inline bytes and refuses to externalize them under the same detail cursor', async () => {
    const raw = '{ "output" : "\\u4e2d", "args": null }\n'
    await expect(codec.encodeDetail(tenant, raw)).rejects.toMatchObject({ code: 'NONCANONICAL_DETAIL' })
    expect(await codec.getDetailChunk(tenant, raw, 0, 4096)).toMatchObject({ text: raw, totalBytes: Buffer.byteLength(raw), hasMore: false })
  })

  it('reads only the intersecting 256 KiB blocks for small pages inside multi-MiB Unicode fields', async () => {
    const detail = { id: 'large', args: { text: '参数🙂'.repeat(220000) }, output: '结果🚀'.repeat(240000) }
    const original = Buffer.from(JSON.stringify(detail)), stored = await codec.encodeDetail(tenant, detail)
    const refs = refsOf(stored)
    expect(refs.args.bytes).toBeGreaterThan(2 * 1024 * 1024)
    expect(refs.output.bytes).toBeGreaterThan(2 * 1024 * 1024)
    for (const ref of Object.values(refs)) {
      expect(ref.chunks.length).toBeGreaterThan(8)
      expect(ref.chunks.reduce((total, chunk) => total + chunk.bytes, 0)).toBe(ref.bytes)
      for (const chunk of ref.chunks) expect(chunk.bytes).toBeLessThanOrEqual(SUBAGENT_PAYLOAD_CHUNK_BYTES)
    }
    expect(await codec.decodeDetail(tenant, stored)).toEqual(detail)
    const fullRead = vi.spyOn(files, 'read').mockImplementation(async () => { throw new Error('Small pages must not read full fields') })
    const ranges = vi.spyOn(files, 'readRange')
    const argsStart = Buffer.byteLength('{"id":"large","args":')
    const boundary = argsStart + refs.args.chunks.slice(0, 3).reduce((total, chunk) => total + chunk.bytes, 0)
    const page = async (requestedOffset: number, expectedBlocks: number) => {
      let offset = requestedOffset
      while ((original[offset] & 0xc0) === 0x80) offset++
      let end = offset + 4096
      while ((original[end] & 0xc0) === 0x80) end--
      ranges.mockClear()
      const chunk = await codec.getDetailChunk(tenant, stored, offset, 4096)
      expect(chunk).toMatchObject({ text: original.subarray(offset, end).toString('utf8'), offset,
        totalBytes: original.length, hasMore: true, nextOffset: end })
      expect(ranges).toHaveBeenCalledTimes(expectedBlocks)
      for (const [, ref, options] of ranges.mock.calls) {
        expect(refs.args.chunks).toContainEqual(ref)
        expect((ref as SubagentPayloadReference).bytes).toBeLessThanOrEqual(SUBAGENT_PAYLOAD_CHUNK_BYTES)
        expect(options!.limitBytes).toBeLessThanOrEqual(4096)
      }
    }
    await page(boundary + 300, 1)
    await page(boundary - 64, 2)
    ranges.mockClear()
    const boundaryStart = boundary - 4090
    expect(original[boundaryStart] & 0xc0).not.toBe(0x80)
    expect(await codec.getDetailChunk(tenant, stored, boundaryStart, 4090)).toMatchObject({
      text: original.subarray(boundaryStart, boundary).toString('utf8'), nextOffset: boundary,
    })
    expect(ranges).toHaveBeenCalledTimes(1)
    expect(fullRead).not.toHaveBeenCalled()
  })

  it('keeps old argument refs through SQLite completion/cancellation and clears replaced refs', async () => {
    const db = createClient({ url: 'file::memory:' })
    const original = { args: { text: 'unchanged args'.repeat(300) }, id: 'tool', name: 'custom', status: 'running', startedAt: 10 }
    let stored = JSON.stringify(await codec.encodeDetail(tenant, original))
    const merge = async (patch: Record<string, unknown>, replaceArgs = false) => {
      const { args, ...rest } = patch
      const sql = replaceArgs ? "SELECT json_set(json_patch(?,?), '$.args',json(?)) AS value" : 'SELECT json_patch(?,?) AS value'
      const result = await db.execute({ sql, args: replaceArgs ? [stored, JSON.stringify(rest), JSON.stringify(args)] : [stored, JSON.stringify(patch)] })
      stored = String(result.rows[0].value)
    }
    try {
      await merge(await codec.encodeDetailPatch(tenant, { status: 'succeeded', output: 'completed output'.repeat(300), finishedAt: 20 }))
      expect(await codec.decodeDetail(tenant, stored)).toEqual({ ...original, status: 'succeeded', output: 'completed output'.repeat(300), finishedAt: 20 })
      await merge(await codec.encodeDetailPatch(tenant, { output: 'short' }))
      expect((JSON.parse(stored)[SUBAGENT_PAYLOAD_FIELDS] as { refs: object }).refs).not.toHaveProperty('output')
      const largeArgs = { text: 'replacement🙂'.repeat(50000) }
      await merge(await codec.encodeDetailPatch(tenant, { args: largeArgs }), true)
      expect(refsOf(JSON.parse(stored)).args.chunks.length).toBeGreaterThan(1)
      expect(await codec.decodeDetail(tenant, stored)).toMatchObject({ args: largeArgs })
      await merge(await codec.encodeDetailPatch(tenant, { args: original.args }), true)
      expect(refsOf(JSON.parse(stored)).args.chunks).toHaveLength(1)
      expect(Object.keys(refsOf(JSON.parse(stored)).args).sort()).toEqual(['bytes', 'chunks', 'format', 'version'])
      expect(await codec.decodeDetail(tenant, stored)).toMatchObject({ args: original.args })
      await merge(await codec.encodeDetailPatch(tenant, { args: null }), true)
      expect(await codec.decodeDetail(tenant, stored)).toEqual({ ...original, args: null, status: 'succeeded', output: 'short', finishedAt: 20 })
      const inline = await codec.decodeDetail(tenant, stored)
      expect((await codec.getDetailChunk(tenant, stored, 0, 4096)).text).toBe(JSON.stringify(inline))
      stored = String((await db.execute({ sql: "SELECT json_set(?, '$.status','cancelled','$.finishedAt',30) AS value", args: [stored] })).rows[0].value)
      expect(await codec.decodeDetail(tenant, stored)).toMatchObject({ args: null, status: 'cancelled', output: 'short', finishedAt: 30 })
    } finally { db.close() }
  })

  it('rejects unknown envelopes, unauthorized fields, foreign tenants and missing selected fragments', async () => {
    await expect(codec.decodeState(tenant, { [SUBAGENT_PAYLOAD_FIELDS]: { version: 99 } })).rejects.toThrow('Unknown')
    await expect(codec.encodeSummary(tenant, { [SUBAGENT_PAYLOAD_FIELDS]: {} })).rejects.toThrow('forged')
    const stored = await codec.encodeDetail(tenant, { id: 'tool', args: 'A'.repeat(2000), output: 'B'.repeat(2000) })
    await expect(codec.getDetailChunk('other-tenant', stored, 0, 4)).rejects.toThrow('another tenant')
    const forged = structuredClone(stored)
    const marker = forged[SUBAGENT_PAYLOAD_FIELDS] as { refs: Record<string, unknown> }
    marker.refs.status = marker.refs.args
    forged.status = '[aether-subagent-payload]'
    await expect(codec.decodeDetail(tenant, forged)).rejects.toThrow('field reference')
    const output = refsOf(stored).output.chunks[0]
    const target = path.join(root, output.tenantHash, output.hash.slice(0, 2), `${output.hash}.gz`)
    await fs.unlink(target)
    expect(await codec.getDetailChunk(tenant, stored, 0, 4)).toMatchObject({ text: '{"id' })
    const outputOffset = Buffer.byteLength(`{"id":"tool","args":"${'A'.repeat(2000)}","output":`)
    await expect(codec.getDetailChunk(tenant, stored, outputOffset, 4)).rejects.toMatchObject({ code: 'SUBAGENT_PAYLOAD_MISSING' })
  })
})
