import type { Message } from '../agent-context/types.js'
import { browserOutputPresentation } from './browser-output.js'
import { legacyBrowserFailureContent } from './browser-failure.js'
import { estimateTokens } from './tokens.js'
import { estimateMultimodalContent, imageToolPayload } from './multimodal-context.js'

/** The provider snapshot is independent from editable UI attachment/display content. */
export function modelMessageContent(message: Message): Message['content'] {
  const recovered = legacyBrowserFailureContent(message, message.modelInputContent ?? message.content)
  if (recovered !== undefined) return recovered
  if (message.modelInputContent != null) return message.modelInputContent
  // Historical browser previews predate the separate model input column.
  return (message.role === 'tool' ? browserOutputPresentation(message.content)?.modelInputContent : undefined) ?? message.content
}

/** Only fields consumed by the provider adapters; replay/UI data stays in storage. */
export function modelMessageInput(message: Message): Pick<Message, 'role' | 'content' | 'toolCall' | 'toolCallId' | 'reasoningContent'> {
  return {
    role: message.role,
    content: modelMessageContent(message),
    // Parsed calls also carry replay/diagnostic fields such as _rawArgs. Only
    // adapters' public call fields enter the prompt; counting the retained raw
    // JSON again can double a large write_file argument.
    ...(message.role === 'assistant' && message.toolCall ? { toolCall: {
      id: message.toolCall.id, name: message.toolCall.name, args: message.toolCall.args,
    } } : {}),
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
