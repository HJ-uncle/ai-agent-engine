import { describe, expect, it } from 'vitest'
import { continuedTurnUsage, sessionUsageAtWatermark, sessionSubagentUsage } from '../chat-usage.js'
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
      runId, parentConversationId: turn, tenantId: ctx.tenantId, parentSessionId: ctx.sessionId,
      lastSeq, usage, finishedAt: 1234,
    } as SubagentRun)
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
})
