import { describe, expect, it } from 'vitest'
import { StreamBus, busToIterable, type SseEventPayload } from '../stream-bus.js'

async function collect(source: AsyncIterable<SseEventPayload>): Promise<SseEventPayload[]> {
  const result: SseEventPayload[] = []
  for await (const payload of source) result.push(payload)
  return result
}

function expectSnapshotRequired(action: () => unknown): void {
  try {
    action()
    expect.fail('Expected a snapshot_required cursor error')
  } catch (error) {
    expect(error).toMatchObject({ statusCode: 409, code: 'snapshot_required' })
  }
}

function frame(name: string, payload: unknown): string {
  return `\x00__${name}__${JSON.stringify(payload)}`
}

describe('StreamBus resumable subscriptions', () => {
  it('retains the latest context and billing snapshot when long-turn details exceed the projection cap', () => {
    const bus = new StreamBus(new AbortController())
    const usage = { currentPromptTokens: 10_000, promptTokens: 44_000, contextWindow: 100_000 }
    bus.push(frame('run', { runId: 'long-turn' }))
    bus.push(frame('usage', usage))
    for (let index = 0; index < 4_200; index++) bus.push(frame('file_change', { id: `change-${index}` }))
    expect(bus.snapshot().projectionTruncated).toBe(true)
    expect(bus.snapshot().projection.find(frame => frame.usage)?.usage).toEqual(usage)
    expect(bus.snapshot().projection.find(frame => frame.run)?.run).toEqual({ runId: 'long-turn' })
  })

  it('retains detached child sequence watermarks through detail eviction and approval seeding', () => {
    const bus = new StreamBus(new AbortController())
    const child = { runId: 'child-1', lastSeq: 2 }
    bus.push(frame('subagent_event', { snapshot: child }))
    for (let index = 0; index < 4_200; index++) bus.push(frame('file_change', { id: `change-${index}` }))
    const snapshot = bus.snapshot()
    expect(snapshot.projection.find(frame => frame.subagentEvent)).toBeUndefined()
    expect(snapshot.subagentWatermarks).toEqual([{ runId: child.runId, seq: 2 }])
    const resumed = new StreamBus(new AbortController())
    resumed.seedProjection(snapshot.projection, snapshot.subagentWatermarks, snapshot.projectionTruncated)
    snapshot.subagentWatermarks![0].seq = 1000
    expect(resumed.snapshot().subagentWatermarks).toEqual([{ runId: child.runId, seq: 2 }])
    expect(resumed.snapshot().projectionTruncated).toBe(true)
    resumed.push(frame('tool_result', { metadata: { subagent: { ...child, lastSeq: 3 } } }))
    resumed.push(frame('subagent_event', { snapshot: child }))
    expect(resumed.snapshot().subagentWatermarks).toEqual([{ runId: child.runId, seq: 3 }])
  })

  it('retains active approval controls beyond thousands of answered predecessors', () => {
    const bus = new StreamBus(new AbortController())
    const answered = Array.from({ length: 4_200 }, (_, index) => ({ requestId: `answered-${index}`, status: 'answered' }))
    const pending = { requestId: 'active', toolCallId: 'active-tool', status: 'pending' }
    bus.push(frame('run', { runId: 'long-run', status: 'waiting', pending: [...answered, pending] }))
    const snapshot = bus.snapshot()
    const run = snapshot.projection.find(frame => frame.run)?.run as { pending: Array<typeof pending> }
    expect(run.pending.filter(item => item.status === 'pending')).toEqual([pending])
    expect(run.pending).toHaveLength(4_096)
    expect(snapshot.projectionTruncated).toBe(true)
  })

  it('bounds tool-only projection streams while retaining their usage snapshot', () => {
    const bus = new StreamBus(new AbortController())
    bus.push(frame('usage', { promptTokens: 44_000, currentPromptTokens: 10_000 }))
    for (let index = 0; index < 4_200; index++) bus.push(frame('tool_start', { toolCallId: `tool-${index}`, name: 'read_file' }))
    const snapshot = bus.snapshot()
    expect(snapshot.projectionTruncated).toBe(true)
    expect(snapshot.projection.length).toBeLessThanOrEqual(4_096)
    expect(snapshot.projection.find(frame => frame.usage)?.usage).toMatchObject({ promptTokens: 44_000, currentPromptTokens: 10_000 })
    expect(snapshot.projection.find(frame => (frame.toolStart as { toolCallId?: string })?.toolCallId === 'tool-0')).toBeUndefined()
  })

  it('replays a shrinking context snapshot with increasing cumulative input and preserves it after model-only updates', async () => {
    const bus = new StreamBus(new AbortController())
    const first = bus.push(frame('usage', { currentPromptTokens: 12_000, promptTokens: 12_000, contextWindow: 100_000 }))!
    bus.push(frame('usage', { currentPromptTokens: 22_000, promptTokens: 34_000, contextWindow: 100_000 }))
    bus.push(frame('usage', { currentPromptTokens: 10_000, promptTokens: 44_000, contextWindow: 100_000 }))
    bus.push(frame('usage', { modelId: 'fallback' }))
    bus.end()
    expect(bus.snapshot().projection).toEqual([{ usage: {
      currentPromptTokens: 10_000, promptTokens: 44_000, contextWindow: 100_000, modelId: 'fallback',
    } }])
    const replay = await collect(busToIterable(bus, first.id))
    expect(replay.map(event => JSON.parse(event.chunk.slice('\x00__usage__'.length)))).toEqual([
      { currentPromptTokens: 22_000, promptTokens: 34_000, contextWindow: 100_000 },
      { currentPromptTokens: 10_000, promptTokens: 44_000, contextWindow: 100_000 }, { modelId: 'fallback' },
    ])
  })

  it('merges model-only usage updates without summing or losing cumulative counters', () => {
    const bus = new StreamBus(new AbortController())
    bus.push(frame('usage', { promptTokens: 20, completionTokens: 10, totalTokens: 30, modelId: 'primary' }))
    bus.push(frame('usage', { modelId: 'fallback' }))
    expect(bus.snapshot().projection).toEqual([
      { usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30, modelId: 'fallback', contextModelId: 'primary' } },
    ])
    bus.push(frame('usage', { promptTokens: 40, completionTokens: 15, totalTokens: 55, modelId: 'fallback' }))
    expect(bus.snapshot().projection).toEqual([
      { usage: { promptTokens: 40, completionTokens: 15, totalTokens: 55, modelId: 'fallback', contextModelId: 'fallback' } },
    ])
  })

  it('recovers a pending invocation input without charging its estimate as completed usage', () => {
    const bus = new StreamBus(new AbortController())
    bus.push(frame('usage', { currentPromptTokens: 14_577, promptTokens: 130_000, completionTokens: 9_352,
      totalTokens: 139_352, contextWindow: 1_000_000, modelId: 'primary', contextUsageEstimated: false }))
    bus.push(frame('usage', { currentPromptTokens: 17_123, contextWindow: 64_000,
      modelId: 'fallback', contextUsageEstimated: true }))
    expect(bus.snapshot().projection.find(item => item.usage)?.usage).toEqual({ currentPromptTokens: 17_123,
      promptTokens: 130_000, completionTokens: 9_352, totalTokens: 139_352, contextWindow: 64_000,
      modelId: 'fallback', contextModelId: 'fallback', contextUsageEstimated: true,
      confirmedContext: { used: 14_577, contextWindow: 1_000_000, modelId: 'primary' } })
    bus.push(frame('usage', { currentPromptTokens: 16_885, contextWindow: 64_000,
      modelId: 'fallback', contextUsageEstimated: false }))
    expect(bus.snapshot().projection.find(item => item.usage)?.usage).toMatchObject({ currentPromptTokens: 16_885,
      totalTokens: 139_352, contextUsageEstimated: false })
    bus.push(frame('usage', { currentPromptTokens: 18_000, contextWindow: 64_000 }))
    expect(bus.snapshot().projection.find(item => item.usage)?.usage).not.toHaveProperty('contextUsageEstimated')
  })

  it('retains confirmed context through estimates, provisional gateway counts, eviction and recovery', () => {
    const bus = new StreamBus(new AbortController())
    bus.push(frame('usage', { currentPromptTokens: 55_327, contextWindow: 128_000, modelId: 'model',
      contextUsageEstimated: false, contextUsageProvisional: false, promptTokens: 164_025, totalTokens: 164_025 }))
    bus.push(frame('usage', { currentPromptTokens: 64_673, contextWindow: 128_000, modelId: 'model',
      contextUsageEstimated: true, contextUsageProvisional: false, requestInputTokenEstimate: 64_673 }))
    bus.push(frame('usage', { currentPromptTokens: 19_848, contextWindow: 128_000, modelId: 'model',
      contextUsageEstimated: false, contextUsageProvisional: true, requestInputTokenEstimate: 64_673 }))
    for (let index = 0; index < 4_200; index++) bus.push(frame('file_change', { id: `context-change-${index}` }))
    const snapshot = bus.snapshot()
    expect(snapshot.projection.find(item => item.usage)?.usage).toMatchObject({ currentPromptTokens: 19_848,
      totalTokens: 164_025, contextUsageProvisional: true, requestInputTokenEstimate: 64_673,
      confirmedContext: { used: 55_327, contextWindow: 128_000, modelId: 'model' } })
    const recovered = new StreamBus(new AbortController())
    recovered.seedProjection(snapshot.projection)
    expect(recovered.snapshot().projection.find(item => item.usage)?.usage).toEqual(snapshot.projection.find(item => item.usage)?.usage)
    recovered.push(frame('usage', { currentPromptTokens: 56_306, contextWindow: 128_000, modelId: 'model',
      contextUsageEstimated: false, contextUsageProvisional: false, requestInputTokenEstimate: 64_673,
      promptTokens: 220_331, completionTokens: 1_295, totalTokens: 221_626 }))
    expect(recovered.snapshot().projection.find(item => item.usage)?.usage).toMatchObject({ currentPromptTokens: 56_306,
      totalTokens: 221_626, confirmedContext: { used: 56_306, contextWindow: 128_000, modelId: 'model' } })
    recovered.push(frame('usage', { currentPromptTokens: 20_000, contextUsageEstimated: false }))
    expect(recovered.snapshot().projection.find(item => item.usage)?.usage).toMatchObject({ confirmedContext: { used: 20_000, modelId: 'model' } })
    expect(recovered.snapshot().projection.find(item => item.usage)?.usage).not.toHaveProperty('contextUsageProvisional')
    expect(recovered.snapshot().projection.find(item => item.usage)?.usage).not.toHaveProperty('requestInputTokenEstimate')
  })

  it('does not retain an older context window when a fresh invocation has an unknown window', () => {
    const bus = new StreamBus(new AbortController())
    bus.push(frame('usage', { promptTokens: 12_000, currentPromptTokens: 12_000, contextWindow: 100_000 }))
    bus.push(frame('usage', { modelId: 'new-provider' }))
    expect(bus.snapshot().projection[0].usage).toMatchObject({ contextWindow: 100_000, currentPromptTokens: 12_000 })
    bus.push(frame('usage', { promptTokens: 22_000, currentPromptTokens: 10_000, modelId: 'new-provider' }))
    expect(bus.snapshot().projection).toEqual([{ usage: { promptTokens: 22_000, currentPromptTokens: 10_000, modelId: 'new-provider', contextModelId: 'new-provider' } }])
  })

  it('preserves input model ownership across model-only frames and snapshots without a window', () => {
    const bus = new StreamBus(new AbortController())
    bus.push(frame('usage', { promptTokens: 12_000, currentPromptTokens: 12_000, modelId: 'input-model' }))
    bus.push(frame('usage', { modelId: 'new-model' }))
    expect(bus.snapshot().projection).toEqual([{ usage: { promptTokens: 12_000, currentPromptTokens: 12_000,
      modelId: 'new-model', contextModelId: 'input-model' } }])
  })

  it('publishes a newer cancellation after a waiting stream ends and replays it after the old watermark', async () => {
    const bus = new StreamBus(new AbortController())
    const pending = { requestId: 'approval-1', toolCallId: 'tool-1', status: 'pending' }
    bus.push(frame('run', { runId: 'run-1', version: 2, status: 'waiting', pending: [pending] }))
    bus.push(frame('permission_request', pending))
    bus.end()
    const old = bus.snapshot()
    const run = { runId: 'run-1', version: 3, status: 'cancelled', pending: [pending] }
    const event = bus.publishRunState(run)

    expect(event).toBeDefined()
    expect(bus.snapshot()).toMatchObject({ eventId: event!.id, finished: true })
    expect(bus.snapshot().projection).toContainEqual({ run })
    expect(bus.snapshot().projection.some(payload => payload.permissionRequest)).toBe(false)
    expect(await collect(busToIterable(bus, old.eventId))).toEqual([event])
    expect(bus.push('cannot restart the producer')).toBeUndefined()
  })

  it('rejects run-state updates for another run or an older version without advancing its cursor', () => {
    const bus = new StreamBus(new AbortController())
    bus.push(frame('run', { runId: 'run-1', version: 5, status: 'cancelled' }))
    bus.end()
    const snapshot = bus.snapshot()
    for (const run of [{ runId: 'other', version: 6 }, { runId: 'run-1', version: 4 },
      { runId: 'run-1', version: 5 }, { runId: 'run-1', version: 5.5 }]) {
      expect(bus.publishRunState(run)).toBeUndefined()
      expect(bus.snapshot()).toEqual(snapshot)
    }
  })

  it('starts at a stable zero watermark and gives each stream its own cursor namespace', () => {
    const first = new StreamBus(new AbortController())
    const second = new StreamBus(new AbortController())
    expect(first.streamId).not.toBe(second.streamId)
    expect(first.lastEventId).toBe(`${first.streamId}:0`)
    expect(first.snapshot()).toMatchObject({
      schemaVersion: 1,
      streamId: first.streamId,
      eventId: first.lastEventId,
      finished: false,
      projection: [],
    })
    expect(() => first.assertReplayCursor(first.lastEventId)).not.toThrow()
    expect(() => first.assertReplayCursor()).not.toThrow()
  })

  it('subscribes when created so ring eviction before the first next does not lose events', async () => {
    const bus = new StreamBus(new AbortController(), { maxReplayEvents: 1, maxSubscriberEvents: 8 })
    const first = bus.push('before')!
    const iterator = busToIterable(bus, first.id)
    const second = bus.push('during-1')!
    const third = bus.push('during-2')!
    bus.end()

    expect(await collect(iterator)).toEqual([second, third])
  })

  it('hands cached replay over to live delivery without missing or repeating a boundary event', async () => {
    const bus = new StreamBus(new AbortController(), { maxReplayEvents: 2, maxSubscriberEvents: 8 })
    const first = bus.push('cached-1')!
    const second = bus.push('cached-2')!
    const iterator = busToIterable(bus)
    expect(await iterator.next()).toEqual({ value: first, done: false })

    const third = bus.push('live-1')!
    const fourth = bus.push('live-2')!
    bus.end()
    expect(await collect(iterator)).toEqual([second, third, fourth])
  })

  it('accepts the event immediately before the replay window and rejects older or absent cursors', async () => {
    const bus = new StreamBus(new AbortController(), { maxReplayEvents: 2 })
    const zero = bus.lastEventId
    const first = bus.push('one')!
    const second = bus.push('two')!
    const third = bus.push('three')!
    expect(bus.events.map(event => event.id)).toEqual([second.id, third.id])
    expect(() => bus.assertReplayCursor(first.id)).not.toThrow()
    expectSnapshotRequired(() => bus.assertReplayCursor(zero))
    expectSnapshotRequired(() => bus.assertReplayCursor())
    expectSnapshotRequired(() => busToIterable(bus, zero))

    bus.end()
    expect(await collect(busToIterable(bus, first.id))).toEqual([second, third])
  })

  it('rejects foreign, malformed and future cursors instead of silently replaying from the start', () => {
    const bus = new StreamBus(new AbortController())
    const other = new StreamBus(new AbortController())
    bus.push('one')
    for (const cursor of [other.lastEventId, 'unknown', `${bus.streamId}:99`, `${bus.streamId}:-1`, `${bus.streamId}:1x`]) {
      expectSnapshotRequired(() => bus.assertReplayCursor(cursor))
      expectSnapshotRequired(() => busToIterable(bus, cursor))
    }
  })

  it('bounds replay by UTF-8 bytes as well as event count', () => {
    const bus = new StreamBus(new AbortController(), { maxReplayEvents: 20, maxReplayBytes: 80 })
    const zero = bus.lastEventId
    const first = bus.push('中'.repeat(20))!
    const second = bus.push('文'.repeat(20))!
    expect(bus.events).toEqual([second])
    expect(() => bus.assertReplayCursor(first.id)).not.toThrow()
    expectSnapshotRequired(() => bus.assertReplayCursor(zero))
  })

  it('keeps sequence numbers monotonic after ring eviction', () => {
    const bus = new StreamBus(new AbortController(), { maxReplayEvents: 1 })
    const ids = Array.from({ length: 5 }, (_, index) => bus.push(String(index))!.id)
    expect(ids).toEqual([1, 2, 3, 4, 5].map(seq => `${bus.streamId}:${seq}`))
    expect(bus.lastEventId).toBe(ids[4])
    expect(bus.events).toHaveLength(1)
  })

  it('cancels one idle subscriber immediately without aborting the producer or another subscriber', async () => {
    const controller = new AbortController()
    const bus = new StreamBus(controller)
    const first = busToIterable(bus)
    const second = busToIterable(bus)
    const firstRead = first.next()
    const secondRead = second.next()

    await first.return!()
    expect(await firstRead).toMatchObject({ done: true })
    expect(controller.signal.aborted).toBe(false)
    const payload = bus.push('still running')!
    expect(await secondRead).toEqual({ value: payload, done: false })
    bus.end()
    expect(await second.next()).toMatchObject({ done: true })
  })

  it('supports cancelling a subscriber before its first read and ignores later production', async () => {
    const controller = new AbortController()
    const bus = new StreamBus(controller)
    const iterator = busToIterable(bus)
    await iterator.return!()
    bus.push('later')
    expect(await iterator.next()).toMatchObject({ done: true })
    expect(controller.signal.aborted).toBe(false)
    bus.end()
  })

  it('makes only the slow subscriber require a new snapshot when its queue overflows', async () => {
    const controller = new AbortController()
    const bus = new StreamBus(controller, { maxSubscriberEvents: 2 })
    const slow = busToIterable(bus)
    const fast = busToIterable(bus)
    for (const chunk of ['one', 'two', 'three']) {
      const next = fast.next()
      const payload = bus.push(chunk)!
      expect(await next).toEqual({ value: payload, done: false })
    }

    await expect(slow.next()).rejects.toMatchObject({ statusCode: 409, code: 'snapshot_required' })
    expect(controller.signal.aborted).toBe(false)
    const fastNext = fast.next()
    const payload = bus.push('four')!
    expect(await fastNext).toEqual({ value: payload, done: false })
    bus.end()
    expect(await fast.next()).toMatchObject({ done: true })
  })

  it('requires a snapshot when a subscriber queue exceeds the byte budget', async () => {
    const bus = new StreamBus(new AbortController(), { maxSubscriberEvents: 100, maxSubscriberBytes: 8 })
    const iterator = busToIterable(bus)
    bus.push('1234')
    bus.push('56789')
    await expect(iterator.next()).rejects.toMatchObject({ statusCode: 409, code: 'snapshot_required' })
    expect(bus.abortController.signal.aborted).toBe(false)
    bus.end()
  })

  it('bounds semantic projection slots while marking persisted history as the source of older frames', () => {
    const bus = new StreamBus(new AbortController())
    for (let index = 0; index < 4_200; index++) {
      bus.push(frame('file_change', { id: `change-${index}`, path: `file-${index}.txt` }))
    }
    const snapshot = bus.snapshot()
    expect(snapshot.projectionTruncated).toBe(true)
    expect(snapshot.projection.length).toBeLessThanOrEqual(4_096)
    expect(JSON.stringify(snapshot.projection)).not.toContain('change-0')
    expect(JSON.stringify(snapshot.projection)).toContain('change-4199')
  })

  it('records producer errors safely before any subscriber exists and replays evidence before failing', async () => {
    const bus = new StreamBus(new AbortController())
    const payload = bus.push('partial')!
    const failure = new Error('provider disconnected')
    expect(() => bus.error(failure)).not.toThrow()
    expect(bus.snapshot()).toMatchObject({ finished: true, error: failure.message })
    const iterator = busToIterable(bus)
    expect(await iterator.next()).toEqual({ value: payload, done: false })
    await expect(iterator.next()).rejects.toThrow(failure.message)
  })

  it('wakes an idle subscriber when production fails', async () => {
    const bus = new StreamBus(new AbortController())
    const iterator = busToIterable(bus)
    const next = iterator.next()
    const assertion = expect(next).rejects.toThrow('failed while idle')
    expect(() => bus.error(new Error('failed while idle'))).not.toThrow()
    await assertion
  })

  it('returns one atomic detached snapshot watermark and delivers only later events on resume', async () => {
    const bus = new StreamBus(new AbortController())
    bus.push('before')
    const snapshot = bus.snapshot()
    const iterator = busToIterable(bus, snapshot.eventId)
    const after = bus.push('after')!
    bus.end()

    expect(snapshot.projection.filter(value => typeof value.content === 'string').map(value => value.content).join('')).toBe('before')
    expect(snapshot.finished).toBe(false)
    expect(snapshot.eventId).not.toBe(bus.lastEventId)
    expect(await collect(iterator)).toEqual([after])
    const complete = bus.snapshot()
    expect(complete.finished).toBe(true)
    expect(complete.projection.filter(value => typeof value.content === 'string').map(value => value.content).join('')).toBe('beforeafter')
    complete.projection[0]!.content = 'tampered'
    expect(bus.snapshot().projection[0]!.content).toBe('beforeafter')
  })

  it('keeps waiting run state and pending interaction in a finished snapshot', () => {
    const bus = new StreamBus(new AbortController())
    const pending = { requestId: 'approval-1', toolCallId: 'tool-1', kind: 'permission', status: 'pending', toolName: 'execute_cmd', args: { command: 'pwd' } }
    const run = { runId: 'root-1', turnId: 'turn-1', status: 'waiting', pending: [pending] }
    bus.push(frame('permission_request', pending))
    bus.push(frame('run', run))
    bus.end()

    const snapshot = bus.snapshot()
    expect(snapshot.finished).toBe(true)
    expect(snapshot.projection).toContainEqual({ run })
    expect(snapshot.projection.some(value => value.permissionRequest !== undefined || value.ask_user !== undefined)).toBe(true)
  })

  it('ignores pushes after end without advancing the watermark or mutating the final projection', async () => {
    const bus = new StreamBus(new AbortController())
    bus.push('done')
    bus.end()
    const snapshot = bus.snapshot()
    expect(bus.push('too late')).toBeUndefined()
    expect(bus.snapshot()).toEqual(snapshot)
    expect(await collect(busToIterable(bus, snapshot.eventId))).toEqual([])
  })

  it('can start with an existing projection at sequence zero', () => {
    const content = { content: 'recovered output' }
    const run = { run: { runId: 'root-1', status: 'waiting' } }
    const bus = new StreamBus(new AbortController(), { initialProjection: [content, run] })
    expect(bus.snapshot()).toMatchObject({ eventId: `${bus.streamId}:0`, projection: [content, run] })
    expect(() => bus.assertReplayCursor()).not.toThrow()
    run.run.status = 'tampered'
    expect(bus.snapshot().projection).toContainEqual({ run: { runId: 'root-1', status: 'waiting' } })
  })

  it('seeds recovery state without replay events and refuses to replace an already published projection', () => {
    const bus = new StreamBus(new AbortController())
    const seed = [{ run: { runId: 'root-1', status: 'waiting' } }]
    bus.seedProjection(seed)
    seed[0]!.run.status = 'tampered'
    expect(bus.events).toEqual([])
    expect(bus.lastEventId).toBe(`${bus.streamId}:0`)
    expect(bus.snapshot().projection).toEqual([{ run: { runId: 'root-1', status: 'waiting' } }])
    bus.push('continued')
    const snapshot = bus.snapshot()
    expect(() => bus.seedProjection([])).toThrow()
    expect(bus.snapshot()).toEqual(snapshot)
  })

  it('retains an oversized frame in the snapshot while requiring recovery for any earlier cursor', async () => {
    const bus = new StreamBus(new AbortController(), { maxReplayBytes: 3 })
    const zero = bus.lastEventId
    const payload = bus.push('larger than the entire replay budget')!
    expect(bus.events).toEqual([])
    expectSnapshotRequired(() => bus.assertReplayCursor(zero))
    expectSnapshotRequired(() => bus.assertReplayCursor())
    expect(() => bus.assertReplayCursor(payload.id)).not.toThrow()
    expect(bus.snapshot().projection).toEqual([{ content: payload.chunk }])
    bus.end()
    expect(await collect(busToIterable(bus, payload.id))).toEqual([])
  })

  it('makes the new projection and exact watermark visible together inside synchronous delivery', () => {
    const bus = new StreamBus(new AbortController())
    const observations: Array<{ deliveredId: string; snapshot: ReturnType<StreamBus['snapshot']> }> = []
    bus.emitter.on('data', (payload: SseEventPayload) => {
      observations.push({ deliveredId: payload.id, snapshot: bus.snapshot() })
    })
    bus.push('first')
    bus.push(' second')
    expect(observations.map(value => value.snapshot.eventId)).toEqual(observations.map(value => value.deliveredId))
    expect(observations[0]!.snapshot.projection).toEqual([{ content: 'first' }])
    expect(observations[1]!.snapshot.projection).toEqual([{ content: 'first second' }])
  })

  it('accumulates partial tool arguments and replaces them when the complete call arrives', () => {
    const bus = new StreamBus(new AbortController())
    bus.push(frame('tool_start', { name: 'read_file', toolCallId: 'tool-1' }))
    bus.push(frame('tool_args', { toolCallId: 'tool-1', args: '{"pa' }))
    bus.push(frame('tool_args', { toolCallId: 'tool-1', args: 'th":"x"}' }))
    const partial = bus.snapshot()
    expect(partial.projection).toContainEqual({ toolArgs: { toolCallId: 'tool-1', args: '{"path":"x"}' } })

    const call = { name: 'read_file', toolName: 'read_file', toolCallId: 'tool-1', messageId: 'message-1', args: { path: 'x' } }
    bus.push(frame('tool_start', call))
    bus.push(frame('tool_call', call))
    const complete = bus.snapshot()
    expect(complete.projection.filter(value => value.toolCall !== undefined)).toEqual([{ toolCall: call }])
    expect(complete.projection.some(value => value.toolStart !== undefined || value.toolArgs !== undefined)).toBe(false)
    expect(partial.projection).toContainEqual({ toolArgs: { toolCallId: 'tool-1', args: '{"path":"x"}' } })
  })

  it('coalesces legacy terminal and pending aliases into one result and one interaction', () => {
    const bus = new StreamBus(new AbortController())
    const pending = { requestId: 'tool-1', toolCallId: 'tool-1', question: 'continue?' }
    bus.push(frame('tool_start', { name: 'execute_cmd', toolCallId: 'tool-1' }))
    bus.push(frame('ask_user', pending))
    bus.push(frame('permission_request', { ...pending, toolName: 'execute_cmd' }))
    let projection = bus.snapshot().projection
    expect(projection.filter(value => value.permissionRequest !== undefined)).toHaveLength(1)
    expect(projection.some(value => value.ask_user !== undefined)).toBe(false)

    const end = { name: 'execute_cmd', toolCallId: 'tool-1', status: 'succeeded', success: true, outputPreview: 'ok' }
    const result = { toolName: 'execute_cmd', toolCallId: 'tool-1', status: 'succeeded', success: true, output: 'okay' }
    bus.push(frame('tool_end', end))
    bus.push(frame('tool_result', result))
    projection = bus.snapshot().projection
    expect(projection.filter(value => value.toolResult !== undefined)).toEqual([{ toolResult: { ...end, ...result } }])
    expect(projection.some(value => value.toolEnd !== undefined || value.permissionRequest !== undefined || value.ask_user !== undefined)).toBe(false)
  })

  it('clears answered interactions on a running continuation and all interactions on terminal runs', () => {
    const bus = new StreamBus(new AbortController())
    bus.push(frame('permission_request', { toolCallId: 'tool-1', requestId: 'request-1' }))
    bus.push(frame('permission_request', { toolCallId: 'tool-2', requestId: 'request-2' }))
    bus.push(frame('run', { runId: 'root-1', status: 'running', pending: [{ toolCallId: 'tool-1', status: 'answered' }] }))
    expect(bus.snapshot().projection.filter(value => value.permissionRequest !== undefined)).toEqual([
      { permissionRequest: { toolCallId: 'tool-2', requestId: 'request-2' } },
    ])
    const terminal = { runId: 'root-1', status: 'cancelled', pending: [] }
    bus.push(frame('run', terminal))
    expect(bus.snapshot().projection.filter(value => value.run !== undefined)).toEqual([{ run: terminal }])
    expect(bus.snapshot().projection.some(value => value.permissionRequest !== undefined)).toBe(false)
  })

  it('keeps text order across semantic boundaries while retaining only the latest usage', () => {
    const bus = new StreamBus(new AbortController())
    bus.push('one')
    bus.push(' two')
    bus.push('\x00__thinking__reason')
    bus.push('\x00__thinking__ing')
    bus.push('three')
    bus.push(frame('usage', { totalTokens: 1 }))
    bus.push(frame('usage', { totalTokens: 2 }))
    expect(bus.snapshot().projection).toEqual([
      { content: 'one two' }, { thinking: 'reasoning' }, { content: 'three' }, { usage: { totalTokens: 2 } },
    ])
  })
})
