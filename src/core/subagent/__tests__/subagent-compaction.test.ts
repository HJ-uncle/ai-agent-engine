import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext } from '../../agent-context/types.js'
import type { LLMAdapter, LLMStreamChunk } from '../../llm-adapter/types.js'
import { ReActStrategy } from '../../agent-loop/react.js'
import { JSONLConversationHistory } from '../../../storage/conversation/jsonl-history.js'
import { LocalSqliteProcessClient } from '../../../storage/sqlite/local-process-client.js'
import { closeDb } from '../../../storage/sqlite/db.js'
import { SubagentRunner, type SubagentExecution } from '../runner.js'
import { SubagentStore } from '../store.js'
import { applySubagentDelta } from '../view.js'
import type { CreateSubagentRun, SubagentDeltaEvent, SubagentWireEvent } from '../types.js'

vi.mock('../../../storage/todo/index.js', () => ({ TodoStore: class { async list() { return [] } } }))
vi.mock('../projection.js', () => ({ projectPendingSubagents: vi.fn().mockResolvedValue(undefined) }))

let directory: string, db: LocalSqliteProcessClient, store: SubagentStore, parent: AgentContext
let events: SubagentWireEvent[], sequence = 0
const logger = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
function input(overrides: Partial<CreateSubagentRun> = {}): CreateSubagentRun {
  return { tenantId: 'compaction-tenant', rootSessionId: 'parent', parentSessionId: 'parent', parentConversationId: 'turn',
    parentMessageId: 'message', parentToolCallId: 'dispatch-' + ++sequence, task: 'Continue the verified work.',
    description: 'Actual child compaction', modelId: 'scripted-only',
    continuation: { readOnly: true, systemPrompt: '', toolNames: [], workspacePaths: [] }, ...overrides }
}
function openDatabase() { return new LocalSqliteProcessClient({ url: 'file:' + path.join(directory, 'fixture.db').replaceAll('\\', '/') }) }
beforeEach(async () => {
  await closeDb()
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-child-compaction-'))
  vi.stubEnv('DATA_DIR', path.join(directory, 'fixture.db'))
  vi.stubEnv('LLM_SUMMARIZE_MODEL', ''); vi.stubEnv('COMPRESS_THRESHOLD_RATIO', '0.92')
  db = openDatabase(); store = new SubagentStore(db); events = []
  parent = { tenantId: 'compaction-tenant', sessionId: 'parent', logger: logger(), history: {}, subagentEventVersion: 2,
    emitSubagentEvent: (event: SubagentWireEvent) => { events.push(event) } } as unknown as AgentContext
})
afterEach(async () => {
  await db.closeWithReceipt(); await closeDb(); vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('aether-child-compaction-')) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 })
})
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
async function childFixture(execution: SubagentExecution, seed = true) {
  const location = { tenantId: parent.tenantId, sessionId: execution.snapshot.childSessionId }
  const childDirectory = path.join(directory, 'sessions', location.tenantId)
  fs.mkdirSync(childDirectory, { recursive: true })
  const file = path.join(childDirectory, location.sessionId + '.jsonl')
  if (!fs.existsSync(file)) fs.writeFileSync(file, '')
  const history = new JSONLConversationHistory()
  if (seed) for (let index = 0; index < 10; index++) await history.append({ id: 'source-' + index, role: 'assistant',
    content: `Verified development step ${index}; preserve this evidence. `.repeat(150) }, location)
  const ctx = { ...location, rootRunId: 'root-progress', turnId: execution.snapshot.runId, runId: execution.snapshot.runId,
    parentSessionId: parent.sessionId, rootSessionId: parent.sessionId, userMessageId: 'request-' + execution.snapshot.runId,
    assistantMessageId: 'answer-' + execution.snapshot.runId, workspaceDir: directory, toolProfile: 'code',
    modelCaps: { contextWindow: 20_000 }, history, logger: logger(), tools: { list: () => [] },
    runObserver: execution.observer, signal: execution.signal } as unknown as AgentContext
  const llm: LLMAdapter = { model: 'scripted-only', provider: 'test', countTokens: () => 0,
    complete: vi.fn(async () => ({ content: '<summary>All verified checkpoints are retained; continue the latest task.</summary>', promptTokens: 12, completionTokens: 8, finishReason: 'stop' as const })),
    stream: vi.fn(async function* (): AsyncGenerator<LLMStreamChunk> {
      yield { done: true, content: 'Continued the verified task.', promptTokens: 450, completionTokens: 10 }
    }) }
  const run = async () => { for await (const _frame of new ReActStrategy(llm, { maxIterations: 2 }).run('Continue from the verified checkpoint.', ctx)) { /* drain actual ReAct */ } }
  return { ctx, history, llm, run }
}
function compactionEvents(): SubagentDeltaEvent[] {
  let previous = ''
  return events.filter((event): event is SubagentDeltaEvent => {
    if (event.schemaVersion !== 2 || !('headerPatch' in event) || event.kind !== 'output.updated' || !event.headerPatch.compaction) return false
    const key = JSON.stringify(event.headerPatch.compaction)
    if (key === previous) return false
    previous = key; return true
  })
}

