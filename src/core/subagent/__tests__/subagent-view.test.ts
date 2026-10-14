import { describe, expect, it } from 'vitest'
import type { SubagentRun, SubagentRunView, SubagentDeltaEvent, SubagentToolSummary } from '../types.js'
import { projectSubagentRunView, mergeSubagentViews, applySubagentDelta } from '../view.js'
import { CurrentTurnProjection } from '../../stream-pipeline/stream-projection.js'

const run = (patch: Partial<SubagentRun> = {}): SubagentRun => ({ schemaVersion: 1, runId: 'child', tenantId: 'tenant',
  rootSessionId: 'root', parentSessionId: 'parent', parentConversationId: 'turn', parentMessageId: 'message',
  parentToolCallId: 'delegate', childSessionId: 'child-session', task: 'task', description: 'description', modelId: 'model',
  status: 'running', lastSeq: 4200, createdAt: 1, updatedAt: 4200, usage: { totalTokens: 10 }, toolCalls: [],
  transcriptRef: 'transcript', ...patch })
const tool = (index: number, status: SubagentToolSummary['status'] = 'succeeded', revision = index): SubagentToolSummary => ({
  id: `tool-${index}`, name: 'read_file', status, args: { path: 'workspace.txt' }, output: 'ok',
  ordinal: index, revisionSeq: revision, startedAt: index, ...(status === 'running' ? {} : { finishedAt: revision }),
  detailRef: `detail-${index}`, detailTruncated: false,
})
const page = (view: SubagentRunView, items: SubagentToolSummary[]): SubagentRunView => ({ ...view, toolCalls: items,
  coverage: { ...view.coverage, includedToolCount: items.length, ids: items.map(item => item.id),
    includedActiveToolCount: items.filter(item => item.status === 'running').length, completeness: 'partial', hasMore: true, truncated: true } })
const delta = (view: SubagentRunView, patch: Partial<SubagentDeltaEvent> = {}): SubagentDeltaEvent => ({ schemaVersion: 2,
  runId: view.runId, seq: view.lastSeq + 1, baseSeq: view.lastSeq, kind: 'usage.updated', identity: {
    tenantId: view.tenantId, rootSessionId: view.rootSessionId, parentSessionId: view.parentSessionId,
    parentConversationId: view.parentConversationId, parentMessageId: view.parentMessageId,
    parentToolCallId: view.parentToolCallId, childSessionId: view.childSessionId,
  }, headerPatch: { updatedAt: view.updatedAt + 1 }, ...patch })

