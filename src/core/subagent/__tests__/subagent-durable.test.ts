// Production SQLite mutations: 4100/10000 tools, linear UTF-8 storage, exact recovery and rollback.
// Fixtures never call getDb(), start the runtime, or use an operator database.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Client, Transaction } from '@libsql/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SubagentStore } from '../store.js'
import { LocalSqliteProcessClient } from '../../../storage/sqlite/local-process-client.js'
import type { CreateSubagentRun, SubagentMutation, SubagentRunView, SubagentToolSummary } from '../types.js'
import { SUBAGENT_VIEW_MAX_ACTIVE_TOOLS, SUBAGENT_VIEW_MAX_BYTES, SUBAGENT_VIEW_MAX_TOOLS } from '../view.js'

const tenant = 'durable-tenant'
const startedAt = 1_800_000_000_000
let db: Client
let store: SubagentStore
let fixtureDir: string
let databasePath: string
let profile: ReturnType<typeof emptyProfile>
let lastHistoricalSql: string | undefined
function emptyProfile() {
  return { sqlCalls: 0, sqlArgumentBytes: 0, transactionsOpened: 0, transactionCloseCalls: 0,
    outstandingTransactions: 0, peakOutstandingTransactions: 0, serializationCalls: 0, serializedBytes: 0,
    maxSerializedTools: 0, memorySamples: 0, peakRss: 0, peakHeapUsed: 0 }
}
function observeQueries(query: Client | Transaction): void {
  query.execute = new Proxy(query.execute, { apply(target, receiver, parameters) {
    profile.sqlCalls++
    const statement: unknown = parameters[0]
    if (statement !== null && typeof statement === 'object' && 'sql' in statement && typeof statement.sql === 'string'
      && statement.sql.includes(' AS expected_seq FROM subagent_tool_versions')) lastHistoricalSql = statement.sql
    if (statement !== null && typeof statement === 'object' && 'args' in statement) {
      const values = Array.isArray(statement.args) ? statement.args : Object.values(statement.args ?? {})
      for (const value of values) if (typeof value === 'string') profile.sqlArgumentBytes += Buffer.byteLength(value)
    }
    return Reflect.apply(target, receiver, parameters)
  } })
}
function observedClient(): Client {
  // Use the same driver as getDb(); direct native libsql in the Vitest host is a separate compatibility probe.
  const client: Client = new LocalSqliteProcessClient({ url: `file:${databasePath.replace(/\\/g, '/')}` })
  observeQueries(client)
  client.transaction = new Proxy(client.transaction, { async apply(target, receiver, parameters) {
    const transaction: Transaction = await Reflect.apply(target, receiver, parameters)
    profile.transactionsOpened++
    profile.outstandingTransactions++
    profile.peakOutstandingTransactions = Math.max(profile.peakOutstandingTransactions, profile.outstandingTransactions)
    observeQueries(transaction)
    let closed = false
    transaction.close = new Proxy(transaction.close, { apply(close, owner, arguments_) {
      profile.transactionCloseCalls++
      if (!closed) { closed = true; profile.outstandingTransactions-- }
      return Reflect.apply(close, owner, arguments_)
    } })
    return transaction
  } })
  return client
}
function observeSerialization(): () => void {
  const original = JSON.stringify
  JSON.stringify = new Proxy(original, { apply(target, receiver, parameters) {
    const encoded: unknown = Reflect.apply(target, receiver, parameters)
    profile.serializationCalls++
    if (typeof encoded === 'string') profile.serializedBytes += Buffer.byteLength(encoded)
    const value: unknown = parameters[0]
    if (value !== null && typeof value === 'object' && 'toolCalls' in value && Array.isArray(value.toolCalls))
      profile.maxSerializedTools = Math.max(profile.maxSerializedTools, value.toolCalls.length)
    return encoded
  } })
  return () => { JSON.stringify = original }
}
function sampleMemory(): void {
  const memory = process.memoryUsage()
  profile.memorySamples++
  profile.peakRss = Math.max(profile.peakRss, memory.rss)
  profile.peakHeapUsed = Math.max(profile.peakHeapUsed, memory.heapUsed)
}
function writeEvidence(value: Record<string, unknown>): void {
  fs.appendFileSync(path.join(fixtureDir, 'durability-evidence.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n')
}
async function traceStage(stage: string): Promise<void> {
  sampleMemory()
  writeEvidence({ stage, ...profile })
  console.info('SUBAGENT_DURABLE_STAGE ' + JSON.stringify({ stage, ...profile }))
  await new Promise<void>(resolve => setImmediate(resolve))
}

function required<T>(value: T | null): T {
  if (value === null) throw new Error('Expected a production mutation or page, received null')
  return value
}
function runInput(runId: string, extra: Partial<CreateSubagentRun> = {}): CreateSubagentRun {
  return { tenantId: tenant, runId, childSessionId: `child-${runId}`, rootSessionId: 'durable-root',
    parentSessionId: 'durable-parent', parentConversationId: 'durable-turn', parentMessageId: 'durable-message',
    parentToolCallId: `parent-${runId}`, task: 'Synthetic durability fixture only', description: 'Durability regression',
    modelId: 'synthetic-no-model', ...extra }
}
async function running(runId: string, extra: Partial<CreateSubagentRun> = {}): Promise<SubagentMutation> {
  await store.createRunDelta(runInput(runId, extra))
  return required(await store.appendHeader(tenant, runId, 'started', { status: 'running', startedAt }))
}
async function startTool(runId: string, id: string, args: unknown = { fixture: id }): Promise<SubagentMutation> {
  return required(await store.upsertTool(tenant, runId, 'tool.started', { id, name: 'read_file', args, status: 'running', startedAt }))
}
async function finishTool(runId: string, id: string, output = `output-${id}`): Promise<SubagentMutation> {
  return required(await store.upsertTool(tenant, runId, 'tool.completed', { id, name: 'read_file', status: 'succeeded', output,
    finishedAt: startedAt + 1, durationMs: 1 }))
}
async function countRows(table: string, runId: string): Promise<number> {
  if (!/^subagent_(runs|records|events|checkpoints|tools|tool_versions|usage_invocations|outbox)$/.test(table)) throw new Error('Unknown fixture table')
  const result = await db.execute({ sql: `SELECT count(*) AS count FROM ${table} WHERE tenant_id=? AND run_id=?`, args: [tenant, runId] })
  return Number(result.rows[0].count)
}
async function reopen(): Promise<void> {
  db.close()
  if (db instanceof LocalSqliteProcessClient) await db.whenClosed()
  db = observedClient()
  store = new SubagentStore(db)
}
async function allTools(runId: string, atSeq: number): Promise<SubagentToolSummary[]> {
  const result: SubagentToolSummary[] = []
  let cursor: string | undefined
  do {
    const page = required(await store.listToolsPage(tenant, runId, { atSeq, cursor, limit: 200 }))
    expect(page.asOfSeq).toBe(atSeq)
    expect(Buffer.byteLength(JSON.stringify(page.items))).toBeLessThanOrEqual(512 * 1024)
    result.push(...page.items)
    cursor = page.nextCursor
    if (!page.hasMore) expect(cursor).toBeUndefined()
    else if (!cursor) throw new Error('Nonterminal production page did not return a cursor')
  } while (cursor)
  return result
}
function assertBounded(view: SubagentRunView): void {
  expect(view.toolCalls.length).toBeLessThanOrEqual(SUBAGENT_VIEW_MAX_TOOLS)
  expect(view.coverage.includedToolCount).toBe(view.toolCalls.length)
  expect(view.coverage.includedActiveToolCount).toBe(view.toolCalls.filter(tool => tool.status === 'running').length)
  expect(view.coverage.includedActiveToolCount).toBeLessThanOrEqual(SUBAGENT_VIEW_MAX_ACTIVE_TOOLS)
  expect(view.coverage.asOfSeq).toBe(view.lastSeq)
  expect(Buffer.byteLength(JSON.stringify(view))).toBeLessThanOrEqual(SUBAGENT_VIEW_MAX_BYTES)
}

beforeEach(() => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-subagent-durable-'))
  databasePath = path.join(fixtureDir, 'fixture.db')
  profile = emptyProfile()
  lastHistoricalSql = undefined
  db = observedClient()
  store = new SubagentStore(db)
})
afterEach(async () => {
  db.close()
  if (db instanceof LocalSqliteProcessClient) await db.whenClosed()
  const resolved = path.resolve(fixtureDir)
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('aether-subagent-durable-')) throw new Error('Unsafe fixture cleanup path')
  if (process.env.AETHER_SUBAGENT_DURABLE_KEEP_FIXTURE === '1') {
    console.info('SUBAGENT_DURABLE_RETAINED ' + resolved)
    return
  }
  try { fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 2, retryDelay: 20 }) }
  catch (error) {
    // Detached libsql native handles may outlive db.close() until the worker exits on Windows.
    if (process.platform !== 'win32' || !(error instanceof Error) || !('code' in error) || error.code !== 'EPERM') throw error
  }
})

