import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext } from '../../agent-context/types.js'
import { RequestBudget, BudgetExceededError } from '../budget.js'
import { SubagentPool } from '../pool.js'
import { SubagentRunner } from '../runner.js'
import { SubagentStore } from '../store.js'
import { LocalSqliteProcessClient } from '../../../storage/sqlite/local-process-client.js'
import { closeDb, getDb } from '../../../storage/sqlite/db.js'
import type { CreateSubagentRun, RunOutcome, SubagentEvent, SubagentWireEvent } from '../types.js'

vi.mock('../projection.js', () => ({ projectPendingSubagents: vi.fn().mockResolvedValue(undefined) }))

let db: LocalSqliteProcessClient
let store: SubagentStore
let runner: SubagentRunner
let events: SubagentEvent[]
let parent: AgentContext
let sequence = 0
let fixtureDir: string
let ownedProjectionDb: LocalSqliteProcessClient | undefined

function input(overrides: Partial<CreateSubagentRun> = {}): CreateSubagentRun {
  return { tenantId: 'tenant-a', rootSessionId: 'root', parentSessionId: 'root', parentConversationId: 'turn', parentMessageId: 'message', parentToolCallId: `tool-${++sequence}`, task: '读取 README', description: '同名调研', modelId: 'fixture', ...overrides }
}

beforeEach(() => {
  ownedProjectionDb = undefined
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-subagent-runtime-'))
  db = new LocalSqliteProcessClient({ url: `file:${path.join(fixtureDir, 'runs.db').replace(/\\/g, '/')}` })
  store = new SubagentStore(db)
  runner = new SubagentRunner(store, new SubagentPool(1))
  events = []
  parent = {
    tenantId: 'tenant-a', sessionId: 'root', tokenBudget: 100_000,
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    history: {}, emitSubagentEvent: (event: SubagentEvent) => { events.push(event) },
  } as unknown as AgentContext
})