describe('bounded subagent view and published watermark projection', () => {
  it('retains the newest running tool among 4100 canonical tools without changing the archive', () => {
    const archive = run({ toolCalls: Array.from({ length: 4100 }, (_, index) => tool(index + 1, index === 4099 ? 'running' : 'succeeded')) })
    const projection = new CurrentTurnProjection()
    projection.apply({ subagentEvent: { schemaVersion: 1, runId: archive.runId, seq: archive.lastSeq, snapshot: archive } })
    const event = projection.snapshot()[0].subagentEvent as { view: SubagentRunView }
    expect(event.view).toMatchObject({ schemaVersion: 2, view: 'summary', toolCount: 4100, activeToolCount: 1,
      coverage: { includedToolCount: 64, hasMore: true, truncated: true, completeness: 'partial' } })
    expect(event.view.toolCalls.find(item => item.id === 'tool-4100')?.status).toBe('running')
    expect(event.view.latestActivity?.id).toBe('tool-4100')
    expect(archive.toolCalls).toHaveLength(4100)
    expect(archive.schemaVersion).toBe(1)
    expect(Buffer.byteLength(JSON.stringify(event.view), 'utf8')).toBeLessThanOrEqual(256 * 1024)
    expect(projection.subagentWatermarks()).toEqual([{ runId: 'child', seq: 4200 }])
  })

  it('selects a recently completed old ordinal by revision rather than first creation position', () => {
    const items = Array.from({ length: 4100 }, (_, index) => tool(index + 1))
    items[0] = tool(1, 'succeeded', 4199)
    const view = projectSubagentRunView(run({ toolCalls: items }))
    expect(view.latestActivity?.id).toBe('tool-1')
    expect(view.toolCalls[0].revisionSeq).toBe(4199)
    expect(view.toolCalls).toHaveLength(64)
  })

  it('caps active samples and counts omitted active tools accurately', () => {
    const view = projectSubagentRunView(run({ toolCalls: Array.from({ length: 100 }, (_, index) => tool(index + 1, 'running')) }))
    expect(view.activeToolCount).toBe(100)
    expect(view.coverage.includedActiveToolCount).toBe(32)
    expect(view.toolCalls).toHaveLength(32)
    expect(view.latestActivity?.id).toBe('tool-100')
  })

  it('keeps valid JSON, UTF-8 byte budgets and detail references for oversized data', () => {
    const huge = tool(1)
    huge.args = { text: '图😀'.repeat(200_000), nested: Array.from({ length: 100 }, () => 'a'.repeat(100_000)) }
    huge.output = '多字节😀'.repeat(300_000)
    const view = projectSubagentRunView(run({ task: '任务'.repeat(100_000), toolCalls: [huge] }))
    expect(view.toolCalls[0].detailTruncated).toBe(true)
    expect(view.toolCalls[0].detailRef).toBe('detail-1')
    expect(() => JSON.parse(JSON.stringify(view.toolCalls[0].args))).not.toThrow()
    expect(Buffer.byteLength(view.toolCalls[0].argsPreview!, 'utf8')).toBeLessThanOrEqual(1024)
    expect(Buffer.byteLength(view.toolCalls[0].output!, 'utf8')).toBeLessThanOrEqual(2048)
    expect(Buffer.byteLength(JSON.stringify(view), 'utf8')).toBeLessThanOrEqual(256 * 1024)
    expect(view.coverage.truncated).toBe(true)
  })

  it.each([
    { label: 'ASCII at the byte boundary', output: 'a'.repeat(2048), expected: 'a'.repeat(2048), truncated: false },
    { label: 'Chinese at the byte boundary', output: '界'.repeat(682) + 'aa', expected: '界'.repeat(682) + 'aa', truncated: false },
    { label: 'emoji at the byte boundary', output: '😀'.repeat(512), expected: '😀'.repeat(512), truncated: false },
    { label: 'Chinese beyond the byte boundary', output: '界'.repeat(683), expected: '界'.repeat(682), truncated: true },
  ])('preserves bounded output when reprojecting $label', ({ output, expected, truncated }) => {
    const view = projectSubagentRunView(run({ toolCalls: [{ ...tool(1), output }] }))
    const repeated = projectSubagentRunView(view)
    expect(view.toolCalls[0].output).toBe(expected)
    expect(view.toolCalls[0].detailTruncated).toBe(truncated)
    expect(Buffer.byteLength(view.toolCalls[0].output!, 'utf8')).toBeLessThanOrEqual(2048)
    expect(repeated.toolCalls[0].output).toBe(expected)
    expect(repeated.toolCalls[0].detailTruncated).toBe(truncated)
    expect(repeated.coverage).toEqual(view.coverage)
  })

  it('merges overlapping pages at one verified sequence and never double counts usage', () => {
    const base = projectSubagentRunView(run({ toolCalls: [tool(1), tool(2), tool(3)] }))
    const first = page(base, [tool(1), tool(2)])
    const second = page(base, [tool(2), tool(3)])
    const forward = mergeSubagentViews(first, second)
    const reverse = mergeSubagentViews(second, first)
    expect(forward.status).toBe('merged')
    expect(forward.view.toolCalls.map(item => item.id)).toEqual(['tool-3', 'tool-2', 'tool-1'])
    expect(reverse.view.toolCalls).toEqual(forward.view.toolCalls)
    expect(forward.view.usage.totalTokens).toBe(10)
    expect(forward.view.coverage.ids).toHaveLength(3)
    expect(forward.view.coverage.completeness).toBe('complete')
    expect(mergeSubagentViews(forward.view, second).view.toolCalls).toHaveLength(3)
  })

  it('rejects same-sequence scalar contradictions and foreign identities', () => {
    const view = projectSubagentRunView(run({ toolCalls: [tool(1)] }))
    expect(mergeSubagentViews(view, { ...view, usage: { totalTokens: 100 } }).status).toBe('conflict')
    expect(mergeSubagentViews(view, { ...view, status: 'failed' }).status).toBe('conflict')
    expect(mergeSubagentViews(view, { ...view, tenantId: 'other' }).status).toBe('invalid')
    expect(view.usage.totalTokens).toBe(10)
  })

  it('keeps unknown coverage unknown and rejects a future tool version', () => {
    const view = projectSubagentRunView(run({ toolCalls: [tool(1)] }))
    const unknown = { ...view, coverage: { ...view.coverage, completeness: 'unknown' as const } }
    expect(projectSubagentRunView(unknown).coverage.completeness).toBe('unknown')
    expect(() => projectSubagentRunView({ ...view, toolCalls: [{ ...view.toolCalls[0], revisionSeq: view.lastSeq + 1 }] })).toThrow('Invalid subagent coverage')
  })

  it('advances valid deltas and refuses missing prefixes without exposing future fields', () => {
    const view = projectSubagentRunView(run({ lastSeq: 1, updatedAt: 1 }))
    const gap = delta(view, { seq: 3, baseSeq: 2, headerPatch: { status: 'succeeded', usage: { totalTokens: 9999 } } })
    const reduced = applySubagentDelta(view, gap)
    expect(reduced.status).toBe('gap')
    expect(reduced.view).toMatchObject({ lastSeq: 1, status: 'running', usage: { totalTokens: 10 }, recoveryRequired: true })
    const valid = delta(view, { headerPatch: { toolCount: 1, activeToolCount: 1 }, toolUpsert: tool(1, 'running', 2) })
    const applied = applySubagentDelta(view, valid)
    expect(applied.status).toBe('applied')
    expect(applied.view).toMatchObject({ lastSeq: 2, toolCount: 1, activeToolCount: 1 })
    expect(applied.view!.latestActivity?.id).toBe('tool-1')
    expect(applySubagentDelta(applied.view, valid).status).toBe('verified-duplicate')
  })

  it('stores the published delta sequence even when local summary reduction needs recovery', () => {
    const view = projectSubagentRunView(run({ lastSeq: 1, updatedAt: 1 }))
    const projection = new CurrentTurnProjection([{ subagentEvent: { schemaVersion: 2, view: 'snapshot', snapshot: view } }])
    projection.apply({ subagentEvent: delta(view, { seq: 3, baseSeq: 2, headerPatch: { usage: { totalTokens: 9999 } } }) })
    expect(projection.subagentWatermarks()).toEqual([{ runId: 'child', seq: 3 }])
    const snapshot = (projection.snapshot()[0].subagentEvent as { view: SubagentRunView }).view
    expect(snapshot.lastSeq).toBe(1)
    expect(snapshot.usage.totalTokens).toBe(10)
    expect(snapshot.recoveryRequired).toBe(true)
  })

  it('seeds an explicit checkpoint and advances the exact next delta', () => {
    const view = projectSubagentRunView(run({ lastSeq: 1, updatedAt: 1 }))
    const projection = new CurrentTurnProjection([{ subagentEvent: { schemaVersion: 2, kind: 'snapshot', runId: view.runId, seq: 1, view } }])
    projection.apply({ subagentEvent: delta(view, { headerPatch: { toolCount: 1, activeToolCount: 1 }, toolUpsert: tool(1, 'running', 2) }) })
    const checkpoint = projection.snapshot()[0].subagentEvent as { schemaVersion: number; kind: string; seq: number; view: SubagentRunView }
    expect(checkpoint).toMatchObject({ schemaVersion: 2, kind: 'snapshot', seq: 2 })
    expect(checkpoint.view.lastSeq).toBe(2)
    expect(checkpoint.view.toolCalls[0].id).toBe('tool-1')
    expect(checkpoint.view.recoveryRequired).toBeUndefined()
  })

  it('uses the same bounded view for nested child tool results and marks generic array loss', () => {
    const archive = run({ toolCalls: Array.from({ length: 4100 }, (_, index) => tool(index + 1, index === 4099 ? 'running' : 'succeeded')) })
    const projection = new CurrentTurnProjection()
    projection.apply({ toolEnd: { toolCallId: 'parent-tool', metadata: { subagent: archive } } })
    const child = ((projection.snapshot()[0].toolEnd as { metadata: { subagent: SubagentRunView } }).metadata.subagent)
    expect(child.toolCalls).toHaveLength(64)
    expect(child.latestActivity?.id).toBe('tool-4100')
    const generic = new CurrentTurnProjection()
    generic.apply({ todo: { items: Array.from({ length: 4100 }, (_, id) => ({ id })) } })
    expect(generic.truncated).toBe(true)
    expect(((generic.snapshot()[0].todo as { items: unknown[] }).items)).toHaveLength(4096)
  })

  it('does not revive terminal child or tool state', () => {
    const done = projectSubagentRunView(run({ status: 'cancelled', lastSeq: 3, toolCalls: [tool(1, 'cancelled', 3)] }))
    expect(applySubagentDelta(done, delta(done, { headerPatch: { status: 'running' } })).status).toBe('invalid')
    expect(applySubagentDelta(done, delta(done, { kind: 'tool.started', toolUpsert: tool(1, 'running', 4) })).status).toBe('invalid')
    expect(done.status).toBe('cancelled')
    expect(mergeSubagentViews(done, { ...done, status: 'failed', lastSeq: 4,
      coverage: { ...done.coverage, asOfSeq: 4 } }).status).toBe('conflict')
  })

  it('normalizes resident active tools at the exact terminal delta without an unbounded upsert array', () => {
    const view = projectSubagentRunView(run({ lastSeq: 3, updatedAt: 3, toolCalls: [tool(1, 'running', 2)] }))
    const event = delta(view, { kind: 'finished', headerPatch: { status: 'cancelled', activeToolCount: 0, finishedAt: 4, updatedAt: 4 } })
    const result = applySubagentDelta(view, event)
    expect(result.status).toBe('applied')
    expect(result.view).toMatchObject({ lastSeq: 4, status: 'cancelled', activeToolCount: 0 })
    expect(result.view!.toolCalls[0]).toMatchObject({ status: 'cancelled', revisionSeq: 4, finishedAt: 4 })
    expect(result.view!.toolCalls[0].detailRef).toContain('atSeq=4')
  })

  it('bounds child copies across events and nested parent results together', () => {
    const projection = new CurrentTurnProjection()
    for (let index = 0; index < 32; index++) {
      const child = run({ runId: `child-${index}`, task: '任'.repeat(10_000), toolCalls: Array.from({ length: 64 }, (_, id) => ({
        ...tool(id + 1), output: '文'.repeat(1000), args: { text: '参'.repeat(1000) } })) })
      projection.apply({ toolResult: { toolCallId: `parent-${index}`, metadata: { subagent: child } } })
      projection.apply({ subagentEvent: { schemaVersion: 1, runId: child.runId, seq: child.lastSeq, snapshot: child } })
    }
    const snapshot = projection.snapshot()
    const childBytes = snapshot.reduce((total, envelope) => {
      const event = envelope.subagentEvent as { view?: SubagentRunView } | undefined
      const toolResult = envelope.toolResult as { metadata?: { subagent?: SubagentRunView } } | undefined
      return total + (event ? Buffer.byteLength(JSON.stringify(event), 'utf8') : 0)
        + (toolResult?.metadata?.subagent ? Buffer.byteLength(JSON.stringify(toolResult.metadata.subagent), 'utf8') : 0)
    }, 0)
    expect(childBytes).toBeLessThanOrEqual(4 * 1024 * 1024)
    expect(projection.truncated).toBe(true)
    expect(projection.subagentWatermarks()).toHaveLength(32)
    expect(snapshot.some(envelope => (envelope.subagentEvent as { runId?: string })?.runId === 'child-31')).toBe(true)
  })
})

