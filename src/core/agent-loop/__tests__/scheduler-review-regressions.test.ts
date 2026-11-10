/** Scheduler observation ordering only. Real owner/SQLite contracts are tested separately. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext, Message } from '../../agent-context/types.js'
import type { DependencyHook, HookSnapshot } from '../../subagent/dependency-hooks.js'
import { ChildResultReview } from '../child-result-review.js'

const fixture = vi.hoisted(() => ({ read: vi.fn(), block: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn(),
  observe: vi.fn(), change: vi.fn(), mailbox: vi.fn(), activity: vi.fn(), take: vi.fn(), evaluate: vi.fn(), consume: vi.fn() }))
vi.mock('../../subagent/dependency-hooks.js', () => ({
  readHookSnapshot: fixture.read, blockUnresolvedHooks: fixture.block, subscribeHookChanges: fixture.subscribe,
  takeDependencyWait: fixture.take, evaluateDependencyHooks: fixture.evaluate, recordDependencyJoinFailure: vi.fn(), consumeHooks: fixture.consume,
}))
vi.mock('../../subagent/runner.js', () => ({ getSubagentRunner: () => ({ observeOwned: fixture.observe, waitForOwnedChange: fixture.change }) }))
vi.mock('../../collaboration/execution-owner.js', () => ({ serviceForOwner: () => ({
  producerForExecution: () => ({}), collaboration: { waitForInput: fixture.mailbox },
}) }))
vi.mock('../../../storage/root-runs/index.js', () => ({ rootRunStore: { setActivityOwned: fixture.activity } }))

const tick = () => new Promise<void>(resolve => setImmediate(resolve))
function gate<T>() {
  let release!: (value: T) => void
  const promise = new Promise<T>(resolve => { release = resolve })
  return { promise, release }
}
function hook(id: string, state: DependencyHook['state']): DependencyHook {
  return { id, stepId: id, label: id, revision: 1, state, refs: [id + '-child'], resolvedRunIds: [id + '-child'], unresolvedRefs: [] }
}
function snapshot(hooks: DependencyHook[] = [hook('current', 'armed')]): HookSnapshot {
  return { revision: 1, hooks, hasHooks: true, activeHookCount: hooks.filter(item => ['armed', 'ready', 'blocked'].includes(item.state)).length,
    managedRunIds: hooks.flatMap(item => item.resolvedRunIds), suppressedRunIds: [] }
}
function context(signal: AbortSignal): AgentContext {
  return { tenantId: 'fixture', sessionId: 'parent', rootRunId: 'root', turnId: 'turn', executionOwner: {}, signal,
    emitRootActivity: vi.fn() } as unknown as AgentContext
}
let observers = 0
/** Match cancellation of an observation, without producing any child completion or model request. */
function pending(signals: AbortSignal[]): Promise<void> {
  observers++
  let cleanup = () => {}
  return new Promise<void>((_resolve, reject) => {
    const listeners = signals.map(signal => ({ signal, onAbort: () => reject(signal.reason) }))
    cleanup = () => { for (const item of listeners) item.signal.removeEventListener('abort', item.onAbort) }
    for (const item of listeners) item.signal.addEventListener('abort', item.onAbort, { once: true })
    for (const item of listeners) if (item.signal.aborted) item.onAbort()
  }).finally(() => { cleanup(); observers-- })
}
beforeEach(() => {
  vi.resetAllMocks(); observers = 0
  fixture.read.mockResolvedValue(snapshot()); fixture.block.mockResolvedValue(snapshot())
  fixture.take.mockReturnValue(true); fixture.subscribe.mockImplementation(() => fixture.unsubscribe)
  fixture.observe.mockResolvedValue({ revision: 0, runs: [] })
  fixture.change.mockImplementation((ctx: AgentContext, _revision: number, signal: AbortSignal) => pending([ctx.signal!, signal]))
  fixture.mailbox.mockImplementation((_producer: unknown, signal: AbortSignal) => pending([signal]))
  fixture.activity.mockImplementation(async (_owner, activity) => ({ runId: 'root', version: 2, status: 'running', activity }))
})
afterEach(() => { expect(observers).toBe(0) })

