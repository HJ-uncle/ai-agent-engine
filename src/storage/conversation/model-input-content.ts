import type { Message } from '../../core/agent-context/types.js'

// Preserve provider input in existing SQLite databases without changing the
// public metadata shape or requiring a migration while development runs exist.
const MODEL_INPUT_CONTENT_KEY = '__aetherModelInputContent'

export function serializeMessageMetadata(message: Pick<Message, 'metadata' | 'modelInputContent'>): string | null {
  const source = message.metadata
  let metadata: any = source && typeof source === 'object' && !Array.isArray(source) ? { ...source } : source
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) delete metadata[MODEL_INPUT_CONTENT_KEY]
  if (typeof message.modelInputContent === 'string' || Array.isArray(message.modelInputContent)) {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) metadata = {}
    metadata[MODEL_INPUT_CONTENT_KEY] = message.modelInputContent
  }
  return metadata === undefined || metadata === null ? null : JSON.stringify(metadata)
}

export function restoreModelInputContent(message: Message): void {
  const metadata = message.metadata
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return
  const snapshot = metadata[MODEL_INPUT_CONTENT_KEY]
  const { [MODEL_INPUT_CONTENT_KEY]: _internal, ...visible } = metadata
  message.metadata = visible
  if (typeof snapshot === 'string' || Array.isArray(snapshot)) message.modelInputContent = snapshot
}
