import { createClient, type Client } from '@libsql/client'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext } from '../../agent-context/types.js'
import { RequestBudget, BudgetExceededError } from '../budget.js'
import { SubagentPool } from '../pool.js'
import { SubagentRunner } from '../runner.js'
import { SubagentStore } from '../store.js'
import type { CreateSubagentRun, RunOutcome, SubagentEvent } from '../types.js'

vi.mock('../projection.js', () => ({ projectPendingSubagents: vi.fn().mockResolvedValue(undefined) }))

let db: Client
let store: SubagentStore
let runner: SubagentRunner
let events: SubagentEvent[]
let parent: AgentContext
let sequence = 0
let fixtureDir: string

function input(overrides: Partial<CreateSubagentRun> = {}): CreateSubagentRun {
  return { tenantId: 'tenant-a', rootSessionId: 'root', parentSessionId: 'root', parentConversationId: 'turn', parentMessageId: 'message', parentToolCallId: `tool-${++sequence}`, task: '读取 README', description: '同名调研', modelId: 'fixture', ...overrides }
}

beforeEach(() => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-subagent-runtime-'))
  db = createClient({ url: `file:${path.join(fixtureDir, 'runs.db').replace(/\\/g, '/')}` })
  store = new SubagentStore(db)
  runner = new SubagentRunner(store, new SubagentPool(1))
  events = []
  parent = {
    tenantId: 'tenant-a', sessionId: 'root', tokenBudget: 100_000,
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    history: {}, emitSubagentEvent: (event: SubagentEvent) => { events.push(event) },
  } as unknown as AgentContext
})

afterEach(() => {
  vi.unstubAllEnvs()
  db.close()
  if (path.dirname(fixtureDir) !== path.resolve(os.tmpdir()) || !path.basename(fixtureDir).startsWith('aether-subagent-runtime-')) throw new Error('Unsafe fixture cleanup path')
  try { fs.rmSync(fixtureDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 20 }) }
  catch (error) {
    // libsql detaches transaction connections; Windows may keep the fixture locked until the worker exits.
    if (process.platform !== 'win32' || !(error instanceof Error) || !('code' in error) || error.code !== 'EPERM') throw error
  }
})

