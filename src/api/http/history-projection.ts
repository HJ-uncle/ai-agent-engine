import type { Message } from '../../core/agent-context/types.js'
import { finalResults } from '../../storage/results/index.js'

/** UI history uses display content; exact provider snapshots stay in storage/search_history. */
export function publicHistoryMessage(message: Message): Message {
  const { modelInputContent: _modelInputContent, ...display } = message
  return display
}

export function publicHistoryMessages(messages: Message[]): Message[] {
  return messages.map(publicHistoryMessage)
}

/** Rollback revokes attachments independently of whether all history could be truncated. */
export async function publicSessionHistoryMessages(tenantId: string, messages: Message[]): Promise<Message[]> {
  return publicHistoryMessages(await finalResults.projectHistory(tenantId, messages))
}
