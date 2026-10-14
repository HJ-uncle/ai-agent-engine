// Pure per-viewer adaptation tests: no service/model startup and no writes to durable records.
import { describe, expect, it, vi } from 'vitest'
import { subagentProtocolStream } from '../stream-protocol.js'
import { projectSubagentRunView } from '../view.js'
import type { SubagentRun, SubagentRunView, SubagentDeltaEvent } from '../types.js'
import type { SubagentProtocolStreamOptions } from '../stream-protocol.js'
import type { SseEventPayload } from '../../stream-pipeline/stream-bus.js'
import { SnapshotRequiredError } from '../../stream-pipeline/stream-bus.js'

const run = (patch: Partial<SubagentRun> = {}): SubagentRun => ({ schemaVersion: 1, runId: 'child', tenantId: 'tenant',
  rootSessionId: 'root', parentSessionId: 'parent', parentConversationId: 'turn', parentMessageId: 'message',
  parentToolCallId: 'delegate', childSessionId: 'child-session', task: 'task', description: 'description', modelId: 'model',
  status: 'running', lastSeq: 5, createdAt: 1, updatedAt: 5, usage: { totalTokens: 10 }, toolCalls: [],
  transcriptRef: 'transcript', ...patch })
const delta = (canonical: SubagentRun, patch: Partial<SubagentDeltaEvent> = {}): SubagentDeltaEvent => ({
  schemaVersion: 2, runId: canonical.runId, seq: canonical.lastSeq, baseSeq: canonical.lastSeq - 1,
  kind: 'usage.updated', identity: {
    tenantId: canonical.tenantId, rootSessionId: canonical.rootSessionId, parentSessionId: canonical.parentSessionId,
    parentConversationId: canonical.parentConversationId, parentMessageId: canonical.parentMessageId,
    parentToolCallId: canonical.parentToolCallId, childSessionId: canonical.childSessionId,
  }, headerPatch: { usage: canonical.usage, updatedAt: canonical.updatedAt }, ...patch,
})
function fixture(canonical: SubagentRun) {
  return { getSnapshotsAtSequences: vi.fn(async () => [canonical]),
    getViewsAtSequences: vi.fn(async () => [projectSubagentRunView(canonical)]) }
}
const frame = (kind: 'subagent_event' | 'tool_end' | 'tool_result', value: unknown, id = 'stream:5'): SseEventPayload =>
  ({ id, chunk: '\x00__' + kind + '__' + JSON.stringify(value) })
const body = (value: SseEventPayload | string): Record<string, unknown> => {
  const chunk = typeof value === 'string' ? value : value.chunk
  return JSON.parse(chunk.slice(/^\x00__[a-z_]+__/.exec(chunk)![0].length))
}
async function* items(values: (SseEventPayload | string)[]) { yield* values }
async function collect(values: (SseEventPayload | string)[], options: SubagentProtocolStreamOptions) {
  const output: (SseEventPayload | string)[] = []
  for await (const value of subagentProtocolStream(items(values), options)) output.push(value)
  return output
}