interface BytesLedger {
  toolCount: number; seq: number; eventRows: number; eventBytes: number; maxEventBytes: number
  checkpointRows: number; checkpointBytes: number; maxCheckpointBytes: number
  versionRows: number; detailBytes: number; summaryBytes: number; recordRows: number; recordBytes: number
  snapshotBytes: number; databaseBytes: number; elapsedMs: number
}
async function ledger(runId: string, toolCount: number, seq: number, begin: number): Promise<BytesLedger> {
  const args = [tenant, runId]
  const [events, checkpoints, versions, records, snapshot] = await Promise.all([
    db.execute({ sql: 'SELECT count(*) AS rows,coalesce(sum(length(CAST(event AS BLOB))),0) AS bytes,coalesce(max(length(CAST(event AS BLOB))),0) AS max_bytes FROM subagent_events WHERE tenant_id=? AND run_id=?', args }),
    db.execute({ sql: 'SELECT count(*) AS rows,coalesce(sum(length(CAST(header AS BLOB))),0) AS bytes,coalesce(max(length(CAST(header AS BLOB))),0) AS max_bytes FROM subagent_checkpoints WHERE tenant_id=? AND run_id=?', args }),
    db.execute({ sql: 'SELECT count(*) AS rows,coalesce(sum(length(CAST(detail AS BLOB))),0) AS detail_bytes,coalesce(sum(length(CAST(summary AS BLOB))),0) AS summary_bytes FROM subagent_tool_versions WHERE tenant_id=? AND run_id=?', args }),
    db.execute({ sql: 'SELECT count(*) AS rows,coalesce(sum(length(CAST(record AS BLOB))),0) AS bytes FROM subagent_records WHERE tenant_id=? AND run_id=?', args }),
    db.execute({ sql: 'SELECT length(CAST(snapshot AS BLOB)) AS bytes FROM subagent_runs WHERE tenant_id=? AND run_id=?', args }),
  ])
  const result: BytesLedger = { toolCount, seq, eventRows: Number(events.rows[0].rows), eventBytes: Number(events.rows[0].bytes), maxEventBytes: Number(events.rows[0].max_bytes),
    checkpointRows: Number(checkpoints.rows[0].rows), checkpointBytes: Number(checkpoints.rows[0].bytes), maxCheckpointBytes: Number(checkpoints.rows[0].max_bytes),
    versionRows: Number(versions.rows[0].rows), detailBytes: Number(versions.rows[0].detail_bytes), summaryBytes: Number(versions.rows[0].summary_bytes),
    recordRows: Number(records.rows[0].rows), recordBytes: Number(records.rows[0].bytes), snapshotBytes: Number(snapshot.rows[0].bytes),
    databaseBytes: fs.readdirSync(fixtureDir).reduce((sum, file) => sum + fs.statSync(path.join(fixtureDir, file)).size, 0), elapsedMs: Date.now() - begin }
  sampleMemory()
  writeEvidence({ ...result, ...profile })
  console.info('SUBAGENT_DURABLE_BYTES ' + JSON.stringify({ ...result, ...profile }))
  return result
}