afterEach(async () => {
  if (ownedProjectionDb) { closeDb(); await ownedProjectionDb.whenClosed() }
  vi.unstubAllEnvs()
  db.close()
  await db.whenClosed()
  if (path.dirname(fixtureDir) !== path.resolve(os.tmpdir()) || !path.basename(fixtureDir).startsWith('aether-subagent-runtime-')) throw new Error('Unsafe fixture cleanup path')
  // Join the production adapter's native process before removing its database.
  fs.rmSync(fixtureDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

describe('SubagentRunner: typed outcome and durable lifecycle', () => {
  it('uses keyed v2 mutations without materializing growing legacy snapshots or leaking server permissions', async () => {
    const streamed: SubagentWireEvent[] = []
    const modern = { ...parent, subagentEventVersion: 2 as const,
      emitSubagentEvent: (event: SubagentWireEvent) => { streamed.push(event) } }
    const fullReads = vi.spyOn(store, 'getRun')
    const archiveReads = vi.spyOn(store, 'getSnapshotsAtSequences')
    const profile = { readOnly: true, systemPrompt: 'PRIVATE_PERMISSION_CONFIGURATION', toolNames: ['read_file'], workspacePaths: [] }
    let executionSawPermissions = false
    const output = '数据'.repeat(8000)
    const run = await runner.run(input({ continuation: profile }), modern, async ({ snapshot, observer }) => {
      executionSawPermissions = snapshot.continuation?.systemPrompt === profile.systemPrompt
      expect('toolCalls' in snapshot).toBe(false)
      for (let index = 0; index < 80; index++) {
        await observer.onToolStart({ toolCallId: `tool-${index}`, name: 'read_file', args: { path: `file-${index}` } })
        await observer.onToolEnd({ toolCallId: `tool-${index}`, name: 'read_file', success: true, output })
      }
      const usage = { invocationId: 'v2-invocation', promptTokens: 3, completionTokens: 2 }
      await observer.onUsage(usage)
      await observer.onUsage(usage)
      await observer.onOutcome({ status: 'succeeded', output: 'done' })
    })
    expect(executionSawPermissions).toBe(true)
    expect(run).toMatchObject({ schemaVersion: 2, view: 'summary', status: 'succeeded', toolCount: 80, activeToolCount: 0,
      usage: { totalTokens: 5 }, continuation: { readOnly: true } })
    expect(run.toolCalls).toHaveLength(64)
    expect(run.latestActivity?.id).toBe('tool-79')
    expect(fullReads).not.toHaveBeenCalled()
    expect(archiveReads).not.toHaveBeenCalled()
    expect(streamed).toHaveLength(164)
    expect(streamed.every(event => event.schemaVersion === 2 && !('snapshot' in event))).toBe(true)
    expect(JSON.stringify(streamed)).not.toContain(profile.systemPrompt)
    expect(JSON.stringify(run)).not.toContain(profile.systemPrompt)
    const progress = streamed.filter(event => event.kind === 'tool.completed')
    expect(progress).toHaveLength(80)
    expect(Math.max(...progress.map(event => Buffer.byteLength(JSON.stringify(event), 'utf8')))).toBeLessThan(16 * 1024)
  })

  it('persists tool details, per-invocation usage and a successful final result before returning', async () => {
    const run = await runner.run(input(), parent, async ({ observer }) => {
      await observer.onToolStart({ toolCallId: 'read-1', name: 'read_file', args: { path: 'README.md' } })
      await observer.onToolEnd({ toolCallId: 'read-1', name: 'read_file', success: true, output: 'fixture contents', durationMs: 3 })
      const usage = { invocationId: 'llm-1', promptTokens: 3, completionTokens: 2 }
      await observer.onUsage(usage)
      await observer.onUsage(usage)
      await observer.onOutcome({ status: 'succeeded', output: '已核实 README。' })
    })
    expect(run.status).toBe('succeeded')
    expect(run.resultSummary).toBe('已核实 README。')
    expect(run.toolCalls[0]).toMatchObject({ id: 'read-1', status: 'succeeded', args: { path: 'README.md' }, output: 'fixture contents' })
    expect(run.usage.totalTokens).toBe(5)
    expect((await store.getRun('tenant-a', run.runId))?.status).toBe('succeeded')
    expect((await store.listEvents('tenant-a', run.runId)).map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6])
    expect(events.at(-1)?.snapshot.status).toBe('succeeded')
  })

  it('cancels and joins every owned child across bounded run pages', async () => {
    runner = new SubagentRunner(store, new SubagentPool(2))
    const modern = { ...parent, subagentEventVersion: 2 as const, emitSubagentEvent: vi.fn() }
    const started: string[] = []
    const execute = async ({ snapshot, signal, observer }: Parameters<Parameters<SubagentRunner['run']>[2]>[0]) => {
      started.push(snapshot.runId)
      await new Promise<void>(resolve => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', () => resolve(), { once: true })
      })
      await observer.onOutcome({ status: 'succeeded', output: 'late result' })
    }
    const first = runner.run(input(), modern, execute)
    const second = runner.run(input(), modern, execute)
    try {
      await vi.waitFor(() => expect(started).toHaveLength(2))
      const firstView = (await store.getRunView('tenant-a', started[0]))!
      const secondView = (await store.getRunView('tenant-a', started[1]))!
      const pages = vi.spyOn(store, 'listRunViewsPage').mockImplementation(async (_tenant, session, options) => ({
        schemaVersion: 2 as const, parentSessionId: session, revision: 'fixture-revision', listComplete: options?.cursor !== undefined,
        runs: options?.cursor ? [secondView] : [firstView], hasMore: options?.cursor === undefined,
        ...(options?.cursor ? {} : { nextCursor: 'fixture-page-2' }),
      }))
      const fullList = vi.spyOn(store, 'listRunsForParent')
      await runner.cancelRunsForParent('tenant-a', 'root')
      expect((await first).status).toBe('cancelled')
      expect((await second).status).toBe('cancelled')
      expect(pages.mock.calls.map(call => call[2]?.cursor)).toEqual([undefined, 'fixture-page-2'])
      expect(fullList).not.toHaveBeenCalled()
      expect((await store.getRunHeader('tenant-a', firstView.runId))?.stopReason).toBe('parent_deleted')
      expect((await store.getRunHeader('tenant-a', secondView.runId))?.stopReason).toBe('parent_deleted')
    } finally {
      for (const runId of started) await runner.cancel('tenant-a', runId, 'fixture_cleanup')
      await Promise.all([first, second])
    }
  })

  it.each<RunOutcome>([
    { status: 'failed', stopReason: 'llm_error', error: { code: 'LLM_ERROR', message: '400 Request body format invalid', retryable: false } },
    { status: 'blocked', stopReason: 'approval_required', error: { code: 'APPROVAL_REQUIRED', message: '需要授权', retryable: false } },
    { status: 'failed', stopReason: 'max_steps', partialOutput: '已经读取了一个文件' },
  ])('does not report $stopReason as success', async (outcome) => {
    const run = await runner.run(input(), parent, async ({ observer }) => { await observer.onOutcome(outcome) })
    expect(run.status).toBe(outcome.status)
    expect(run.stopReason).toBe(outcome.stopReason)
    expect(run.resultSummary).toBeUndefined()
    expect(run.error).toEqual(outcome.error)
  })

  it('missing outcome remains failed even if an old strategy returns normally', async () => {
    const run = await runner.run(input(), parent, async () => undefined)
    expect(run.status).toBe('failed')
    expect(run.error?.code).toBe('MISSING_RUN_OUTCOME')
  })

  it('enforces tenant ownership and cancellation wins against late model success', async () => {
    let startedId = ''
    const result = runner.run(input(), parent, async ({ snapshot, signal, observer }) => {
      await observer.onToolStart({ toolCallId: 'active-command', name: 'cmd', args: { command: 'fixture' } })
      startedId = snapshot.runId
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
      await observer.onOutcome({ status: 'succeeded', output: '迟到结果' })
    })
    await vi.waitFor(() => expect(startedId).not.toBe(''))
    expect(await runner.cancel('other-tenant', startedId)).toBeNull()
    expect((await store.getRun('tenant-a', startedId))?.status).toBe('running')
    expect((await runner.cancel('tenant-a', startedId))?.status).toBe('cancelling')
    const run = await result
    expect(run.status).toBe('cancelled')
    expect(run.partialOutput).toBe('迟到结果')
    expect(run.externalEffectStatus).toBe('unknown')
    expect(run.toolCalls[0].status).toBe('cancelled')
    expect((await runner.cancel('tenant-a', startedId))?.status).toBe('cancelled')
  })

  it('same-name children retain separate identity; queued cancellation never starts work', async () => {
    let releaseFirst!: () => void
    let firstStarted = false
    const first = runner.run(input(), parent, async ({ observer }) => {
      firstStarted = true
      await new Promise<void>((resolve) => { releaseFirst = resolve })
      await observer.onOutcome({ status: 'succeeded', output: 'one' })
    })
    await vi.waitFor(() => expect(firstStarted).toBe(true))
    const secondInput = input()
    const secondExecute = vi.fn(async () => undefined)
    const second = runner.run(secondInput, parent, secondExecute)
    await vi.waitFor(async () => expect(await store.findByParentTool('tenant-a', 'root', secondInput.parentToolCallId)).not.toBeNull())
    const waiting = (await store.findByParentTool('tenant-a', 'root', secondInput.parentToolCallId))!
    expect(waiting.status).toBe('queued')
    await runner.cancel('tenant-a', waiting.runId)
    expect((await second).status).toBe('cancelled')
    expect(secondExecute).not.toHaveBeenCalled()
    releaseFirst()
    const completed = await first
    expect(completed.status).toBe('succeeded')
    expect(completed.runId).not.toBe(waiting.runId)
    expect(completed.description).toBe(waiting.description)
  })

  it('accounts physical attempts instead of double-counting loop usage', async () => {
    const run = await runner.run(input(), parent, async ({ observer, onRequestAttempt }) => {
      await onRequestAttempt({ type: 'start', requestAttemptId: 'attempt-1', provider: 'fixture', model: 'fixture', reservationTokens: 20 })
      await onRequestAttempt({ type: 'finish', requestAttemptId: 'attempt-1', provider: 'fixture', model: 'fixture', outcome: 'failed' })
      await onRequestAttempt({ type: 'start', requestAttemptId: 'attempt-2', provider: 'fixture', model: 'fixture', reservationTokens: 20 })
      await onRequestAttempt({ type: 'finish', requestAttemptId: 'attempt-2', provider: 'fixture', model: 'fixture', outcome: 'succeeded', usage: { promptTokens: 10, completionTokens: 4, cacheHitTokens: 5 } })
      await observer.onUsage({ invocationId: 'logical-call', promptTokens: 10, completionTokens: 4 })
      await observer.onOutcome({ status: 'succeeded', output: 'done' })
    })
    expect(run.usage).toMatchObject({ totalTokens: 14, cacheReadTokens: 5, unknown: true })
  })

  it('shares unlimited fallback accounting across active siblings without legacy context or env caps', async () => {
    runner = new SubagentRunner(store, new SubagentPool(2))
    parent.tokenBudget = 100
    vi.stubEnv('SUBAGENT_TOKEN_LIMIT', '100')
    let fallback: RequestBudget | undefined
    let releaseFirst!: () => void
    let firstReserved = false
    const first = runner.run(input(), parent, async ({ observer, onRequestAttempt, requestBudget }) => {
      fallback = requestBudget
      expect(fallback?.limit).toBe(Infinity)
      await onRequestAttempt({ type: 'start', requestAttemptId: 'first', provider: 'fixture', model: 'fixture', reservationTokens: 60 })
      await new Promise<void>((resolve) => { releaseFirst = resolve; firstReserved = true })
      await onRequestAttempt({ type: 'finish', requestAttemptId: 'first', provider: 'fixture', model: 'fixture', outcome: 'succeeded', usage: { promptTokens: 60, completionTokens: 20 } })
      await observer.onOutcome({ status: 'succeeded', output: 'first done' })
    })
    await vi.waitFor(() => expect(firstReserved).toBe(true))
    try {
      const second = await runner.run(input(), parent, async ({ observer, onRequestAttempt, requestBudget }) => {
        expect(requestBudget).toBe(fallback)
        await onRequestAttempt({ type: 'start', requestAttemptId: 'second', provider: 'fixture', model: 'fixture', reservationTokens: 60 })
        expect(fallback?.snapshot).toEqual({ charged: 0, reserved: 120, remaining: Infinity, unknown: false })
        await onRequestAttempt({ type: 'finish', requestAttemptId: 'second', provider: 'fixture', model: 'fixture', outcome: 'succeeded', usage: { promptTokens: 40, completionTokens: 30 } })
        await observer.onOutcome({ status: 'succeeded', output: 'second done' })
      })
      expect(second.status).toBe('succeeded')
      expect(second.error).toBeUndefined()
      expect(second.usage.totalTokens).toBe(70)
    } finally { releaseFirst(); await first }
    expect((await first).status).toBe('succeeded')
    expect((await first).usage.totalTokens).toBe(80)
    expect(fallback?.snapshot).toEqual({ charged: 150, reserved: 0, remaining: Infinity, unknown: false })
  })

  it('preserves explicit finite parent-budget slices and finalization reserves across active siblings', async () => {
    runner = new SubagentRunner(store, new SubagentPool(2))
    const budget = new RequestBudget(100)
    parent.requestBudget = budget
    parent.finalizationReserveTokens = 60
    let releaseFirst!: () => void
    let firstReserved = false
    const first = runner.run(input(), parent, async ({ observer, onRequestAttempt, requestBudget }) => {
      expect(requestBudget?.limit).toBe(25)
      await onRequestAttempt({ type: 'start', requestAttemptId: 'first-finite', provider: 'fixture', model: 'fixture', reservationTokens: 20 })
      await new Promise<void>(resolve => { releaseFirst = resolve; firstReserved = true })
      await onRequestAttempt({ type: 'finish', requestAttemptId: 'first-finite', provider: 'fixture', model: 'fixture', outcome: 'succeeded', usage: { promptTokens: 10, completionTokens: 5 } })
      await observer.onOutcome({ status: 'succeeded', output: 'first finite done' })
    })
    await vi.waitFor(() => expect(firstReserved).toBe(true))
    try {
      expect(budget.snapshot).toEqual({ charged: 0, reserved: 25, remaining: 75, unknown: false })
      const secondExecute = vi.fn(async () => undefined)
      const second = await runner.run(input(), parent, secondExecute)
      expect(second.status).toBe('failed')
      expect(second.error?.code).toBe('TOKEN_BUDGET_EXCEEDED')
      expect(secondExecute).not.toHaveBeenCalled()
      expect(budget.snapshot).toEqual({ charged: 0, reserved: 25, remaining: 75, unknown: false })
    } finally { releaseFirst(); await first }
    expect((await first).status).toBe('succeeded')
    expect(budget.snapshot).toEqual({ charged: 15, reserved: 0, remaining: 85, unknown: false })
    expect(budget.isClosed).toBe(false)
  })

  it('aborts an overdue child and persists its partial output with a failed deadline outcome', async () => {
    const run = await runner.run(input(), parent, async ({ observer, signal }) => {
      await observer.onOutput?.('已经读取项目入口')
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', () => resolve(), { once: true })
      })
    }, { deadlineMs: 50 })
    expect(run.status).toBe('failed')
    expect(run.stopReason).toBe('deadline_exceeded')
    expect(run.error?.code).toBe('DEADLINE_EXCEEDED')
    expect(run.partialOutput).toBe('已经读取项目入口')
  })

  it('keeps a Code child alive until explicit cancellation when no deadline is configured', async () => {
    vi.stubEnv('SUBAGENT_DEADLINE_MS', '')
    ;(parent as unknown as { toolProfile: string }).toolProfile = 'code'
    let started = false
    let runId = ''
    const result = runner.run(input(), parent, async ({ signal, snapshot, observer }) => {
      started = true
      runId = snapshot.runId
      await observer.onOutput?.('持续工作中')
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    })
    await vi.waitFor(() => expect(started).toBe(true))
    await new Promise(resolve => setTimeout(resolve, 75))
    expect((await store.getRun('tenant-a', runId))?.status).toBe('running')
    await runner.cancel('tenant-a', runId, 'test_cancel')
    expect((await result).status).toBe('cancelled')
  })

  it('bounds stored summaries and flushes partial output at terminal failure', async () => {
    const text = 'A'.repeat(20_000)
    const run = await runner.run(input(), parent, async ({ observer }) => {
      await observer.onOutput?.('first')
      await observer.onOutput?.(text)
      await observer.onOutcome({ status: 'failed', stopReason: 'provider_error' })
    })
    expect(run.partialOutput).toContain('内容已截断')
    expect(run.partialOutput!.length).toBeLessThan(8100)
    const success = await runner.run(input(), parent, async ({ observer }) => { await observer.onOutcome({ status: 'succeeded', output: text }) })
    expect(success.resultSummary!.length).toBeLessThan(8100)
  })
})

