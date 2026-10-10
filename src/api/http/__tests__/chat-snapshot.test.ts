import { describe, expect, it } from 'vitest'
import { persistedTurnProjection } from '../chat-snapshot.js'
import type { Message } from '../../../core/agent-context/types.js'
import type { RootRun } from '../../../storage/root-runs/index.js'

const run = { runId: 'run-1', turnId: 'turn-1', userMessageId: 'user-1', actualModelId: 'model-a' } as RootRun
const assistant = (id: string, usage: Record<string, number>): Message => ({
  id, role: 'assistant', content: '', conversationId: run.turnId, usage,
}) as Message

describe('persisted context and billing snapshots', () => {
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
