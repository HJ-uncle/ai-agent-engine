import type { SseEventPayload } from '../stream-pipeline/stream-bus.js'
import { SnapshotRequiredError } from '../stream-pipeline/stream-bus.js'
import { getSubagentStore, type SubagentStore } from './store.js'
import { projectSubagentRunView } from './view.js'
import type { SubagentRun, SubagentRunView } from './types.js'

export interface SubagentProtocolStreamOptions {
  protocol: 1 | 2
  tenantId: string
  store?: Pick<SubagentStore, 'getViewsAtSequences' | 'getSnapshotsAtSequences'>
}

// Expansion for a legacy viewer must not bypass the transport's existing
// memory protection merely because its shared producer now emits small deltas.
const MAX_FRAME_BYTES = 8 * 1024 * 1024
const identityKeys = ['tenantId', 'rootSessionId', 'parentSessionId', 'parentConversationId',
  'parentMessageId', 'parentToolCallId', 'childSessionId'] as const
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const sequence = (value: unknown, min = 1): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min

function legacyKind(value: unknown): string {
  return typeof value === 'string' && ['created', 'started', 'cancelling', 'tool.started',
    'tool.completed', 'usage.updated', 'output.updated', 'finished'].includes(value) ? value : 'output.updated'
}

function recovery(message: string): SnapshotRequiredError {
  return new SnapshotRequiredError(`SUBAGENT_RECOVERY_REQUIRED: ${message}`)
}

function checkRun(value: Record<string, unknown>, options: SubagentProtocolStreamOptions,
  expected?: { runId: string; seq: number; identity?: Record<string, unknown> }): void {
  if (typeof value.runId !== 'string' || !value.runId || !sequence(value.lastSeq)
    || !identityKeys.every(key => typeof value[key] === 'string') || value.tenantId !== options.tenantId
    || expected && (value.runId !== expected.runId || value.lastSeq !== expected.seq
      || expected.identity && identityKeys.some(key => value[key] !== expected.identity![key]))) {
    throw recovery('Subagent identity or published watermark is inconsistent')
  }
}

/** Preflight expansion before allocating a potentially giant legacy JSON frame. */
function assertSerializedBudget(value: unknown, maxBytes: number): void {
  let bytes = 0
  const ancestors = new Set<object>()
  const add = (count: number) => { bytes += count; if (bytes > maxBytes) throw recovery('Expanded subagent frame exceeds the transport byte budget') }
  const string = (text: string) => {
    // JSON escaping only adds bytes, so a giant stored string can fail without
    // first allocating another giant encoded string.
    if (Buffer.byteLength(text, 'utf8') + 2 > maxBytes - bytes) throw recovery('Expanded subagent frame exceeds the transport byte budget')
    add(2)
    for (const character of text) {
      const point = character.codePointAt(0)!
      add(point === 34 || point === 92 || (point === 8 || point === 9 || point === 10 || point === 12 || point === 13) ? 2
        : point < 32 || point >= 0xd800 && point <= 0xdfff ? 6 : Buffer.byteLength(character, 'utf8'))
    }
  }
  const visit = (item: unknown): void => {
    if (typeof item === 'string') { string(item); return }
    if (item === null || item === undefined) { add(4); return }
    if (typeof item === 'boolean') { add(item ? 4 : 5); return }
    if (typeof item === 'number') { add(Number.isFinite(item) ? String(item).length : 4); return }
    if (typeof item !== 'object') throw recovery('Invalid subagent JSON detail type')
    if (ancestors.has(item)) throw recovery('Cyclic subagent JSON detail')
    ancestors.add(item)
    try {
      add(2)
      let count = 0
      if (Array.isArray(item)) for (const entry of item) {
        if (count++) add(1)
        visit(entry)
      } else for (const key in item) {
        if (!Object.hasOwn(item, key)) continue
        const entry = (item as Record<string, unknown>)[key]
        if (entry === undefined) continue
        if (count++) add(1)
        string(key)
        add(1)
        visit(entry)
      }
    } finally { ancestors.delete(item) }
  }
  try { visit(value) }
  catch (error) {
    if (error instanceof SnapshotRequiredError) throw error
    throw recovery('Subagent JSON detail cannot be serialized within the transport budget')
  }
}

