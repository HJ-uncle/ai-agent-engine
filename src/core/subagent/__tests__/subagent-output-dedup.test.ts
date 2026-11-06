import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalSqliteProcessClient } from '../../../storage/sqlite/local-process-client.js'
import { SubagentStore } from '../store.js'
import type { CreateSubagentRun, SubagentMutation } from '../types.js'

const tenantId = 'output-dedup-tenant', runId = 'output-dedup-run'
const input: CreateSubagentRun = { tenantId, runId, childSessionId: 'child', rootSessionId: 'root', parentSessionId: 'parent',
  parentConversationId: 'turn', parentMessageId: 'message', parentToolCallId: 'parent-tool', task: 'Synthetic output test',
  description: 'Output deduplication fixture', modelId: 'fixture-no-model' }
let fixture: string, database: string, db: LocalSqliteProcessClient, store: SubagentStore
const clients = new Set<LocalSqliteProcessClient>()
const connect = () => {
  const client = new LocalSqliteProcessClient({ url: 'file:' + database.replaceAll('\\', '/') })
  clients.add(client); return client
}
const required = <T>(value: T | null): T => { if (value === null) throw new Error('Expected a state transition'); return value }
const output = (text: string) => store.appendHeader(tenantId, runId, 'output.updated', { partialOutput: text }, { allowedStatuses: ['running', 'cancelling'] })
const snapshot = async () => ({
  run: (await db.execute({ sql: 'SELECT seq,updated_at,snapshot FROM subagent_runs WHERE tenant_id=? AND run_id=?', args: [tenantId, runId] })).rows,
  events: (await db.execute({ sql: 'SELECT seq,kind,event FROM subagent_events WHERE tenant_id=? AND run_id=? ORDER BY seq', args: [tenantId, runId] })).rows,
  checkpoints: (await db.execute({ sql: 'SELECT seq,header FROM subagent_checkpoints WHERE tenant_id=? AND run_id=? ORDER BY seq', args: [tenantId, runId] })).rows,
})

