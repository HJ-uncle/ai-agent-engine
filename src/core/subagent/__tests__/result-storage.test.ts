import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext, Message } from '../../agent-context/types.js'
import { LocalSqliteProcessClient } from '../../../storage/sqlite/local-process-client.js'
import * as stores from '../store.js'
import { SubagentRunner } from '../runner.js'
import { getSubagentPayloadFiles } from '../payload-files.js'
import { fitResultPage, SUBAGENT_RESULT_TRUNCATION_NOTICE } from '../result.js'
import { outcomeText, type CreateSubagentRun } from '../types.js'
import { applySubagentDelta } from '../view.js'

let directory: string, databasePath: string, db: LocalSqliteProcessClient, store: stores.SubagentStore, parent: AgentContext
let projected: Message[], serial = 0
const input = (): CreateSubagentRun => ({ tenantId: 'tenant', parentSessionId: 'parent', rootSessionId: 'parent',
  parentConversationId: 'turn', parentMessageId: 'message', parentToolCallId: `call-${++serial}`,
  task: 'Inspect implementation', description: 'Inspect', modelId: 'fixture', parentToolName: 'subagent_start' })

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-result-storage-'))
  databasePath = path.join(directory, 'runs.db')
  db = new LocalSqliteProcessClient({ url: 'file:' + databasePath.replaceAll('\\', '/') })
  store = new stores.SubagentStore(db)
  vi.spyOn(stores, 'getSubagentStore').mockImplementation(() => store)
  projected = []
  parent = { tenantId: 'tenant', sessionId: 'parent', rootSessionId: 'parent', subagentEventVersion: 2,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }, history: {
      appendIfActiveToolCallAnchor: vi.fn(async (message: Message) => {
        projected.push(message); return { messageId: message.id, disposition: 'appended' }
      }),
    } } as unknown as AgentContext
})