async function adaptChunk(chunk: string, options: SubagentProtocolStreamOptions): Promise<string> {
  const marker = /^\x00__(subagent_event|tool_end|tool_result)__/.exec(chunk)
  if (!marker) return chunk
  if (Buffer.byteLength(chunk, 'utf8') > MAX_FRAME_BYTES) throw recovery('Subagent source frame exceeds the transport byte budget')
  let parsed: unknown
  try { parsed = JSON.parse(chunk.slice(marker[0].length)) }
  catch { throw recovery('Invalid subagent control JSON') }
  const payload = record(parsed)
  if (!payload) throw recovery('Invalid subagent control payload')
  let store: SubagentProtocolStreamOptions['store']
  const exactCache = new Map<string, Promise<SubagentRun | SubagentRunView>>()
  const exact = (runId: string, seq: number): Promise<SubagentRun | SubagentRunView> => {
    const key = JSON.stringify([runId, seq])
    const existing = exactCache.get(key)
    if (existing) return existing
    const promise = (async () => {
      const activeStore = store ?? options.store ?? getSubagentStore()
      store = activeStore
      const watermarks = [{ runId, seq }]
      const rows = options.protocol === 1
        ? await activeStore.getSnapshotsAtSequences(options.tenantId, watermarks)
        : await activeStore.getViewsAtSequences(options.tenantId, watermarks)
      const matches = rows.filter(item => item.runId === runId && item.lastSeq === seq && item.tenantId === options.tenantId)
      if (matches.length !== 1) throw recovery('Exact published subagent version is unavailable')
      const result = matches[0]
      if (options.protocol === 1 && (result.schemaVersion !== 1 || 'coverage' in result || 'view' in result)) {
        throw recovery('A summary cannot be represented as a complete legacy snapshot')
      }
      if (options.protocol === 2 && result.schemaVersion !== 2) throw recovery('Exact subagent summary is unavailable')
      return result
    })()
    exactCache.set(key, promise)
    return promise
  }

  const adaptRun = async (value: unknown, expected?: { runId: string; seq: number; identity?: Record<string, unknown> }): Promise<SubagentRun | SubagentRunView> => {
    const run = record(value)
    if (!run || (run.schemaVersion !== 1 && run.schemaVersion !== 2)) throw recovery('Unsupported subagent run version')
    checkRun(run, options, expected)
    if (options.protocol === 1) {
      if (run.schemaVersion === 1 && !('coverage' in run) && !('view' in run)) {
        if (!Array.isArray(run.toolCalls)) throw recovery('Legacy subagent tools are unavailable')
        return run as unknown as SubagentRun
      }
      const canonical = await exact(String(run.runId), Number(run.lastSeq))
      checkRun(canonical as unknown as Record<string, unknown>, options, expected)
      return canonical
    }
    try { return projectSubagentRunView(run as unknown as SubagentRun | SubagentRunView) }
    catch { throw recovery('Subagent summary coverage is invalid') }
  }

  let changed = false
  let result: Record<string, unknown> = payload
  if (marker[1] === 'subagent_event') {
    if ((payload.schemaVersion !== 1 && payload.schemaVersion !== 2)
      || typeof payload.runId !== 'string' || !payload.runId || !sequence(payload.seq)) {
      throw recovery('Unsupported subagent event version or watermark')
    }
    const expected = { runId: payload.runId, seq: payload.seq, identity: record(payload.identity) }
    const embedded = record(payload.view) ?? record(payload.snapshot)
    if (embedded) {
      const adapted = await adaptRun(embedded, expected)
      if (options.protocol === 1) {
        if (payload.schemaVersion === 1 && payload.snapshot === embedded && Object.is(adapted, embedded)) return chunk
        result = { schemaVersion: 1, kind: legacyKind(payload.kind),
          runId: payload.runId, seq: payload.seq, snapshot: adapted }
      } else {
        result = { schemaVersion: 2, kind: 'snapshot', runId: payload.runId, seq: payload.seq, view: adapted }
      }
      changed = true
    } else {
      if (payload.schemaVersion !== 2) throw recovery('A legacy event is missing its complete snapshot')
      if (payload.recoveryRequired === true || payload.view === 'recovery-required') {
        const exactRun = await exact(payload.runId, payload.seq)
        checkRun(exactRun as unknown as Record<string, unknown>, options, expected)
        result = options.protocol === 1
          ? { schemaVersion: 1, kind: 'output.updated', runId: payload.runId, seq: payload.seq, snapshot: exactRun }
          : { schemaVersion: 2, kind: 'snapshot', runId: payload.runId, seq: payload.seq, view: projectSubagentRunView(exactRun) }
        changed = true
      } else {
        const identity = expected.identity
        if (!identity || identity.tenantId !== options.tenantId || !identityKeys.every(key => typeof identity[key] === 'string')
          || !sequence(payload.baseSeq, 0) || payload.seq !== payload.baseSeq + 1 || !record(payload.headerPatch)) {
          throw recovery('Invalid subagent delta identity or sequence')
        }
        if (options.protocol === 2) return chunk
        const canonical = await exact(payload.runId, payload.seq)
        checkRun(canonical as unknown as Record<string, unknown>, options, expected)
        result = { schemaVersion: 1, kind: legacyKind(payload.kind), runId: payload.runId, seq: payload.seq, snapshot: canonical }
        changed = true
      }
    }
  } else {
    const nested = async (parent: Record<string, unknown>): Promise<Record<string, unknown>> => {
      if (parent.subagent === undefined) return parent
      const adapted = await adaptRun(parent.subagent)
      if (adapted === parent.subagent) return parent
      changed = true
      return { ...parent, subagent: adapted }
    }
    result = await nested(result)
    for (const key of ['metadata', 'meta']) {
      const metadata = record(result[key])
      if (!metadata) continue
      const adapted = await nested(metadata)
      if (adapted !== metadata) result = { ...result, [key]: adapted }
    }
  }
  if (!changed) return chunk
  assertSerializedBudget(result, MAX_FRAME_BYTES - Buffer.byteLength(marker[0], 'utf8'))
  const encoded = marker[0] + JSON.stringify(result)
  if (Buffer.byteLength(encoded, 'utf8') > MAX_FRAME_BYTES) throw recovery('Expanded subagent frame exceeds the transport byte budget')
  return encoded
}