beforeEach(async () => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-output-dedup-'))
  database = path.join(fixture, 'agent.db'); db = connect(); store = new SubagentStore(db)
  await store.createRunDelta(input)
  await store.appendHeader(tenantId, runId, 'started', { status: 'running', startedAt: Date.now() })
})
afterEach(async () => {
  vi.restoreAllMocks()
  for (const client of clients) { client.close(); await client.whenClosed() }
  clients.clear()
  if (path.dirname(fixture) !== path.resolve(os.tmpdir()) || !path.basename(fixture).startsWith('aether-output-dedup-')) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

describe('Subagent output no-op persistence', () => {
  it('keeps the exact published version and timestamp when only the same output is reported again', async () => {
    const first = required(await output('already published')), before = await snapshot()
    const view = await store.getRunView(tenantId, runId, { atSeq: first.header.lastSeq })
    vi.spyOn(Date, 'now').mockReturnValue(first.header.updatedAt + 60 * 60_000)
    expect(await output('already published')).toBeNull()
    expect(await snapshot()).toEqual(before)
    expect(await store.getRunView(tenantId, runId, { atSeq: first.header.lastSeq })).toEqual(view)
    expect((await store.getRunHeader(tenantId, runId))?.updatedAt).toBe(first.header.updatedAt)
  })

  it('does not multiply events/checkpoints when cumulative output changes only beyond the UTF-8 preview bound', async () => {
    const prefix = '界'.repeat(3000), first = required(await output(prefix + ' first suffix'))
    expect(Buffer.byteLength(first.header.partialOutput!)).toBe(8190)
    const before = await snapshot()
    for (let i = 0; i < 25; i++) expect(await output(prefix + ' next suffix ' + i)).toBeNull()
    expect(await snapshot()).toEqual(before)
  })

  it('retains genuinely changed output as a new exact version and contiguous event', async () => {
    const first = required(await output('first output')), next = required(await output('second output'))
    expect(next.header.lastSeq).toBe(first.header.lastSeq + 1)
    expect(next.event).toMatchObject({ schemaVersion: 2, kind: 'output.updated', seq: next.header.lastSeq, baseSeq: first.header.lastSeq })
    expect((await store.getRunView(tenantId, runId, { atSeq: first.header.lastSeq }))?.partialOutput).toBe('first output')
    expect((await store.getRunView(tenantId, runId, { atSeq: next.header.lastSeq }))?.partialOutput).toBe('second output')
    const events = await store.listEventsPage(tenantId, runId, { afterSeq: first.header.lastSeq })
    expect(events).toMatchObject({ checkpointRequired: false, nextSeq: next.header.lastSeq })
    expect(events?.events).toHaveLength(1)
  })

  it('compares inside the transaction across concurrent datasource connections', async () => {
    const other = new SubagentStore(connect()); await other.initialize()
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? store : other)
      .appendHeader(tenantId, runId, 'output.updated', { partialOutput: 'one durable prefix' }, { allowedStatuses: ['running'] })))
    expect(results.filter(Boolean)).toHaveLength(1)
    const saved = await snapshot()
    expect(saved.events.filter(row => row.kind === 'output.updated')).toHaveLength(1)
    expect(saved.checkpoints).toHaveLength(3)
  })

  it('uses persisted state after closing and reopening the database', async () => {
    const first = required(await output('durable prefix')), before = await snapshot()
    db.close(); await db.whenClosed(); clients.delete(db)
    db = connect(); store = new SubagentStore(db)
    expect(await output('durable prefix')).toBeNull()
    expect(await snapshot()).toEqual(before)
    const changed = required(await output('changed after restart'))
    expect(changed.header.lastSeq).toBe(first.header.lastSeq + 1)
    expect((await store.getRunView(tenantId, runId, { atSeq: first.header.lastSeq }))?.partialOutput).toBe('durable prefix')
  })

  it('does not suppress usage, tool, status or terminal events with the same output', async () => {
    let prior = required(await output('same prefix'))
    const assertAdvance = (next: SubagentMutation | null) => { const value = required(next); expect(value.header.lastSeq).toBe(prior.header.lastSeq + 1); prior = value }
    assertAdvance(await store.appendHeader(tenantId, runId, 'usage.updated', { modelId: input.modelId }))
    assertAdvance(await store.upsertTool(tenantId, runId, 'tool.started', { id: 'tool', name: 'read_file', status: 'running', args: { path: 'fixture' } }))
    assertAdvance(await store.upsertTool(tenantId, runId, 'tool.completed', { id: 'tool', name: 'read_file', status: 'succeeded', output: 'same prefix' }))
    assertAdvance(await store.appendHeader(tenantId, runId, 'cancelling', { status: 'cancelling' }))
    expect(await output('same prefix')).toBeNull()
    assertAdvance(await store.appendHeader(tenantId, runId, 'finished', { status: 'cancelled', partialOutput: 'same prefix', finishedAt: Date.now() }))
    expect((await store.getRunHeader(tenantId, runId))?.status).toBe('cancelled')
    expect((await db.execute({ sql: 'SELECT count(*) AS count FROM subagent_outbox WHERE tenant_id=? AND run_id=?', args: [tenantId, runId] })).rows[0].count).toBe(1)
  })

  it('does not drop other fields or requested tool cancellation on an output.updated call', async () => {
    const first = required(await output('same prefix'))
    const withState = required(await store.appendHeader(tenantId, runId, 'output.updated', { partialOutput: 'same prefix', modelId: 'new-model' }))
    expect(withState.header).toMatchObject({ modelId: 'new-model', lastSeq: first.header.lastSeq + 1 })
    await store.upsertTool(tenantId, runId, 'tool.started', { id: 'active-tool', name: 'read_file', status: 'running', args: null })
    const cancelled = required(await store.appendHeader(tenantId, runId, 'output.updated', { partialOutput: 'same prefix' }, { cancelActiveTools: true }))
    expect(cancelled.view.activeToolCount).toBe(0)
    expect(cancelled.view.toolCalls[0].status).toBe('cancelled')
  })

  it('still applies allowed status checks and distinguishes an absent preview from the first empty preview', async () => {
    const first = required(await output(''))
    expect(first.header.partialOutput).toBe('')
    expect(await output('')).toBeNull()
    await store.appendHeader(tenantId, runId, 'finished', { status: 'succeeded', resultSummary: 'done', finishedAt: Date.now() })
    const before = await snapshot()
    expect(await output('late output')).toBeNull()
    expect(await snapshot()).toEqual(before)
  })
})
