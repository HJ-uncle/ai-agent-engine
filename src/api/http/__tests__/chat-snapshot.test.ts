import { describe, expect, it } from 'vitest'
import { persistedTurnProjection } from '../chat-snapshot.js'
import type { Message } from '../../../core/agent-context/types.js'
import type { RootRun } from '../../../storage/root-runs/index.js'

const run = { runId: 'run-1', turnId: 'turn-1', userMessageId: 'user-1', actualModelId: 'model-a' } as RootRun
const assistant = (id: string, usage: Record<string, number>): Message => ({
  id, role: 'assistant', content: '', conversationId: run.turnId, usage,
}) as Message

describe('persisted context and billing snapshots', () => {
  it('keeps legacy untagged rows on the immutable original attempt after repeated continuation', () => {
    const continuedRun = { ...run, attemptId: 'third', assistantMessageId: 'third-segment', createdAt: 1,
      serverAdmissionReceipt: { attemptId: 'first' },
      continuationReceipt: { previousAttemptId: 'second', assistantAnchorId: 'original-segment' },
    } as unknown as RootRun
    const projection = persistedTurnProjection([{ ...assistant('original-segment', { promptTokens: 10 }), content: 'Original evidence.' }], continuedRun)
    expect(projection[0]).toEqual({ assistantSegment: { runId: run.runId, turnId: run.turnId,
      attemptId: 'first', messageId: 'original-segment', createdAt: 1 } })
  })
  it('marks each retained attempt once without splitting tool iterations or repeating usage', () => {
    const continuedRun = { ...run, attemptId: 'attempt-3', assistantMessageId: 'segment-3', createdAt: 1 } as RootRun
    const history = [
      { ...assistant('tool-row', { promptTokens: 10 }), content: 'first;', metadata: { attemptId: 'attempt-1', assistantSegmentId: 'segment-1' } },
      { ...assistant('segment-1', { promptTokens: 20 }), content: 'partial;', metadata: { attemptId: 'attempt-1', assistantSegmentId: 'segment-1' } },
      { ...assistant('segment-2', { promptTokens: 30 }), content: 'continued;', metadata: { attemptId: 'attempt-2', assistantSegmentId: 'segment-2' } },
    ]
    const projection = persistedTurnProjection(history, continuedRun)
    expect(projection.filter(frame => frame.assistantSegment).map(frame => frame.assistantSegment)).toEqual([
      { runId: run.runId, turnId: run.turnId, attemptId: 'attempt-1', messageId: 'segment-1', createdAt: 1 },
      { runId: run.runId, turnId: run.turnId, attemptId: 'attempt-2', messageId: 'segment-2', createdAt: 1 },
    ])
    expect(projection.filter(frame => frame.content).map(frame => frame.content).join('')).toBe('first;partial;continued;')
    expect(projection.find(frame => frame.usage)?.usage).toMatchObject({ promptTokens: 60, currentPromptTokens: 30 })
  })
  it('pairs input estimate provenance with its own invocation across recovery', () => {
    const first = { ...assistant('estimated', { promptTokens: 17 }), metadata: { contextUsageEstimated: true } }
    expect(persistedTurnProjection([first], run).find(frame => frame.usage)?.usage).toMatchObject({
      currentPromptTokens: 17, contextUsageEstimated: true,
    })
    const measured = { ...assistant('measured', { promptTokens: 21 }), metadata: { contextUsageEstimated: false, usageEstimated: true } }
    expect(persistedTurnProjection([first, measured], run).find(frame => frame.usage)?.usage).toMatchObject({
      promptTokens: 38, currentPromptTokens: 21, contextUsageEstimated: false,
    })
    expect(persistedTurnProjection([first, assistant('legacy', { promptTokens: 23 })], run).find(frame => frame.usage)?.usage)
      .not.toHaveProperty('contextUsageEstimated')
  })

  it('rehydrates shrinking context with increasing billing and clears a previous model window', () => {
    const history = [
      assistant('a', { promptTokens: 12_000, currentPromptTokens: 12_000, contextWindow: 100_000 }),
      assistant('b', { promptTokens: 22_000, currentPromptTokens: 22_000, contextWindow: 100_000 }),
      assistant('c', { promptTokens: 10_000, currentPromptTokens: 10_000 }),
      { ...assistant('other', { promptTokens: 90_000 }), conversationId: 'other-turn' },
    ]
    expect(persistedTurnProjection(history, run).find(frame => frame.usage)?.usage).toEqual({
      promptTokens: 44_000, currentPromptTokens: 10_000, modelId: 'model-a',
    })
  })

  it('derives the latest legacy input snapshot before adding persisted invocation increments', () => {
    const history = [assistant('a', { promptTokens: 12_000 }), assistant('b', { promptTokens: 22_000 }),
      assistant('c', { promptTokens: 10_000 }), assistant('model-only', {})]
    expect(persistedTurnProjection(history, run).find(frame => frame.usage)?.usage).toEqual({
      promptTokens: 44_000, currentPromptTokens: 10_000, modelId: 'model-a',
    })
  })

  it('keeps the context model when a later model-only row has no new input', () => {
    const history = [{ ...assistant('input', { promptTokens: 12_000 }), modelId: 'input-model' },
      { ...assistant('model-only', {}), modelId: 'new-model' }]
    expect(persistedTurnProjection(history, run).find(frame => frame.usage)?.usage).toEqual({
      promptTokens: 12_000, currentPromptTokens: 12_000, modelId: 'new-model', contextModelId: 'input-model',
    })
  })

  it('recovers a provisional interrupted request without replacing the previous confirmed input', () => {
    const history = [
      { ...assistant('confirmed', { promptTokens: 55_327, contextWindow: 128_000 }), modelId: 'confirmed-model',
        metadata: { contextUsageEstimated: false, contextUsageProvisional: false, requestInputTokenEstimate: 63_000 } },
      { ...assistant('interrupted', { promptTokens: 19_848, contextWindow: 128_000 }), modelId: 'active-model',
        metadata: { partial: true, contextUsageEstimated: false, contextUsageProvisional: true, requestInputTokenEstimate: 64_673 } },
    ]
    expect(persistedTurnProjection(history, run).find(frame => frame.usage)?.usage).toEqual({
      promptTokens: 75_175, currentPromptTokens: 19_848, contextWindow: 128_000, modelId: 'active-model', contextModelId: 'active-model',
      contextUsageEstimated: false, contextUsageProvisional: true, requestInputTokenEstimate: 64_673,
      confirmedContext: { used: 55_327, contextWindow: 128_000, modelId: 'confirmed-model' },
    })
  })

  it('keeps request estimates out of billing and confirms terminal reported counts including explicit zero', () => {
    const measured = { ...assistant('measured', { promptTokens: 56_306, completionTokens: 1_295, totalTokens: 57_601, contextWindow: 128_000 }),
      metadata: { contextUsageEstimated: false, contextUsageProvisional: false, requestInputTokenEstimate: 64_673 } }
    expect(persistedTurnProjection([measured], run).find(frame => frame.usage)?.usage).toMatchObject({
      totalTokens: 57_601, requestInputTokenEstimate: 64_673, confirmedContext: { used: 56_306, contextWindow: 128_000 },
    })
    const zero = { ...assistant('zero', { promptTokens: 0 }), metadata: { contextUsageEstimated: false } }
    expect(persistedTurnProjection([measured, zero], run).find(frame => frame.usage)?.usage).toMatchObject({ confirmedContext: { used: 0 } })
    expect(persistedTurnProjection([measured, zero], run).find(frame => frame.usage)?.usage).not.toHaveProperty('requestInputTokenEstimate')
    expect(persistedTurnProjection([measured, zero], run).find(frame => frame.usage)?.usage).not.toHaveProperty('contextUsageProvisional')
  })
})
