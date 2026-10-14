import type { AgentContext } from '../agent-context/types.js'
import { createHash, randomUUID } from 'node:crypto'
import { serviceForOwner, type ExecutionOwner } from '../collaboration/execution-owner.js'
import { projectOwnedSubagent } from './projection.js'
import { BudgetExceededError, RequestBudget, type RequestAttempt } from './budget.js'
import { logRequestDispatch } from '../llm-adapter/dispatch-diagnostics.js'
import { SubagentPool } from './pool.js'
import { getSubagentStore, SubagentStore } from './store.js'
import { isTerminalRun, type CreateSubagentRun, type RunError, type RunObserver, type RunOutcome,
  type SubagentMutation, type SubagentRunHeader, type SubagentRunView } from './types.js'

interface ActiveRun {
  controller: AbortController
  emit(event: SubagentMutation): Promise<void>
}

export interface SubagentStart {
  readonly runId: string
  readonly childSessionId: string
  readonly admittedSeq: number
  /** The runner and canonical root retain this executor plus projection join. */
  readonly completion: Promise<SubagentRunView>
}
export type SubagentWait = { state: 'completed'; run: SubagentRunView } | { state: 'pending'; runId: string }
export interface SubagentWaitOptions { timeoutMs?: number; signal?: AbortSignal }
interface OwnedCompletion { runner: SubagentRunner; start: SubagentStart }
// A second runner instance cannot reinterpret readable durable IDs as a new
// executor. Ephemeral owner keys release the receipts with the canonical root.
const ownedCompletions = new WeakMap<ExecutionOwner, Map<string, OwnedCompletion>>()

export interface SubagentExecution {
  executionOwner?: ExecutionOwner
  snapshot: SubagentRunHeader
  signal: AbortSignal
  observer: RunObserver
  requestBudget?: RequestBudget
  onRequestAttempt(event: RequestAttempt): Promise<void>
}

function errorInfo(error: unknown): RunError {
  const candidate = error instanceof Error ? error : new Error(String(error))
  const code = error instanceof BudgetExceededError ? error.code : 'SUBAGENT_EXECUTION_FAILED'
  return { code, message: candidate.message, retryable: false }
}

function boundedText(text: string | undefined, limit = 8000): string | undefined {
  if (text === undefined || text.length <= limit) return text
  return `${text.slice(0, limit)}\n[内容已截断；子任务转录保留已落盘内容]`
}

function concurrencyLimit(): number {
  const value = Number(process.env.SUBAGENT_CONCURRENCY_LIMIT)
  return Number.isInteger(value) && value > 0 ? Math.min(value, 16) : 3
}

/** Owns lifecycle and persistence; a model's text is never interpreted as an execution status. */
export class SubagentRunner {
  private readonly active = new Map<string, ActiveRun>()
  private readonly completions = new Map<string, Promise<SubagentRunView>>()
  private readonly fallbackBudgets = new Map<string, RequestBudget>()
  private readonly budgetUsers = new Map<string, number>()

  constructor(readonly store: SubagentStore = getSubagentStore(), private readonly pool = new SubagentPool(concurrencyLimit())) {}

  private key(tenantId: string, runId: string): string { return `${tenantId}:${runId}` }

  async run(input: CreateSubagentRun, parent: AgentContext, execute: (execution: SubagentExecution) => Promise<void>, options: { deadlineMs?: number } = {}): Promise<SubagentRunView> {
    return (await this.admitAndStart(input, parent, execute, options)).completion
  }

  /** Return only after actual durable admission, while the canonical ticket owns the unfinished work. */
  start(input: CreateSubagentRun, parent: AgentContext, execute: (execution: SubagentExecution) => Promise<void>, options: { deadlineMs?: number } = {}): Promise<SubagentStart> {
    if (!parent.executionOwner) return Promise.reject(new Error('ASYNC_SUBAGENT_REQUIRES_CANONICAL_OWNER'))
    return this.admitAndStart({ ...input, parentToolName: 'subagent_start' }, parent, execute, options, true)
  }