describe('SubagentStore: transactional snapshots, event replay and recovery', () => {
  it('creates idempotently, archives progress, and queues only terminal results', async () => {
    const definition = input()
    const event = await store.createRun(definition)
    const duplicate = await store.createRun(definition)
    expect(duplicate.runId).toBe(event.runId)
    expect((await store.listEvents('tenant-a', event.runId))).toHaveLength(1)
    expect(await store.listPendingParentProjections('tenant-a')).toEqual([])
    await store.appendSnapshot('tenant-a', event.runId, 'finished', { status: 'succeeded', resultSummary: 'Done' })
    const outbox = await store.listPendingParentProjections('tenant-a')
    expect(outbox).toHaveLength(1)
    expect((await store.listEvents('tenant-a', event.runId)).map(item => item.kind)).toEqual(['created', 'finished'])
    if (outbox[0].event.schemaVersion === 1) expect(outbox[0].event.snapshot).toEqual(await store.getRun('tenant-a', event.runId))
    else {
      expect(outbox[0].event.kind).toBe('snapshot')
      if (!('view' in outbox[0].event)) throw new Error('Terminal outbox lacks its bounded checkpoint view')
      expect(outbox[0].event.view).toEqual(await store.getRunView('tenant-a', event.runId))
    }
    await store.ackProjection(outbox[0].id, 'other-tenant')
    expect(await store.listPendingParentProjections('tenant-a')).toHaveLength(1)
    await store.ackProjection(outbox[0].id, 'tenant-a')
    expect(await store.listPendingParentProjections('tenant-a')).toHaveLength(0)
  })

  it('rolls back snapshot and event when outbox insertion fails', async () => {
    const event = await store.createRun(input())
    await db.execute("CREATE TRIGGER reject_test_outbox BEFORE INSERT ON subagent_outbox BEGIN SELECT RAISE(FAIL,'fixture outbox unavailable'); END")
    await expect(store.appendSnapshot('tenant-a', event.runId, 'finished', { status: 'succeeded' })).rejects.toThrow('fixture outbox unavailable')
    expect((await store.getRun('tenant-a', event.runId))?.status).toBe('queued')
    expect(await store.listEvents('tenant-a', event.runId)).toHaveLength(1)
  })

  it('reopens the on-disk database, recovers active runs once and never resurrects a terminal state', async () => {
    const event = await store.createRun(input())
    await store.appendSnapshot('tenant-a', event.runId, 'started', { status: 'running' })
    db.close()
    await db.whenClosed()
    db = new LocalSqliteProcessClient({ url: `file:${path.join(fixtureDir, 'runs.db').replace(/\\/g, '/')}` })
    const reopened = new SubagentStore(db)
    const recovered = await reopened.recoverInterrupted()
    expect(recovered).toHaveLength(1)
    expect(recovered[0]).toMatchObject({ runId: event.runId, kind: 'finished' })
    expect((await reopened.getRunHeader('tenant-a', event.runId))?.status).toBe('interrupted')
    const recoveredView = await reopened.getRunView('tenant-a', event.runId, { atSeq: recovered[0].seq })
    expect(recoveredView?.status).toBe('interrupted')
    expect(recoveredView?.lastSeq).toBe(recovered[0].seq)
    expect(await reopened.recoverInterrupted()).toHaveLength(0)
    expect(await reopened.appendSnapshot('tenant-a', event.runId, 'started', { status: 'running' })).toBeNull()
    expect((await reopened.getRun('tenant-a', event.runId))?.status).toBe('interrupted')
  })
})

