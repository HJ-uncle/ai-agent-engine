/** The same envelopes are used by live SSE and the current-turn snapshot. */
export type StreamEnvelope = Record<string, unknown>

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

  constructor(initial: StreamEnvelope[] = []) { for (const payload of initial) this.apply(payload) }

  currentRun(): Record<string, unknown> | undefined {
    const slot = this.slots.get('run:')
    return slot?.kind === 'payload' ? record(slot.payload.run) : undefined
  }

  apply(envelope: StreamEnvelope): void {
    for (const [field, value] of Object.entries(envelope)) this.applyField(field, value)
  }

  private applyField(field: string, value: unknown): void {
    if ((field === 'content' || field === 'thinking') && typeof value === 'string') {
      const tail = this.textTail?.field === field ? this.slots.get(this.textTail.key) : undefined
      if (tail?.kind === 'payload') tail.payload[field] = String(tail.payload[field]) + value
      else {
        const key = `text:${++this.sequence}`
        this.slots.set(key, { kind: 'payload', payload: { [field]: value } })
        this.textTail = { key, field }
      }
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
        slot.start = { ...slot.start, ...data }
        if (data.args !== undefined) slot.args = undefined
      } else if (field === 'toolCall') {
        slot.call = { ...slot.start, ...slot.call, ...data }
        if (data.args !== undefined) slot.args = undefined
      } else if (field === 'toolArgs') {
        slot.args = { ...data, args: typeof data.args === 'string'
          ? (typeof slot.args?.args === 'string' ? slot.args.args : '') + data.args : data.args }
      } else if (field === 'toolEnd' || field === 'toolResult') {
        if (field === 'toolEnd') slot.end = { ...slot.end, ...data }
        else slot.result = { ...slot.end, ...slot.result, ...data }
        if (data.status !== 'waiting') slot.pending = undefined
      } else {
        // The modern permission envelope supersedes its legacy ask_user alias.
        if (field === 'permissionRequest' || !slot.pending?.permissionRequest) slot.pending = { [field]: data }
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
    this.slots.set(key, { kind: 'payload', payload: { [field]: mergedValue } })
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
