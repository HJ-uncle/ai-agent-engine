/** The same envelopes are used by live SSE and the current-turn snapshot. */
export type StreamEnvelope = Record<string, unknown>

// A stream snapshot is a live-turn view, not a second transcript database.
// Keep the in-memory projection bounded; persisted history remains the source
// for older content when these limits are reached.
const MAX_PROJECTION_SLOTS = 4096
const MAX_TEXT_CHARS = 512 * 1024
const PROJECTION_TRUNCATION_MARKER = '\n[…部分内容已归档，可从历史记录读取…]\n'

const jsonFrames: Record<string, string> = {
  __run__: 'run', __user_message__: 'userMessage', __subagent_event__: 'subagentEvent',
  __usage__: 'usage', __tool_start__: 'toolStart', __tool_args__: 'toolArgs',
  __tool_end__: 'toolEnd', __ask_user__: 'ask_user', __tool_call__: 'toolCall',
  __tool_result__: 'toolResult', __permission_request__: 'permissionRequest',
  __message_block__: 'messageBlock', __flow__: 'flow', __todo__: 'todo', __file_change__: 'fileChange',
}
const textFrames: Record<string, string> = {
  __thinking__: 'thinking', __assistant_msg_id__: 'assistantMsgId',
  __user_msg_id__: 'userMsgId', __userMsgId__: 'userMsgId',
}