  private async admitAndStart(input: CreateSubagentRun, parent: AgentContext, execute: (execution: SubagentExecution) => Promise<void>, options: { deadlineMs?: number }, asynchronous = false): Promise<SubagentStart> {
    const service = parent.executionOwner ? serviceForOwner(parent.executionOwner) : undefined
    if (service && service.db !== this.store.db) throw new Error('SUBAGENT_DATASOURCE_MISMATCH')
    if (service && parent.executionOwner) {
      const binding = service.collaboration.executionBinding(service.producerForExecution(parent.executionOwner))
      if (binding.kind !== 'root' || binding.tenantId !== parent.tenantId || binding.sessionId !== parent.sessionId
        || binding.rootRunId !== parent.rootRunId || binding.turnId !== parent.turnId) throw new Error('SUBAGENT_PARENT_AUTHORITY_MISMATCH')
    }
    const ticket = service && parent.executionOwner ? service.reserveChild(parent.executionOwner) : undefined
    try {
    let created: SubagentMutation
    let childProducer: import('../collaboration/types.js').CollaborationProducer | undefined
    if (service && parent.executionOwner) {
      const producer = service.producer(parent.executionOwner)
      try {
        const admitted = await service.collaboration.admitChild(producer, input)
        created = admitted.mutation; childProducer = admitted.producer
      }
      catch (error) {
        // A commit can win even when its response is lost. Reconcile the exact
        // immutable dispatch; never repeat creation or the external executor.
        const admitted = await service.collaboration.lookupChildAdmissionReceipt(producer, input)
        if (!admitted) throw error
        childProducer = await service.collaboration.recoverChildProducer(producer, input) ?? undefined
        if (!childProducer) throw new Error('SUBAGENT_PRODUCER_RECOVERY_UNKNOWN')
        const header = await this.store.getRunHeader(input.tenantId, admitted.invocationRunId, true)
        const view = await this.store.getRunView(input.tenantId, admitted.invocationRunId)
        if (!header || !view) throw new Error('SUBAGENT_ADMISSION_UNKNOWN')
        created = { header, view, event: { schemaVersion: 2, kind: 'snapshot', runId: header.runId, seq: header.lastSeq, view } }
      }
    } else created = await this.store.createRunDelta(input)
    const snapshot = created.header
    if (service && ticket && !childProducer) throw new Error('SUBAGENT_PRODUCER_MISSING')
    const childOwner = service && ticket ? service.attachChild(ticket, snapshot.runId, childProducer!) : undefined
    const key = this.key(snapshot.tenantId, snapshot.runId)
    const owned = parent.executionOwner ? ownedCompletions.get(parent.executionOwner)?.get(snapshot.runId) : undefined
    const prior = owned?.start.completion ?? this.completions.get(key)
    if (asynchronous && !prior && snapshot.status !== 'queued') throw new Error('SUBAGENT_EXECUTOR_JOIN_UNKNOWN')
    const promise = prior ?? (isTerminalRun(snapshot.status) ? Promise.resolve(created.view) : this.execute(snapshot, created,
      service && ticket ? { ...parent, signal: service.ticketSignal(ticket) } : parent, execute, options, childOwner))
    const completion = (async () => { try {
      const result = await promise
      if (service && ticket) {
        const projection = await projectOwnedSubagent(parent.history, this.store, result.tenantId, result.runId, result.lastSeq)
        service.completeChild(ticket, { runId: result.runId, terminalSeq: result.lastSeq, projection })
      }
      return result
    } catch (error) { if (service && ticket) service.failChild(ticket, error); throw error } })()
    // Admission may return before the caller ever waits. Rejection remains
    // observable to wait/root drain without becoming an unhandled rejection.
    void completion.catch(() => undefined)
    if (!prior) {
      this.completions.set(key, completion)
      void completion.finally(() => { if (this.completions.get(key) === completion) this.completions.delete(key) }).catch(() => undefined)
    }
    const start = Object.freeze({ runId: snapshot.runId, childSessionId: snapshot.childSessionId, admittedSeq: snapshot.lastSeq, completion })
    if (parent.executionOwner) {
      let runs = ownedCompletions.get(parent.executionOwner)
      if (!runs) { runs = new Map(); ownedCompletions.set(parent.executionOwner, runs) }
      runs.set(snapshot.runId, { runner: owned?.runner ?? this, start })
    }
    return start
    } catch (error) { if (service && ticket) service.failChild(ticket, error); throw error }
  }

