import { createHash } from 'node:crypto'
import type { ToolCall, ToolResult } from '../agent-context/types.js'

/** Explicit zero disables the optional local no-progress stop. */
export function toolFailureLimit(value = process.env.MAX_CONSECUTIVE_FAILURES): number {
  const raw = Number(value)
  if (value !== undefined && value.trim() !== '' && raw === 0) return Number.POSITIVE_INFINITY
  return Number.isFinite(raw) && raw > 0 ? Math.max(1, Math.floor(raw)) : 8
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

function waitingOnActiveWork(call: Pick<ToolCall, 'name'>, result: ToolResult): boolean {
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

/** Track absence of useful progress, rather than repetition of a tool name or arguments. */
export class ToolProgressTracker {
  private previous = new Set<string>()
  private consecutive = 0

  observe(calls: Pick<ToolCall, 'name' | 'args'>[], results: ToolResult[]): number {
    const current = new Set<string>()
    let progress = false, permanentFailure = false, repeatedSuccess = false, transientFailure = false
    for (let index = 0; index < calls.length; index++) {
      const result = results[index]
      if (!result) continue
      const fingerprint = outcomeFingerprint(calls[index], result)
      current.add(fingerprint)
      if (isTransientToolFailure(result)) transientFailure = true
      else if (result.status === 'failed') permanentFailure = true
      else if (result.status === 'succeeded') {
        if (waitingOnActiveWork(calls[index], result) || !this.previous.has(fingerprint)) progress = true
        else repeatedSuccess = true
      }
    }
    this.previous = current
    if (progress) this.consecutive = 0
    else if (permanentFailure || (repeatedSuccess && !transientFailure)) this.consecutive++
    return this.consecutive
  }
}