afterEach(async () => {
  vi.restoreAllMocks()
  await db.closeWithReceipt()
  const target = path.resolve(directory)
  if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('aether-result-storage-')) throw new Error('Unsafe cleanup')
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

describe('immutable complete child results and bounded ownership-scoped reads', () => {
  it('keeps the final answer on disk, carries explicit preview integrity through SQLite, deltas and parent projection, and survives restart', async () => {
    const final = '\ufeff最终结论🙂证据\n'.repeat(900) + 'UNIQUE_COMPLETE_RESULT_TAIL'
    const commentary = 'PROCESS_ONLY: investigating\n'
    const events: Parameters<NonNullable<AgentContext['emitSubagentEvent']>>[0][] = []
    parent.emitSubagentEvent = event => { events.push(event) }
    const run = await new SubagentRunner(store).run(input(), parent, async ({ observer }) => {
      await observer.onOutput?.(commentary)
      await observer.onOutcome({ status: 'succeeded', output: commentary + final, finalOutput: final })
    })
    expect(run).toMatchObject({ status: 'succeeded', resultBytes: Buffer.byteLength(final), resultTruncated: true, resultKind: 'final',
      resultHash: createHash('sha256').update(final).digest('hex') })
    expect(run.resultSummary).not.toContain('PROCESS_ONLY')
    expect(run.resultSummary).toContain(SUBAGENT_RESULT_TRUNCATION_NOTICE)
    expect(Buffer.byteLength(run.resultSummary!)).toBeLessThanOrEqual(8192)
    expect(run.resultSummary).not.toContain('UNIQUE_COMPLETE_RESULT_TAIL')
    expect(projected).toHaveLength(1)
    expect(projected[0]).toMatchObject({ id: `subagent-result:${run.runId}`, role: 'assistant', metadata: { subagent: {
      resultRef: run.resultRef, resultBytes: run.resultBytes, resultHash: run.resultHash, resultTruncated: true } } })
    expect(projected[0].content).toContain('subagent_read_result')
    expect(projected[0].content).toContain('汇总或验收本次结果前必须补读全文')
    expect(projected[0].content).toContain(`"totalBytes":${run.resultBytes}`)
    expect(projected[0].content).not.toContain('UNIQUE_COMPLETE_RESULT_TAIL')
    const raw = await db.execute({ sql: 'SELECT snapshot FROM subagent_runs WHERE tenant_id=? AND run_id=?', args: ['tenant', run.runId] })
    expect(String(raw.rows[0].snapshot)).not.toContain('UNIQUE_COMPLETE_RESULT_TAIL')
    expect(Buffer.byteLength(String(raw.rows[0].snapshot))).toBeLessThan(20 * 1024)
    let view
    for (const event of events) {
      if (event.schemaVersion !== 2 || event.kind === 'snapshot') continue
      const reduced = applySubagentDelta(view, event)
      expect(reduced.status).toBe('applied'); view = reduced.view
    }
    expect(view).toMatchObject({ resultRef: run.resultRef, resultHash: run.resultHash, resultBytes: run.resultBytes, resultTruncated: true })

    await db.closeWithReceipt()
    db = new LocalSqliteProcessClient({ url: 'file:' + databasePath.replaceAll('\\', '/') })
    store = new stores.SubagentStore(db)
    expect(await store.getRunView('tenant', run.runId)).toMatchObject({ resultRef: run.resultRef, resultBytes: run.resultBytes })
    const files = await getSubagentPayloadFiles(db), read = vi.spyOn(files, 'read'), range = vi.spyOn(files, 'readRange')
    let offset = 0, restored = '', pages = 0
    while (true) {
      const page = (await store.getResultPage('tenant', 'parent', run.runId, { offset, limitBytes: 1031 }))!
      expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(1031)
      expect(page.text).not.toContain('\ufffd')
      expect(page.resultHash).toBe(run.resultHash)
      restored += page.text; pages++
      if (!page.hasMore) { expect(page.nextOffset).toBeUndefined(); break }
      expect(page.nextOffset).toBe(offset + Buffer.byteLength(page.text)); offset = page.nextOffset!
    }
    expect(pages).toBeGreaterThan(1); expect(restored).toBe(final)
    expect(read).not.toHaveBeenCalled(); expect(range).toHaveBeenCalledTimes(pages)
  })

  it('rejects foreign tenants/parents, invalid UTF-8 offsets and mutated evidence without falling back to a preview', async () => {
    const body = '🙂你好\ufefftail'.repeat(500)
    const run = await new SubagentRunner(store).run(input(), parent, async ({ observer }) => { await observer.onOutcome({ status: 'succeeded', finalOutput: body }) })
    const files = await getSubagentPayloadFiles(db), read = vi.spyOn(files, 'readRange')
    expect(await store.getResultPage('foreign', 'parent', run.runId)).toBeNull()
    expect(await store.getResultPage('tenant', 'foreign', run.runId)).toBeNull()
    expect(await store.getResultPage('tenant', 'parent', run.runId, { rootSessionId: 'foreign' })).toBeNull()
    expect(read).not.toHaveBeenCalled()
    await expect(store.getResultPage('tenant', '', run.runId)).rejects.toThrow('parentSessionId')
    await expect(store.getResultPage('tenant', 'parent', run.runId, { offset: 1, limitBytes: 4 })).rejects.toThrow('UTF-8 boundary')
    await expect(store.getResultPage('tenant', 'parent', run.runId, { offset: run.resultBytes! + 1 })).rejects.toThrow('exceeds')
    await expect(store.appendHeader('tenant', run.runId, 'output.updated', { resultRef: run.resultRef, resultHash: run.resultHash,
      resultBytes: run.resultBytes, resultTruncated: false, resultKind: 'final' })).rejects.toThrow('immutable')
    const hash = createHash('sha256').update('tenant').digest('hex')
    fs.writeFileSync(path.join(files.root, hash, run.resultHash!.slice(0, 2), run.resultHash! + '.gz'), 'corrupt')
    await expect(store.getResultPage('tenant', 'parent', run.runId)).rejects.toMatchObject({ code: 'SUBAGENT_PAYLOAD_CORRUPT' })
  })

  it('archives failed partial evidence without claiming a final success; legacy previews have no fake complete reference', async () => {
    const partial = '未完成的证据🙂'.repeat(1500)
    const run = await new SubagentRunner(store).run(input(), parent, async ({ observer }) => {
      await observer.onOutcome({ status: 'failed', partialOutput: partial, stopReason: 'test_failure' })
    })
    expect(run).toMatchObject({ status: 'failed', resultKind: 'partial', resultTruncated: true })
    expect(outcomeText(run)).toContain('"status":"failed"')
    expect(run.resultSummary).toBeUndefined()
    expect((await store.getResultPage('tenant', 'parent', run.runId))?.resultKind).toBe('partial')
    const legacy = await store.createRunDelta(input())
    await store.appendHeader('tenant', legacy.header.runId, 'finished', { status: 'succeeded', resultSummary: 'Historical preview' })
    await expect(store.getResultPage('tenant', 'parent', legacy.header.runId)).rejects.toThrow('SUBAGENT_RESULT_UNAVAILABLE')
    expect(outcomeText((await store.getRunView('tenant', legacy.header.runId))!)).toContain('不保证完整')
  })

  it('never commits a success or result reference when the immutable result file cannot be published', async () => {
    await store.initialize()
    vi.spyOn(await getSubagentPayloadFiles(db), 'put').mockRejectedValue(new Error('fixture disk unavailable'))
    const value = input()
    const run = await new SubagentRunner(store).run(value, parent, async ({ observer }) => {
      await observer.onOutcome({ status: 'succeeded', finalOutput: 'Evidence' })
    })
    expect(run).toMatchObject({ status: 'failed', error: { code: 'RESULT_PERSIST_FAILED' } })
    const header = await store.findHeaderByParentTool('tenant', 'parent', value.parentToolCallId)
    expect(header?.status).toBe('failed'); expect(header?.resultRef).toBeUndefined(); expect(projected).toHaveLength(1)
  })

  it('keeps cancellation authoritative when it wins during full-result publication', async () => {
    const value = input(), original = store.prepareResult.bind(store)
    vi.spyOn(store, 'prepareResult').mockImplementation(async (...args) => {
      const prepared = await original(...args)
      const run = (await store.findHeaderByParentTool('tenant', 'parent', value.parentToolCallId))!
      await store.appendHeader('tenant', run.runId, 'cancelling', { status: 'cancelling', stopReason: 'user_cancelled' })
      return prepared
    })
    const run = await new SubagentRunner(store).run(value, parent, async ({ observer }) => {
      await observer.onOutcome({ status: 'succeeded', finalOutput: 'Completed candidate answer' })
    })
    expect(run).toMatchObject({ status: 'cancelled', stopReason: 'user_cancelled', resultKind: 'partial' })
    expect(run.resultSummary).toBeUndefined()
    expect((await store.getResultPage('tenant', 'parent', run.runId))?.text).toBe('Completed candidate answer')
    expect(projected[0].content).toContain('"status":"cancelled"')
    expect(projected[0].content).toContain('"kind":"partial"')
  })

  it('preserves a finalOutput-only candidate when cancellation wins before the terminal latest-state read', async () => {
    const runner = new SubagentRunner(store), body = 'Completed candidate answer 🙂'
    const run = await runner.run(input(), parent, async ({ observer, snapshot }) => {
      await observer.onOutcome({ status: 'succeeded', finalOutput: body })
      await runner.cancel('tenant', snapshot.runId, 'user_cancelled')
    })
    expect(run).toMatchObject({ status: 'cancelled', stopReason: 'user_cancelled', resultKind: 'partial', resultBytes: Buffer.byteLength(body) })
    expect(run.resultSummary).toBeUndefined()
    expect((await store.getResultPage('tenant', 'parent', run.runId))?.text).toBe(body)
  })

  it('preserves valid paged JSON and progress under Work budgets even with heavily escaped text', () => {
    const text = '\u0000\n"\\🙂'.repeat(3000), totalBytes = Buffer.byteLength(text)
    const original = { runId: 'run', resultRef: 'subagent-result:v1:' + 'a'.repeat(64), resultHash: 'a'.repeat(64), resultKind: 'final' as const,
      encoding: 'utf8' as const, offset: 0, totalBytes, hasMore: false, text }
    let offset = 0, restored = ''
    while (offset < totalBytes) {
      const page = fitResultPage({ ...original, offset, text: Buffer.from(text).subarray(offset).toString('utf8') }, 4000)
      const wire = JSON.stringify(page)
      expect(wire.length).toBeLessThanOrEqual(4000); expect(JSON.parse(wire)).toEqual(page)
      expect(wire.indexOf('"nextOffset"')).toBeLessThan(wire.indexOf('"text"'))
      expect(page.text).not.toContain('\ufffd'); restored += page.text
      if (!page.hasMore) break
      expect(page.nextOffset).toBeGreaterThan(offset); offset = page.nextOffset!
    }
    expect(restored).toBe(text)
  })
})