  private async ownedCompletion(parent: AgentContext, runId: string): Promise<OwnedCompletion> {
    if (!parent.executionOwner) throw new Error('ASYNC_SUBAGENT_REQUIRES_CANONICAL_OWNER')
    const service = serviceForOwner(parent.executionOwner), producer = service.producerForExecution(parent.executionOwner)
    const binding = service.collaboration.executionBinding(producer)
    if (service.db !== this.store.db || binding.kind !== 'root' || binding.tenantId !== parent.tenantId || binding.sessionId !== parent.sessionId
      || binding.rootRunId !== parent.rootRunId || binding.turnId !== parent.turnId) throw new Error('SUBAGENT_PARENT_AUTHORITY_MISMATCH')
    await service.collaboration.store.assertProducer(service.db, binding, true)
    const owned = ownedCompletions.get(parent.executionOwner)?.get(runId)
    if (!owned) throw new Error('SUBAGENT_EXECUTOR_JOIN_UNKNOWN: 当前执行未持有该子代理的真实 join；重启后的持久记录只作 interrupted 历史，不会自动重跑或取得旧执行权限。')
    const run = await this.store.getRunHeader(binding.tenantId, runId)
    if (!run || run.tenantId !== binding.tenantId || run.parentSessionId !== binding.sessionId || run.rootSessionId !== binding.rootSessionId
      || run.parentConversationId !== binding.turnId || run.childSessionId !== owned.start.childSessionId) throw new Error('SUBAGENT_PARENT_AUTHORITY_MISMATCH')
    // Recheck local ownership after both durable reads; a replaced attempt is
    // never allowed to complete a wait or initiate a cancellation.
    await service.collaboration.store.assertProducer(service.db, binding, true)
    service.producerForExecution(parent.executionOwner)
    return owned
  }