describe('SubagentRunner: typed outcome and durable lifecycle', () => {
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

  it('shares fallback reservations between concurrently active siblings until they finish', async () => {
    runner = new SubagentRunner(store, new SubagentPool(2))
    parent.tokenBudget = 100
    vi.stubEnv('SUBAGENT_TOKEN_LIMIT', '100')
    let releaseFirst!: () => void
    let firstReserved = false
    const first = runner.run(input(), parent, async ({ observer, onRequestAttempt }) => {
      await onRequestAttempt({ type: 'start', requestAttemptId: 'first', provider: 'fixture', model: 'fixture', reservationTokens: 60 })
      await new Promise<void>((resolve) => { releaseFirst = resolve; firstReserved = true })
      await onRequestAttempt({ type: 'finish', requestAttemptId: 'first', provider: 'fixture', model: 'fixture', outcome: 'succeeded', usage: { promptTokens: 10, completionTokens: 5 } })
      await observer.onOutcome({ status: 'succeeded', output: 'first done' })
    })
    await vi.waitFor(() => expect(firstReserved).toBe(true))
    try {
      const second = await runner.run(input(), parent, async ({ observer, onRequestAttempt }) => {
        await onRequestAttempt({ type: 'start', requestAttemptId: 'second', provider: 'fixture', model: 'fixture', reservationTokens: 60 })
        await observer.onOutcome({ status: 'succeeded', output: 'must not have budget' })
      })
      expect(second.status).toBe('failed')
      expect(second.error?.code).toBe('TOKEN_BUDGET_EXCEEDED')
    } finally { releaseFirst(); await first }
    expect((await first).status).toBe('succeeded')
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
  it('creates idempotently and commits snapshot/event/outbox together', async () => {
    const definition = input()
    const event = await store.createRun(definition)
    const duplicate = await store.createRun(definition)
    expect(duplicate.runId).toBe(event.runId)
    expect((await store.listEvents('tenant-a', event.runId))).toHaveLength(1)
    const outbox = await store.listPendingParentProjections('tenant-a')
    expect(outbox).toHaveLength(1)
    expect(outbox[0].event.snapshot).toEqual(await store.getRun('tenant-a', event.runId))
    await store.ackProjection(outbox[0].id, 'other-tenant')
    expect(await store.listPendingParentProjections('tenant-a')).toHaveLength(1)
    await store.ackProjection(outbox[0].id, 'tenant-a')
    expect(await store.listPendingParentProjections('tenant-a')).toHaveLength(0)
  })

  it('rolls back snapshot and event when outbox insertion fails', async () => {
    const event = await store.createRun(input())
    await db.execute("CREATE TRIGGER reject_test_outbox BEFORE INSERT ON subagent_outbox BEGIN SELECT RAISE(FAIL,'fixture outbox unavailable'); END")
    await expect(store.appendSnapshot('tenant-a', event.runId, 'started', { status: 'running' })).rejects.toThrow('fixture outbox unavailable')
    expect((await store.getRun('tenant-a', event.runId))?.status).toBe('queued')
    expect(await store.listEvents('tenant-a', event.runId)).toHaveLength(1)
  })

  it('reopens the on-disk database, recovers active runs once and never resurrects a terminal state', async () => {
    const event = await store.createRun(input())
    await store.appendSnapshot('tenant-a', event.runId, 'started', { status: 'running' })
    db.close()
    db = createClient({ url: `file:${path.join(fixtureDir, 'runs.db').replace(/\\/g, '/')}` })
    const reopened = new SubagentStore(db)
    const recovered = await reopened.recoverInterrupted()
    expect(recovered).toHaveLength(1)
    expect(recovered[0].snapshot.status).toBe('interrupted')
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


it('honors an explicitly configured child cap under an unlimited HTTP parent without limiting the parent', async () => {
  vi.stubEnv('SUBAGENT_TOKEN_LIMIT', '100')
  const budget = new RequestBudget()
  parent.requestBudget = budget
  parent.onRequestAttempt = event => budget.observe(event)
  const run = await runner.run(input(), parent, async ({ onRequestAttempt }) => {
    await onRequestAttempt({ type: 'start', requestAttemptId: 'child-over-cap', provider: 'fixture', model: 'fixture', reservationTokens: 101 })
    throw new Error('Over-cap child request must not start')
  })
  expect(run.status).toBe('failed')
  expect(run.error?.code).toBe('TOKEN_BUDGET_EXCEEDED')
  expect(budget.snapshot).toEqual({ charged: 0, reserved: 0, remaining: Infinity, unknown: false })
  expect(budget.canAfford(600_000)).toBe(true)
})

it('keeps browser tool overview JSON complete without copying archived screenshot pixels into parent snapshots', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDdwAAAAASUVORK5CYII=', 'base64')
  const dataUrl = 'data:image/png;base64,' + Buffer.concat([png, Buffer.alloc(100_000)]).toString('base64')
  const output = JSON.stringify({ tab: { title: 'Login', url: 'https://example.test/' }, text: 'Log in',
    elements: [{ role: 'button', name: 'Log in', bounds: { x: 20, y: 30, width: 80, height: 32 } }],
    viewport: { width: 1000, height: 700 }, screenshot: { dataUrl, width: 1, height: 1 }, truncated: false })
  const run = await runner.run(input(), parent, async ({ observer }) => {
    await observer.onToolStart({ toolCallId: 'browser-1', name: 'browser_snapshot', args: {} })
    await observer.onToolEnd({ toolCallId: 'browser-1', name: 'browser_snapshot', success: true, output, durationMs: 3 })
    await observer.onOutcome({ status: 'succeeded', output: 'Inspected the page.' })
  })
  const preview = run.toolCalls[0].output!
  expect(preview.length).toBeLessThanOrEqual(32_000)
  expect(preview).not.toContain('data:image')
  expect(JSON.parse(preview)).toMatchObject({ screenshot: { retainedForDisplay: true, width: 1, height: 1 },
    elements: [{ name: 'Log in', bounds: { x: 20, y: 30, width: 80, height: 32 } }] })
  expect((await store.getRun('tenant-a', run.runId))?.toolCalls[0].output).toBe(preview)
  expect(events.at(-1)?.snapshot.toolCalls[0].output).toBe(preview)
})