/** One published stream can serve both generations without changing durable events or their IDs. */
export function subagentProtocolStream(source: AsyncIterable<SseEventPayload | string>,
  options: SubagentProtocolStreamOptions): AsyncIterableIterator<SseEventPayload | string> {
  if ((options.protocol !== 1 && options.protocol !== 2) || !options.tenantId) throw new TypeError('Invalid subagent stream protocol')
  const iterator = source[Symbol.asyncIterator]()
  let closed = false
  let reading = false
  const finish = () => {
    if (closed) return
    closed = true
    // Detach immediately, even while an exact-version database read is pending.
    // Async-generator return would queue behind that read and retain bus listeners.
    try { void Promise.resolve(iterator.return?.()).catch(() => undefined) } catch { /* already closed */ }
  }
  const done = (): IteratorResult<SseEventPayload | string> => ({ done: true, value: undefined })
  return {
    [Symbol.asyncIterator]() { return this },
    async next() {
      if (closed) return done()
      if (reading) throw new Error('Concurrent reads on one subagent protocol stream are not supported')
      reading = true
      try {
        const item = await iterator.next()
        if (closed) return done()
        if (item.done) { finish(); return done() }
        const value = item.value
        const original = typeof value === 'string' ? value : value.chunk
        const adapted = await adaptChunk(original, options)
        if (closed) return done()
        return { done: false, value: adapted === original ? value
          : typeof value === 'string' ? adapted : { ...value, chunk: adapted } }
      } catch (error) {
        if (closed) return done()
        finish()
        throw error
      } finally { reading = false }
    },
    return() { finish(); return Promise.resolve(done()) },
    throw(error: unknown) { finish(); return Promise.reject(error) },
  }
}
