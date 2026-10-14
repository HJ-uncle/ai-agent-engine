import { createHash } from 'node:crypto'
import { isTaskPlanControl } from '../task-plan/control.js'
import type { ToolCall, ToolExecutionMode, ToolResult } from '../agent-context/types.js'

/** Product runs do not stop on repeated failures; positive values remain
 * available for explicit internal probes and focused tests. */
export function toolFailureLimit(value = process.env.MAX_CONSECUTIVE_FAILURES): number {
  const raw = Number(value)
  return value !== undefined && value.trim() !== '' && Number.isFinite(raw) && raw > 0
    ? Math.max(1, Math.floor(raw))
    : Number.POSITIVE_INFINITY
}

/** Temporary infrastructure failures remain retryable without consuming the no-progress allowance. */
export function isTransientToolFailure(result: ToolResult): boolean {
  if (result.status !== 'failed') return false
  if (result.metadata?.retryable === true) return true
  const metadataCode = result.metadata?.code ?? result.metadata?.errorCode ?? result.metadata?.errorType
  const text = `${metadataCode ?? ''} ${result.error ?? ''} ${result.output ?? ''}`.toLowerCase()
  return /(?:timeout|timed out|time\s*out|econnreset|econnrefused|ehostunreach|enetunreach|enetreset|socket hang up|network|temporar|rate.?limit|too many requests|service unavailable|gateway (?:timeout|unavailable)|(?:^|[^a-z])5\d\d(?:[^a-z]|$))/.test(text)
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => [key, canonical(item)]))
  return value
}

/** Hash all arguments and output; changes after character 200 are real progress too. */
function outcomeFingerprint(call: Pick<ToolCall, 'name' | 'args'>, result: ToolResult): string {
  return createHash('sha256').update(JSON.stringify({ name: call.name, args: canonical(call.args),
    status: result.status, output: result.output, error: result.error })).digest('hex')
}

export function waitingOnActiveWork(call: Pick<ToolCall, 'name'>, result: ToolResult): boolean {
  if (call.name === 'command_output') {
    const job = result.metadata?.commandJob as { status?: string } | undefined
    return ['pending', 'queued', 'starting', 'running'].includes(job?.status ?? '')
  }
  if (call.name === 'task_status') {
    try {
      const job = JSON.parse(result.output) as { status?: string }
      return ['pending', 'queued', 'starting', 'running'].includes(job.status ?? '')
    } catch { return false }
  }
  return false
}

const RECENT_READONLY_OUTCOMES = 64
const RECENT_MUTATION_OUTCOMES = 128
// Generic serial tools may be queries or remote operations with unknown effects.
// Restrict action advice to the builtin write/edit/exec contracts we can verify.
const MUTATION_ADVICE_TOOLS = new Set(['write_file', 'edit_file', 'execute_cmd'])
// Static engine guidance must never promote paths, arguments or tool output into instructions.
export const READONLY_REPETITION_PROMPT = 'The last two tool batches repeated successful read-only calls with the same arguments and results already observed recently, without obtaining new evidence. Break this query cycle while continuing the original task: use the evidence already collected to take the next unfinished step, or change the query, path, range or approach to obtain genuinely new information. Do not alternate the same exhausted queries or rerun them unchanged. Re-read unchanged inputs only when a relevant change or an active operation justifies it. Continue to obey the existing permissions and safety policy; this notice does not grant additional access or ask you to stop.'

// Exact output identity cannot prove an operation had no effects; advice asks
// for a workflow review, and never replaces execution, permission or stop policy.
export const MUTATION_REPETITION_PROMPT = 'Recent non-read-only operations reused the same arguments and returned the same successful results already observed in this turn. Matching results alone do not prove there were no side effects. Review whether these repeats are needed for the original task, verify their intended effects when appropriate, and use the available evidence to advance the remaining work. Necessary retries, testing and repeated authorized operations may continue. This advisory does not change permissions, grant access, assert completion or stop execution.'

