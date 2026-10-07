import type { AgentContext } from '../agent-context/types.js'
import { BudgetExceededError, RequestBudget, parseRequestTokenLimit, type RequestAttempt } from './budget.js'
import { SubagentPool } from './pool.js'
import { getSubagentStore, SubagentStore } from './store.js'
import { isTerminalRun, type CreateSubagentRun, type RunError, type RunObserver, type RunOutcome, type SubagentEvent, type SubagentRun } from './types.js'

interface ActiveRun {
  controller: AbortController
  emit(event: SubagentEvent): Promise<void>
}

export interface SubagentExecution {
  snapshot: SubagentRun
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
  private readonly completions = new Map<string, Promise<SubagentRun>>()
  private readonly fallbackBudgets = new Map<string, RequestBudget>()
  private readonly budgetUsers = new Map<string, number>()

  constructor(readonly store: SubagentStore = getSubagentStore(), private readonly pool = new SubagentPool(concurrencyLimit())) {}

  private key(tenantId: string, runId: string): string { return `${tenantId}:${runId}` }

  async run(input: CreateSubagentRun, parent: AgentContext, execute: (execution: SubagentExecution) => Promise<void>, options: { deadlineMs?: number } = {}): Promise<SubagentRun> {
    const created = await this.store.createRun(input)
    const snapshot = created.snapshot
    if (isTerminalRun(snapshot.status)) return snapshot
    const key = this.key(snapshot.tenantId, snapshot.runId)
    const prior = this.completions.get(key)
    if (prior) return prior
    const promise = this.execute(snapshot, created, parent, execute, options)
    this.completions.set(key, promise)
    try { return await promise } finally { this.completions.delete(key) }
  }

