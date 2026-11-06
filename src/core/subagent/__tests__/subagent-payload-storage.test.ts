import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalSqliteProcessClient } from '../../../storage/sqlite/local-process-client.js'
import { SubagentStore } from '../store.js'
import type { CreateSubagentRun } from '../types.js'

let directory: string, database: string, db: LocalSqliteProcessClient, store: SubagentStore
const tenant = 'payload-tenant'
const input = (overrides: Partial<CreateSubagentRun> = {}): CreateSubagentRun => ({
  tenantId: tenant, rootSessionId: 'parent', parentSessionId: 'parent', parentConversationId: 'turn',
  parentMessageId: 'message', parentToolCallId: 'dispatch', task: 'Inspect and implement the component',
  description: 'component', modelId: 'test-model', continuation: { readOnly: false, systemPrompt: 'Executor',
    toolNames: ['read_file', 'write_file'], workspacePaths: ['/project'] }, ...overrides,
})
async function reopen() {
  db.close(); await db.whenClosed()
  db = new LocalSqliteProcessClient({ url: `file:${database.replaceAll('\\', '/')}` })
  store = new SubagentStore(db)
}
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aether-child-body-test-'))
  database = path.join(directory, 'agent.db')
  db = new LocalSqliteProcessClient({ url: `file:${database.replaceAll('\\', '/')}` })
  store = new SubagentStore(db)
})
afterEach(async () => { db.close(); await db.whenClosed(); await fs.rm(directory, { recursive: true, force: true }) })

describe('durable subagent bodies outside SQLite', () => {
  it('keeps exact history, details, pagination and continuation across a real database reopen', async () => {
    const first = (await store.createRunDelta(input())).header
    await store.appendHeader(tenant, first.runId, 'started', { status: 'running' })
    const args = { source: '原始参数🪶'.repeat(6000), count: 7 }
    const output = '工具输出与证据🌿'.repeat(8000)
    const started = (await store.upsertTool(tenant, first.runId, 'tool.started', { id: 'tool', name: 'read_file', args, status: 'running' }))!
    const completed = (await store.upsertTool(tenant, first.runId, 'tool.completed', { id: 'tool', name: 'read_file', output, status: 'succeeded' }))!
    const partialOutput = '需要保留的进度'.repeat(200)
    await store.appendHeader(tenant, first.runId, 'output.updated', { partialOutput })
    const finished = (await store.appendHeader(tenant, first.runId, 'finished', { status: 'succeeded', resultSummary: partialOutput }))!
    const original = (await store.getRun(tenant, first.runId))!
    expect(original.toolCalls[0]).toMatchObject({ args, output })
    expect((await store.getSnapshotsAtSequences(tenant, [{ runId: first.runId, seq: started.header.lastSeq }]))[0].toolCalls[0]).toMatchObject({ args, status: 'running' })
    const view = (await store.getRunView(tenant, first.runId))!
    const events = (await store.listEventsPage(tenant, first.runId))!.events
    expect(JSON.stringify({ view, events })).not.toContain('__aetherSubagentPayloads')
    expect(events.at(-1)?.headerPatch.resultSummary).toBe(partialOutput)
    const detailText = JSON.stringify(original.toolCalls[0])
    let text = '', offset = 0
    for (;;) {
      const page = (await store.getToolDetail(tenant, first.runId, 'tool', { atSeq: completed.header.lastSeq, offset, limitBytes: 16384 }))!
      expect(page.detail.totalBytes).toBe(Buffer.byteLength(detailText))
      text += page.detail.text
      if (!page.detail.hasMore) break
      offset = page.detail.nextOffset!
    }
    expect(text).toBe(detailText)
    const stored = (await db.execute({ sql: 'SELECT detail FROM subagent_tool_versions WHERE run_id=? AND seq=?', args: [first.runId, completed.header.lastSeq] })).rows[0]
    expect(Buffer.byteLength(String(stored.detail))).toBeLessThan(4096)
    expect(String(stored.detail)).not.toContain('工具输出与证据')
    expect((await fs.stat(database + '.subagent-payloads')).isDirectory()).toBe(true)

    await reopen()
    expect(await store.getRun(tenant, first.runId)).toEqual(original)
    expect(await store.getRunView(tenant, first.runId)).toEqual(view)
    const projection = await store.listPendingParentProjections(tenant)
    expect(projection).toHaveLength(1)
    expect(projection[0].event).toMatchObject({ seq: finished.header.lastSeq, view: { resultSummary: partialOutput } })
    const next = await store.createRunDelta(input({ parentConversationId: 'next-turn', parentToolCallId: 'next-dispatch', resumeFromRunId: first.runId }))
    expect(next.header.childSessionId).toBe(first.childSessionId)
    expect(next.header.continuation).toEqual(first.continuation)
  })

  it('preserves external args when completing and cancelling, and removes stale references when replaced inline', async () => {
    const run = (await store.createRunDelta(input())).header
    await store.appendHeader(tenant, run.runId, 'started', { status: 'running' })
    const args = { text: 'large-original-arguments'.repeat(1000) }
    await store.upsertTool(tenant, run.runId, 'tool.started', { id: 'a', name: 'read_file', args, status: 'running' })
    await store.upsertTool(tenant, run.runId, 'tool.completed', { id: 'a', name: 'read_file', output: 'large-output'.repeat(1000), status: 'succeeded' })
    await store.upsertTool(tenant, run.runId, 'tool.completed', { id: 'a', name: 'read_file', args: null, output: 'short replacement', status: 'succeeded' })
    await store.upsertTool(tenant, run.runId, 'tool.started', { id: 'b', name: 'read_file', args, status: 'running' })
    await store.appendHeader(tenant, run.runId, 'finished', { status: 'cancelled', finishedAt: 1234 }, { cancelActiveTools: true })
    const restored = (await store.getRun(tenant, run.runId))!
    expect(restored.toolCalls[0]).toMatchObject({ args: null, output: 'short replacement' })
    expect(restored.toolCalls[1]).toMatchObject({ args, status: 'cancelled', finishedAt: 1234 })
  })

  it('never publishes new state when an event transaction fails after writing bodies', async () => {
    const run = (await store.createRunDelta(input())).header
    await store.appendHeader(tenant, run.runId, 'started', { status: 'running' })
    const before = await store.getRunView(tenant, run.runId)
    await db.execute("CREATE TRIGGER fail_child_payload_event BEFORE INSERT ON subagent_events WHEN NEW.kind='output.updated' BEGIN SELECT RAISE(ABORT,'TEST_EVENT_FAILURE'); END")
    await expect(store.appendHeader(tenant, run.runId, 'output.updated', { partialOutput: 'uncommitted body'.repeat(400) })).rejects.toThrow('TEST_EVENT_FAILURE')
    expect(await store.getRunView(tenant, run.runId)).toEqual(before)
    await reopen()
    expect(await store.getRunView(tenant, run.runId)).toEqual(before)
  })
})