describe('dependency scheduler review regressions', () => {
  it('handles observation rejection immediately while the post-subscription database read is held', async () => {
    const controller = new AbortController(), readEntered = gate<void>(), readRelease = gate<HookSnapshot>()
    const errors: unknown[] = [], capture = (reason: unknown) => { errors.push(reason) }
    process.on('unhandledRejection', capture)
    fixture.read.mockResolvedValueOnce(snapshot()).mockImplementationOnce(async () => { readEntered.release(); return readRelease.promise })
    const operation = new ChildResultReview().waitWhenRequested(context(controller.signal))
    void operation.catch(() => undefined)
    try {
      await readEntered.promise
      expect(observers).toBe(2)
      controller.abort(new Error('User cancelled during durable recheck'))
      // Let Node finish rejection reporting while the DB gate remains closed.
      await tick(); await tick()
      expect(errors).toEqual([])
      expect(fixture.unsubscribe).not.toHaveBeenCalled()
      readRelease.release(snapshot())
      await expect(operation).rejects.toThrow('User cancelled during durable recheck')
      expect(fixture.unsubscribe).toHaveBeenCalledTimes(1)
      expect(observers).toBe(0)
    } finally {
      readRelease.release(snapshot()); controller.abort(); await operation.catch(() => undefined)
      process.off('unhandledRejection', capture)
    }
  })

  it('cleans a synchronous mailbox subscription failure without leaving the child-change observer', async () => {
    fixture.mailbox.mockImplementation(() => { throw new Error('Mailbox subscription refused') })
    const controller = new AbortController()
    await expect(new ChildResultReview().waitWhenRequested(context(controller.signal))).rejects.toThrow('Mailbox subscription refused')
    expect(fixture.unsubscribe).toHaveBeenCalledTimes(1)
    expect(fixture.change).toHaveBeenCalledTimes(1)
    expect(observers).toBe(0)
  })

  it('does not defer a synchronous hook subscription error behind the next durable read', async () => {
    const subscribed = gate<void>(), held = gate<HookSnapshot>(), controller = new AbortController()
    fixture.subscribe.mockImplementation(() => { subscribed.release(); throw new Error('Hook subscription refused') })
    fixture.read.mockResolvedValueOnce(snapshot()).mockImplementationOnce(() => held.promise)
    const operation = new ChildResultReview().waitWhenRequested(context(controller.signal))
    let observedError: unknown
    void operation.catch(error => { observedError = error })
    try {
      await subscribed.promise; await tick(); await tick()
      expect(observedError).toEqual(expect.objectContaining({ message: 'Hook subscription refused' }))
      expect(fixture.read).toHaveBeenCalledTimes(1)
      expect(observers).toBe(0)
    } finally { held.release(snapshot()); controller.abort(); await operation.catch(() => undefined) }
  })

  it('keeps the current dependency visible after 32 earlier groups have already been consumed', async () => {
    const state = snapshot([...Array.from({ length: 32 }, (_, i) => hook('old-' + i, 'consumed')), hook('current', 'armed')])
    fixture.read.mockResolvedValue(state); fixture.block.mockResolvedValue(state)
    const subscribed = gate<void>(), controller = new AbortController()
    fixture.subscribe.mockImplementation(() => { subscribed.release(); return fixture.unsubscribe })
    const operation = new ChildResultReview().waitWhenRequested(context(controller.signal)); void operation.catch(() => undefined)
    try {
      await subscribed.promise
      const activity = fixture.activity.mock.calls[0][1]
      expect(activity.phase).toBe('waiting_children')
      expect(activity.groups.length).toBeLessThanOrEqual(32)
      expect(activity.groups).toContainEqual(expect.objectContaining({ id: 'current', state: 'waiting', total: 1, settled: 0 }))
      expect(activity.groups.every((item: { state: string }) => item.state === 'consumed')).toBe(false)
    } finally { controller.abort(new Error('Fixture ended')); await operation.catch(() => undefined) }
    expect(fixture.unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('counts one resolved child once when both its run ID and task key refer to it', async () => {
    const state = snapshot([{ ...hook('aliased', 'armed'), refs: ['same-child', 'task:one'], resolvedRunIds: ['same-child'] }])
    fixture.read.mockResolvedValue(state); fixture.block.mockResolvedValue(state)
    const subscribed = gate<void>(), controller = new AbortController()
    fixture.subscribe.mockImplementation(() => { subscribed.release(); return fixture.unsubscribe })
    const operation = new ChildResultReview().waitWhenRequested(context(controller.signal)); void operation.catch(() => undefined)
    try {
      await subscribed.promise
      expect(fixture.activity.mock.calls[0][1]).toEqual({ phase: 'waiting_children', groups: [
        { id: 'aliased', label: 'aliased', state: 'waiting', total: 1, settled: 0, failed: 0 },
      ] })
    } finally { controller.abort(new Error('Fixture ended')); await operation.catch(() => undefined) }
    expect(fixture.unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('projects only visible evidence for compaction without injecting or consuming dependency hooks', async () => {
    const armed = { ...hook('half-ready', 'armed'), refs: ['arrived', 'pending'], resolvedRunIds: ['arrived', 'pending'] }
    const state = { ...snapshot([armed, hook('ready', 'ready')]), suppressedRunIds: ['withdrawn'] }
    fixture.read.mockResolvedValue(state)
    const ctx = context(new AbortController().signal), review = new ChildResultReview()
    const messages: Message[] = [
      { id: 'user', role: 'user', content: 'Complete the task using the collected evidence.' },
      { id: 'subagent-result:arrived', role: 'assistant', content: 'PARTIAL_RESULT_MUST_NOT_ENTER_SUMMARY' },
      { id: 'subagent-result:ready-child', role: 'assistant', content: 'READY_RESULT_MUST_REMAIN' },
      { id: 'subagent-result:withdrawn', role: 'assistant', content: 'SUPPRESSED_RESULT_MUST_NOT_ENTER_SUMMARY' },
      { id: 'dependency-hooks:0', role: 'assistant', content: 'STALE_HOOK_EVENT',
        metadata: { dependencyHooks: [{ id: 'ready', revision: 1 }] } },
      { id: 'ordinary', role: 'assistant', content: 'Retain ordinary history.' },
    ]
    const original = structuredClone(messages)
    const projected = await review.projectForCompaction(ctx, messages)
    expect(projected).toEqual([messages[0], messages[2], messages[5]])
    expect(messages).toEqual(original)
    expect(projected.some(message => message.metadata?.dependencyHooks)).toBe(false)
    expect(review.pending).toBe(false)
    await review.commitResponse(ctx, 'compaction-is-not-a-parent-response')
    expect(fixture.read).toHaveBeenCalledTimes(1)
    expect(fixture.consume).not.toHaveBeenCalled()
    expect(fixture.evaluate).not.toHaveBeenCalled()
    expect(fixture.observe).not.toHaveBeenCalled()
    expect(fixture.subscribe).not.toHaveBeenCalled()
    expect(fixture.activity).not.toHaveBeenCalled()
  })
})