describe('Production subagent delta durability', () => {
  it('writes 10000 tools through the real store with bounded activity and linear persisted bytes, including watermark 4100', async () => {
    const runId = 'ten-thousand'
    const privatePrompt = 'SERVER_PRIVATE_DURABLE_PERMISSION_'.repeat(256)
    const begin = Date.now()
    await traceStage('before-create')
    let mutation = await running(runId, { continuation: { readOnly: true, role: 'synthetic', systemPrompt: privatePrompt,
      toolNames: ['PRIVATE_TOOL_SENTINEL'], workspacePaths: ['PRIVATE_WORKSPACE_SENTINEL'] } })
    const checkpoints: BytesLedger[] = [await ledger(runId, 0, mutation.view.lastSeq, begin)]
    const milestones = new Set([1000, 2000, 4100, 8000, 10000])
    let maxResidentTools = 0
    let maxResidentActive = 0
    let seqAt4100 = 0
    const restoreSerialization = observeSerialization()
    try {
    for (let index = 1; index <= 10000; index++) {
      const suffix = String(index).padStart(5, '0'), id = `tool-${suffix}`
      mutation = await startTool(runId, id, { text: '参数'.repeat(80) + `ARG_SENTINEL_${suffix}`, index: suffix })
      maxResidentTools = Math.max(maxResidentTools, mutation.view.toolCalls.length)
      maxResidentActive = Math.max(maxResidentActive, mutation.view.coverage.includedActiveToolCount)
      if (index !== 1) {
        mutation = await finishTool(runId, id, '结果'.repeat(36) + `OUTPUT_SENTINEL_${suffix}`)
        maxResidentTools = Math.max(maxResidentTools, mutation.view.toolCalls.length)
      }
      if (index % 250 === 0) mutation = required(await store.recordUsageDelta(tenant, runId,
        { invocationId: `invocation-${suffix}`, promptTokens: 3, completionTokens: 2, cacheHitTokens: 1 }))
      if (milestones.has(index)) {
        assertBounded(mutation.view)
        expect(mutation.view.toolCount).toBe(index)
        expect(mutation.view.activeToolCount).toBe(1)
        expect(mutation.view.toolCalls.some(tool => tool.id === 'tool-00001' && tool.status === 'running')).toBe(true)
        expect(mutation.view.latestActivity?.id).toBe(id)
        expect(mutation.view.coverage.hasMore).toBe(true)
        expect(mutation.view.coverage.truncated).toBe(true)
        expect(mutation.view.usage.totalTokens).toBe(Math.floor(index / 250) * 5)
        expect(JSON.stringify(mutation.event)).not.toContain('OUTPUT_SENTINEL_00002')
        if (index === 4100) seqAt4100 = mutation.view.lastSeq
        const measured = await ledger(runId, index, mutation.view.lastSeq, begin)
        expect(measured.eventRows).toBe(2 * index + 1 + Math.floor(index / 250))
        expect(measured.checkpointRows).toBe(measured.eventRows)
        expect(measured.versionRows).toBe(2 * index - 1)
        expect(measured.maxEventBytes).toBeLessThan(12 * 1024)
        expect(measured.maxCheckpointBytes).toBeLessThan(4 * 1024)
        expect(measured.snapshotBytes).toBeLessThan(4 * 1024)
        expect(measured.recordRows).toBe(1)
        expect(measured.recordBytes).toBe(checkpoints[0].recordBytes)
        checkpoints.push(measured)
      } else if (index % 1000 === 0) console.info(`SUBAGENT_DURABLE_PROGRESS ${index}/10000 elapsedMs=${Date.now() - begin}`)
      // Real tools await I/O. Yielding keeps this synthetic loop from starving native handle cleanup and the worker's output bridge.
      if (index % 50 === 0) {
        sampleMemory()
        if (index % 250 === 0) writeEvidence({ toolCount: index, seq: mutation.view.lastSeq, elapsedMs: Date.now() - begin, ...profile })
        await new Promise<void>(resolve => setImmediate(resolve))
      }
    }
    } finally { restoreSerialization() }
    expect(maxResidentTools).toBeLessThanOrEqual(64)
    expect(maxResidentActive).toBeLessThanOrEqual(32)
    expect(profile.maxSerializedTools).toBeLessThanOrEqual(64)
    expect(profile.transactionsOpened).toBe(profile.transactionCloseCalls)
    expect(profile.outstandingTransactions).toBe(0)
    expect(profile.peakOutstandingTransactions).toBe(1)
    for (const field of ['eventBytes', 'checkpointBytes', 'detailBytes', 'summaryBytes'] as const) {
      const marginalBytes = checkpoints.slice(1).map((value, index) => (value[field] - checkpoints[index][field]) / (value.toolCount - checkpoints[index].toolCount))
      // A full history copied on every mutation makes the late segments many times larger.
      expect(Math.max(...marginalBytes) / Math.min(...marginalBytes)).toBeLessThan(1.12)
    }
    const forbidden = await db.execute({ sql: `SELECT
      (SELECT count(*) FROM subagent_events WHERE tenant_id=? AND run_id=? AND (json_type(event,'$.snapshot') IS NOT NULL OR json_type(event,'$.headerPatch.toolCalls') IS NOT NULL OR instr(event,'SERVER_PRIVATE_DURABLE_PERMISSION_')>0 OR instr(event,'PRIVATE_TOOL_SENTINEL')>0 OR instr(event,'PRIVATE_WORKSPACE_SENTINEL')>0 OR instr(event,'ARG_SENTINEL_00001')>0)) AS events,
      (SELECT count(*) FROM subagent_checkpoints WHERE tenant_id=? AND run_id=? AND (json_type(header,'$.toolCalls') IS NOT NULL OR instr(header,'SERVER_PRIVATE_DURABLE_PERMISSION_')>0)) AS checkpoints`, args: [tenant, runId, tenant, runId] })
    expect(Number(forbidden.rows[0].events)).toBe(0)
    expect(Number(forbidden.rows[0].checkpoints)).toBe(0)
    await traceStage('before-last-completion')
    const oldFinished = await finishTool(runId, 'tool-00001', 'OLD_ORDINAL_FINISHED_LAST')
    expect(oldFinished.view.latestActivity).toMatchObject({ id: 'tool-00001', ordinal: 1, status: 'succeeded' })
    expect(oldFinished.view.activeToolCount).toBe(0)
    expect(oldFinished.view.toolCalls.some(tool => tool.id === 'tool-00001' && tool.output === 'OLD_ORDINAL_FINISHED_LAST')).toBe(true)
    await traceStage('before-terminal')
    await store.appendHeader(tenant, runId, 'finished', { status: 'succeeded', finishedAt: startedAt + 2, resultSummary: 'Synthetic fixture completed' })
    await traceStage('before-close-reopen')
    await reopen()
    await traceStage('after-close-reopen')
    const recovered = required(await store.getRunView(tenant, runId))
    assertBounded(recovered)
    expect(recovered).toMatchObject({ status: 'succeeded', toolCount: 10000, activeToolCount: 0, usage: { totalTokens: 200, inputTokens: 120, outputTokens: 80 } })
    expect(recovered.latestActivity?.id).toBe('tool-00001')
    await traceStage('before-watermark-4100')
    const historical = required(await store.getRunView(tenant, runId, { atSeq: seqAt4100 }))
    await traceStage('after-watermark-4100')
    assertBounded(historical)
    expect(historical).toMatchObject({ lastSeq: seqAt4100, status: 'running', toolCount: 4100, activeToolCount: 1, usage: { totalTokens: 80 } })
    expect(historical.latestActivity?.id).toBe('tool-04100')
    const first = required(await store.getToolDetail(tenant, runId, 'tool-00001', { atSeq: recovered.lastSeq }))
    expect(JSON.parse(first.detail.text)).toMatchObject({ args: { text: '参数'.repeat(80) + 'ARG_SENTINEL_00001', index: '00001' }, output: 'OLD_ORDINAL_FINISHED_LAST', status: 'succeeded' })
    expect(await store.recoverInterrupted()).toEqual([])
    expect((await store.listPendingParentProjections(tenant)).map(item => item.event.runId)).toEqual([runId])
    await traceStage('after-detail-outbox')
    console.info('SUBAGENT_DURABLE_RESIDENT ' + JSON.stringify({ maxResidentTools, maxResidentActive, finalViewBytes: Buffer.byteLength(JSON.stringify(recovered)), seqAt4100, finalSeq: recovered.lastSeq }))
    // This watchdog bounds only the synthetic measurement. The first worker exit remains failed evidence.
  }, 600_000)

  it('keeps fixed-watermark pages and details stable across completion, usage and newly created tools', async () => {
    const runId = 'fixed-pages'
    await running(runId)
    let mutation: SubagentMutation | undefined
    for (let index = 1; index <= 17; index++) mutation = await startTool(runId, `fixed-${index}`, { index, unicode: '固定🙂' })
    if (!mutation) throw new Error('No fixture tools written')
    const atSeq = mutation.view.lastSeq
    const page1 = required(await store.listToolsPage(tenant, runId, { atSeq, limit: 4 }))
    expect(page1.items.map(tool => tool.id)).toEqual(['fixed-1', 'fixed-2', 'fixed-3', 'fixed-4'])
    await finishTool(runId, 'fixed-1', 'future completion')
    await finishTool(runId, 'fixed-17', 'future completion')
    await startTool(runId, 'future-18')
    await store.recordUsageDelta(tenant, runId, { invocationId: 'future-usage', promptTokens: 70, completionTokens: 30 })
    const laterPages: SubagentToolSummary[] = [...page1.items]
    let cursor = page1.nextCursor
    while (cursor) {
      const page = required(await store.listToolsPage(tenant, runId, { atSeq, cursor, limit: 4 }))
      expect(page.totalCount).toBe(17)
      expect(page.asOfSeq).toBe(atSeq)
      laterPages.push(...page.items)
      cursor = page.nextCursor
    }
    expect(laterPages.map(tool => [tool.id, tool.ordinal, tool.status])).toEqual(Array.from({ length: 17 }, (_, index) => [`fixed-${index + 1}`, index + 1, 'running']))
    const original = required(await store.getToolDetail(tenant, runId, 'fixed-1', { atSeq }))
    expect(JSON.parse(original.detail.text)).toEqual({ id: 'fixed-1', name: 'read_file', args: { index: 1, unicode: '固定🙂' }, status: 'running', startedAt })
    expect(await store.getToolDetail(tenant, runId, 'future-18', { atSeq })).toBeNull()
    expect(required(await store.getRunView(tenant, runId, { atSeq })).usage).toEqual({})
    const latest = required(await store.getRunView(tenant, runId))
    expect(latest).toMatchObject({ toolCount: 18, activeToolCount: 16, usage: { totalTokens: 100 } })
    await expect(store.listToolsPage(tenant, runId, { atSeq: latest.lastSeq, cursor: page1.nextCursor })).rejects.toThrow('scope mismatch')
    await expect(store.listToolsPage('another-tenant', runId, { atSeq, cursor: page1.nextCursor })).rejects.toThrow('scope mismatch')
    await running('another-run')
    await expect(store.listToolsPage(tenant, 'another-run', { atSeq, cursor: page1.nextCursor })).rejects.toThrow('scope mismatch')
    expect(await store.getRunView('another-tenant', runId)).toBeNull()
  })

  it('binds the historical tool identity and sequence to the expression index in the actual production query plan', async () => {
    const runId = 'history-plan'
    await running(runId)
    await startTool(runId, 'plan-tool-1')
    await startTool(runId, 'plan-tool-2')
    const completed = await finishTool(runId, 'plan-tool-2')
    await store.appendHeader(tenant, runId, 'output.updated', { partialOutput: 'make the exact checkpoint historical' })
    const history = required(await store.getRunView(tenant, runId, { atSeq: completed.view.lastSeq }))
    expect(history.latestActivity).toMatchObject({ id: 'plan-tool-2', status: 'succeeded' })
    if (!lastHistoricalSql) throw new Error('Production exact-watermark query was not observed')
    // Assert the planner's actual seek keys, not a time threshold affected by the machine's load.
    const plan = await db.execute({ sql: 'EXPLAIN QUERY PLAN ' + lastHistoricalSql,
      args: [completed.view.lastSeq, tenant, runId, completed.view.lastSeq, completed.view.lastSeq, 64] })
    const eventLookup = plan.rows.map(row => String(row.detail)).filter(detail => detail.includes('SEARCH e '))
    expect(eventLookup).toHaveLength(1)
    expect(eventLookup[0]).toContain('idx_subagent_delta_tool_revision')
    expect(eventLookup[0]).toContain('<expr>=? AND seq<?')
  })

  it('counts all 96 active tools, cancels them durably and keeps settled tools terminal after late callbacks', async () => {
    const runId = 'active-overflow'
    let mutation = await running(runId)
    for (let index = 1; index <= 96; index++) mutation = await startTool(runId, `active-${index}`)
    const activeSeq = mutation.view.lastSeq
    assertBounded(mutation.view)
    expect(mutation.view.coverage).toMatchObject({ toolCount: 96, activeToolCount: 96, includedToolCount: 32, includedActiveToolCount: 32, hasMore: true, truncated: true, completeness: 'partial' })
    expect(mutation.view.latestActivity?.id).toBe('active-96')
    const terminal = required(await store.appendHeader(tenant, runId, 'finished', { status: 'cancelled', finishedAt: startedAt + 3 }, { cancelActiveTools: true }))
    expect(terminal.view).toMatchObject({ status: 'cancelled', toolCount: 96, activeToolCount: 0 })
    expect((await allTools(runId, terminal.view.lastSeq)).map(tool => tool.status)).toEqual(Array(96).fill('cancelled'))
    expect(required(await store.getRunView(tenant, runId, { atSeq: activeSeq })).activeToolCount).toBe(96)
    const late = await finishTool(runId, 'active-1', 'late tool callback evidence')
    expect(late.view.status).toBe('cancelled')
    expect(late.view.activeToolCount).toBe(0)
    expect(late.view.latestActivity).toMatchObject({ id: 'active-1', status: 'cancelled' })
    expect(required(await store.getToolDetail(tenant, runId, 'active-1', { atSeq: late.view.lastSeq })).tool.status).toBe('cancelled')
    expect(await store.upsertTool(tenant, runId, 'tool.started', { id: 'late-new', name: 'read_file', args: {}, status: 'running' })).toBeNull()
    expect(await store.appendHeader(tenant, runId, 'finished', { status: 'succeeded' })).toBeNull()
    const usage = { invocationId: 'late-invocation', promptTokens: 7, completionTokens: 5 }
    expect(required(await store.recordUsageDelta(tenant, runId, usage)).view).toMatchObject({ status: 'cancelled', usage: { totalTokens: 12 } })
    expect(await store.recordUsageDelta(tenant, runId, usage)).toBeNull()
    expect(await countRows('subagent_outbox', runId)).toBe(1)
  })

  it('rolls back tool index, detail version, counters and checkpoints when the event insert fails', async () => {
    const runId = 'tool-rollback'
    const before = await running(runId)
    await db.execute("CREATE TRIGGER fixture_reject_tool_event BEFORE INSERT ON subagent_events WHEN NEW.kind IN ('tool.started','tool.completed') BEGIN SELECT RAISE(ABORT,'FIXTURE_TOOL_EVENT_ABORT'); END")
    await expect(startTool(runId, 'rolled-back-tool')).rejects.toThrow('FIXTURE_TOOL_EVENT_ABORT')
    expect(required(await store.getRunView(tenant, runId))).toEqual(before.view)
    for (const table of ['subagent_tools', 'subagent_tool_versions']) expect(await countRows(table, runId)).toBe(0)
    expect(await countRows('subagent_events', runId)).toBe(before.view.lastSeq)
    expect(await countRows('subagent_checkpoints', runId)).toBe(before.view.lastSeq)
    await db.execute('DROP TRIGGER fixture_reject_tool_event')
    const started = await startTool(runId, 'rolled-back-tool')
    await db.execute("CREATE TRIGGER fixture_reject_tool_completion BEFORE INSERT ON subagent_events WHEN NEW.kind='tool.completed' BEGIN SELECT RAISE(ABORT,'FIXTURE_TOOL_COMPLETION_ABORT'); END")
    await expect(finishTool(runId, 'rolled-back-tool')).rejects.toThrow('FIXTURE_TOOL_COMPLETION_ABORT')
    expect(required(await store.getRunView(tenant, runId))).toEqual(started.view)
    expect(await countRows('subagent_tool_versions', runId)).toBe(1)
    expect(JSON.parse(required(await store.getToolDetail(tenant, runId, 'rolled-back-tool', { atSeq: started.view.lastSeq })).detail.text).status).toBe('running')
    await db.execute('DROP TRIGGER fixture_reject_tool_completion')
    const finished = await finishTool(runId, 'rolled-back-tool')
    expect(finished.view).toMatchObject({ toolCount: 1, activeToolCount: 0, lastSeq: started.view.lastSeq + 1 })
    expect(await countRows('subagent_tool_versions', runId)).toBe(2)
  })

  it('rolls back invocation deduplication and cumulative usage before an identical retry', async () => {
    const runId = 'usage-rollback'
    const before = await running(runId)
    const usage = { invocationId: 'same-invocation', promptTokens: 11, completionTokens: 7, cacheHitTokens: 3, cacheWriteTokens: 2 }
    await db.execute("CREATE TRIGGER fixture_reject_usage BEFORE INSERT ON subagent_events WHEN NEW.kind='usage.updated' BEGIN SELECT RAISE(ABORT,'FIXTURE_USAGE_ABORT'); END")
    await expect(store.recordUsageDelta(tenant, runId, usage)).rejects.toThrow('FIXTURE_USAGE_ABORT')
    expect(await countRows('subagent_usage_invocations', runId)).toBe(0)
    expect(required(await store.getRunView(tenant, runId))).toEqual(before.view)
    expect(await countRows('subagent_events', runId)).toBe(before.view.lastSeq)
    expect(await countRows('subagent_checkpoints', runId)).toBe(before.view.lastSeq)
    await db.execute('DROP TRIGGER fixture_reject_usage')
    const committed = required(await store.recordUsageDelta(tenant, runId, usage))
    expect(committed.view.usage).toEqual({ inputTokens: 11, outputTokens: 7, totalTokens: 18, cacheReadTokens: 3, cacheWriteTokens: 2 })
    expect(await store.recordUsageDelta(tenant, runId, usage)).toBeNull()
    expect(await countRows('subagent_usage_invocations', runId)).toBe(1)
    await reopen()
    expect(required(await store.getRunView(tenant, runId))).toEqual(committed.view)
    expect(await store.recordUsageDelta(tenant, runId, usage)).toBeNull()
  })

  it('rolls back cancellation and terminal outbox together, then reopens and acknowledges the exact terminal once', async () => {
    const runId = 'outbox-rollback'
    let before = await running(runId)
    for (let index = 1; index <= 3; index++) before = await startTool(runId, `outbox-tool-${index}`)
    await db.execute("CREATE TRIGGER fixture_reject_outbox BEFORE INSERT ON subagent_outbox BEGIN SELECT RAISE(ABORT,'FIXTURE_OUTBOX_ABORT'); END")
    await expect(store.appendHeader(tenant, runId, 'finished', { status: 'cancelled', finishedAt: startedAt + 4 }, { cancelActiveTools: true })).rejects.toThrow('FIXTURE_OUTBOX_ABORT')
    expect(required(await store.getRunView(tenant, runId))).toEqual(before.view)
    expect((await allTools(runId, before.view.lastSeq)).map(tool => tool.status)).toEqual(['running', 'running', 'running'])
    expect(await countRows('subagent_tool_versions', runId)).toBe(3)
    expect(await countRows('subagent_outbox', runId)).toBe(0)
    expect(await countRows('subagent_events', runId)).toBe(before.view.lastSeq)
    expect(await countRows('subagent_checkpoints', runId)).toBe(before.view.lastSeq)
    await db.execute('DROP TRIGGER fixture_reject_outbox')
    const committed = required(await store.appendHeader(tenant, runId, 'finished', { status: 'cancelled', finishedAt: startedAt + 4 }, { cancelActiveTools: true }))
    expect(await store.appendHeader(tenant, runId, 'finished', { status: 'cancelled', finishedAt: startedAt + 4 })).toBeNull()
    expect(await countRows('subagent_outbox', runId)).toBe(1)
    await reopen()
    expect(required(await store.getRunView(tenant, runId))).toEqual(committed.view)
    expect((await allTools(runId, committed.view.lastSeq)).map(tool => tool.status)).toEqual(['cancelled', 'cancelled', 'cancelled'])
    const pending = await store.listPendingParentProjections(tenant)
    expect(pending.map(item => [item.id, item.event.runId, item.event.seq])).toEqual([[`${tenant}:${runId}:${committed.view.lastSeq}`, runId, committed.view.lastSeq]])
    await store.ackProjection(pending[0].id, 'another-tenant')
    expect((await store.listPendingParentProjections(tenant)).length).toBe(1)
    await store.ackProjection(pending[0].id, tenant)
    await store.ackProjection(pending[0].id, tenant)
    expect(await store.listPendingParentProjections(tenant)).toEqual([])
    expect(await store.recoverInterrupted()).toEqual([])
  })

  it('recovers queued, running and cancelling runs after reopen without rerunning or reviving settled tools', async () => {
    await store.createRunDelta(runInput('recovery-queued'))
    await running('recovery-running')
    await startTool('recovery-running', 'recovery-active')
    const settled = await startTool('recovery-running', 'recovery-settled')
    const completed = await finishTool('recovery-running', 'recovery-settled', 'already completed')
    await store.recordUsageDelta(tenant, 'recovery-running', { invocationId: 'prior-restart', promptTokens: 8, completionTokens: 4 })
    await running('recovery-cancelling')
    await startTool('recovery-cancelling', 'recovery-cancelling-tool')
    await store.appendHeader(tenant, 'recovery-cancelling', 'cancelling', { status: 'cancelling' })
    await running('recovery-terminal')
    await store.appendHeader(tenant, 'recovery-terminal', 'finished', { status: 'failed', finishedAt: startedAt + 5, stopReason: 'synthetic failure' })
    const before = required(await store.getRunView(tenant, 'recovery-running'))
    await reopen()
    expect(required(await store.getRunView(tenant, 'recovery-running'))).toEqual(before)
    const interrupted = await store.recoverInterrupted()
    expect(interrupted.map(event => event.runId).sort()).toEqual(['recovery-cancelling', 'recovery-queued', 'recovery-running'])
    const recovered = required(await store.getRunView(tenant, 'recovery-running'))
    expect(recovered).toMatchObject({ status: 'interrupted', stopReason: 'engine_restarted', activeToolCount: 0, toolCount: 2, usage: { totalTokens: 12, unknown: true }, error: { code: 'ENGINE_RESTARTED', retryable: false } })
    expect((await allTools('recovery-running', recovered.lastSeq)).map(tool => [tool.id, tool.status])).toEqual([['recovery-active', 'cancelled'], ['recovery-settled', 'succeeded']])
    const prior = required(await store.getRunView(tenant, 'recovery-running', { atSeq: completed.view.lastSeq }))
    expect(prior).toMatchObject({ status: 'running', activeToolCount: 1, usage: {} })
    expect(required(await store.getRunView(tenant, 'recovery-running', { atSeq: settled.view.lastSeq })).activeToolCount).toBe(2)
    expect(required(await store.getRunView(tenant, 'recovery-queued'))).toMatchObject({ status: 'interrupted', toolCount: 0, activeToolCount: 0 })
    expect(required(await store.getRunView(tenant, 'recovery-terminal')).status).toBe('failed')
    expect(await store.recoverInterrupted()).toEqual([])
    await reopen()
    expect(await store.recoverInterrupted()).toEqual([])
    expect(required(await store.getRunView(tenant, 'recovery-running'))).toEqual(recovered)
  })

  it('requires recovery for a deleted exact checkpoint and future watermarks without exposing foreign tenants', async () => {
    const runId = 'missing-checkpoint'
    await running(runId)
    const original = await startTool(runId, 'checkpoint-tool')
    await finishTool(runId, 'checkpoint-tool')
    const atSeq = original.view.lastSeq
    await db.execute({ sql: 'DELETE FROM subagent_checkpoints WHERE tenant_id=? AND run_id=? AND seq=?', args: [tenant, runId, atSeq] })
    await expect(store.getRunView(tenant, runId, { atSeq })).rejects.toThrow('SUBAGENT_RECOVERY_REQUIRED')
    await expect(store.listToolsPage(tenant, runId, { atSeq })).rejects.toThrow('SUBAGENT_RECOVERY_REQUIRED')
    await expect(store.getToolDetail(tenant, runId, 'checkpoint-tool', { atSeq })).rejects.toThrow('SUBAGENT_RECOVERY_REQUIRED')
    const latest = required(await store.getRunView(tenant, runId))
    await expect(store.getRunView(tenant, runId, { atSeq: latest.lastSeq + 1 })).rejects.toThrow('SUBAGENT_RECOVERY_REQUIRED')
    expect(await store.getRunView('another-tenant', runId, { atSeq })).toBeNull()
    expect(await store.getToolDetail('another-tenant', runId, 'checkpoint-tool', { atSeq })).toBeNull()
  })

  it.each(['latest', 'historical'] as const)('refuses an older tool version when the expected %s completion detail is missing', async (mode) => {
    const runId = `missing-version-${mode}`
    await running(runId)
    const started = await startTool(runId, 'version-tool', { preserved: 'original arguments' })
    const completed = await finishTool(runId, 'version-tool', 'expected completion')
    const atSeq = completed.view.lastSeq
    if (mode === 'historical') await store.appendHeader(tenant, runId, 'output.updated', { partialOutput: 'a newer header exists' })
    await db.execute({ sql: 'DELETE FROM subagent_tool_versions WHERE tenant_id=? AND run_id=? AND tool_id=? AND seq=?', args: [tenant, runId, 'version-tool', atSeq] })
    expect(await countRows('subagent_tool_versions', runId)).toBe(1)
    expect(await countRows('subagent_tools', runId)).toBe(1)
    expect(JSON.parse(required(await store.getToolDetail(tenant, runId, 'version-tool', { atSeq: started.view.lastSeq })).detail.text).status).toBe('running')
    await expect(store.getRunView(tenant, runId, { atSeq })).rejects.toThrow('SUBAGENT_RECOVERY_REQUIRED')
    await expect(store.listToolsPage(tenant, runId, { atSeq })).rejects.toThrow('SUBAGENT_RECOVERY_REQUIRED')
    await expect(store.getToolDetail(tenant, runId, 'version-tool', { atSeq })).rejects.toThrow('SUBAGENT_RECOVERY_REQUIRED')
  })

  it('reports missing tool ordinals and missing event prefixes instead of empty success pages', async () => {
    const runId = 'missing-prefix'
    let mutation = await running(runId)
    for (let index = 1; index <= 5; index++) mutation = await startTool(runId, `ordinal-${index}`)
    const atSeq = mutation.view.lastSeq
    await db.execute({ sql: 'DELETE FROM subagent_tool_versions WHERE tenant_id=? AND run_id=? AND tool_id=?', args: [tenant, runId, 'ordinal-2'] })
    await db.execute({ sql: 'DELETE FROM subagent_tools WHERE tenant_id=? AND run_id=? AND tool_id=?', args: [tenant, runId, 'ordinal-2'] })
    await expect(store.listToolsPage(tenant, runId, { atSeq })).rejects.toThrow('SUBAGENT_RECOVERY_REQUIRED')
    await db.execute({ sql: 'DELETE FROM subagent_events WHERE tenant_id=? AND run_id=? AND seq=4', args: [tenant, runId] })
    const gap = required(await store.listEventsPage(tenant, runId, { limit: 200 }))
    expect(gap).toMatchObject({ nextSeq: 3, hasMore: true, checkpointRequired: true })
    expect(gap.events.map(event => event.seq)).toEqual([1, 2, 3])
    await db.execute({ sql: 'DELETE FROM subagent_events WHERE tenant_id=? AND run_id=? AND seq>3', args: [tenant, runId] })
    expect(required(await store.listEventsPage(tenant, runId, { afterSeq: 3 }))).toMatchObject({ events: [], nextSeq: 3, hasMore: true, checkpointRequired: true })
  })

  it('preserves giant Unicode args and output in bounded UTF-8 detail chunks with explicit truncated summaries', async () => {
    const runId = 'unicode-detail'
    await running(runId)
    const args = { unicode: '参数🙂'.repeat(32_000), nested: { marker: 'END_OF_ARGUMENTS' } }
    const output = '结果🚀'.repeat(32_000) + 'END_OF_OUTPUT'
    await startTool(runId, 'giant-tool', args)
    const completed = await finishTool(runId, 'giant-tool', output)
    assertBounded(completed.view)
    expect(completed.view.toolCalls[0].detailTruncated).toBe(true)
    expect(completed.view.coverage.truncated).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(completed.event))).toBeLessThan(16 * 1024)
    const chunks: string[] = []
    let offset = 0, expectedTotal = 0
    for (;;) {
      const result = required(await store.getToolDetail(tenant, runId, 'giant-tool', { atSeq: completed.view.lastSeq, offset, limitBytes: 64 * 1024 }))
      const chunk = result.detail
      expect(chunk.offset).toBe(offset)
      expect(chunk.text).not.toContain('\uFFFD')
      expect(Buffer.byteLength(chunk.text)).toBeLessThanOrEqual(64 * 1024)
      chunks.push(chunk.text)
      if (expectedTotal) expect(chunk.totalBytes).toBe(expectedTotal)
      expectedTotal = chunk.totalBytes
      if (!chunk.hasMore) break
      expect(chunk.nextOffset).toBe(offset + Buffer.byteLength(chunk.text))
      if (chunk.nextOffset === undefined || chunk.nextOffset <= offset) throw new Error('Detail cursor did not advance')
      offset = chunk.nextOffset
    }
    const encoded = chunks.join('')
    expect(Buffer.byteLength(encoded)).toBe(expectedTotal)
    expect(JSON.parse(encoded)).toMatchObject({ args, output, status: 'succeeded' })
    const badBoundary = Buffer.byteLength(encoded.slice(0, encoded.indexOf('🙂'))) + 1
    await expect(store.getToolDetail(tenant, runId, 'giant-tool', { atSeq: completed.view.lastSeq, offset: badBoundary })).rejects.toThrow('UTF-8 boundary')
    await expect(store.getToolDetail(tenant, runId, 'giant-tool', { atSeq: completed.view.lastSeq, offset: expectedTotal + 1 })).rejects.toThrow('exceeds length')
  })
})
