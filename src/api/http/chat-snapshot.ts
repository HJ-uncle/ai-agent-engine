import type { Message } from '../../core/agent-context/types.js'
import type { RootRun } from '../../storage/root-runs/index.js'
import { publicHistoryMessage } from './history-projection.js'

type HistoryMessage = Message & { conversationId?: string }

/** Rehydrate the preceding attempts of a waiting turn, without replaying execution. */
export function persistedTurnProjection(history: HistoryMessage[], run: RootRun): Record<string, unknown>[] {
  const frames: Record<string, unknown>[] = []
  const usage: Record<string, number> = {}
  let modelId = run.actualModelId
  let contextModelId: string | undefined
  let contextUsageEstimated: boolean | undefined
  let contextUsageProvisional: boolean | undefined
  let requestInputTokenEstimate: number | undefined
  let confirmedContext: { used: number; contextWindow?: number; modelId?: string } | undefined
  for (const message of history.filter(item => item.conversationId === run.turnId || item.id === run.userMessageId)) {
    if (message.role === 'user') { frames.push({ userMessage: publicHistoryMessage(message) }); continue }
    if (message.role === 'assistant') {
      if (message.modelId) modelId = message.modelId
      if (message.reasoningContent) frames.push({ thinking: message.reasoningContent })
      if (typeof message.content === 'string' && message.content) frames.push({ content: message.content })
      if (message.toolCall) frames.push({ toolStart: { name: message.toolCall.name, toolName: message.toolCall.name,
        toolCallId: message.toolCall.id, args: message.toolCall.args, messageId: message.id, rootRunId: run.runId, turnId: run.turnId } })
      if (message.usage) {
        const input = message.usage.currentPromptTokens ?? message.usage.promptTokens
        if (typeof input === 'number' && Number.isFinite(input) && input >= 0) {
          // Legacy rows only stored promptTokens. It is an invocation increment,
          // so derive the context snapshot before summing billing counters.
          usage.currentPromptTokens = input
          contextModelId = message.modelId
          contextUsageEstimated = typeof message.metadata?.contextUsageEstimated === 'boolean'
            ? message.metadata.contextUsageEstimated : undefined
          contextUsageProvisional = typeof message.metadata?.contextUsageProvisional === 'boolean'
            ? message.metadata.contextUsageProvisional : undefined
          const estimate = message.metadata?.requestInputTokenEstimate
          requestInputTokenEstimate = typeof estimate === 'number' && Number.isFinite(estimate) && estimate >= 0 ? estimate : undefined
          if (contextUsageEstimated === false && contextUsageProvisional !== true) {
            const window = message.usage.contextWindow
            confirmedContext = { used: input,
              ...(typeof window === 'number' && Number.isFinite(window) && window > 0 ? { contextWindow: window } : {}),
              ...(contextModelId ? { modelId: contextModelId } : {}) }
          }
          delete usage.contextWindow
        }
        for (const [key, value] of Object.entries(message.usage)) {
          if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue
          if (key === 'currentPromptTokens') continue
          usage[key] = key === 'contextWindow' ? value : (usage[key] ?? 0) + value
        }
      }
    }
    if (message.role === 'tool' && message.toolCallId) {
      frames.push({ toolResult: { toolCallId: message.toolCallId, name: message.toolName, toolName: message.toolName,
        output: message.content, outputPreview: message.metadata?.outputPreview ?? message.content,
        ...message.metadata, metadata: message.metadata, rootRunId: run.runId, turnId: run.turnId } })
      if (message.metadata?.change) frames.push({ fileChange: { ...message.metadata.change, toolCallId: message.toolCallId } })
    }
  }
  if (Object.keys(usage).length || modelId) frames.push({ usage: { ...usage,
    ...(contextUsageEstimated === undefined ? {} : { contextUsageEstimated }),
    ...(contextUsageProvisional === undefined ? {} : { contextUsageProvisional }),
    ...(requestInputTokenEstimate === undefined ? {} : { requestInputTokenEstimate }),
    ...(confirmedContext ? { confirmedContext } : {}),
    ...(modelId ? { modelId } : {}), ...(contextModelId ? { contextModelId } : {}) } })
  frames.push({ run })
  return frames
}
