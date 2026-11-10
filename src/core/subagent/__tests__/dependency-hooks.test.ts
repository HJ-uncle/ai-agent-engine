/** Dependency readiness over actual SQLite, owned executors and durable transcript projection. */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext } from '../../agent-context/types.js'
import * as database from '../../../storage/sqlite/db.js'
import { LocalSqliteProcessClient } from '../../../storage/sqlite/local-process-client.js'
import { RootRunStore, type RootRun } from '../../../storage/root-runs/index.js'
import { createConversationHistory } from '../../../storage/conversation/factory.js'
import { TodoStore } from '../../../storage/todo/index.js'
import { SubagentRunner, type SubagentExecution } from '../runner.js'
import { SubagentStore } from '../store.js'
import type { RunOutcome } from '../types.js'
import { CollaborationRuntime } from '../../collaboration/runtime.js'
import { CollaborationStore } from '../../collaboration/store.js'
import { ExecutionOwners, initializeOwnedExecutionStartup, type ExecutionOwner } from '../../collaboration/execution-owner.js'
import { bindTaskKey, blockUnresolvedHooks, claimTaskKey, consumeHooks, evaluateDependencyHooks,
  readHookSnapshot, recordDependencyJoinFailure, subscribeHookChanges, takeDependencyWait } from '../dependency-hooks.js'

const tenant = 'dependency-hooks', plans = new TodoStore()
let backend = 'jsonl', directory: string, db: LocalSqliteProcessClient, roots: RootRunStore, root: RootRun
let agents: SubagentStore, runner: SubagentRunner, runtime: CollaborationRuntime, owners: ExecutionOwners, owner: ExecutionOwner, parent: AgentContext
const releases: (() => void)[] = [], joins: Promise<unknown>[] = []
function gate() { let release!: () => void; const promise = new Promise<void>(yes => { release = yes }); releases.push(release); return { promise, release } }
async function input(key: string) {
  const value = { tenantId: tenant, rootSessionId: root.sessionId, parentSessionId: root.sessionId, parentConversationId: root.turnId,
    parentMessageId: 'dispatch:' + key, parentToolCallId: key, task: 'Exact child ' + key, description: key, modelId: 'scripted-only',
    continuation: { readOnly: true, systemPrompt: '', toolNames: [], workspacePaths: [directory] } }
  await parent.history.append({ id: value.parentMessageId, role: 'assistant', content: '',
    toolCall: { id: key, name: 'subagent_start', args: {} }, ...{ conversationId: root.turnId } }, parent)
  return value
}
async function held(key: string, outcome: RunOutcome = { status: 'succeeded', output: 'Exact child output' }) {
  const entered = gate(), finish = gate(); let execution!: SubagentExecution
  const start = await runner.start(await input(key), parent, async current => { execution = current; entered.release(); await finish.promise; await current.observer.onOutcome(outcome) })
  joins.push(start.completion.catch(() => undefined)); await entered.promise
  return { start, finish, execution }
}
const update = (value: unknown, ctx = parent) => plans.updatePlan(tenant, root.sessionId, value, ctx)
async function oneHook(ref: string, step = 'Merge') {
  return update({ plan: [{ step, status: 'pending', wakeWhen: { allSucceeded: [ref] } }] })
}
async function setupOwner() {
  agents = new SubagentStore(db); runtime = new CollaborationRuntime(new CollaborationStore(db), agents); owners = new ExecutionOwners(db, runtime)
  owner = await owners.admitRoot({ tenantId: tenant, rootRunId: root.runId, rootAttemptId: (await roots.get(tenant, root.runId))!.attemptId, controller: new AbortController() })
  parent = { tenantId: tenant, sessionId: root.sessionId, rootRunId: root.runId, turnId: root.turnId, conversationId: root.turnId,
    executionOwner: owner, history: createConversationHistory(), logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as unknown as AgentContext
  runner = new SubagentRunner(agents)
}
beforeEach(async () => {
  await database.closeDb()
  fs.mkdirSync('.e2e-tmp', { recursive: true }); directory = fs.mkdtempSync(path.resolve('.e2e-tmp/dependency-hooks-'))
  vi.stubEnv('DATA_DIR', path.join(directory, 'fixture.db')); vi.stubEnv('HISTORY_BACKEND', backend)
  db = new LocalSqliteProcessClient({ url: 'file:' + path.join(directory, 'fixture.db').replaceAll('\\', '/') })
  vi.spyOn(database, 'getDb').mockImplementation(() => db)
  await database.initDb()
  roots = new RootRunStore(() => db); root = await roots.create(tenant, 'parent', 'scripted-only', [directory], {})
  await setupOwner()
})
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  await Promise.allSettled(joins.splice(0)); await database.closeDb(); expect((await db.closeWithReceipt()).healthy).toBe(true)
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (path.dirname(directory) !== path.resolve('.e2e-tmp') || !path.basename(directory).startsWith('dependency-hooks-')) throw new Error('Unsafe hook fixture cleanup')
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 })
})