  /** Timeout/abort ends this observation only; it never aborts a shared child executor. */
  async waitOwned(parent: AgentContext, runId: string, options: SubagentWaitOptions = {}): Promise<SubagentWait> {
    const timeout = options.timeoutMs ?? 30_000
    if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 60_000) throw new RangeError('Invalid subagent wait timeout')
    const signals = [...new Set([parent.signal, options.signal].filter((signal): signal is AbortSignal => !!signal))]
    for (const signal of signals) signal.throwIfAborted()
    const owned = await this.ownedCompletion(parent, runId)
    const result = await new Promise<SubagentWait>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined, done = false
      const listeners = signals.map(signal => ({ signal, listener: () => settle(() => reject(signal.reason ?? new Error('Subagent wait aborted'))) }))
      const cleanup = () => { if (timer) clearTimeout(timer); for (const { signal, listener } of listeners) signal.removeEventListener('abort', listener) }
      const settle = (action: () => void) => { if (!done) { done = true; cleanup(); action() } }
      for (const { signal, listener } of listeners) { if (done) break; signal.addEventListener('abort', listener, { once: true }); if (signal.aborted) listener() }
      if (done) return
      owned.start.completion.then(run => settle(() => resolve({ state: 'completed', run })), error => settle(() => reject(error)))
      timer = setTimeout(() => settle(() => resolve({ state: 'pending', runId })), timeout)
    })
    for (const signal of signals) signal.throwIfAborted()
    await this.ownedCompletion(parent, runId)
    return result
  }

  /** A cancellation ACK is pending until the actual executor, projection and ticket all join. */
  async cancelOwned(parent: AgentContext, runId: string, options: SubagentWaitOptions & { reason?: string } = {}): Promise<SubagentWait> {
    if (!Number.isSafeInteger(options.timeoutMs ?? 30_000) || (options.timeoutMs ?? 30_000) < 0 || (options.timeoutMs ?? 30_000) > 60_000) throw new RangeError('Invalid subagent wait timeout')
    parent.signal?.throwIfAborted(); options.signal?.throwIfAborted()
    const owned = await this.ownedCompletion(parent, runId)
    parent.signal?.throwIfAborted(); options.signal?.throwIfAborted()
    serviceForOwner(parent.executionOwner!).producerForExecution(parent.executionOwner!)
    await owned.runner.cancel(parent.tenantId, runId, options.reason ?? 'model_cancelled')
    return this.waitOwned(parent, runId, options)
  }

  private async execute(initial: SubagentRunHeader, created: SubagentMutation, parent: AgentContext, execute: (execution: SubagentExecution) => Promise<void>, options: { deadlineMs?: number }, executionOwner?: ExecutionOwner): Promise<SubagentRunView> {
    const { tenantId, runId } = initial
    const key = this.key(tenantId, runId)
    const controller = new AbortController()
    const emit = async (mutation: SubagentMutation | null): Promise<void> => {
      if (!mutation || !parent.emitSubagentEvent) return
      try {
        if (parent.subagentEventVersion === 2) await parent.emitSubagentEvent(mutation.event)
        else {
          // Compatibility is negotiated at the viewing boundary. New live
          // clients use deltas; an explicit legacy consumer reads its exact
          // canonical prefix only when it actually subscribes to events.
          const [snapshot] = await this.store.getSnapshotsAtSequences(tenantId, [{ runId, seq: mutation.event.seq }])
          if (!snapshot) throw new Error('SUBAGENT_LEGACY_PREFIX_UNAVAILABLE')
          const kind = mutation.event.kind === 'snapshot' ? isTerminalRun(snapshot.status) ? 'finished' : 'created' : mutation.event.kind
          await parent.emitSubagentEvent({ schemaVersion: 1, kind, runId,
            seq: mutation.event.seq, snapshot })
        }
      } catch (error) {
        // A disconnected viewer can replay persisted events; it must not kill otherwise valid work.
        parent.logger.warn({ err: error, runId }, 'Subagent event delivery failed; event remains persisted')
      }
    }
    this.active.set(key, { controller, emit })
    let cancelPromise: Promise<SubagentRunView | null> | undefined
    const onParentAbort = () => {
      if (!controller.signal.aborted) controller.abort(new Error('parent_cancelled'))
      cancelPromise = this.cancel(tenantId, runId, 'parent_cancelled')
    }
    parent.signal?.addEventListener('abort', onParentAbort, { once: true })
    if (parent.signal?.aborted) onParentAbort()
    let timedOut = false
    // Subagents run until completion or explicit cancellation. The old
    // general-mode ten-minute default cut off valid long audits/builds.
    const requestedTimeout = options.deadlineMs
    const timeout = requestedTimeout === undefined || requestedTimeout === Infinity
      ? undefined
      : Math.max(1, Number.isFinite(requestedTimeout) ? requestedTimeout : 10 * 60_000)
    const timer = timeout === undefined ? undefined : setTimeout(() => {
      timedOut = true
      cancelPromise = this.cancel(tenantId, runId, 'deadline_exceeded')
    }, Math.max(1, timeout))
    timer?.unref?.()
    let release: (() => void) | undefined
    let requestBudget: RequestBudget | undefined
    let outcome: RunOutcome | undefined
    let attemptsSeen = false
    let partialOutput = ''
    let lastOutputWrite = 0
    const group = `${tenantId}:${initial.rootSessionId}:${initial.parentConversationId}`
    const fallback = this.fallbackBudgets.get(group) ?? new RequestBudget(Infinity)
    this.fallbackBudgets.set(group, fallback)
    this.budgetUsers.set(group, (this.budgetUsers.get(group) ?? 0) + 1)
    const observer: RunObserver = {
      onOutcome: (value) => { outcome = value },
      onOutput: async (text) => {
        partialOutput = boundedText(text) ?? ''
        if (Date.now() - lastOutputWrite < 200) return
        lastOutputWrite = Date.now()
        await emit(await this.store.appendHeader(tenantId, runId, 'output.updated', { partialOutput }, { allowedStatuses: ['running', 'cancelling'] }))
      },
      onToolStart: async (tool) => {
        await emit(await this.store.upsertTool(tenantId, runId, 'tool.started', {
          id: tool.toolCallId, name: tool.name, args: tool.args, status: 'running', startedAt: Date.now(),
        }))
      },
      onToolEnd: async (tool) => {
        await emit(await this.store.upsertTool(tenantId, runId, 'tool.completed', {
          id: tool.toolCallId, name: tool.name, status: controller.signal.aborted ? 'cancelled' : tool.success ? 'succeeded' : 'failed',
          output: tool.output,
          ...(tool.error ? { error: tool.error } : {}), finishedAt: Date.now(),
          ...(tool.durationMs !== undefined ? { durationMs: tool.durationMs } : {}),
        }))
      },
      onUsage: async (usage) => {
        // Adapters with physical-attempt callbacks already accounted for success and failed retries.
        if (!attemptsSeen) await emit(await this.store.recordUsageDelta(tenantId, runId, usage))
      },
    }
    const onRequestAttempt = async (event: RequestAttempt): Promise<void> => {
      attemptsSeen = true
      if (requestBudget) requestBudget.observe(event)
      else if (parent.onRequestAttempt) await parent.onRequestAttempt(event)
      else fallback.observe(event)
      logRequestDispatch(event, parent.logger, { subagentRunId: runId })
      if (event.type === 'start' && event.model !== initial.modelId) {
        await emit(await this.store.appendHeader(tenantId, runId, 'usage.updated', { modelId: event.model }))
      }
      if (event.type === 'finish') {
        await emit(await this.store.recordUsageDelta(tenantId, runId, {
          invocationId: event.requestAttemptId,
          promptTokens: event.usage?.promptTokens ?? 0,
          completionTokens: event.usage?.completionTokens ?? 0,
          cacheHitTokens: event.usage?.cacheHitTokens,
          cacheMissTokens: event.usage?.cacheMissTokens,
          cacheWriteTokens: event.usage?.cacheWriteTokens,
          unknown: !event.usage || event.usage.unknown === true,
        }))
      }
    }

    try {
      await emit(created)
      if (cancelPromise) await cancelPromise
      release = await this.pool.acquire(`${tenantId}:${initial.parentSessionId}`, controller.signal)
      const started = await this.store.appendHeader(tenantId, runId, 'started', { status: 'running', startedAt: Date.now() }, { allowedStatuses: ['queued'] })
      if (!started) {
        if (!controller.signal.aborted) controller.abort(new Error('Run no longer queued'))
      } else {
        await emit(started)
        const configuredChildLimit = Infinity
        if (parent.requestBudget && (Number.isFinite(parent.requestBudget.limit) || Number.isFinite(configuredChildLimit))) {
          // Only explicitly enabled budgets allocate slices; the default unlimited parent/child path only records usage.
          const finiteParent = Number.isFinite(parent.requestBudget.limit)
          const childLimit = finiteParent ? Math.min(configuredChildLimit, Math.floor(parent.requestBudget.limit * 0.25)) : configuredChildLimit
          const parentReserve = finiteParent ? Math.max(Math.ceil(parent.requestBudget.limit * 0.2), parent.finalizationReserveTokens ?? 0) : 0
          requestBudget = parent.requestBudget.fork(Math.max(1, childLimit), parentReserve)
        }
        const executionHeader = await this.store.getRunHeader(tenantId, runId, true)
        if (!executionHeader) throw new Error(`Subagent run ${runId} disappeared before execution`)
        await execute({ snapshot: executionHeader, signal: controller.signal, observer, onRequestAttempt, executionOwner, requestBudget: requestBudget ?? parent.requestBudget ?? (!parent.onRequestAttempt ? fallback : undefined) })
      }
      if (!outcome) outcome = { status: 'failed', stopReason: 'missing_outcome', error: { code: 'MISSING_RUN_OUTCOME', message: '子代理循环未报告明确终态，未将文本误判为成功。', retryable: false } }
    } catch (error) {
      outcome = { status: 'failed', stopReason: error instanceof BudgetExceededError ? 'budget_exceeded' : 'execution_error', error: errorInfo(error) }
    } finally {
      requestBudget?.close()
      release?.()
      if (timer) clearTimeout(timer)
      parent.signal?.removeEventListener('abort', onParentAbort)
      if (cancelPromise) await cancelPromise
      const users = (this.budgetUsers.get(group) ?? 1) - 1
      if (users <= 0) { this.budgetUsers.delete(group); this.fallbackBudgets.delete(group) }
      else this.budgetUsers.set(group, users)
    }

    const latest = await this.store.getRunHeader(tenantId, runId)
    if (!latest) { this.active.delete(key); throw new Error(`Subagent run ${runId} disappeared`) }
    if (controller.signal.aborted || latest.status === 'cancelling') {
      outcome = {
        status: timedOut ? 'failed' : 'cancelled',
        stopReason: timedOut ? 'deadline_exceeded' : latest.stopReason ?? 'cancelled',
        partialOutput: outcome?.partialOutput ?? outcome?.output ?? partialOutput,
        ...(timedOut ? { error: { code: 'DEADLINE_EXCEEDED', message: '子代理超过执行时限。', retryable: false } } : {}),
      }
    }
    const final = outcome!
    const finishRequestKey = randomUUID()
    const finishPayloadHash = createHash('sha256').update(JSON.stringify(final)).digest('hex')
    try {
      let finished: SubagentMutation | null
      try { finished = await this.store.appendHeader(tenantId, runId, 'finished', (current) => {
        // Cancellation may win after the read above; decide the winner inside the write transaction.
        const settled = current.status === 'cancelling' && !timedOut
          ? { ...final, status: 'cancelled' as const, stopReason: current.stopReason ?? 'cancelled', partialOutput: final.partialOutput ?? final.output }
          : final
        return {
          status: settled.status, stopReason: settled.stopReason, error: settled.error,
          ...(settled.status === 'succeeded' ? { resultSummary: boundedText(settled.output) ?? '' } : { partialOutput: boundedText(settled.partialOutput ?? settled.output ?? partialOutput) }),
          ...(settled.status === 'cancelled' && current.nonPlanToolCount > 0 ? { externalEffectStatus: 'unknown' as const } : {}),
          finishedAt: Date.now(), durationMs: current.startedAt ? Date.now() - current.startedAt : 0,
        }
      }, { allowedStatuses: ['queued', 'running', 'cancelling'], cancelActiveTools: true, finishRequestKey, finishPayloadHash }) }
      catch (error) {
        finished = await this.store.finishReceipt(tenantId, runId, finishRequestKey, finishPayloadHash)
        if (!finished) throw error
      }
      if (!finished) throw new Error('SUBAGENT_FINISH_ACK_UNKNOWN')
      await emit(finished)
      if (!executionOwner) try {
        const { projectPendingSubagents } = await import('./projection.js')
        await projectPendingSubagents(parent.history, tenantId)
      } catch (error) {
        parent.logger.warn({ err: error, runId }, 'Subagent parent projection pending; retained in outbox')
      }
      const result = finished?.view ?? await this.store.getRunView(tenantId, runId)
      if (!result) throw new Error(`Subagent run ${runId} disappeared after settlement`)
      return result
    } finally { this.active.delete(key) }
  }

  async cancel(tenantId: string, runId: string, reason = 'user_cancelled'): Promise<SubagentRunView | null> {
    const handle = this.active.get(this.key(tenantId, runId))
    if (handle && !handle.controller.signal.aborted) handle.controller.abort(new Error(reason))
    const current = await this.store.getRunHeader(tenantId, runId)
    if (!current) return null
    if (isTerminalRun(current.status)) return this.store.getRunView(tenantId, runId)
    const event = await this.store.appendHeader(tenantId, runId, 'cancelling', { status: 'cancelling', stopReason: reason }, { allowedStatuses: ['queued', 'running'] })
    const active = this.active.get(this.key(tenantId, runId))
    if (active) {
      if (event) await active.emit(event)
      if (!active.controller.signal.aborted) active.controller.abort(new Error(reason))
    }
    return event?.view ?? this.store.getRunView(tenantId, runId)
  }

  async cancelByParentTool(tenantId: string, parentSessionId: string, toolCallId: string, reason?: string): Promise<SubagentRunView | null> {
    const run = await this.store.findHeaderByParentTool(tenantId, parentSessionId, toolCallId)
    return run ? this.cancel(tenantId, run.runId, reason) : null
  }

  async cancelRunsForParent(tenantId: string, parentSessionId: string): Promise<void> {
    let cursor: string | undefined
    do {
      const page = await this.store.listRunViewsPage(tenantId, parentSessionId, { cursor, limit: 64 })
      // A bounded page limits cancellation fan-out and waits for its owned
      // completions before moving to the next stable cursor.
      await Promise.all(page.runs.filter(run => !isTerminalRun(run.status)).map(run => this.cancel(tenantId, run.runId, 'parent_deleted')))
      await Promise.all(page.runs.map(run => this.completions.get(this.key(tenantId, run.runId))).filter((pending): pending is Promise<SubagentRunView> => pending !== undefined))
      cursor = page.hasMore ? page.nextCursor : undefined
      if (page.hasMore && !cursor) throw new Error('Subagent cancellation page is missing its continuation cursor')
    } while (cursor)
  }
}

let singleton: SubagentRunner | undefined
export function getSubagentRunner(): SubagentRunner {
  const store = getSubagentStore()
  if (!singleton || singleton.store !== store) singleton = new SubagentRunner(store)
  return singleton
}