describe('RequestBudget', () => {
  it('reserves concurrently, bills each retry, deduplicates finish and conservatively retains unknown usage', () => {
    const budget = new RequestBudget(30, 20)
    const start = { type: 'start' as const, requestAttemptId: 'first', provider: 'fixture', model: 'fixture' }
    budget.observe(start)
    expect(() => budget.observe({ ...start, requestAttemptId: 'parallel' })).toThrow(BudgetExceededError)
    const finish = { type: 'finish' as const, requestAttemptId: 'first', provider: 'fixture', model: 'fixture', outcome: 'failed' as const }
    budget.observe(finish)
    budget.observe(finish)
    expect(budget.snapshot).toEqual({ charged: 20, reserved: 0, remaining: 10, unknown: true })
    expect(() => budget.observe({ ...start, requestAttemptId: 'retry' })).toThrow(BudgetExceededError)
  })
})


it('ignores legacy child env caps under an unlimited HTTP parent while retaining actual usage', async () => {
  vi.stubEnv('SUBAGENT_TOKEN_LIMIT', '100')
  const budget = new RequestBudget()
  parent.requestBudget = budget
  parent.onRequestAttempt = event => budget.observe(event)
  const run = await runner.run(input(), parent, async ({ observer, onRequestAttempt, requestBudget }) => {
    expect(requestBudget).toBe(budget)
    await onRequestAttempt({ type: 'start', requestAttemptId: 'child-over-legacy-cap', provider: 'fixture', model: 'fixture', reservationTokens: 101 })
    expect(budget.snapshot).toEqual({ charged: 0, reserved: 101, remaining: Infinity, unknown: false })
    await onRequestAttempt({ type: 'finish', requestAttemptId: 'child-over-legacy-cap', provider: 'fixture', model: 'fixture', outcome: 'succeeded', usage: { promptTokens: 90, completionTokens: 20 } })
    await observer.onOutcome({ status: 'succeeded', output: 'Finished above the legacy child cap' })
  })
  expect(run.status).toBe('succeeded')
  expect(run.error).toBeUndefined()
  expect(run.usage.totalTokens).toBe(110)
  expect((await store.getRun('tenant-a', run.runId))?.usage.totalTokens).toBe(110)
  expect(budget.snapshot).toEqual({ charged: 110, reserved: 0, remaining: Infinity, unknown: false })
  expect(budget.isClosed).toBe(false)
  expect(budget.canAfford(600_000)).toBe(true)
})

