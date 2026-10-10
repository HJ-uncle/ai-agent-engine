import type { Message } from '../agent-context/types.js'
import { estimateTokens } from './tokens.js'
import { estimateMultimodalContent, imageToolPayload } from './multimodal-context.js'

/** The provider snapshot is independent from editable UI attachment/display content. */
export function modelMessageContent(message: Message): Message['content'] {
  return message.modelInputContent ?? message.content
}

/** Only fields consumed by the provider adapters; replay/UI data stays in storage. */
export function modelMessageInput(message: Message): Pick<Message, 'role' | 'content' | 'toolCall' | 'toolCallId' | 'reasoningContent'> {
  return {
    role: message.role,
    content: modelMessageContent(message),
    ...(message.role === 'assistant' && message.toolCall ? { toolCall: message.toolCall } : {}),
    ...(message.role === 'tool' && message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    // OpenAI-compatible reasoning models require this field on replay. Counting
    // it is conservative for adapters that do not replay reasoning.
    ...(message.role === 'assistant' && message.reasoningContent ? { reasoningContent: message.reasoningContent } : {}),
  }
}

export function estimateModelMessageTokens(message: Message): number {
  const input = modelMessageInput(message)
  const imageTool = input.role === 'tool' ? imageToolPayload(input.content) : undefined
  const content = imageTool ? [
    { type: 'text', text: JSON.stringify({ ...imageTool, dataUrl: '[native image payload]' }) },
    { type: 'image_url', image_url: { url: imageTool.dataUrl } },
  ] : input.content
  return Math.ceil((estimateTokens(JSON.stringify({ ...input, content: null })) + estimateMultimodalContent(content)) * 1.2)
}

export function estimateModelHistoryTokens(messages: Message[]): number {
  return messages.reduce((sum, message) => sum + estimateModelMessageTokens(message), 0)
}
