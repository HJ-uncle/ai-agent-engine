import { describe, expect, it } from 'vitest'
import { continuedTurnUsage, sessionUsageAtWatermark, sessionSubagentUsage, sessionSubagentRunsAtWatermark } from '../chat-usage.js'
import { projectSubagentRunView } from '../../../core/subagent/view.js'
import type { SubagentRun } from '../../../core/subagent/types.js'

describe('continued turn billing usage', () => {
  it('adds a fixed persisted baseline to each attempt snapshot without summing occupancy', () => {
    const baseline = { promptTokens: 100, completionTokens: 20, totalTokens: 120 }
    const first = continuedTurnUsage(baseline, { promptTokens: 12, completionTokens: 3, totalTokens: 15,
      currentPromptTokens: 12_000, contextWindow: 100_000 })
    const final = continuedTurnUsage(baseline, { promptTokens: 40, completionTokens: 8, totalTokens: 48,
      currentPromptTokens: 10_000, contextWindow: 100_000 })
    expect(first).toMatchObject({ promptTokens: 112, totalTokens: 135, currentPromptTokens: 12_000 })
    expect(final).toEqual({ promptTokens: 140, completionTokens: 28, totalTokens: 168,
      currentPromptTokens: 10_000, contextWindow: 100_000 })
    expect(baseline).toEqual({ promptTokens: 100, completionTokens: 20, totalTokens: 120 })
  })

  it('keeps a provider model-only update separate from cumulative billing counters', () => {
    expect(continuedTurnUsage({ promptTokens: 100, totalTokens: 120 }, { modelId: 'fallback-model' }))
      .toEqual({ modelId: 'fallback-model' })
    expect(continuedTurnUsage({}, { currentPromptTokens: 0, contextWindow: 100_000 })).toEqual({
      currentPromptTokens: 0, contextWindow: 100_000,
    })
  })

  it('anchors session billing to the published active turn rather than future persisted calls', () => {
    expect(sessionUsageAtWatermark({ promptTokens: 1_200, completionTokens: 200, totalTokens: 1_400 },
      { promptTokens: 1_000, completionTokens: 100, totalTokens: 1_100 },
      { promptTokens: 12, completionTokens: 3, totalTokens: 15, currentPromptTokens: 10_000 }))
      .toMatchObject({ promptTokens: 212, completionTokens: 103, totalTokens: 315 })
  })

  it('deduplicates child snapshots, preserves unknown lower bounds and respects the published cursor', () => {
    const ctx = { tenantId: 'tenant', sessionId: 'session' }
    const child = (runId: string, turn: string, lastSeq: number, usage: SubagentRun['usage']): SubagentRun => ({
      schemaVersion: 1, runId, parentConversationId: turn, tenantId: ctx.tenantId, parentSessionId: ctx.sessionId,
      rootSessionId: 'root', parentMessageId: 'message', parentToolCallId: 'delegate', childSessionId: `child-${runId}`,
      task: 'task', description: 'description', modelId: 'model', status: 'succeeded', createdAt: 1, updatedAt: lastSeq,
      toolCalls: [], transcriptRef: `transcript-${runId}`, lastSeq, usage, finishedAt: 1234,
    })
    const old = child('old-child', 'old-turn', 2, { totalTokens: 20 })
    const delivered = child('new-child', 'current-turn', 2, { totalTokens: 5, unknown: true })
    const future = child('new-child', 'current-turn', 3, { totalTokens: 5000, unknown: true })
    const missing = child('missing-child', 'current-turn', 1, {})
    const foreign = { ...old, runId: 'foreign-child', tenantId: 'other' }
    const projection = [
      { subagentEvent: { snapshot: { ...delivered, lastSeq: 1, usage: { totalTokens: 2 } } } },
      { toolResult: { metadata: { subagent: delivered } } }, { subagentEvent: { snapshot: missing } },
    ]
    expect(sessionSubagentUsage([old, future, missing, foreign], ctx, 'current-turn', projection))
      .toEqual({ totalTokens: 25, count: 3, unknown: 2, finishedAt: 1234 })
    expect(sessionSubagentUsage([old, future, missing, foreign], ctx))
      .toEqual({ totalTokens: 5020, count: 3, unknown: 2, finishedAt: 1234 })
  })

  it('enriches overlapping same-watermark coverage with bounded IDs and reports conflicts', () => {
    const ctx = { tenantId: 'tenant', sessionId: 'session' }
    const base: SubagentRun = { schemaVersion: 1, runId: 'child', tenantId: ctx.tenantId, parentSessionId: ctx.sessionId,
      parentConversationId: 'turn', rootSessionId: 'root', parentMessageId: 'message', parentToolCallId: 'delegate',
      childSessionId: 'child-session', task: 'task', description: 'description', modelId: 'model', status: 'running',
      lastSeq: 100, createdAt: 1, updatedAt: 100, usage: { totalTokens: 12 }, transcriptRef: 'transcript',
      toolCalls: Array.from({ length: 4100 }, (_, index) => ({ id: `tool-${index}`, name: 'read_file',
        args: {}, status: index === 4099 ? 'running' : 'succeeded', startedAt: index,
        ...(index === 4099 ? {} : { finishedAt: index }) })) }
    const exact = projectSubagentRunView(base)
    const current = { ...exact, toolCalls: exact.toolCalls.slice(0, 2), coverage: { ...exact.coverage,
      includedToolCount: 2, includedActiveToolCount: 1, ids: exact.toolCalls.slice(0, 2).map(tool => tool.id) } }
    const projection = [{ subagentEvent: { snapshot: current } }, { subagentEvent: { snapshot: exact } }]
    const visible = sessionSubagentRunsAtWatermark([], ctx, 'turn', projection)
    expect(visible).toHaveLength(1)
    expect(visible[0].lastSeq).toBe(100)
    expect(visible[0].toolCalls).toHaveLength(64)
    expect(visible[0].toolCount).toBe(4100)
    expect(visible[0].latestActivity?.id).toBe('tool-4099')
    expect(sessionSubagentUsage(visible, ctx).totalTokens).toBe(12)
    const conflicts: string[] = []
    const conflicting = sessionSubagentRunsAtWatermark([], { ...ctx, onConflict: (_id, _seq, reason) => conflicts.push(reason) }, 'turn',
      [...projection, { subagentEvent: { snapshot: { ...exact, usage: { totalTokens: 999 } } } }])
    expect(conflicts).toHaveLength(1)
    expect(conflicting[0].recoveryRequired).toBe(true)
    expect(conflicting[0].usage.totalTokens).toBe(12)
  })

  it('never supplements active published views from future durable runs', () => {
    const ctx = { tenantId: 'tenant', sessionId: 'session' }
    const published: SubagentRun = { schemaVersion: 1, runId: 'child', tenantId: ctx.tenantId, parentSessionId: ctx.sessionId,
      parentConversationId: 'turn', rootSessionId: 'root', parentMessageId: 'message', parentToolCallId: 'delegate',
      childSessionId: 'child-session', task: 'task', description: 'description', modelId: 'model', status: 'running',
      lastSeq: 100, createdAt: 1, updatedAt: 100, usage: { totalTokens: 12 }, transcriptRef: 'transcript', toolCalls: [] }
    const future: SubagentRun = { ...published, lastSeq: 101, status: 'succeeded', usage: { totalTokens: 999 }, toolCalls: [
      { id: 'future-tool', name: 'write_file', status: 'succeeded', args: {} } ] }
    const result = sessionSubagentRunsAtWatermark([future], ctx, 'turn', [{ subagentEvent: { snapshot: projectSubagentRunView(published) } }])
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ lastSeq: 100, status: 'running', toolCount: 0, usage: { totalTokens: 12 } })
    expect(result[0].toolCalls).toEqual([])
  })
})