it('archives complete browser screenshot output while keeping v2 event and resident previews bounded', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDdwAAAAASUVORK5CYII=', 'base64')
  const dataUrl = 'data:image/png;base64,' + Buffer.concat([png, Buffer.alloc(100_000)]).toString('base64')
  const output = JSON.stringify({ tab: { title: 'Login', url: 'https://example.test/' }, text: '登录界面😀',
    elements: [{ role: 'button', name: 'Log in', bounds: { x: 20, y: 30, width: 80, height: 32 } }],
    viewport: { width: 1000, height: 700 }, screenshot: { dataUrl, width: 1, height: 1 }, truncated: false })
  const streamed: SubagentWireEvent[] = []
  const modern = { ...parent, subagentEventVersion: 2 as const,
    emitSubagentEvent: (event: SubagentWireEvent) => { streamed.push(event) } }
  const archiveReads = vi.spyOn(store, 'getSnapshotsAtSequences')
  const run = await runner.run(input(), modern, async ({ observer }) => {
    await observer.onToolStart({ toolCallId: 'browser-1', name: 'browser_snapshot', args: {} })
    await observer.onToolEnd({ toolCallId: 'browser-1', name: 'browser_snapshot', success: true, output, durationMs: 3 })
    await observer.onOutcome({ status: 'succeeded', output: 'Inspected the page.' })
  })
  const preview = run.toolCalls[0].output!
  expect(Buffer.byteLength(preview, 'utf8')).toBeLessThanOrEqual(2048)
  expect(run.toolCalls[0]).toMatchObject({ detailTruncated: true,
    detailRef: expect.stringContaining(`?atSeq=${run.toolCalls[0].revisionSeq}`) })
  expect(run.coverage.truncated).toBe(true)
  expect(archiveReads).not.toHaveBeenCalled()
  expect(streamed.every(event => event.schemaVersion === 2 && !('snapshot' in event))).toBe(true)
  expect(Math.max(...streamed.map(event => Buffer.byteLength(JSON.stringify(event), 'utf8')))).toBeLessThan(16 * 1024)
  expect(JSON.stringify(streamed)).not.toContain(dataUrl)
  expect(JSON.stringify(run)).not.toContain(dataUrl)

  // The same watermark must page the original bytes, not a display-only
  // replacement which could silently discard screenshot pixels forever.
  let offset = 0, detailText = ''
  do {
    const chunk = await store.getToolDetail('tenant-a', run.runId, 'browser-1', { atSeq: run.lastSeq, offset, limitBytes: 4096 })
    expect(chunk).not.toBeNull()
    if (!chunk) throw new Error('Missing archived browser detail')
    expect(chunk.asOfSeq).toBe(run.lastSeq)
    expect(chunk.detail.offset).toBe(offset)
    expect(Buffer.byteLength(chunk.detail.text, 'utf8')).toBeLessThanOrEqual(4096)
    detailText += chunk.detail.text
    if (!chunk.detail.hasMore) break
    expect(chunk.detail.nextOffset).toBeGreaterThan(offset)
    offset = chunk.detail.nextOffset!
  } while (true)
  const archived = JSON.parse(detailText) as { output: string }
  expect(archived.output).toBe(output)
  expect(JSON.parse(archived.output)).toMatchObject({ screenshot: { dataUrl }, text: '登录界面😀' })
  const [canonical] = await store.getSnapshotsAtSequences('tenant-a', [{ runId: run.runId, seq: run.lastSeq }])
  expect(canonical.schemaVersion).toBe(1)
  expect(canonical.toolCalls).toHaveLength(1)
  expect(canonical.toolCalls[0].output).toBe(output)
})

