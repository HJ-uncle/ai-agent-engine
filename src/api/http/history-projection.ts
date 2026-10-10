import type { Message } from '../../core/agent-context/types.js'

/** UI history uses display content; exact provider snapshots stay in storage/search_history. */
export function publicHistoryMessage(message: Message): Message {
  const { modelInputContent: _modelInputContent, ...display } = message
  return display
}

export function publicHistoryMessages(messages: Message[]): Message[] {
  return messages.map(publicHistoryMessage)
}