// Periodic advice reviews workflow; it does not classify new evidence as a loop.
export const WORKFLOW_REVIEW_PROMPT = 'Periodic workflow review: continue the original task within its existing scope, role and permissions. Check which requested deliverable or review conclusion is still unfinished and whether further exploration addresses a specific unresolved question. If the original task requests implementation and your role permits it, apply the evidence to the requested deliverable and perform the required verification; temporary probes and their passing results do not replace that delivery. If your role is read-only, produce the supported review or investigation conclusion without writing files or running unauthorized commands. Necessary pagination, exhaustive audits and genuinely new investigation may continue. This review does not claim that the task is complete or that recent operations lacked progress, and adds no execution limit or permission.'
const WORKFLOW_REVIEW_INTERVAL = 32

type ObservedCall = Pick<ToolCall, 'name' | 'args'>

function queryFingerprint(call: ObservedCall): string {
  return createHash('sha256').update(JSON.stringify({ name: call.name, args: canonical(call.args) })).digest('hex')
}

/** Track absence of useful progress, rather than repetition of a tool name or arguments. */
export class ToolProgressTracker {
  private previous = new Set<string>()
  private consecutive = 0
  private readonlyRecent = new Map<string, string>()
  /** Exact query -> outcome hashes only; bounded so long turns cannot retain raw data. */
  private mutationRecent = new Map<string, string>()
  /** Separate evidence prevents the base mutation epoch from erasing advice. */
  private advisoryReadonlyRecent = new Map<string, string>()
  private repeatedMutationBatches = 0
  private repeatedReadonlyBatches = 0
  private completedProgress = false
  private workflowOperations = 0
  private workflowReviewPending = false
  private workflowReviewActive = false

  constructor(private readonly executionMode?: (call: ObservedCall) => ToolExecutionMode | undefined) {}

  /** Request-local advice disappears after progress; it is never a stored user/plan message. */
  recoveryPrompt(): string | undefined {
    const prompts: string[] = []
    if (this.repeatedReadonlyBatches >= 2) prompts.push(READONLY_REPETITION_PROMPT)
    if (this.repeatedMutationBatches >= 2) prompts.push(MUTATION_REPETITION_PROMPT)
    return prompts.length ? prompts.join('\n\n') : undefined
  }

  /** Focus persists for this turn once due, without classifying useful exploration as stalled. */
  workflowReviewPrompt(): string | undefined {
    return this.workflowReviewPending || this.workflowReviewActive ? WORKFLOW_REVIEW_PROMPT : undefined
  }
  markWorkflowReviewDispatched(): void {
    if (this.workflowReviewPending) this.workflowReviewActive = true
    this.workflowReviewPending = false
  }

  /** Only new completed evidence may reopen a reasoning-output recovery episode. */
  hasCompletedProgress(): boolean { return this.completedProgress }

  private observeMutationAdvice(calls: ObservedCall[], results: ToolResult[], modes: Array<ToolExecutionMode | undefined>): void {
    let resetAdvice = false
    let newEvidence = false
    let repeatedMutation = false
    const observations: Array<{ readonly: boolean; query: string; outcome: string }> = []
    for (let index = 0; index < calls.length; index++) {
      const call = calls[index]
      const result = results[index]
      // Plans and job queries form control flow, not evidence of a write/exec
      // cycle. They clear the episode without changing the original counters.
      if (isTaskPlanControl(call.name) || ['command_output', 'task_list', 'task_status'].includes(call.name)
        || !result || result.status !== 'succeeded' || waitingOnActiveWork(call, result)) {
        resetAdvice = true
        continue
      }
      const readonly = modes[index] === 'readonly'
      if (!readonly && (modes[index] !== 'serial' || !MUTATION_ADVICE_TOOLS.has(call.name))) {
        resetAdvice = true
        continue
      }
      const query = queryFingerprint(call)
      const outcome = outcomeFingerprint(call, result)
      const recent = readonly ? this.advisoryReadonlyRecent : this.mutationRecent
      if (recent.get(query) !== outcome) newEvidence = true
      else if (!readonly) repeatedMutation = true
      observations.push({ readonly, query, outcome })
    }
    if (resetAdvice || newEvidence) this.repeatedMutationBatches = 0
    else if (repeatedMutation) this.repeatedMutationBatches++
    // Compare the whole batch against its prior window before storing outcomes:
    // two identical siblings in their first batch must not manufacture a repeat.
    for (const observation of observations) {
      const recent = observation.readonly ? this.advisoryReadonlyRecent : this.mutationRecent
      recent.delete(observation.query)
      recent.set(observation.query, observation.outcome)
      const bound = observation.readonly ? RECENT_READONLY_OUTCOMES : RECENT_MUTATION_OUTCOMES
      while (recent.size > bound) recent.delete(recent.keys().next().value!)
    }
  }