describe('Subagent continuation ownership and concurrency', () => {
  const profile = { readOnly: true, systemPrompt: 'Keep the prior context', toolNames: ['read_file'], workspacePaths: [] }
  it('reuses the same durable child transcript while creating independent per-turn run records', async () => {
    vi.stubEnv('DATA_DIR', path.join(fixtureDir, 'runs.db'))
    const actual = getDb()
    if (!(actual instanceof LocalSqliteProcessClient)) throw new Error('Expected the fixture-owned projection database adapter')
    ownedProjectionDb = actual
    const { JSONLConversationHistory } = await import('../../../storage/conversation/jsonl-history.js')
    const first = await runner.run(input({ continuation: profile }), parent, async ({ snapshot, observer }) => {
      const context = { tenantId: snapshot.tenantId, sessionId: snapshot.childSessionId }
      const history = new JSONLConversationHistory()
      await history.clear(context, { tombstone: false })
      await new JSONLConversationHistory().append({ id: 'memory-one', role: 'user', content: 'The project codename is cedar-742.', createdAt: Date.now(), tokens: 10 }, context)
      await observer.onOutcome({ status: 'succeeded', output: 'Stored the project context' })
    })
    let historyRead = ''
    const next = await runner.run(input({ resumeFromRunId: first.runId }), parent, async ({ snapshot, observer }) => {
      const history = new JSONLConversationHistory()
      historyRead = (await history.getHistory({ tenantId: snapshot.tenantId, sessionId: snapshot.childSessionId })).map(row => row.content).join('\n')
      await observer.onOutcome({ status: 'succeeded', output: 'Continued' })
    })
    expect(next.runId).not.toBe(first.runId)
    expect(next.childSessionId).toBe(first.childSessionId)
    expect(next.continuation).toEqual({ readOnly: true })
    expect((await store.getRunHeader('tenant-a', next.runId, true))?.continuation).toEqual(profile)
    expect(historyRead).toContain('cedar-742')
    expect((await store.listRunsForParent('tenant-a', 'root')).length).toBe(2)
  })
  it('atomically refuses two concurrent resumptions of one child', async () => {
    const first = await runner.run(input({ continuation: profile }), parent, async ({ observer }) => { await observer.onOutcome({ status: 'succeeded', output: 'first' }) })
    const results = await Promise.allSettled([
      store.createRun(input({ resumeFromRunId: first.runId })),
      store.createRun(input({ resumeFromRunId: first.runId })),
    ])
    expect(results.filter(item => item.status === 'fulfilled')).toHaveLength(1)
    const failure = results.find(item => item.status === 'rejected')
    expect(failure && failure.status === 'rejected' ? String(failure.reason) : '').toContain('SUBAGENT_RESUME_BUSY')
  })
  it('rejects another tenant, parent or root and cannot forge a replacement child or permission profile', async () => {
    const first = await runner.run(input({ continuation: profile }), parent, async ({ observer }) => { await observer.onOutcome({ status: 'succeeded', output: 'first' }) })
    for (const overrides of [{ tenantId: 'other' }, { parentSessionId: 'other' }, { rootSessionId: 'other' }]) {
      await expect(store.createRun(input({ ...overrides, resumeFromRunId: first.runId }))).rejects.toThrow('SUBAGENT_RESUME_NOT_OWNED')
    }
    const next = await store.createRun(input({ resumeFromRunId: first.runId, childSessionId: 'forged', continuation: { ...profile, readOnly: false, toolNames: ['execute_cmd'] } }))
    expect(next.snapshot.childSessionId).toBe(first.childSessionId)
    expect(next.snapshot.continuation).toEqual(profile)
  })
})

