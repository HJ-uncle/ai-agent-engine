export interface TokenUsage {
  systemPromptTokens: number
  systemToolsTokens: number
  messagesTokens: number
  skillTokens: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  conversationId: string | null
}
