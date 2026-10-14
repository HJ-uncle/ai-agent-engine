/** Conditional projection contracts: no split lookup fallback, stable identity and durable ACK ordering. */
import { beforeEach, expect, it, vi } from 'vitest'
import type { ConversationHistory, ConversationToolCallAnchor } from '../../agent-context/types.js'
import type { SubagentRun } from '../types.js'
const store = vi.hoisted(() => ({ listPendingParentProjections: vi.fn(), ackProjection: vi.fn() }))
vi.mock('../store.js', () => ({ getSubagentStore: () => store }))
import { projectPendingSubagents } from '../projection.js'

const ctx = { tenantId: 'tenant', sessionId: 'parent' }
const key: ConversationToolCallAnchor = { messageId: 'dispatch', toolCallId: 'delegate', conversationId: 'turn' }
const run: SubagentRun = { schemaVersion: 1, runId: 'child-run', tenantId: ctx.tenantId, rootSessionId: ctx.sessionId, parentSessionId: ctx.sessionId,
  parentMessageId: key.messageId, parentToolCallId: key.toolCallId, parentConversationId: key.conversationId, childSessionId: 'child',
  status: 'succeeded', lastSeq: 3, createdAt: 1, updatedAt: 3, task: 'Task', description: 'Task', modelId: 'test', usage: {}, toolCalls: [], resultSummary: 'Result', transcriptRef: 'child' }
beforeEach(() => {
  vi.resetAllMocks()
  store.listPendingParentProjections.mockResolvedValueOnce([{ id: 'outbox', tenantId: ctx.tenantId, event: { schemaVersion: 1, kind: 'finished', snapshot: run } }]).mockResolvedValue([])
})
function history(conditional?: ConversationHistory['appendIfActiveToolCallAnchor']) {
  return { append: vi.fn(), getFullHistory: vi.fn(), getActiveToolCallAnchor: vi.fn(),
    ...(conditional ? { appendIfActiveToolCallAnchor: conditional } : {}) } as unknown as ConversationHistory
}
it.each(['appended', 'duplicate', 'suppressed'] as const)('ACKs only after correctly scoped durable %s', async disposition => {
  const order: string[] = []
  const conditional = vi.fn(async () => { order.push('durable'); return { messageId: 'subagent-result:child-run', disposition } })
  store.ackProjection.mockImplementation(async () => { order.push('ack') })
  const target = history(conditional)
  await projectPendingSubagents(target, ctx.tenantId)
  expect(conditional).toHaveBeenCalledWith(expect.objectContaining({ id: 'subagent-result:child-run', conversationId: key.conversationId, content: expect.stringContaining('Result') }), ctx, key)
  expect(target.append).not.toHaveBeenCalled()
  expect(target.getFullHistory).not.toHaveBeenCalled()
  expect(target.getActiveToolCallAnchor).not.toHaveBeenCalled()
  expect(order).toEqual(['durable', 'ack'])
  expect(store.ackProjection).toHaveBeenCalledWith('outbox', ctx.tenantId)
})
it('unsupported histories retain the outbox without a split lookup fallback', async () => {
  const target = history()
  await expect(projectPendingSubagents(target, ctx.tenantId)).rejects.toThrow('does not support conditional')
  expect(target.append).not.toHaveBeenCalled()
  expect(target.getFullHistory).not.toHaveBeenCalled()
  expect(target.getActiveToolCallAnchor).not.toHaveBeenCalled()
  expect(store.ackProjection).not.toHaveBeenCalled()
})
it('storage failures retain the outbox', async () => {
  await expect(projectPendingSubagents(history(vi.fn().mockRejectedValue(new Error('write failure'))), ctx.tenantId)).rejects.toThrow('write failure')
  expect(store.ackProjection).not.toHaveBeenCalled()
})
it.each([{ messageId: 'foreign', disposition: 'appended' }, { messageId: 'subagent-result:child-run', disposition: 'pending' }])('rejects an invalid backend receipt', async result => {
  await expect(projectPendingSubagents(history(vi.fn().mockResolvedValue(result)), ctx.tenantId)).rejects.toThrow('invalid conditional projection receipt')
  expect(store.ackProjection).not.toHaveBeenCalled()
})