  private async execute(initial: SubagentRun, created: SubagentEvent, parent: AgentContext, execute: (execution: SubagentExecution) => Promise<void>, options: { deadlineMs?: number }): Promise<SubagentRun> {
    const { tenantId, runId } = initial
    const key = this.key(tenantId, runId)
    const controller = new AbortController()
    const emit = async (event: SubagentEvent | null): Promise<void> => {
      if (!event) return
      try { await parent.emitSubagentEvent?.(event) } catch (error) {
        // A disconnected viewer can replay persisted events; it must not kill otherwise valid work.
        parent.logger.warn({ err: error, runId }, 'Subagent event delivery failed; event remains persisted')
      }
    }
    this.active.set(key, { controller, emit })
    let cancelPromise: Promise<SubagentRun | null> | undefined
    const onParentAbort = () => { cancelPromise = this.cancel(tenantId, runId, 'parent_cancelled') }
    parent.signal?.addEventListener('abort', onParentAbort, { once: true })
    if (parent.signal?.aborted) onParentAbort()
    let timedOut = false
    // Code work is allowed to run until it finishes or is explicitly cancelled.
    // An operator may still opt into a deadline through the request or env var;
    // the ten-minute default is retained for other profiles for safety.
    const configuredDeadline = Number(process.env.SUBAGENT_DEADLINE_MS)
    const requestedTimeout = options.deadlineMs !== undefined
      ? options.deadlineMs
      : parent.toolProfile === 'code'
        ? (Number.isFinite(configuredDeadline) && configuredDeadline > 0 ? configuredDeadline : undefined)
        : Math.max(1000, configuredDeadline || 10 * 60_000)
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
    const fallback = this.fallbackBudgets.get(group) ?? new RequestBudget(
      parseRequestTokenLimit(process.env.SUBAGENT_TOKEN_LIMIT),
      Math.max(1, Number(process.env.SUBAGENT_REQUEST_RESERVE_TOKENS) || 8192),
    )
    this.fallbackBudgets.set(group, fallback)
    this.budgetUsers.set(group, (this.budgetUsers.get(group) ?? 0) + 1)
    const observer: RunObserver = {
      onOutcome: (value) => { outcome = value },
      onOutput: async (text) => {
        partialOutput = boundedText(text) ?? ''
        if (Date.now() - lastOutputWrite < 200) return
        lastOutputWrite = Date.now()
        await emit(await this.store.appendSnapshot(tenantId, runId, 'output.updated', { partialOutput }, { allowedStatuses: ['running', 'cancelling'] }))
      },
      onToolStart: async (tool) => {
        await emit(await this.store.appendSnapshot(tenantId, runId, 'tool.started', (current) => {
          const existing = current.toolCalls.find((item) => item.id === tool.toolCallId)
          if (existing && existing.status !== 'running') return {}
          const next = { id: tool.toolCallId, name: tool.name, args: tool.args, status: 'running' as const, startedAt: existing?.startedAt ?? Date.now() }
          return { toolCalls: existing ? current.toolCalls.map((item) => item.id === next.id ? next : item) : [...current.toolCalls, next] }
        }, { allowedStatuses: ['running'] }))
      },
      onToolEnd: async (tool) => {
        await emit(await this.store.appendSnapshot(tenantId, runId, 'tool.completed', (current) => ({
          toolCalls: current.toolCalls.map((item) => item.id === tool.toolCallId ? {
            ...item, status: controller.signal.aborted ? 'cancelled' : tool.success ? 'succeeded' : 'failed',
            output: boundedText(tool.output, 32_000), ...(tool.error ? { error: tool.error } : {}), finishedAt: Date.now(),
            ...(tool.durationMs !== undefined ? { durationMs: tool.durationMs } : {}),
          } : item),
        })))
      },
      onUsage: async (usage) => {
        // Adapters with physical-attempt callbacks already accounted for success and failed retries.
        if (!attemptsSeen) await emit(await this.store.recordUsage(tenantId, runId, usage))
      },
    }
    const onRequestAttempt = async (event: RequestAttempt): Promise<void> => {
      attemptsSeen = true
      if (requestBudget) requestBudget.observe(event)
      else if (parent.onRequestAttempt) await parent.onRequestAttempt(event)
      else fallback.observe(event)
      if (event.type === 'start' && event.model !== initial.modelId) {
        await emit(await this.store.appendSnapshot(tenantId, runId, 'usage.updated', { modelId: event.model }))
      }
      if (event.type === 'finish') {
        await emit(await this.store.recordUsage(tenantId, runId, {
          invocationId: event.requestAttemptId,
          promptTokens: event.usage?.promptTokens ?? 0,
          completionTokens: event.usage?.completionTokens ?? 0,
          cacheHitTokens: event.usage?.cacheHitTokens,
          cacheMissTokens: event.usage?.cacheMissTokens,
          cacheWriteTokens: event.usage?.cacheWriteTokens,
          unknown: !event.usage,
        }))
      }
    }

    try {
      await emit(created)
      if (cancelPromise) await cancelPromise
      release = await this.pool.acquire(`${tenantId}:${initial.parentSessionId}`, controller.signal)
      const started = await this.store.appendSnapshot(tenantId, runId, 'started', { status: 'running', startedAt: Date.now() }, { allowedStatuses: ['queued'] })
      if (!started) {
        if (!controller.signal.aborted) controller.abort(new Error('Run no longer queued'))
      } else {
        await emit(started)
        const configuredChildLimit = parent.toolProfile === 'code'
          ? Infinity
          : parseRequestTokenLimit(process.env.SUBAGENT_TOKEN_LIMIT)
        if (parent.requestBudget && (Number.isFinite(parent.requestBudget.limit) || Number.isFinite(configuredChildLimit))) {
          // Only explicitly enabled budgets allocate slices; the default unlimited parent/child path only records usage.
          const finiteParent = Number.isFinite(parent.requestBudget.limit)
          const childLimit = finiteParent ? Math.min(configuredChildLimit, Math.floor(parent.requestBudget.limit * 0.25)) : configuredChildLimit
          const parentReserve = finiteParent ? Math.max(Math.ceil(parent.requestBudget.limit * 0.2), parent.finalizationReserveTokens ?? 0) : 0
          requestBudget = parent.requestBudget.fork(Math.max(1, childLimit), parentReserve)
        }
        await execute({ snapshot: started.snapshot, signal: controller.signal, observer, onRequestAttempt, requestBudget: requestBudget ?? parent.requestBudget ?? (!parent.onRequestAttempt ? fallback : undefined) })
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

    const latest = await this.store.getRun(tenantId, runId)
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
    try {
      const finished = await this.store.appendSnapshot(tenantId, runId, 'finished', (current) => {
        // Cancellation may win after the read above; decide the winner inside the write transaction.
        const settled = current.status === 'cancelling' && !timedOut
          ? { ...final, status: 'cancelled' as const, stopReason: current.stopReason ?? 'cancelled', partialOutput: final.partialOutput ?? final.output }
          : final
        return {
          status: settled.status, stopReason: settled.stopReason, error: settled.error,
          ...(settled.status === 'succeeded' ? { resultSummary: boundedText(settled.output) ?? '' } : { partialOutput: boundedText(settled.partialOutput ?? settled.output ?? partialOutput) }),
          ...(settled.status === 'cancelled' && current.toolCalls.length > 0 ? { externalEffectStatus: 'unknown' as const } : {}),
          finishedAt: Date.now(), durationMs: current.startedAt ? Date.now() - current.startedAt : 0,
          toolCalls: current.toolCalls.map((tool) => tool.status === 'running' ? { ...tool, status: 'cancelled', finishedAt: Date.now() } : tool),
        }
      }, { allowedStatuses: ['queued', 'running', 'cancelling'] })
      await emit(finished)
      try {
        const { projectPendingSubagents } = await import('./projection.js')
        await projectPendingSubagents(parent.history, tenantId)
      } catch (error) {
        parent.logger.warn({ err: error, runId }, 'Subagent parent projection pending; retained in outbox')
      }
      return finished?.snapshot ?? (await this.store.getRun(tenantId, runId))!
    } finally { this.active.delete(key) }
  }

  async cancel(tenantId: string, runId: string, reason = 'user_cancelled'): Promise<SubagentRun | null> {
    const current = await this.store.getRun(tenantId, runId)
    if (!current || isTerminalRun(current.status)) return current
    const event = await this.store.appendSnapshot(tenantId, runId, 'cancelling', { status: 'cancelling', stopReason: reason }, { allowedStatuses: ['queued', 'running'] })
    const active = this.active.get(this.key(tenantId, runId))
    if (active) {
      if (event) await active.emit(event)
      if (!active.controller.signal.aborted) active.controller.abort(new Error(reason))
    }
    return event?.snapshot ?? this.store.getRun(tenantId, runId)
  }

  async cancelByParentTool(tenantId: string, parentSessionId: string, toolCallId: string, reason?: string): Promise<SubagentRun | null> {
    const run = await this.store.findByParentTool(tenantId, parentSessionId, toolCallId)
    return run ? this.cancel(tenantId, run.runId, reason) : null
  }

  async cancelRunsForParent(tenantId: string, parentSessionId: string): Promise<void> {
    const runs = await this.store.listRunsForParent(tenantId, parentSessionId)
    await Promise.all(runs.filter((run) => !isTerminalRun(run.status)).map((run) => this.cancel(tenantId, run.runId, 'parent_deleted')))
    await Promise.all(runs.map((run) => this.completions.get(this.key(tenantId, run.runId))).filter((pending): pending is Promise<SubagentRun> => pending !== undefined))
  }
}

let singleton: SubagentRunner | undefined
export function getSubagentRunner(): SubagentRunner { return singleton ??= new SubagentRunner() }