  observe(calls: ObservedCall[], results: ToolResult[]): number {
    this.completedProgress = false
    const operations = calls.filter((call, index) => {
      const result = results[index]
      return result && ['succeeded', 'failed'].includes(result.status ?? '')
        && !isTaskPlanControl(call.name)
        && !waitingOnActiveWork(call, result) && !isTransientToolFailure(result)
    }).length
    this.workflowOperations += operations
    if (this.workflowOperations >= WORKFLOW_REVIEW_INTERVAL) {
      this.workflowReviewPending = true
      this.workflowOperations %= WORKFLOW_REVIEW_INTERVAL
    }
    // A completed write/command/child can change files even if their subsequent
    // read happens to return an earlier value. Do not inherit the old read epoch.
    const modes = calls.map(call => this.executionMode?.(call))
    // Advice has its own exact-evidence window. The original previous-batch
    // progress bit resets on A/B alternation and must not control this episode.
    this.observeMutationAdvice(calls, results, modes)
    // A completed tool exchange does not prove the requested deliverable is
    // complete. Keep request-local focus for this tracker/turn; the next turn
    // creates a fresh tracker without altering history, permissions or limits.
    const possibleMutation = calls.some((call, index) => results[index]?.status === 'succeeded'
      && modes[index] !== 'readonly' && !waitingOnActiveWork(call, results[index]))
    if (possibleMutation) this.readonlyRecent.clear()

    const current = new Set<string>()
    let progress = false, permanentFailure = false, repeatedSuccess = false, transientFailure = false
    let repeatedReadonly = false
    for (let index = 0; index < calls.length; index++) {
      const result = results[index]
      if (!result) continue
      const fingerprint = outcomeFingerprint(calls[index], result)
      current.add(fingerprint)
      if (isTransientToolFailure(result)) transientFailure = true
      else if (result.status === 'failed') permanentFailure = true
      else if (result.status === 'succeeded') {
        if (waitingOnActiveWork(calls[index], result)) progress = true
        else if (modes[index] === 'readonly') {
          const query = queryFingerprint(calls[index])
          if (this.readonlyRecent.get(query) !== fingerprint) { progress = true; this.completedProgress = true }
          else { repeatedSuccess = true; repeatedReadonly = true }
          // Compare a query's latest outcome, not any old version: concurrent
          // edits can legitimately restore earlier content. Retain only hashes.
          this.readonlyRecent.delete(query)
          this.readonlyRecent.set(query, fingerprint)
          if (this.readonlyRecent.size > RECENT_READONLY_OUTCOMES) {
            this.readonlyRecent.delete(this.readonlyRecent.keys().next().value!)
          }
        } else if (!this.previous.has(fingerprint)) { progress = true; this.completedProgress = true }
        else repeatedSuccess = true
      }
    }
    this.previous = current
    if (progress) this.consecutive = 0
    else if (permanentFailure || (repeatedSuccess && !transientFailure)) this.consecutive++
    this.repeatedReadonlyBatches = !progress && repeatedReadonly && !transientFailure && !possibleMutation
      ? this.repeatedReadonlyBatches + 1 : 0
    return this.consecutive
  }
}
