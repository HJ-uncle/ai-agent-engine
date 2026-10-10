import type { Message } from '../../core/agent-context/types.js'
import { estimateModelMessageTokens } from '../../core/utils/model-context.js'

export interface CompressionOptions {
  keepRecentTokens?: number
  /** An over-threshold request must make progress even when fixed prompts dominate. */
  force?: boolean
}

/** Keep complete tool exchanges, with the same model-input accounting as admission. */
export function compressionSplitIndex(messages: Message[], retention: number | CompressionOptions): number {
  const count = messages.length
  if (!count) return 0
  const boundaries = Array.from({ length: count + 1 }, () => true)
  const calls = new Map<string, number>()
  for (let index = 0; index < count; index++) {
    const message = messages[index]
    if (message.role === 'assistant' && message.toolCall) calls.set(message.toolCall.id, index)
    if (message.role === 'tool' && message.toolCallId) {
      const callIndex = calls.get(message.toolCallId)
      if (callIndex !== undefined) {
        for (let boundary = callIndex + 1; boundary <= index; boundary++) boundaries[boundary] = false
      }
    }
  }
  if (typeof retention === 'number') {
    let split = Math.max(0, count - Math.max(0, Math.floor(retention)))
    while (split > 0 && !boundaries[split]) split--
    return split
  }

  const budget = Math.max(0, retention.keepRecentTokens ?? 20_000)
  let split = count
  let accumulated = 0
  for (let index = count - 1; index >= 0; index--) {
    accumulated += estimateModelMessageTokens(messages[index])
    if (!boundaries[index]) continue
    if (accumulated > budget) break
    split = index
  }
  if (split === 0 && retention.force && count > 1) {
    split = Math.ceil(count / 2)
    while (split < count && !boundaries[split]) split++
  }
  return split
}