describe('durable child automatic compaction observation', () => {
  it('actual child ReAct persists running, then committed success across checkpoint, delta and database reopen; resumed run starts clean', async () => {
    const entered = deferred(), release = deferred(), value = input()
    let fixture!: Awaited<ReturnType<typeof childFixture>>
    const running = new SubagentRunner(store).run(value, parent, async execution => {
      fixture = await childFixture(execution)
      fixture.llm.complete = vi.fn(async () => { entered.resolve(); await release.promise
        return { content: '<summary>Retain all verified checkpoints; continue the current task.</summary>', promptTokens: 12, completionTokens: 8, finishReason: 'stop' as const } })
      await fixture.run()
    })
    try {
      await entered.promise
      const progress = compactionEvents().at(-1)!
      expect(progress.headerPatch.compaction?.phase).toBe('running')
      expect((await new SubagentStore(db).getRunView(parent.tenantId, progress.runId))?.compaction?.phase).toBe('running')
      expect(fixture.llm.stream).not.toHaveBeenCalled()
      expect((await fixture.history.getFullHistory(fixture.ctx)).some(message => message.metadata?.isCompactSummary)).toBe(false)
    } finally { release.resolve() }
    const result = await running
    expect(result).toMatchObject({ status: 'succeeded', compaction: { phase: 'succeeded', startedAt: expect.any(Number), finishedAt: expect.any(Number) } })
    expect(result.compaction!.afterTokens!).toBeLessThan(result.compaction!.beforeTokens!)
    expect((await new JSONLConversationHistory().getFullHistory(fixture.ctx)).some(message => message.metadata?.isCompactSummary)).toBe(true)
    const phases = compactionEvents()
    expect(phases.map(event => event.headerPatch.compaction?.phase)).toEqual(['running', 'succeeded'])
    const atRunning = (await store.getRunView(parent.tenantId, result.runId, { atSeq: phases[0].seq }))!
    expect(atRunning.compaction?.phase).toBe('running')
    expect(applySubagentDelta(atRunning, phases[1])).toMatchObject({ status: 'applied', view: { compaction: result.compaction } })
    await db.closeWithReceipt(); db = openDatabase(); store = new SubagentStore(db)
    expect((await store.getRunView(parent.tenantId, result.runId))?.compaction).toEqual(result.compaction)
    expect((await store.getRunHeader(parent.tenantId, result.runId))?.compaction).toEqual(result.compaction)
    const resumed = await new SubagentRunner(store).run(input({ resumeFromRunId: result.runId }), parent, async execution => {
      expect(execution.snapshot.compaction).toBeUndefined()
      const next = await childFixture(execution, false); await next.run()
      expect(next.llm.complete).not.toHaveBeenCalled()
    })
    expect(resumed.childSessionId).toBe(result.childSessionId)
    expect(resumed.compaction).toBeUndefined()
    expect((await store.getRunView(parent.tenantId, result.runId))?.compaction).toEqual(result.compaction)
  })

  it('actual summary failure preserves original history, carries bounded failure evidence and never reports compaction success', async () => {
    const result = await new SubagentRunner(store).run(input(), parent, async execution => {
      const fixture = await childFixture(execution)
      const before = await fixture.history.getFullHistory(fixture.ctx)
      fixture.llm.complete = vi.fn(async () => { throw new Error('摘要不可用'.repeat(10_000)) })
      await fixture.run()
      const replay = await new JSONLConversationHistory().getFullHistory(fixture.ctx)
      expect(replay.slice(0, before.length)).toEqual(before)
      expect(replay.some(message => message.metadata?.isCompactSummary)).toBe(false)
      expect(fixture.llm.stream).not.toHaveBeenCalled()
    })
    expect(result.status).toBe('failed')
    expect(compactionEvents().map(event => event.headerPatch.compaction?.phase)).toEqual(['running', 'failed'])
    expect(result.compaction?.phase).toBe('failed')
    expect(Buffer.byteLength(result.compaction!.error!, 'utf8')).toBeLessThanOrEqual(1024)
    const rows = await db.execute({ sql: 'SELECT header FROM subagent_checkpoints WHERE tenant_id=? AND run_id=?', args: [parent.tenantId, result.runId] })
    expect(rows.rows.every(row => Buffer.byteLength(String(row.header), 'utf8') < 4096)).toBe(true)
    expect(JSON.parse(String(rows.rows.at(-1)!.header)).compaction).toEqual(result.compaction)
  })

  it('reopen recovery marks unfinished compaction failed once, and a resumed child never inherits the old running state', async () => {
    const admitted = await store.createRunDelta(input())
    await store.appendHeader(parent.tenantId, admitted.header.runId, 'started', { status: 'running', startedAt: 10 })
    await store.appendHeader(parent.tenantId, admitted.header.runId, 'output.updated', { compaction: { phase: 'running', startedAt: 20, beforeTokens: 15_000 } })
    await db.closeWithReceipt(); db = openDatabase(); store = new SubagentStore(db)
    expect(await store.recoverInterrupted()).toHaveLength(1)
    const interrupted = (await store.getRunView(parent.tenantId, admitted.header.runId))!
    expect(interrupted).toMatchObject({ status: 'interrupted', compaction: { phase: 'failed', startedAt: 20, finishedAt: expect.any(Number) } })
    expect(interrupted.compaction?.error).toContain('restarted')
    expect(await store.recoverInterrupted()).toHaveLength(0)
    const resumed = await store.createRunDelta(input({ resumeFromRunId: interrupted.runId }))
    expect(resumed.header.childSessionId).toBe(interrupted.childSessionId)
    expect(resumed.header.compaction).toBeUndefined(); expect(resumed.view.compaction).toBeUndefined()
    expect('headerPatch' in resumed.event && resumed.event.headerPatch.compaction).toBeUndefined()
  })

  it('a short actual child conversation does not fabricate automatic compaction', async () => {
    const result = await new SubagentRunner(store).run(input(), parent, async execution => {
      const fixture = await childFixture(execution, false); await fixture.run()
      expect(fixture.llm.complete).not.toHaveBeenCalled()
    })
    expect(result.status).toBe('succeeded'); expect(result.compaction).toBeUndefined(); expect(compactionEvents()).toEqual([])
  })
})
