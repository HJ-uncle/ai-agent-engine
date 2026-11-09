import { createHash } from 'node:crypto'
import type { Message, ToolCall } from '../agent-context/types.js'
import { isClearedToolMessage } from './tool-evidence.js'

const MIN_PAYLOAD_CHARS = 2048
const KEEP_RECENT_BATCHES = 2
// Request-only bookkeeping cannot leak into JSONL/SQLite or provider schemas.
const originalCalls = new WeakMap<ToolCall, ToolCall>()

/** Hashes the archived argument JSON, never generated file bytes or provider tokenization. */
export function toolArgumentsSnapshot(call: ToolCall): { text: string; sha256: string } {
  const text = JSON.stringify(call.args)
  return { text, sha256: 'sha256:' + createHash('sha256').update(text).digest('hex') }
}

export interface CompletedWriteHistoryOptions {
  /** True only when this request can use search_history's explicit toolArguments recovery. */
  argumentRecoveryAvailable: boolean
  /** Registry-owned selection; unregistered or replaced tools must not opt themselves in. */
  canProject: (call: Pick<ToolCall, 'name' | 'args'>) => boolean
}

export interface CompletedWriteHistoryProjection {
  messages: Message[]
  projectedCalls: number
  omittedCharacters: number
}

/** Undo this request's view if later closeout/admission removes archive recovery. */
export function restoreCompletedWriteHistory(messages: Message[]): Message[] {
  let restored = false
  const result = messages.map(message => {
    const original = message.toolCall && originalCalls.get(message.toolCall)
    if (!original) return message
    restored = true
    return { ...message, toolCall: original }
  })
  return restored ? result : messages
}

function identity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
}

function sameScope(left: Message, right: Message): boolean {
  return ['rootRunId', 'turnId'].every(key => identity(left.metadata?.[key]) && left.metadata[key] === right.metadata?.[key])
}

function payloadKeys(call: ToolCall): string[] {
  if (!call.args || typeof call.args !== 'object' || Array.isArray(call.args)
    || typeof call.args.path !== 'string' || !call.args.path.trim()) return []
  if (call.name === 'write_file' && call.args.copyFrom === undefined) return ['data', 'content']
  if (call.name === 'office_document' && call.args.operation === 'create') return ['markdown']
  return []
}

function payloads(call: ToolCall): Array<{ index?: number; key: string; text: string }> {
  if (call.name === 'write_file' && Array.isArray(call.args?.files)) {
    if (!call.args.files.length || call.args.files.length > 16 || Object.keys(call.args).some(key => key !== 'files')) return []
    return call.args.files.flatMap((args, index) => payloadKeys({ ...call, args })
      .filter(key => typeof args[key] === 'string' && args[key].length >= MIN_PAYLOAD_CHARS)
      .map(key => ({ index, key, text: args[key] as string })))
  }
  return payloadKeys(call).filter(key => typeof call.args[key] === 'string' && (call.args[key] as string).length >= MIN_PAYLOAD_CHARS)
    .map(key => ({ key, text: call.args[key] as string }))
}

/**
 * A disposable model-request view, not a replay or execution input. Preserve all
 * messages, call/result identities, assistant text/reasoning and full receipts.
 * Only long string payloads of older successful writes can become explicit
 * archive references. Structured workbooks/presentations and all errors remain.
 * Call before pairToolHistory so the newest two assistant batches stay intact.
 */
export function projectCompletedWriteHistory(messages: Message[], options: CompletedWriteHistoryOptions): CompletedWriteHistoryProjection {
  const unchanged = { messages, projectedCalls: 0, omittedCharacters: 0 }
  if (!options.argumentRecoveryAvailable) return unchanged
  const calls = new Map<string, number[]>(), results = new Map<string, number[]>(), messageIds = new Map<string, number>()
  const batches = new Map<number, number>()
  let batch = -1
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    if (message.id) messageIds.set(message.id, (messageIds.get(message.id) ?? 0) + 1)
    if (message.role === 'assistant' && message.toolCall) {
      if (index === 0 || messages[index - 1].role !== 'assistant' || !messages[index - 1].toolCall) batch++
      batches.set(index, batch)
      const positions = calls.get(message.toolCall.id) ?? []
      positions.push(index); calls.set(message.toolCall.id, positions)
    }
    if (message.role === 'tool' && message.toolCallId) {
      const positions = results.get(message.toolCallId) ?? []
      positions.push(index); results.set(message.toolCallId, positions)
    }
  }
  let projectedCalls = 0, omittedCharacters = 0
  const projected = messages.map((message, index) => {
    const call = message.role === 'assistant' ? message.toolCall : undefined
    if (!call || !identity(call.id) || !identity(message.id) || messageIds.get(message.id) !== 1
      || (batches.get(index) ?? batch) > batch - KEEP_RECENT_BATCHES
      || calls.get(call.id)?.length !== 1 || results.get(call.id)?.length !== 1
      || message.metadata?.partial || !options.canProject(call)) return message
    const resultIndex = results.get(call.id)![0], result = messages[resultIndex]
    if (resultIndex <= index || result.toolName !== call.name || !sameScope(message, result)
      || result.metadata?.success !== true || result.metadata?.status !== 'succeeded' || result.metadata?.error
      || result.metadata?.outputTruncated || result.metadata?.__aetherMicroCompactArchive || isClearedToolMessage(result)
      || messages.slice(index + 1, resultIndex).some(candidate => candidate.role === 'user' || candidate.role === 'system')) return message
    const fields = payloads(call)
    if (!fields.length) return message
    const snapshot = toolArgumentsSnapshot(call)
    const args = { ...call.args }
    const files = Array.isArray(args.files) ? args.files.map(item => ({ ...item })) : undefined
    if (files) args.files = files
    for (const { index: fileIndex, key, text: original } of fields) {
      const target = fileIndex === undefined ? args : files![fileIndex]
      const field = fileIndex === undefined ? key : `files[${fileIndex}].${key}`
      const marker = '[Historical write payload omitted from this request only; this marker is NOT file content and must NOT be used as new write input.] '
        + JSON.stringify({ version: 1, field, originalChars: original.length,
          argumentsSha256: snapshot.sha256, hashDomain: 'tool-arguments-json-utf8',
          recovery: { tool: 'search_history', args: { messageId: message.id, toolArguments: true, contentOffset: 0, limit: 1 } } })
      target[key] = marker
      omittedCharacters += original.length - marker.length
    }
    projectedCalls++
    const toolCall = { id: call.id, name: call.name, args }
    originalCalls.set(toolCall, call)
    return { ...message, toolCall }
  })
  return projectedCalls ? { messages: projected, projectedCalls, omittedCharacters } : unchanged
}
