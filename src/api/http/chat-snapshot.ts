import type { Message } from '../../core/agent-context/types.js'
import type { RootRun } from '../../storage/root-runs/index.js'
import { publicHistoryMessage } from './history-projection.js'

type HistoryMessage = Message & { conversationId?: string }

/** Rehydrate the preceding attempts of a waiting turn, without replaying execution. */
export function persistedTurnProjection(history: HistoryMessage[], run: RootRun): Record<string, unknown>[] {
  const frames: Record<string, unknown>[] = []
  const usage: Record<string, number> = {}
  let modelId = run.actualModelId
  for (const message of history.filter(item => item.conversationId === run.turnId || item.id === run.userMessageId)) {
    if (message.role === 'user') { frames.push({ userMessage: publicHistoryMessage(message) }); continue }
    if (message.role === 'assistant') {
      if (message.modelId) modelId = message.modelId
      if (message.reasoningContent) frames.push({ thinking: message.reasoningContent })
      if (typeof message.content === 'string' && message.content) frames.push({ content: message.content })
      if (message.toolCall) frames.push({ toolStart: { name: message.toolCall.name, toolName: message.toolCall.name,
        toolCallId: message.toolCall.id, args: message.toolCall.args, messageId: message.id, rootRunId: run.runId, turnId: run.turnId } })
      if (message.usage) for (const [key, value] of Object.entries(message.usage)) {
        if (typeof value !== 'number') continue
        usage[key] = key === 'contextWindow' || key === 'currentPromptTokens' ? value : (usage[key] ?? 0) + value
      }
    }
    if (message.role === 'tool' && message.toolCallId) {
      frames.push({ toolResult: { toolCallId: message.toolCallId, name: message.toolName, toolName: message.toolName,
        output: message.content, outputPreview: message.metadata?.outputPreview ?? message.content,
        ...message.metadata, metadata: message.metadata, rootRunId: run.runId, turnId: run.turnId } })
      if (message.metadata?.change) frames.push({ fileChange: { ...message.metadata.change, toolCallId: message.toolCallId } })
    }
  }
  if (Object.keys(usage).length || modelId) frames.push({ usage: { ...usage, ...(modelId ? { modelId } : {}) } })
  frames.push({ run })
  return frames
}