/** Invalid/unknown controls never become assistant body text. */
export function decodeStreamChunk(chunk: string): StreamEnvelope | null {
  if (!chunk.includes('\x00')) return { content: chunk }
  if (!chunk.startsWith('\x00')) return null
  const match = /^\x00(__[a-zA-Z_]+__)/.exec(chunk)
  if (!match) return null
  const [, name] = match
  const value = chunk.slice(match[0].length)
  if (Object.hasOwn(textFrames, name)) return { [textFrames[name]]: value }
  if (!Object.hasOwn(jsonFrames, name)) return null
  try { return { [jsonFrames[name]]: JSON.parse(value) } }
  catch { return null }
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const identity = (value: Record<string, unknown> | undefined, ...keys: string[]) => {
  for (const key of keys) if (typeof value?.[key] === 'string' && value[key]) return value[key] as string
  return undefined
}

interface ToolProjection {
  kind: 'tool'
  id: string
  start?: Record<string, unknown>
  call?: Record<string, unknown>
  args?: Record<string, unknown>
  result?: Record<string, unknown>
  end?: Record<string, unknown>
  pending?: StreamEnvelope
}
interface PayloadProjection { kind: 'payload'; payload: StreamEnvelope }
type ProjectionSlot = ToolProjection | PayloadProjection

/** Retains semantic state rather than a second unbounded event log. */
export class CurrentTurnProjection {
  private readonly slots = new Map<string, ProjectionSlot>()
  private sequence = 0
  private textTail?: { key: string; field: 'content' | 'thinking' }
  private _truncated = false

  constructor(initial: StreamEnvelope[] = []) { for (const payload of initial) this.apply(payload) }

  currentRun(): Record<string, unknown> | undefined {
    const slot = this.slots.get('run:')
    return slot?.kind === 'payload' ? record(slot.payload.run) : undefined
  }

  get truncated(): boolean { return this._truncated }

  apply(envelope: StreamEnvelope): void {
    for (const [field, value] of Object.entries(envelope)) this.applyField(field, value)
  }

  private applyField(field: string, value: unknown): void {
    if ((field === 'content' || field === 'thinking') && typeof value === 'string') {
      const tail = this.textTail?.field === field ? this.slots.get(this.textTail.key) : undefined
      if (tail?.kind === 'payload') tail.payload[field] = this.appendText(String(tail.payload[field]), value)
      else {
        const key = `text:${++this.sequence}`
        this.slots.set(key, { kind: 'payload', payload: { [field]: this.appendText('', value) } })
        this.textTail = { key, field }
      }
      this.trimSlots()
      return
    }
    this.textTail = undefined
    const data = record(value)
    if (['toolStart', 'toolCall', 'toolArgs', 'toolEnd', 'toolResult', 'ask_user', 'permissionRequest'].includes(field)) {
      const id = identity(data, 'toolCallId', 'requestId')
      if (!id || !data) return
      const key = `tool:${id}`
      let slot = this.slots.get(key) as ToolProjection | undefined
      if (!slot) { slot = { kind: 'tool', id }; this.slots.set(key, slot) }
      if (field === 'toolStart') {
        slot.start = { ...slot.start, ...this.boundRecord(data) }
        if (data.args !== undefined) slot.args = undefined
      } else if (field === 'toolCall') {
        slot.call = { ...slot.start, ...slot.call, ...this.boundRecord(data) }
        if (data.args !== undefined) slot.args = undefined
      } else if (field === 'toolArgs') {
        slot.args = { ...this.boundRecord(data), args: typeof data.args === 'string'
          ? (typeof slot.args?.args === 'string' ? slot.args.args : '') + data.args : data.args }
        if (typeof slot.args.args === 'string') slot.args.args = this.appendText('', slot.args.args)
      } else if (field === 'toolEnd' || field === 'toolResult') {
        if (field === 'toolEnd') slot.end = { ...slot.end, ...this.boundRecord(data) }
        else slot.result = { ...slot.end, ...slot.result, ...this.boundRecord(data) }
        if (data.status !== 'waiting') slot.pending = undefined
      } else {
        // The modern permission envelope supersedes its legacy ask_user alias.
        if (field === 'permissionRequest' || !slot.pending?.permissionRequest) slot.pending = { [field]: this.boundRecord(data) }
      }
      return
    }
    if (field === 'run' && data) {
      const terminal = typeof data.status === 'string' && !['running', 'waiting'].includes(data.status)
      const pending = Array.isArray(data.pending) ? data.pending : []
      const answered = new Set(pending.map(record).filter(item => item?.status === 'answered').map(item => identity(item, 'toolCallId', 'requestId')))
      for (const slot of this.slots.values()) if (slot.kind === 'tool' && (terminal || answered.has(slot.id))) slot.pending = undefined
    }
    const discriminator = field === 'fileChange' ? identity(data, 'id', 'changeId')
      : field === 'subagentEvent' ? identity(data, 'runId') ?? identity(record(data?.snapshot), 'runId')
        : field === 'messageBlock' ? identity(data, 'messageId', 'id')
          : field === 'flow' ? identity(data, 'nodeId', 'runId') : undefined
    const key = `${field}:${discriminator ?? ''}`
    const previous = this.slots.get(key)
    const mergedValue = field === 'usage' && previous?.kind === 'payload' && data
      ? { ...record(previous.payload.usage), ...data } : value
    this.slots.set(key, { kind: 'payload', payload: { [field]: this.boundValue(mergedValue) } })
    this.trimSlots()
  }

  private appendText(existing: string, addition: string): string {
    const next = existing + addition
    if (next.length <= MAX_TEXT_CHARS) return next
    this._truncated = true
    const tailLength = MAX_TEXT_CHARS - PROJECTION_TRUNCATION_MARKER.length - 128
    return next.slice(0, 128) + PROJECTION_TRUNCATION_MARKER
      + next.slice(Math.max(0, next.length - Math.max(1, tailLength)))
  }

  private boundValue(value: unknown): unknown {
    if (typeof value === 'string') return this.appendText('', value)
    if (Array.isArray(value)) return value.slice(0, MAX_PROJECTION_SLOTS).map(item => this.boundValue(item))
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      const entries = Object.entries(value as Record<string, unknown>)
      if (entries.length > MAX_PROJECTION_SLOTS) this._truncated = true
      for (const [key, item] of entries.slice(0, MAX_PROJECTION_SLOTS)) out[key] = this.boundValue(item)
      return out
    }
    return value
  }

  private boundRecord(value: Record<string, unknown>): Record<string, unknown> {
    return this.boundValue(value) as Record<string, unknown>
  }

  private trimSlots(): void {
    while (this.slots.size > MAX_PROJECTION_SLOTS) {
      const first = this.slots.keys().next().value as string | undefined
      if (!first) break
      // Preserve the run watermark even when a very long turn has many tool
      // calls; older transcript details remain available from persisted history.
      if (first === 'run:') {
        const iterator = this.slots.keys()
        iterator.next()
        const candidate = iterator.next().value as string | undefined
        if (!candidate) break
        this.slots.delete(candidate)
      } else this.slots.delete(first)
      this._truncated = true
    }
  }

  snapshot(): StreamEnvelope[] {
    const payloads: StreamEnvelope[] = []
    for (const slot of this.slots.values()) {
      if (slot.kind === 'payload') { payloads.push(slot.payload); continue }
      if (slot.call) payloads.push({ toolCall: slot.call })
      else if (slot.start) payloads.push({ toolStart: slot.start })
      if (slot.args) payloads.push({ toolArgs: slot.args })
      if (slot.result) payloads.push({ toolResult: slot.result })
      else if (slot.end) payloads.push({ toolEnd: slot.end })
      if (slot.pending) payloads.push(slot.pending)
    }
    // Callers cannot mutate a captured snapshot or future projection state.
    return structuredClone(payloads)
  }
}
