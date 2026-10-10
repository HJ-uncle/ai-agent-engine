import { browserOutputPresentation } from '../utils/browser-output.js'

/** The same envelopes are used by live SSE and the current-turn snapshot. */
export type StreamEnvelope = Record<string, unknown>
export interface SubagentWatermark { runId: string; seq: number }

// A stream snapshot is a live-turn view, not a second transcript database.
// Keep the in-memory projection bounded; persisted history remains the source
// for older content when these limits are reached.
const MAX_PROJECTION_SLOTS = 4096
const MAX_TEXT_CHARS = 512 * 1024
const MAX_BROWSER_IMAGE_CHARS = 16 * 1024 * 1024
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
  browserPreviews?: Record<string, { imageChars: number; model: string }>
}
interface PayloadProjection { kind: 'payload'; payload: StreamEnvelope }
type ProjectionSlot = ToolProjection | PayloadProjection

/** Retains semantic state rather than a second unbounded event log. */
export class CurrentTurnProjection {
  private readonly slots = new Map<string, ProjectionSlot>()
  // A transcript slot can be evicted; its published child sequence cannot.
  // Keep only identities here and recover immutable details from the store.
  private readonly childSequences = new Map<string, number>()
  private sequence = 0
  private textTail?: { key: string; field: 'content' | 'thinking' }
  private _truncated = false

  constructor(initial: StreamEnvelope[] = [], watermarks: SubagentWatermark[] = [], truncated = false) {
    this._truncated = truncated
    for (const watermark of watermarks) this.recordChildSequence(watermark.runId, watermark.seq)
    for (const payload of initial) this.apply(payload)
  }

  private recordChildSequence(runId: unknown, seq: unknown): void {
    if (typeof runId !== 'string' || !runId || typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1) return
    this.childSequences.set(runId, Math.max(this.childSequences.get(runId) ?? 0, seq))
  }

