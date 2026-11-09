import { buildMemoryRequestContext, MEMORY_REFERENCE_GUIDANCE } from './memory-request-context.js'

/** Shared assembly prevents the transmitted and measured system text diverging. */
export interface ChatSystemPromptParts {
  base: string
  rag: string
  memory: string
  inlineMemories?: string
  contextWindow?: number
  modelName: string
  download: string
  codegraph?: string
  attachments?: string
  mode?: string
  office?: string
}

export function buildChatSystemPrompts(parts: ChatSystemPromptParts): { fullSystemPrompt: string; pureSystemPrompt: string; requestContext: string } {
  const suffix = '\n\n' + [
    '当前模型：' + parts.modelName + '。', MEMORY_REFERENCE_GUIDANCE, parts.download, parts.codegraph, parts.attachments, parts.mode, parts.office,
  ].filter(Boolean).join('\n\n')
  return {
    fullSystemPrompt: parts.base + parts.rag + suffix,
    pureSystemPrompt: parts.base + suffix,
    requestContext: buildMemoryRequestContext(parts.memory, parts.inlineMemories, parts.contextWindow),
  }
}