describe('per-viewer subagent SSE protocol adapter', () => {
  it('preserves modern deltas, IDs, controls and source ordering without materializing legacy snapshots', async () => {
    const canonical = run()
    const store = fixture(canonical)
    const event = frame('subagent_event', delta(canonical))
    const ordinary = { id: 'stream:4', chunk: 'content' }
    const output = await collect([ordinary, event, '\x00__thinking__continue'], { protocol: 2, tenantId: 'tenant', store })
    expect(output).toEqual([ordinary, event, '\x00__thinking__continue'])
    expect(output[0]).toBe(ordinary)
    expect(output[1]).toBe(event)
    expect(store.getSnapshotsAtSequences).not.toHaveBeenCalled()
    expect(store.getViewsAtSequences).not.toHaveBeenCalled()
  })

  it('materializes the exact published canonical version for a legacy viewer of a modern producer', async () => {
    const canonical = run({ toolCalls: [{ id: 'tool', name: 'read', args: { path: 'exact' }, output: 'exact output', status: 'succeeded' }] })
    const store = fixture(canonical)
    const event = frame('subagent_event', delta(canonical))
    const output = await collect([event], { protocol: 1, tenantId: 'tenant', store })
    expect(output[0]).toMatchObject({ id: event.id })
    expect(body(output[0])).toEqual({ schemaVersion: 1, kind: 'usage.updated', runId: 'child', seq: 5, snapshot: canonical })
    expect(store.getSnapshotsAtSequences).toHaveBeenCalledTimes(1)
    expect(store.getSnapshotsAtSequences).toHaveBeenCalledWith('tenant', [{ runId: 'child', seq: 5 }])
    expect(store.getViewsAtSequences).not.toHaveBeenCalled()
    expect(JSON.parse(event.chunk.slice('\x00__subagent_event__'.length))).toEqual(delta(canonical))
  })

  it('projects a legacy 4100-tool producer as an explicit bounded v2 checkpoint with the latest running activity', async () => {
    const canonical = run({ lastSeq: 4200, toolCalls: Array.from({ length: 4100 }, (_, index) => ({
      id: 'tool-' + index, name: 'read', args: { path: 'original-' + index }, output: 'history',
      status: index === 4099 ? 'running' : 'succeeded', startedAt: index, ...(index < 4099 ? { finishedAt: index + 1 } : {}),
    })) })
    const store = fixture(canonical)
    const event = frame('subagent_event', { schemaVersion: 1, kind: 'tool.started', runId: 'child', seq: 4200, snapshot: canonical })
    const output = await collect([event], { protocol: 2, tenantId: 'tenant', store })
    const checkpoint = body(output[0])
    const view = checkpoint.view as SubagentRunView
    expect(checkpoint).toMatchObject({ schemaVersion: 2, kind: 'snapshot', runId: 'child', seq: 4200 })
    expect(checkpoint.snapshot).toBeUndefined()
    expect(view).toMatchObject({ schemaVersion: 2, view: 'summary', toolCount: 4100, activeToolCount: 1,
      coverage: { asOfSeq: 4200, hasMore: true, truncated: true, completeness: 'partial' } })
    expect(view.toolCalls.length).toBeLessThanOrEqual(64)
    expect(view.toolCalls.map(tool => tool.id)).toContain('tool-4099')
    expect(canonical.toolCalls).toHaveLength(4100)
    expect(store.getSnapshotsAtSequences).not.toHaveBeenCalled()
  })

  it('turns a v2 checkpoint into a real complete legacy snapshot using a legacy-compatible event kind', async () => {
    const canonical = run({ toolCalls: Array.from({ length: 80 }, (_, index) => ({ id: 't-' + index, name: 'read', args: { index }, status: 'succeeded' })) })
    const view = projectSubagentRunView(canonical)
    const store = fixture(canonical)
    const output = await collect([frame('subagent_event', { schemaVersion: 2, kind: 'snapshot', runId: 'child', seq: 5, view })],
      { protocol: 1, tenantId: 'tenant', store })
    const event = body(output[0])
    expect(event).toMatchObject({ schemaVersion: 1, kind: 'output.updated', runId: 'child', seq: 5 })
    expect(event.snapshot).toEqual(canonical)
    expect((event.snapshot as SubagentRun).toolCalls).toHaveLength(80)
    expect(event.snapshot).not.toHaveProperty('coverage')
    expect(event.snapshot).not.toHaveProperty('view')
  })

  it('adapts every direct/metadata/meta child receipt without losing other tool payload fields', async () => {
    const canonical = run({ toolCalls: [{ id: 'tool', name: 'read', args: { text: '参数'.repeat(1000) }, output: '正文'.repeat(4000), status: 'succeeded' }] })
    const view = projectSubagentRunView(canonical)
    for (const kind of ['tool_end', 'tool_result'] as const) {
      const store = fixture(canonical)
      const receipt = { toolCallId: 'parent-tool', output: 'outer output', browserOutput: { caption: 'unchanged' },
        subagent: view, metadata: { flag: true, subagent: view }, meta: { flag: 'meta', subagent: view } }
      const legacy = body((await collect([frame(kind, receipt)], { protocol: 1, tenantId: 'tenant', store }))[0])
      expect(legacy).toEqual({ ...receipt, subagent: canonical, metadata: { flag: true, subagent: canonical }, meta: { flag: 'meta', subagent: canonical } })
      expect(store.getSnapshotsAtSequences).toHaveBeenCalledTimes(1)
      const modern = body((await collect([frame(kind, { ...receipt, subagent: canonical, metadata: { flag: true, subagent: canonical }, meta: { flag: 'meta', subagent: canonical } })],
        { protocol: 2, tenantId: 'tenant', store }))[0])
      expect(modern).toMatchObject({ toolCallId: 'parent-tool', output: 'outer output', browserOutput: { caption: 'unchanged' },
        subagent: { schemaVersion: 2, view: 'summary' }, metadata: { flag: true, subagent: { schemaVersion: 2 } }, meta: { flag: 'meta', subagent: { schemaVersion: 2 } } })
    }
  })

  it('rejects a missing or future database version instead of confirming its event or substituting latest data', async () => {
    const canonical = run()
    const store = fixture(run({ lastSeq: 6, usage: { totalTokens: 999 }, toolCalls: [{ id: 'future', name: 'read', args: {}, status: 'running' }] }))
    const iterator = subagentProtocolStream(items([frame('subagent_event', delta(canonical)), { id: 'stream:6', chunk: 'must not skip' }]), { protocol: 1, tenantId: 'tenant', store })
    await expect(iterator.next()).rejects.toMatchObject({ code: 'snapshot_required', message: expect.stringContaining('SUBAGENT_RECOVERY_REQUIRED') })
    expect(await iterator.next()).toEqual({ done: true, value: undefined })
  })

  it('rejects foreign tenant, root identity mismatch and unknown protocol versions before any event is delivered', async () => {
    const canonical = run()
    const store = fixture(canonical)
    for (const event of [
      delta(run({ tenantId: 'other' })),
      { ...delta(canonical), schemaVersion: 3 },
      { schemaVersion: 1, kind: 'started', runId: 'child', seq: 5, snapshot: run({ tenantId: 'other' }) },
    ]) await expect(collect([frame('subagent_event', event)], { protocol: 2, tenantId: 'tenant', store })).rejects.toBeInstanceOf(SnapshotRequiredError)
    expect(store.getSnapshotsAtSequences).not.toHaveBeenCalled()
    await expect(collect([frame('subagent_event', delta(run({ rootSessionId: 'other-root' })))], { protocol: 1, tenantId: 'tenant', store }))
      .rejects.toBeInstanceOf(SnapshotRequiredError)
  })

  it('restores recovery placeholders only from an exact bounded view and never from a future view', async () => {
    const canonical = run()
    const store = fixture(canonical)
    const placeholder = frame('subagent_event', { schemaVersion: 2, view: 'recovery-required', recoveryRequired: true, runId: 'child', seq: 5 })
    const output = await collect([placeholder], { protocol: 2, tenantId: 'tenant', store })
    expect(body(output[0])).toMatchObject({ schemaVersion: 2, kind: 'snapshot', runId: 'child', seq: 5, view: { lastSeq: 5 } })
    expect(store.getViewsAtSequences).toHaveBeenCalledTimes(1)
    expect(store.getViewsAtSequences).toHaveBeenCalledWith('tenant', [{ runId: 'child', seq: 5 }])
    store.getViewsAtSequences.mockResolvedValueOnce([projectSubagentRunView(run({ lastSeq: 6 }))])
    await expect(collect([placeholder], { protocol: 2, tenantId: 'tenant', store })).rejects.toBeInstanceOf(SnapshotRequiredError)
  })

  it('detaches the original subscription immediately when a viewer closes during a pending database lookup', async () => {
    const canonical = run()
    let resolveSnapshots!: (value: SubagentRun[]) => void
    const store = fixture(canonical)
    store.getSnapshotsAtSequences.mockImplementationOnce(() => new Promise(resolve => { resolveSnapshots = resolve }))
    const sourceReturn = vi.fn(async () => ({ done: true as const, value: undefined }))
    const source = { [Symbol.asyncIterator]() { return this }, next: vi.fn(async () => ({ done: false as const, value: frame('subagent_event', delta(canonical)) })), return: sourceReturn }
    const iterator = subagentProtocolStream(source, { protocol: 1, tenantId: 'tenant', store })
    const pending = iterator.next()
    await Promise.resolve()
    await Promise.resolve()
    expect(store.getSnapshotsAtSequences).toHaveBeenCalledTimes(1)
    expect(await iterator.return!()).toEqual({ done: true, value: undefined })
    expect(sourceReturn).toHaveBeenCalledTimes(1)
    resolveSnapshots([canonical])
    expect(await pending).toEqual({ done: true, value: undefined })
  })

  it('retains upstream failures and rejects source/expanded frames over the existing byte budget', async () => {
    const canonical = run()
    const store = fixture(canonical)
    const failure = new Error('database unavailable')
    store.getSnapshotsAtSequences.mockRejectedValueOnce(failure)
    await expect(collect([frame('subagent_event', delta(canonical))], { protocol: 1, tenantId: 'tenant', store })).rejects.toBe(failure)
    await expect(collect([frame('subagent_event', { schemaVersion: 1, kind: 'started', runId: 'child', seq: 5,
      snapshot: run({ partialOutput: 'x'.repeat(8 * 1024 * 1024) }) })], { protocol: 2, tenantId: 'tenant', store })).rejects.toBeInstanceOf(SnapshotRequiredError)
    const oversized = run({ partialOutput: 'x'.repeat(8 * 1024 * 1024) })
    const source = frame('subagent_event', delta(canonical))
    store.getSnapshotsAtSequences.mockResolvedValueOnce([oversized])
    const stringify = vi.spyOn(JSON, 'stringify')
    try {
      await expect(collect([source], { protocol: 1, tenantId: 'tenant', store })).rejects.toBeInstanceOf(SnapshotRequiredError)
      expect(stringify.mock.calls.some(([value]) => value && typeof value === 'object' && 'snapshot' in value && value.snapshot === oversized)).toBe(false)
    } finally { stringify.mockRestore() }
  })
})
