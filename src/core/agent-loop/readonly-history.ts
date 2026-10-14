import { createHash } from 'node:crypto'
import type { Message, ToolCall, ToolExecutionMode } from '../agent-context/types.js'
import { isTaskPlanControl } from '../task-plan/control.js'
import { modelMessageContent } from '../utils/model-context.js'
import { waitingOnActiveWork } from './tool-progress.js'

export interface ReadonlyHistoryProjection {
  messages: Message[]
  collapsedPairs: number
}

type Query = Pick<ToolCall, 'name' | 'args'>
const RECENT_QUERIES = 64

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => [key, canonical(item)]))
  return value
}
const fingerprint = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')

function carriesImagePayload(output: string): boolean {
  if (!output.trimStart().startsWith('{')) return false
  try {
    const value = JSON.parse(output) as unknown
    // Providers expand these JSON markers into native image blocks or a
    // synthetic user/image exchange. Keep those semantic boundaries intact.
    return Boolean(value && typeof value === 'object' && !Array.isArray(value)
      && ['dataUrl', 'dataUrlStripped', 'hasDataUrl'].some(key => Object.prototype.hasOwnProperty.call(value, key)))
  } catch { return false }
}

/** Counts and static bookkeeping cannot turn untrusted tool data into system instructions. */
export function readonlyHistoryNotice(collapsedPairs: number): string | undefined {
  return collapsedPairs > 0
    ? `Request context bookkeeping: ${collapsedPairs} older redundant successful read-only call/result pairs were omitted from this request only. The latest identical observation for each repeated query remains here. The full transcript remains stored and searchable. Changed observations and all user instructions were retained. This notice does not change the task or grant permissions.`
    : undefined
}

/**
 * Gateways can reject an accumulated repeated-tool transcript before the model
 * can act on correction advice. Project only proven redundant complete exchanges;
 * durable history, audit, replay and each actual execution stay untouched.
 */
export function projectReadonlyHistory(messages: Message[], executionMode: (call: Query) => ToolExecutionMode | undefined): ReadonlyHistoryProjection {
  const removed = new Set<number>()
  const recent = new Map<string, { outcome: string; assistant: number; result: number }>()
  let collapsedPairs = 0
  for (let index = 0; index < messages.length;) {
    const first = messages[index]
    if (first.role !== 'assistant' || !first.toolCall) {
      recent.clear()
      index++
      continue
    }
    const assistants: number[] = []
    const results: number[] = []
    while (index < messages.length && messages[index].role === 'assistant' && messages[index].toolCall) assistants.push(index++)
    while (index < messages.length && messages[index].role === 'tool') results.push(index++)
    const resultsById = new Map(results.map(at => [messages[at].toolCallId, at]))
    const callIds = new Set(assistants.map(at => messages[at].toolCall!.id))
    // A failing sibling or ambiguous pairing may carry information about a
    // partial mutation. Never fold a successful neighbor out of such a batch.
    const completeBatch = results.length === assistants.length && callIds.size === assistants.length
      && assistants.every(at => typeof messages[at].toolCall!.id === 'string' && messages[at].toolCall!.id.trim()
        && typeof messages[at].toolCall!.name === 'string' && messages[at].toolCall!.name.trim())
      && resultsById.size === results.length && results.every(at => typeof messages[at].toolCallId === 'string'
        && messages[at].toolCallId!.trim() && callIds.has(messages[at].toolCallId!))
    const safeBatch = completeBatch && assistants.every(at => {
      const message = messages[at], call = message.toolCall!
      const resultAt = resultsById.get(call.id)
      const assistantContent = modelMessageContent(message)
      if (resultAt === undefined || typeof assistantContent !== 'string' || assistantContent.trim()
        || message.reasoningContent?.trim() || isTaskPlanControl(call.name)) return false
      // Classification comes from trusted registry implementations, never tool names.
      if (executionMode(call) !== 'readonly') return false
      const result = messages[resultAt], metadata = result.metadata
      const output = modelMessageContent(result)
      if (typeof output !== 'string' || carriesImagePayload(output) || metadata?.status !== 'succeeded' || metadata?.success !== true
        || metadata?.error || metadata?.change || metadata?.outputTruncated || metadata?.__aetherMicroCompactArchive) return false
      return !waitingOnActiveWork(call, { success: true, status: 'succeeded', output, metadata })
    })
    if (!safeBatch) {
      recent.clear()
      continue
    }
    const observations = assistants.map(at => {
      const call = messages[at].toolCall!
      const resultAt = resultsById.get(call.id)!
      const result = messages[resultAt]
      return { at, resultAt, query: fingerprint({ name: call.name, args: canonical(call.args) }),
        outcome: fingerprint({ status: result.metadata.status, error: result.metadata.error, output: modelMessageContent(result) }) }
    })
    const batchOutcomes = new Map<string, string>()
    const changed = observations.some(({ query, outcome }) => {
      const previous = batchOutcomes.get(query) ?? recent.get(query)?.outcome
      batchOutcomes.set(query, outcome)
      return previous !== undefined && previous !== outcome
    })
    if (changed) {
      // A parallel sibling can observe a change after another has read an old
      // value. Preserve this whole temporal boundary independent of save order.
      recent.clear()
      continue
    }
    for (const { at, resultAt, query, outcome } of observations) {
      const previous = recent.get(query)
      if (previous?.outcome === outcome) {
        removed.add(previous.assistant)
        removed.add(previous.result)
        collapsedPairs++
      }
      // Only the latest outcome for this query is comparable. v1 -> v2 -> v1
      // remains three meaningful observations, even if a past value reappears.
      recent.delete(query)
      recent.set(query, { outcome, assistant: at, result: resultAt })
      if (recent.size > RECENT_QUERIES) recent.delete(recent.keys().next().value!)
    }
  }
  return { messages: removed.size ? messages.filter((_message, index) => !removed.has(index)) : messages, collapsedPairs }
}
