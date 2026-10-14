/** Real SQLite outbox + both transcript backends: crash recovery, isolation and deletion. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversationHistory } from '../../agent-context/types.js'
import { JSONLConversationHistory } from '../../../storage/conversation/jsonl-history.js'
import { SQLiteConversationHistory } from '../../../storage/conversation/history.js'
import { projectPendingSubagents } from '../projection.js'
import { SubagentStore } from '../store.js'
import { LocalSqliteProcessClient } from '../../../storage/sqlite/local-process-client.js'
import type { CreateSubagentRun } from '../types.js'

const state = vi.hoisted(() => ({ db: null as unknown as LocalSqliteProcessClient, store: null as unknown as SubagentStore }))
vi.mock('../../../storage/sqlite/db.js', () => ({ getDb: () => state.db }))
vi.mock('../store.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../store.js')>()
  return { ...original, getSubagentStore: () => state.store }
})

let fixtureDir: string
let sequence = 0
let parent: { tenantId: string; sessionId: string }
let input: CreateSubagentRun

beforeEach(async () => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-subagent-projection-'))
  vi.stubEnv('DATA_DIR', path.join(fixtureDir, 'history.db'))
  state.db = new LocalSqliteProcessClient({ url: `file:${path.join(fixtureDir, 'history.db').replace(/\\/g, '/')}` })
  await state.db.execute(`CREATE TABLE conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, session_id TEXT NOT NULL,
    conversation_id TEXT, message_id TEXT, role TEXT NOT NULL, content TEXT NOT NULL,
    reasoning_content TEXT, tool_call_id TEXT, tool_call_name TEXT, tool_name TEXT, tool_args TEXT,
    tokens INTEGER DEFAULT 0, token_usage TEXT, model_id TEXT, metadata TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`)
  await state.db.execute('CREATE TABLE sessions (tenant_id TEXT, session_id TEXT, agent_id TEXT, metadata TEXT)')
  state.store = new SubagentStore(state.db)
  parent = { tenantId: 'tenant-a', sessionId: `root-${++sequence}` }
  input = {
    ...parent, rootSessionId: parent.sessionId, parentSessionId: parent.sessionId,
    parentConversationId: `turn-${sequence}`, parentMessageId: `dispatch-${sequence}`,
    parentToolCallId: `spawn-${sequence}`, task: 'Read README', description: 'Inspect README', modelId: 'test-model',
    childSessionId: `related-child-${sequence}`,
  }
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  state.db.close()
  await state.db.whenClosed()
  const target = path.resolve(fixtureDir)
  if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('aether-subagent-projection-')) throw new Error('Unsafe fixture cleanup path')
  // Do not leave native transactions alive across transcript backend fixtures.
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

async function dispatch(history: ConversationHistory) {
  await history.append({ role: 'user', content: 'Use a subagent to inspect README' }, parent)
  // Match the persisted ReAct dispatch shape, including both tool IDs.
  await history.append({
    id: input.parentMessageId, role: 'assistant', content: '', toolCallId: input.parentToolCallId,
    toolCall: { id: input.parentToolCallId, name: 'subagent', args: { task: input.task } },
    ...{ conversationId: input.parentConversationId },
  }, parent)
  return (await state.store.createRun(input)).snapshot
}

describe.each(['jsonl', 'sqlite'] as const)('subagent projection through %s history', backend => {
  const history = () => backend === 'jsonl' ? new JSONLConversationHistory() : new SQLiteConversationHistory()

  it('filters legacy progress payloads before decoding and retains their archive', async () => {
    const first = history()
    const run = await dispatch(first)
    const eventId = `${parent.tenantId}:${run.runId}:1`
    // Old engines queued every event. An invalid payload proves recovery never
    // decodes progress JSON; its large sibling also must remain untouched.
    const legacyPayload = 'legacy progress must not be parsed:' + 'x'.repeat(1024 * 1024)
    await state.db.execute({
      sql: 'INSERT INTO subagent_outbox (id,tenant_id,run_id,seq,event) VALUES (?,?,?,?,?)',
      args: [eventId, parent.tenantId, run.runId, 1, legacyPayload],
    })
    await state.store.appendSnapshot(parent.tenantId, run.runId, 'finished', { status: 'succeeded', resultSummary: 'Recovered final result' })
    const archive = await state.db.execute({ sql: 'SELECT event FROM subagent_events WHERE tenant_id=? AND run_id=? ORDER BY seq', args: [parent.tenantId, run.runId] })
    await projectPendingSubagents(first, parent.tenantId)
    expect((await first.getFullHistory(parent)).filter(message => message.role === 'tool')).toHaveLength(1)
    expect(await state.store.listPendingParentProjections(parent.tenantId)).toEqual([])
    const retained = await state.db.execute({ sql: 'SELECT event,acknowledged FROM subagent_outbox WHERE id=?', args: [eventId] })
    expect(retained.rows[0]).toMatchObject({ event: legacyPayload, acknowledged: 0 })
    const after = await state.db.execute({ sql: 'SELECT event FROM subagent_events WHERE tenant_id=? AND run_id=? ORDER BY seq', args: [parent.tenantId, run.runId] })
    expect(after.rows).toEqual(archive.rows)
  })

  it('drains multiple terminal pages without loading or acknowledging another tenant', async () => {
    const first = history()
    const runIds: string[] = []
    for (let index = 0; index < 35; index++) {
      const definition = { ...input, parentToolCallId: `page-spawn-${index}`, parentMessageId: `page-dispatch-${index}` }
      await first.append({ id: definition.parentMessageId, role: 'assistant', content: '',
        toolCall: { id: definition.parentToolCallId, name: 'subagent', args: {} },
        ...{ conversationId: definition.parentConversationId } }, parent)
      const run = (await state.store.createRun(definition)).snapshot
      runIds.push(run.runId)
      await state.store.appendSnapshot(parent.tenantId, run.runId, 'finished', { status: 'succeeded', resultSummary: `Result ${index}` })
    }
    const other = (await state.store.createRun({ ...input, tenantId: 'tenant-b' })).snapshot
    await state.store.appendSnapshot('tenant-b', other.runId, 'finished', { status: 'succeeded', resultSummary: 'Other tenant' })
    expect(await state.store.listPendingParentProjections(parent.tenantId)).toHaveLength(32)
    expect(await state.store.listPendingParentProjections(parent.tenantId, 100)).toHaveLength(32)
    const reads = vi.spyOn(state.store, 'listPendingParentProjections')
    await projectPendingSubagents(first, parent.tenantId)
    expect(reads.mock.calls).toHaveLength(36)
    expect(reads.mock.calls.every(([tenantId, limit]) => tenantId === parent.tenantId && limit === 1)).toBe(true)
    expect((await first.getFullHistory(parent)).filter(message => message.role === 'tool').map(message => message.id).sort())
      .toEqual(runIds.map(runId => `subagent-result:${runId}`).sort())
    expect(await state.store.listPendingParentProjections(parent.tenantId)).toEqual([])
    expect((await state.store.listPendingParentProjections('tenant-b')).map(row => row.event.runId)).toEqual([other.runId])
    await projectPendingSubagents(first, parent.tenantId)
    expect((await first.getFullHistory(parent)).filter(message => message.role === 'tool')).toHaveLength(35)
  })

  it('replays an unacknowledged append after restart exactly once, retaining metadata and tool pairing', async () => {
    const first = history()
    const run = await dispatch(first)
    await state.store.appendSnapshot(parent.tenantId, run.runId, 'finished', {
      status: 'succeeded', resultSummary: 'README describes the application.', finishedAt: Date.now(),
      toolCalls: [{ id: 'read-1', name: 'read_file', args: { path: 'README.md' }, status: 'succeeded', output: 'Full README contents' }],
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
    })
    const archiveBefore = await state.db.execute({
      sql: 'SELECT event FROM subagent_events WHERE tenant_id=? AND run_id=? AND seq=2',
      args: [parent.tenantId, run.runId],
    })
    const ack = state.store.ackProjection.bind(state.store)
    vi.spyOn(state.store, 'ackProjection').mockImplementation(async (id, tenantId) => {
      if (id.endsWith(':2')) throw new Error('simulated crash after transcript append')
      await ack(id, tenantId)
    })
    await expect(projectPendingSubagents(first, parent.tenantId)).rejects.toThrow('simulated crash')
    expect((await first.getFullHistory(parent)).filter(message => message.role === 'tool')).toHaveLength(1)
    expect(await state.store.listPendingParentProjections(parent.tenantId)).toHaveLength(1)

    state.store = new SubagentStore(state.db)
    const restarted = history()
    await projectPendingSubagents(restarted, parent.tenantId)
    await projectPendingSubagents(restarted, parent.tenantId)
    const results = (await restarted.getFullHistory(parent)).filter(message => message.role === 'tool')
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      id: `subagent-result:${run.runId}`, toolCallId: input.parentToolCallId,
      content: expect.stringContaining('README describes the application.'), metadata: { success: true, subagent: {
        schemaVersion: 2, view: 'summary', runId: run.runId, status: 'succeeded', usage: { totalTokens: 10 },
        coverage: { asOfSeq: 2, toolCount: 1, includedToolCount: 1, activeToolCount: 0,
          includedActiveToolCount: 0, ids: ['read-1'], hasMore: false, completeness: 'complete' },
        toolCalls: expect.arrayContaining([expect.objectContaining({ id: 'read-1', args: { path: 'README.md' }, output: 'Full README contents' })]),
      } },
    })
    // Summary order and previews are allowed to change; the exact v1 archive
    // must retain full details and its original tool order through recovery.
    const [canonical] = await state.store.getSnapshotsAtSequences(parent.tenantId, [{ runId: run.runId, seq: 2 }])
    expect(canonical.schemaVersion).toBe(1)
    expect(canonical.lastSeq).toBe(2)
    expect(canonical.toolCalls).toEqual([
      { id: 'read-1', name: 'read_file', args: { path: 'README.md' }, status: 'succeeded', output: 'Full README contents' },
    ])
    const archiveAfter = await state.db.execute({
      sql: 'SELECT event FROM subagent_events WHERE tenant_id=? AND run_id=? AND seq=2',
      args: [parent.tenantId, run.runId],
    })
    expect(archiveAfter.rows).toEqual(archiveBefore.rows)
    expect(JSON.parse(String(archiveAfter.rows[0].event))).toMatchObject({ schemaVersion: 1, seq: 2, snapshot: canonical })
    expect(await state.store.listPendingParentProjections(parent.tenantId)).toEqual([])
    if (backend === 'jsonl') {
      const lines = fs.readFileSync(path.join(fixtureDir, 'sessions', parent.tenantId, `${parent.sessionId}.jsonl`), 'utf8').trim().split('\n')
      expect(lines.map(line => JSON.parse(line)).filter(row => row.uuid === `subagent-result:${run.runId}`)).toHaveLength(1)
    } else {
      const rows = await state.db.execute({ sql: 'SELECT COUNT(*) AS count FROM conversations WHERE message_id=?', args: [`subagent-result:${run.runId}`] })
      expect(Number(rows.rows[0].count)).toBe(1)
    }
  })

  it('keeps committed terminal state recoverable when transcript append fails before acknowledgment', async () => {
    const first = history()
    const run = await dispatch(first)
    await state.store.appendSnapshot(parent.tenantId, run.runId, 'finished', {
      status: 'failed', stopReason: 'llm_error', error: { code: 'LLM_ERROR', message: '400 Request body format invalid', retryable: false },
    })
    vi.spyOn(first, 'appendIfActiveToolCallAnchor').mockRejectedValueOnce(new Error('simulated transcript write failure'))
    await expect(projectPendingSubagents(first, parent.tenantId)).rejects.toThrow('transcript write failure')
    expect((await state.store.getRun(parent.tenantId, run.runId))?.status).toBe('failed')
    expect(await state.store.listPendingParentProjections(parent.tenantId)).toHaveLength(1)
    const restarted = history()
    await projectPendingSubagents(restarted, parent.tenantId)
    const results = (await restarted.getFullHistory(parent)).filter(message => message.role === 'tool')
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ metadata: { success: false, error: '400 Request body format invalid', subagent: { status: 'failed', toolCalls: [] } } })
    expect(results[0].content).toContain('400 Request body format invalid')
  })

  it('recovers interrupted work without rerunning tools and preserves partial output and completed details', async () => {
    const first = history()
    const run = await dispatch(first)
    await state.store.appendSnapshot(parent.tenantId, run.runId, 'started', {
      status: 'running', startedAt: Date.now(), partialOutput: 'Located the entry point.',
      toolCalls: [
        { id: 'read-1', name: 'read_file', args: { path: 'README.md' }, status: 'succeeded', output: 'Persisted README' },
        { id: 'read-2', name: 'read_file', args: { path: 'package.json' }, status: 'running' },
      ],
      usage: { totalTokens: 23 },
    })
    const archiveBefore = await state.db.execute({
      sql: 'SELECT event FROM subagent_events WHERE tenant_id=? AND run_id=? AND seq=2',
      args: [parent.tenantId, run.runId],
    })
    state.store = new SubagentStore(state.db)
    const recovered = await state.store.recoverInterrupted()
    expect(recovered).toHaveLength(1)
    expect(await state.store.recoverInterrupted()).toEqual([])
    const restarted = history()
    await projectPendingSubagents(restarted, parent.tenantId)
    const result = (await restarted.getFullHistory(parent)).find(message => message.role === 'tool')
    expect(result).toMatchObject({ metadata: { success: false, subagent: {
      schemaVersion: 2, view: 'summary', status: 'interrupted', stopReason: 'engine_restarted', partialOutput: 'Located the entry point.',
      usage: { totalTokens: 23, unknown: true },
      coverage: { asOfSeq: recovered[0].seq, toolCount: 2, includedToolCount: 2, activeToolCount: 0,
        includedActiveToolCount: 0, ids: expect.arrayContaining(['read-1', 'read-2']), hasMore: false, completeness: 'complete' },
      toolCalls: expect.arrayContaining([
        expect.objectContaining({ id: 'read-1', status: 'succeeded', output: 'Persisted README' }),
        expect.objectContaining({ id: 'read-2', status: 'cancelled' }),
      ]),
    } } })
    const [prior, canonical] = await state.store.getSnapshotsAtSequences(parent.tenantId, [
      { runId: run.runId, seq: 2 }, { runId: run.runId, seq: recovered[0].seq },
    ])
    expect(prior.schemaVersion).toBe(1)
    expect(prior.toolCalls).toEqual([
      { id: 'read-1', name: 'read_file', args: { path: 'README.md' }, status: 'succeeded', output: 'Persisted README' },
      { id: 'read-2', name: 'read_file', args: { path: 'package.json' }, status: 'running' },
    ])
    expect(canonical.schemaVersion).toBe(1)
    expect(canonical.lastSeq).toBe(recovered[0].seq)
    expect(canonical.toolCalls.map(tool => tool.id)).toEqual(['read-1', 'read-2'])
    expect(canonical.toolCalls[0]).toEqual(prior.toolCalls[0])
    expect(canonical.toolCalls[1]).toMatchObject({ id: 'read-2', name: 'read_file', args: { path: 'package.json' }, status: 'cancelled' })
    const archiveAfter = await state.db.execute({
      sql: 'SELECT event FROM subagent_events WHERE tenant_id=? AND run_id=? AND seq=2',
      args: [parent.tenantId, run.runId],
    })
    expect(archiveAfter.rows).toEqual(archiveBefore.rows)
    expect(JSON.parse(String(archiveAfter.rows[0].event))).toMatchObject({ schemaVersion: 1, seq: 2, snapshot: prior })
    expect(result?.content).toContain('Located the entry point.')
    expect((await state.store.listEvents(parent.tenantId, run.runId)).map(event => event.kind)).toEqual(['created', 'started', 'finished'])
  })

  it('lists only roots using durable child relationships and legacy prefixes while retaining child transcripts', async () => {
    const first = history()
    const run = await dispatch(first)
    await first.append({ role: 'user', content: 'Child task' }, { tenantId: parent.tenantId, sessionId: run.childSessionId })
    await first.append({ role: 'user', content: 'Legacy child' }, { tenantId: parent.tenantId, sessionId: 'subagent-legacy' })
    await first.append({ role: 'user', content: 'An unrelated root in another tenant' }, { tenantId: 'tenant-b', sessionId: run.childSessionId })
    const restarted = history()
    expect((await restarted.listSessions(parent.tenantId)).map(session => session.sessionId)).toEqual([parent.sessionId])
    expect((await restarted.listSessions('tenant-b')).map(session => session.sessionId)).toEqual([run.childSessionId])
    expect((await restarted.getFullHistory({ tenantId: parent.tenantId, sessionId: run.childSessionId }))[0].content).toBe('Child task')
  })

  it('never resurrects a deleted parent from a late terminal projection, including after tombstones are gone', async () => {
    const first = history()
    const run = await dispatch(first)
    await state.store.appendSnapshot(parent.tenantId, run.runId, 'finished', { status: 'succeeded', resultSummary: 'Late result' })
    await first.clear(parent, { tombstone: false })
    const restarted = history()
    await projectPendingSubagents(restarted, parent.tenantId)
    expect(await restarted.getFullHistory(parent)).toEqual([])
    expect(await state.store.listPendingParentProjections(parent.tenantId)).toEqual([])
    expect((await restarted.listSessions(parent.tenantId)).map(session => session.sessionId)).not.toContain(parent.sessionId)
    await state.store.deleteRunsForParent(parent.tenantId, parent.sessionId)
    expect(await state.store.getRun(parent.tenantId, run.runId)).toBeNull()
    expect(await state.store.listEvents(parent.tenantId, run.runId)).toEqual([])
  })
})