describe.each(['jsonl','sqlite'])('%s durable dependency hooks', selected => {
  beforeAll(() => { backend = selected })
  it('A needs child 1, B needs both 2 and 3; partial completion never makes B ready', async () => {
    const first = await held('one'), second = await held('two'), third = await held('three')
    const plan = await update({ plan: [
      { step: 'A', status: 'pending', wakeWhen: { allSucceeded: [first.start.runId] } },
      { step: 'B', status: 'pending', wakeWhen: { allSucceeded: [second.start.runId,third.start.runId] } },
    ] })
    second.finish.release(); const secondResult = await second.start.completion
    expect((await evaluateDependencyHooks(parent, [secondResult])).hooks.map(hook => hook.state)).toEqual(['armed','armed'])
    first.finish.release(); const firstResult = await first.start.completion
    const firstReady = await evaluateDependencyHooks(parent, [firstResult])
    expect(firstReady.hooks.map(hook => [hook.label,hook.state])).toEqual([['A','ready'],['B','armed']])
    await consumeHooks(parent, [firstReady.hooks[0]], 'request-A')
    third.finish.release(); const final = await evaluateDependencyHooks(parent, [await third.start.completion])
    expect(final.hooks.map(hook => [hook.state,hook.conditionOutcome])).toEqual([['consumed','ready'],['ready','ready']])
    expect(final.managedRunIds).toEqual([first.start.runId,second.start.runId,third.start.runId])
    expect(final.activeHookCount).toBe(1); expect(final.hasHooks).toBe(true)
    expect(await plans.getPlan(tenant, root.sessionId)).toEqual(plan)
  })
  it('terminal DB status cannot bypass the executor, durable projection, or canonical ticket join', async () => {
    const executorEntered = gate(), executorRelease = gate(), projectionEntered = gate(), projectionRelease = gate()
    const history = parent.history as AgentContext['history'] & Required<Pick<AgentContext['history'],'appendIfActiveToolCallAnchor'>>
    const append = history.appendIfActiveToolCallAnchor.bind(history)
    vi.spyOn(history, 'appendIfActiveToolCallAnchor').mockImplementation(async (...args) => { projectionEntered.release(); await projectionRelease.promise; return append(...args) })
    const start = await runner.start(await input('join-phases'), parent, async execution => {
      await execution.observer.onOutcome({ status: 'succeeded', output: 'Visible before actual executor ends' }); executorEntered.release(); await executorRelease.promise
    }); joins.push(start.completion.catch(() => undefined))
    await oneHook(start.runId); await executorEntered.promise
    const executing = (await agents.getRunView(tenant, start.runId))!
    expect(executing.status).toBe('running')
    await expect(evaluateDependencyHooks(parent, [{ ...executing, status: 'succeeded' }])).rejects.toThrow('DEPENDENCY_JOIN_EXECUTOR_UNSETTLED')
    executorRelease.release(); await projectionEntered.promise
    const terminal = (await agents.getRunView(tenant, start.runId))!
    expect(terminal.status).toBe('succeeded')
    await expect(evaluateDependencyHooks(parent, [terminal])).rejects.toThrow('DEPENDENCY_JOIN_EXECUTOR_UNSETTLED')
    expect((await readHookSnapshot(parent)).hooks[0].state).toBe('armed')
    projectionRelease.release()
    expect((await evaluateDependencyHooks(parent, [await start.completion])).hooks[0].state).toBe('ready')
  })
  it('reserves a task key before dispatch, rejects payload/key collisions, and binds only its actual tool call', async () => {
    await oneHook('task:build')
    expect(await claimTaskKey(parent, 'build', 'build-tool', 'hash-one')).toEqual({})
    expect(await claimTaskKey(parent, 'build', 'build-tool', 'hash-one')).toEqual({})
    await expect(claimTaskKey(parent, 'build', 'other-tool', 'hash-one')).rejects.toThrow('ALREADY_RESERVED')
    await expect(claimTaskKey(parent, 'build', 'build-tool', 'hash-two')).rejects.toThrow('PAYLOAD_CONFLICT')
    const other = await held('other-tool'), own = await held('build-tool')
    await expect(bindTaskKey(parent, 'build', other.start.runId)).rejects.toThrow('REQUEST_MISMATCH')
    await expect(bindTaskKey(parent, 'missing', own.start.runId)).rejects.toThrow('NOT_RESERVED')
    own.finish.release(); const result = await own.start.completion
    expect((await evaluateDependencyHooks(parent, [result])).hooks[0].unresolvedRefs).toEqual(['task:build'])
    const bound = await bindTaskKey(parent, 'build', own.start.runId)
    expect(bound.hooks[0]).toMatchObject({ state: 'ready', resolvedRunIds: [own.start.runId], unresolvedRefs: [] })
    expect(await claimTaskKey(parent, 'build', 'build-tool', 'hash-one')).toEqual({ runId: own.start.runId })
    expect((await bindTaskKey(parent, 'build', own.start.runId)).revision).toBe(bound.revision)
    other.finish.release(); await other.start.completion
  })
  it('registration after a joined completion evaluates durable receipts and consumption preserves the outcome', async () => {
    const child = await held('already-done'); child.finish.release(); const result = await child.start.completion
    expect((await evaluateDependencyHooks(parent, [result])).hasHooks).toBe(false)
    const plan = await oneHook(result.runId)
    const ready = (await readHookSnapshot(parent)).hooks[0]
    expect(ready.state).toBe('ready')
    const consumed = await consumeHooks(parent, [ready], 'request-one')
    expect(consumed.hooks[0]).toMatchObject({ state: 'consumed', conditionOutcome: 'ready', consumedRequestId: 'request-one' })
    expect((await consumeHooks(parent, [ready], 'request-one')).revision).toBe(consumed.revision)
    await expect(consumeHooks(parent, [ready], 'request-two')).rejects.toThrow('CONSUMPTION_STALE')
    await expect(consumeHooks(parent, [{ id: ready.id, revision: ready.revision + 1 }], 'request-one')).rejects.toThrow('CONSUMPTION_STALE')
    await update({ plan: plan.plan.map(({ wakeWhen: _wake, ...step }) => ({ ...step, status: 'completed', step: 'Merged and verified' })) })
    expect((await readHookSnapshot(parent)).hooks[0]).toMatchObject({ id: ready.id, state: 'consumed', label: 'Merged and verified', revision: ready.revision })
    expect((await plans.getPlan(tenant, root.sessionId)).plan[0].wakeWhen).toEqual({ allSucceeded: [result.runId] })
  })
  it('revised dependencies supersede, explicit null and plan removal cancel but preserve managed result ownership', async () => {
    const first = await held('revision-one'), second = await held('revision-two')
    let plan = await oneHook(first.start.runId)
    plan = await update({ plan: [{ ...plan.plan[0], wakeWhen: { allSucceeded: [second.start.runId,first.start.runId] } }] })
    let snap = await readHookSnapshot(parent)
    expect(snap.hooks.map(hook => [hook.revision,hook.state])).toEqual([[1,'superseded'],[2,'armed']])
    expect(plan.plan[0].wakeWhen!.allSucceeded).toEqual([second.start.runId,first.start.runId])
    await update({ plan: [{ ...plan.plan[0], wakeWhen: { allSucceeded: [first.start.runId,second.start.runId] } }] })
    expect((await readHookSnapshot(parent)).hooks).toHaveLength(2)
    await update({ plan: [{ ...plan.plan[0], wakeWhen: null }] })
    snap = await readHookSnapshot(parent)
    expect(snap.hasHooks).toBe(true); expect(snap.activeHookCount).toBe(0)
    expect(snap.managedRunIds.sort()).toEqual([first.start.runId,second.start.runId].sort())
    expect(snap.hooks.map(hook => hook.state)).toEqual(['superseded','cancelled'])
    expect((await plans.getPlan(tenant, root.sessionId)).plan[0].wakeWhen).toBeUndefined()
    await update({ plan: [] }); expect((await readHookSnapshot(parent)).hasHooks).toBe(true)
    first.finish.release(); second.finish.release()
    await evaluateDependencyHooks(parent, await Promise.all([first.start.completion,second.start.completion]))
    expect((await readHookSnapshot(parent)).activeHookCount).toBe(0)
  })
  it.each(['failed','blocked','cancelled'] as const)('%s child resolves to one exception branch even while another dependency is unfinished', async status => {
    const failed = await held('failure', { status, output: 'Cannot continue' }), unfinished = await held('unfinished')
    await update({ plan: [{ step: 'Merge both', status: 'pending', wakeWhen: { allSucceeded: [failed.start.runId,unfinished.start.runId] } }] })
    failed.finish.release(); const result = await failed.start.completion
    const snap = await evaluateDependencyHooks(parent, [result])
    expect(snap.hooks[0]).toMatchObject({ state: 'blocked', conditionOutcome: 'blocked', issue: { runId: result.runId } })
    expect((await evaluateDependencyHooks(parent, [result])).revision).toBe(snap.revision)
    const consumed = await consumeHooks(parent, [snap.hooks[0]], 'exception-request')
    unfinished.finish.release(); await evaluateDependencyHooks(parent, [await unfinished.start.completion])
    expect((await readHookSnapshot(parent)).hooks[0]).toEqual(consumed.hooks[0])
  })
  it('a deleted result projection becomes blocked, never successful readiness', async () => {
    const child = await held('suppressed'); await oneHook(child.start.runId)
    await parent.history.deleteMessage('dispatch:suppressed', tenant)
    child.finish.release(); const result = await child.start.completion
    const snap = await evaluateDependencyHooks(parent, [result])
    expect(snap.hooks[0]).toMatchObject({ state: 'blocked', issue: { code: 'DEPENDENCY_RESULT_SUPPRESSED' } })
    expect(snap.suppressedRunIds).toEqual([child.start.runId])
  })
  it('retains every suppressed result after another failure already blocked and consumed the same dependency group', async () => {
    const failed = await held('first-failure', { status: 'failed', output: 'Original failure' })
    const firstSuppressed = await held('late-suppressed-one'), secondSuppressed = await held('late-suppressed-two')
    await update({ plan: [{ step: 'Merge', status: 'pending', wakeWhen: {
      allSucceeded: [failed.start.runId,firstSuppressed.start.runId,secondSuppressed.start.runId],
    } }] })
    failed.finish.release()
    const blocked = await evaluateDependencyHooks(parent, [await failed.start.completion])
    expect(blocked.hooks[0]).toMatchObject({ state: 'blocked', issue: { runId: failed.start.runId } })
    expect(blocked.suppressedRunIds).toEqual([])
    await consumeHooks(parent, [blocked.hooks[0]], 'first-failure-handled')
    for (const [key, child] of [['late-suppressed-one',firstSuppressed],['late-suppressed-two',secondSuppressed]] as const) {
      await parent.history.deleteMessage('dispatch:' + key, tenant)
      child.finish.release(); await evaluateDependencyHooks(parent, [await child.start.completion])
    }
    const snap = await readHookSnapshot(parent)
    expect(snap.hooks[0]).toMatchObject({ state: 'consumed', conditionOutcome: 'blocked', issue: { runId: failed.start.runId } })
    expect(snap.suppressedRunIds).toEqual([firstSuppressed.start.runId,secondSuppressed.start.runId])
    expect(snap.suppressedRunIds).not.toContain(snap.hooks[0].issue!.runId)
    expect((await evaluateDependencyHooks(parent, [await firstSuppressed.start.completion,await secondSuppressed.start.completion])).suppressedRunIds).toEqual(snap.suppressedRunIds)
  })
  it('projection failure requires a failed canonical ticket and produces one durable exception', async () => {
    const child = await held('projection-error'); await oneHook(child.start.runId)
    await expect(recordDependencyJoinFailure(parent, child.start.runId)).rejects.toThrow('FAILURE_UNPROVEN')
    const history = parent.history as AgentContext['history'] & Required<Pick<AgentContext['history'],'appendIfActiveToolCallAnchor'>>
    vi.spyOn(history, 'appendIfActiveToolCallAnchor').mockRejectedValue(new Error('Projection disk unavailable'))
    child.finish.release(); await expect(child.start.completion).rejects.toThrow('Projection disk unavailable')
    const snap = await recordDependencyJoinFailure(parent, child.start.runId, 'PROJECTION_FAILED')
    expect(snap.hooks[0]).toMatchObject({ state: 'blocked', issue: { code: 'PROJECTION_FAILED' } })
    expect((await recordDependencyJoinFailure(parent, child.start.runId, 'PROJECTION_FAILED')).revision).toBe(snap.revision)
    await expect(recordDependencyJoinFailure(parent, child.start.runId, 'CHANGED_ERROR')).rejects.toThrow('RECEIPT_CONFLICT')
  })
  it('only an explicit committed wait with active hooks sets the one-shot owner marker', async () => {
    await expect(update({ plan: [], awaitDependencies: true })).rejects.toThrow('REQUIRES_ACTIVE_HOOK')
    expect(takeDependencyWait(parent)).toBe(false)
    let plan = await update({ plan: [{ step: 'Wait', status: 'pending', wakeWhen: { allSucceeded: ['task:later'] } }], awaitDependencies: false })
    expect(takeDependencyWait(parent)).toBe(false)
    plan = await update({ plan: plan.plan, awaitDependencies: true })
    expect(takeDependencyWait(parent)).toBe(true); expect(takeDependencyWait(parent)).toBe(false)
    await expect(update({ plan: [{ ...plan.plan[0], step: 'Rollback', wakeWhen: null }], awaitDependencies: true })).rejects.toThrow('REQUIRES_ACTIVE_HOOK')
    expect(await plans.getPlan(tenant, root.sessionId)).toEqual(plan); expect(takeDependencyWait(parent)).toBe(false)
    await expect(update({ plan: plan.plan, expectedRevision: plan.revision + 1, awaitDependencies: true })).rejects.toThrow('计划已变化')
    expect(takeDependencyWait(parent)).toBe(false)
    await expect(update({ plan: plan.plan, awaitDependencies: true }, { ...parent, executionOwner: undefined })).rejects.toThrow('OWNER_REQUIRED')
    expect((await roots.get(tenant, root.runId))!.status).toBe('running')
  })
  it('unstarted task references block only at the explicit wait boundary and do not rearm on late binding', async () => {
    const plan = await oneHook('task:missing')
    expect((await readHookSnapshot(parent)).hooks[0].state).toBe('armed')
    const blocked = await blockUnresolvedHooks(parent)
    expect(blocked.hooks[0]).toMatchObject({ state: 'blocked', issue: { code: 'DEPENDENCY_TASK_NOT_STARTED' } })
    expect((await blockUnresolvedHooks(parent)).revision).toBe(blocked.revision)
    await consumeHooks(parent, [blocked.hooks[0]], 'missing-dispatch')
    const child = await held('late'); await claimTaskKey(parent, 'missing', 'late'); await bindTaskKey(parent, 'missing', child.start.runId)
    child.finish.release(); await evaluateDependencyHooks(parent, [await child.start.completion])
    expect((await readHookSnapshot(parent)).hooks[0].state).toBe('consumed')
    await update({ plan: [{ ...plan.plan[0], wakeWhen: { allSucceeded: [child.start.runId] } }] })
    expect((await readHookSnapshot(parent)).hooks.at(-1)).toMatchObject({ state: 'ready', revision: 2 })
  })
  it('invalid conditions, foreign runs, stale revisions and excess hooks roll back the entire plan', async () => {
    const plan = await update({ plan: [{ step: 'Existing', status: 'pending' }] })
    for (const wakeWhen of [{ allSucceeded: ['foreign-run'] }, { allSucceeded: ['task:dup','task:dup'] }, { allSucceeded: [] }, { allSucceeded: ['task:bad key'] }]) {
      await expect(update({ plan: [{ ...plan.plan[0], step: 'Must rollback', wakeWhen }] })).rejects.toThrow()
      expect(await plans.getPlan(tenant, root.sessionId)).toEqual(plan)
    }
    await expect(update({ plan: Array.from({ length: 33 }, (_, i) => ({ step: 'Hook ' + i, status: 'pending', wakeWhen: { allSucceeded: ['task:key-' + i] } })) })).rejects.toThrow('ACTIVE_LIMIT')
    expect(await plans.getPlan(tenant, root.sessionId)).toEqual(plan)
    expect((await readHookSnapshot(parent)).hooks).toEqual([])
    expect((await update({ plan: Array.from({ length: 100 }, (_, i) => ({ step: 'Plain ' + i, status: 'pending' })) })).plan).toHaveLength(100)
  })
  it('canonical authority rejects child capabilities, foreign contexts and forged terminal receipts', async () => {
    const child = await held('authority'); await oneHook(child.start.runId)
    const childContext = { ...parent, sessionId: child.start.childSessionId, rootSessionId: root.sessionId, runId: child.start.runId, executionOwner: child.execution.executionOwner }
    for (const ctx of [childContext,{ ...parent, tenantId: 'foreign' },{ ...parent, rootRunId: 'foreign' },{ ...parent, turnId: 'foreign' },{ ...parent, rootSessionId: 'foreign' }]) {
      await expect(readHookSnapshot(ctx)).rejects.toThrow()
    }
    child.finish.release(); const result = await child.start.completion
    await expect(evaluateDependencyHooks(parent, [{ ...result, tenantId: 'foreign' }])).rejects.toThrow('RECEIPT_MISMATCH')
    await expect(evaluateDependencyHooks(parent, [{ ...result, lastSeq: result.lastSeq + 1 }])).rejects.toThrow('EXECUTOR_UNSETTLED')
    expect((await readHookSnapshot(parent)).hooks[0].state).toBe('armed')
  })
  it('post-commit notifications do not repeat for idempotent evaluation and unsubscribe removes the observer', async () => {
    const child = await held('notify'); await oneHook(child.start.runId)
    const notify = vi.fn(), stop = subscribeHookChanges(parent, notify)
    child.finish.release(); const result = await child.start.completion
    const snap = await evaluateDependencyHooks(parent, [result]); expect(notify).toHaveBeenCalledTimes(1)
    await evaluateDependencyHooks(parent, [result]); expect(notify).toHaveBeenCalledTimes(1)
    expect((await readHookSnapshot(parent)).revision).toBe(snap.revision)
    stop(); await consumeHooks(parent, [snap.hooks[0]], 'notify-request'); expect(notify).toHaveBeenCalledTimes(1)
  })
  it('saved conditions survive reconnect but an old owner or new attempt cannot replay their authority', async () => {
    const plan = await oneHook('task:old-work'), oldParent = parent, oldRootId = root.runId
    expect((await db.closeWithReceipt()).healthy).toBe(true)
    db = new LocalSqliteProcessClient({ url: 'file:' + path.join(directory, 'fixture.db').replaceAll('\\', '/') })
    await database.initDb(); await initializeOwnedExecutionStartup()
    expect(await plans.getPlan(tenant, root.sessionId)).toEqual(plan)
    await expect(readHookSnapshot(oldParent)).rejects.toThrow()
    root = await roots.create(tenant, 'parent', 'scripted-only', [directory], {}); await setupOwner()
    expect(root.runId).not.toBe(oldRootId)
    expect((await readHookSnapshot(parent)).hasHooks).toBe(false)
    await update({ plan: plan.plan.map(({ wakeWhen: _wake, ...step }) => step) })
    expect((await readHookSnapshot(parent)).hasHooks).toBe(false)
    const rows = (await db.execute('SELECT state FROM dependency_hooks')).rows
    expect(rows.map(row => row.state)).toEqual(['superseded'])
    await expect(update({ plan: plan.plan.map(({ wakeWhen: _wake, ...step }) => step), awaitDependencies: true })).rejects.toThrow('REQUIRES_ACTIVE_HOOK')
    expect(takeDependencyWait(parent)).toBe(false)
  })
  it('deleting a root removes its dependency metadata without deleting unrelated session plan content', async () => {
    const child = await held('delete-root')
    const plan = await oneHook('task:delete-task')
    await claimTaskKey(parent, 'delete-task', 'delete-root'); await bindTaskKey(parent, 'delete-task', child.start.runId)
    child.finish.release(); await evaluateDependencyHooks(parent, [await child.start.completion])
    await roots.deleteTurns(tenant, root.sessionId, [root.turnId])
    for (const table of ['dependency_hook_scopes','dependency_hooks','dependency_task_bindings','dependency_joined_results','task_plan_wake_conditions'])
      expect((await db.execute('SELECT COUNT(*) AS n FROM ' + table)).rows[0].n).toBe(0)
    expect((await plans.getPlan(tenant, root.sessionId)).plan).toEqual(plan.plan.map(({ wakeWhen: _wake, ...step }) => step))
    await expect(readHookSnapshot(parent)).rejects.toThrow()
  })
})
