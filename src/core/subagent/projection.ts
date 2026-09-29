import type { ConversationHistory, Message } from '../agent-context/types.js'
import { getSubagentStore } from './store.js'
import { outcomeText, isTerminalRun } from './types.js'
import { estimateTokens } from '../utils/tokens.js'

/** Stable IDs bridge SQLite's transactional outbox and either transcript backend. */
export async function projectPendingSubagents(history: ConversationHistory, tenantId?: string): Promise<void> {
  const store = getSubagentStore()
  for (const row of await store.listPendingParentProjections(tenantId)) {
    const run = row.event.snapshot
    if (row.event.kind === 'finished' && isTerminalRun(run.status)) {
      const ctx = { tenantId: row.tenantId, sessionId: run.parentSessionId }
      const messages = await history.getFullHistory(ctx)
      // Deleting a parent or turn must never resurrect it through delayed projection.
      if (messages.some(message => message.id === run.parentMessageId && message.toolCall?.id === run.parentToolCallId)) {
        const content = outcomeText(run)
        const message: Message & { conversationId: string } = {
          id: 'subagent-result:' + run.runId, role: 'tool', content,
          toolCallId: run.parentToolCallId, toolName: 'subagent',
          conversationId: run.parentConversationId, tokens: estimateTokens(content),
          createdAt: run.finishedAt ?? run.updatedAt,
          metadata: { subagent: run, success: run.status === 'succeeded', error: run.error?.message },
        }
        await history.append(message, ctx)
      }
    }
    await store.ackProjection(row.id, row.tenantId)
  }
}