describe('cancelled session-local planning has no unknown external effects', () => {
  it.each(['code', 'general'] as const)('%s persists real plan controls and their own session state without classifying cancellation as an external mutation', async toolProfile => {
    const database = await import('../../../storage/sqlite/db.js')
    const { up: todoSchema } = await import('../../../storage/sqlite/migrations/006_add_todos_cron.js')
    const { up: planSchema } = await import('../../../storage/sqlite/migrations/028_task_plans.js')
    const { todoTools } = await import('../../../tools/todo/todo-tool.js')
    const { TodoStore } = await import('../../../storage/todo/index.js')
    await todoSchema(db)
    await planSchema(db)
    const isolatedDb = vi.spyOn(database, 'getDb').mockReturnValue(db)
    const todos = new TodoStore()
    parent.toolProfile = toolProfile
    let runId = '', childSessionId = ''
    let readyToCancel = false
    const pending = runner.run(input(), parent, async ({ snapshot, observer, signal }) => {
      runId = snapshot.runId
      childSessionId = snapshot.childSessionId
      const child = { ...parent, sessionId: childSessionId }
      const control = async (name: string, args: unknown) => {
        const tool = todoTools.find(candidate => candidate.name === name)
        if (!tool) throw new Error('Missing builtin plan control: ' + name)
        const toolCallId = 'control-' + name
        await observer.onToolStart({ toolCallId, name, args })
        const result = await tool.execute(args, child)
        expect(result.success).toBe(true)
        await observer.onToolEnd({ toolCallId, name, success: result.success, output: result.output })
      }
      await control('plan_update', { plan: [{ step: 'Review retained changes', status: 'in_progress' }] })
      await control('todo_list', {})
      await control('todo_create', { title: 'Temporary local plan step' })
      const temporary = (await todos.list('tenant-a', childSessionId)).find(todo => todo.title === 'Temporary local plan step')
      expect(temporary).toBeDefined()
      if (!temporary) throw new Error('The real create did not persist')
      await control('todo_update', { id: temporary.id, status: 'done' })
      expect((await todos.getById(temporary.id, 'tenant-a', childSessionId))?.status).toBe('done')
      await control('todo_delete', { id: temporary.id })
      expect(await todos.getById(temporary.id, 'tenant-a', childSessionId)).toBeNull()
      readyToCancel = true
      await new Promise<void>(resolve => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', () => resolve(), { once: true })
      })
      await observer.onOutcome({ status: 'succeeded', output: 'Late plan-only result' })
    })
    try {
      await vi.waitFor(() => expect(readyToCancel).toBe(true))
      expect((await store.getRun('tenant-a', runId))?.status).toBe('running')
      expect((await runner.cancel('tenant-a', runId, 'test_user_cancel'))?.status).toBe('cancelling')
      const run = await pending
      expect(run.status).toBe('cancelled')
      expect(run.stopReason).toBe('test_user_cancel')
      expect(run.resultSummary).toBeUndefined()
      expect(run.partialOutput).toBe('Late plan-only result')
      expect(run.externalEffectStatus).toBeUndefined()
      expect([...run.toolCalls].sort((a, b) => a.ordinal - b.ordinal).map(tool => [tool.name, tool.status])).toEqual([
        ['plan_update', 'succeeded'], ['todo_list', 'succeeded'], ['todo_create', 'succeeded'],
        ['todo_update', 'succeeded'], ['todo_delete', 'succeeded'],
      ])
      const persisted = await store.getRun('tenant-a', runId)
      expect(persisted?.status).toBe('cancelled')
      expect(persisted?.externalEffectStatus).toBeUndefined()
      expect((await store.getRunView('tenant-a', runId))?.externalEffectStatus).toBeUndefined()
      expect(events.at(-1)?.snapshot.status).toBe('cancelled')
      expect(events.at(-1)?.snapshot.externalEffectStatus).toBeUndefined()
      expect((await todos.getPlan('tenant-a', childSessionId)).plan).toEqual([
        { id: expect.any(String), step: 'Review retained changes', status: 'in_progress' },
      ])
      expect((await todos.getPlan('tenant-a', parent.sessionId)).plan).toEqual([])
    } finally {
      if (runId) await runner.cancel('tenant-a', runId, 'fixture_cleanup')
      await pending
      isolatedDb.mockRestore()
    }
  })
})
