import type { Pending } from '../agent-context/types.js'

/** Display receipts are not authority to execute. Full arguments and the sealed
 * action remain in the durable run and are read only by approval resumption. */
export interface PendingDisplaySummary {
  source: 'durable_approval'
  fields: Array<'args' | 'question' | 'description' | 'options'>
  originalArgsBytes?: number
  omittedArgumentKeys?: number
}
type DisplayPending = Omit<Pending, 'pendingAction'> & { description?: string; displaySummary?: PendingDisplaySummary }
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8')

/** Explicitly labeled UTF-8 bounded display text; never changes the sealed text. */
export function publicPermissionText(text: string, limit = 4096): string {
  if (Buffer.byteLength(text, 'utf8') <= limit) return text
  const suffix = '\n[展示摘要；完整内容保留在审批封存中]'
  const available = limit - Buffer.byteLength(suffix, 'utf8')
  let low = 0, high = text.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(text.slice(0, middle), 'utf8') <= available) low = middle
    else high = middle - 1
  }
  if (low && /[\uD800-\uDBFF]/.test(text[low - 1])) low--
  return text.slice(0, low) + suffix
}

function displayArgs(args: Record<string, unknown>, limit: number): { args: Record<string, unknown>; originalArgsBytes?: number; omittedArgumentKeys?: number } {
  const originalArgsBytes = bytes(args)
  if (originalArgsBytes <= limit) return { args: structuredClone(args) }
  const entries: Array<[string, unknown]> = []
  let omittedArgumentKeys = 0
  for (const [key, value] of Object.entries(args)) {
    const size = bytes(value)
    const projected = size <= Math.min(2048, limit / 2) ? value
      : `[展示摘要：${size} 字节；完整参数保留在审批封存中]`
    if (Buffer.byteLength(key, 'utf8') > 256 || bytes(Object.fromEntries([...entries, [key, projected]])) > limit) omittedArgumentKeys++
    else entries.push([key, structuredClone(projected)])
  }
  return { args: Object.fromEntries(entries), originalArgsBytes, ...(omittedArgumentKeys ? { omittedArgumentKeys } : {}) }
}

/** Preserve every interaction and all ordinary questions/answers. Only permission
 * display bodies are summarized; never send private pendingAction over SSE/HTTP. */
export function publicPending(pending: Pending & { description?: string }): DisplayPending {
  const { pendingAction: _privateAction, ...display } = pending
  if (pending.kind === 'ask') return structuredClone(display)
  const answered = pending.status === 'answered'
  const args = displayArgs(pending.args, answered ? 2048 : 12288)
  const summary: PendingDisplaySummary = { source: 'durable_approval', fields: [] }
  const projected: DisplayPending = { ...display, args: args.args }
  if (args.originalArgsBytes !== undefined) {
    summary.fields.push('args'); summary.originalArgsBytes = args.originalArgsBytes
    if (args.omittedArgumentKeys) summary.omittedArgumentKeys = args.omittedArgumentKeys
  }
  for (const field of ['question', 'description'] as const) {
    const original = pending[field]
    if (original === undefined) continue
    const text = publicPermissionText(original, answered ? 1024 : 4096)
    projected[field] = text
    if (text !== original) summary.fields.push(field)
  }
  if (pending.options !== undefined) {
    projected.options = bytes(pending.options) <= 2048 ? structuredClone(pending.options) : ['approved', 'rejected']
    if (bytes(pending.options) > 2048) summary.fields.push('options')
  }
  if (summary.fields.length) projected.displaySummary = summary
  return projected
}

/** Used after the private candidate is durably parked, never before persistence. */
export function pendingWireFrames(pending: Pending, context: { sessionId: string; rootRunId?: string; turnId?: string }): string[] {
  const display = publicPending(pending)
  return [
    '\x00__ask_user__' + JSON.stringify({ ...(pending.kind === 'ask' ? display.args : {}), question: display.question,
      options: display.options, toolCallId: display.toolCallId, requestId: display.requestId }),
    '\x00__permission_request__' + JSON.stringify({ ...display, sessionId: context.sessionId,
      description: display.question, rootRunId: context.rootRunId, turnId: context.turnId }),
  ]
}