  subagentWatermarks(): SubagentWatermark[] {
    return [...this.childSequences].map(([runId, seq]) => ({ runId, seq }))
  }

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
    const child = field === 'subagentEvent' ? record(data?.snapshot)
      : field === 'toolEnd' || field === 'toolResult' ? record(data?.subagent ?? record(data?.metadata)?.subagent) : undefined
    if (child) this.recordChildSequence(child.runId, child.lastSeq)
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
        const bounded = this.boundToolResult(data, slot)
        if (field === 'toolEnd') slot.end = { ...slot.end, ...bounded }
        else {
          slot.result = { ...slot.end, ...slot.result, ...bounded }
          slot.end = undefined
        }
        if (data.status !== 'waiting') slot.pending = undefined
      } else {
        // The modern permission envelope supersedes its legacy ask_user alias.
        if (field === 'permissionRequest' || !slot.pending?.permissionRequest) slot.pending = { [field]: this.boundRecord(data) }
      }
      this.trimSlots()
      if (field === 'toolEnd' || field === 'toolResult') this.trimBrowserImages()
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
    if (field === 'usage' && data && record(mergedValue)
      && (typeof data.currentPromptTokens === 'number' || typeof data.promptTokens === 'number')) {
      const usage = mergedValue as Record<string, unknown>
      const contextModelId = identity(data, 'contextModelId', 'modelId') ?? identity(record(mergedValue), 'modelId')
      delete usage.contextModelId
      if (contextModelId) usage.contextModelId = contextModelId
      if (typeof data.currentPromptTokens !== 'number') delete usage.currentPromptTokens
      if (typeof data.contextUsageEstimated !== 'boolean') delete usage.contextUsageEstimated
      if (typeof data.contextUsageProvisional !== 'boolean') delete usage.contextUsageProvisional
      if (typeof data.requestInputTokenEstimate !== 'number') delete usage.requestInputTokenEstimate
      // A new invocation with an unknown model window must not inherit the
      // previous invocation's limit. Model-only patches keep its snapshot.
      if (data.contextWindow === undefined) delete usage.contextWindow
      const used = data.currentPromptTokens ?? data.promptTokens
      if (data.contextUsageEstimated === false && data.contextUsageProvisional !== true
        && typeof used === 'number' && Number.isFinite(used) && used >= 0) {
        usage.confirmedContext = { used,
          ...(typeof data.contextWindow === 'number' && Number.isFinite(data.contextWindow) && data.contextWindow > 0
            ? { contextWindow: data.contextWindow } : {}), ...(contextModelId ? { modelId: contextModelId } : {}) }
      }
    }
    this.slots.set(key, { kind: 'payload', payload: { [field]: field === 'run' && data ? this.boundRun(data) : this.boundValue(mergedValue) } })
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

  private boundToolResult(value: Record<string, unknown>, slot: ToolProjection): Record<string, unknown> {
    const { output, outputPreview, ...rest } = value
    const bounded = this.boundRecord(rest)
    for (const [key, item] of Object.entries({ output, outputPreview })) {
      if (item === undefined) continue
      const preview = browserOutputPresentation(item, MAX_TEXT_CHARS)
      bounded[key] = preview?.displayOutput ?? this.boundValue(item)
      if (preview?.imageChars) {
        slot.browserPreviews ??= {}
        slot.browserPreviews[key] = { imageChars: preview.imageChars, model: preview.modelInputContent }
      } else if (slot.browserPreviews) delete slot.browserPreviews[key]
    }
    return bounded
  }

  private boundRecord(value: Record<string, unknown>): Record<string, unknown> {
    return this.boundValue(value) as Record<string, unknown>
  }

  private boundRun(run: Record<string, unknown>): Record<string, unknown> {
    if (!Array.isArray(run.pending)) return this.boundRecord(run)
    const { pending, ...state } = run
    const active = pending.filter(item => record(item)?.status === 'pending')
    const answered = pending.filter(item => record(item)?.status !== 'pending')
    const retained = [...(active.length >= MAX_PROJECTION_SLOTS ? [] : answered.slice(-(MAX_PROJECTION_SLOTS - active.length))), ...active]
    if (retained.length < pending.length) this._truncated = true
    // Old answered controls remain in durable audit data. The newest active
    // control must survive even when thousands of earlier ones were answered.
    return { ...this.boundRecord(state), pending: retained.map(item => this.boundValue(item)) }
  }

  private trimSlots(): void {
    while (this.slots.size > MAX_PROJECTION_SLOTS) {
      let candidate: string | undefined
      for (const key of this.slots.keys()) {
        if (key !== 'run:' && key !== 'usage:') { candidate = key; break }
      }
      if (!candidate) break
      // Latest billing/context and run state are semantic snapshots, not old
      // transcript details. Eviction must never reset the visible counters.
      this.slots.delete(candidate)
      this._truncated = true
    }
  }

  private trimBrowserImages(): void {
    // Pixel evidence has its own aggregate bound. Scan only when tool results
    // change; scanning all tool slots for each text token slows long turns.
    // Older screenshots remain in durable history after projection eviction.
    let imageChars = 0
    for (const slot of this.slots.values()) if (slot.kind === 'tool') {
      imageChars += Object.values(slot.browserPreviews ?? {}).reduce((total, image) => total + image.imageChars, 0)
    }
    if (imageChars > MAX_BROWSER_IMAGE_CHARS) for (const slot of this.slots.values()) {
      if (slot.kind !== 'tool' || !slot.browserPreviews) continue
      for (const [key, image] of Object.entries(slot.browserPreviews)) {
        if (slot.end?.[key] !== undefined) slot.end[key] = image.model
        if (slot.result?.[key] !== undefined) slot.result[key] = image.model
        imageChars -= image.imageChars
      }
      slot.browserPreviews = undefined
      this._truncated = true
      if (imageChars <= MAX_BROWSER_IMAGE_CHARS) break
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
