/** Shared assembly prevents the transmitted and measured system text diverging. */
export interface ChatSystemPromptParts {
  base: string
  rag: string
  memory: string
  modelName: string
  download: string
  codegraph?: string
  attachments?: string
  mode?: string
  office?: string
}

export function buildChatSystemPrompts(parts: ChatSystemPromptParts): { fullSystemPrompt: string; pureSystemPrompt: string } {
  const suffix = '\n\n' + [
    '当前模型：' + parts.modelName + '。', parts.download, parts.codegraph, parts.attachments, parts.mode, parts.office,
  ].filter(Boolean).join('\n\n')
  return {
    fullSystemPrompt: parts.base + parts.rag + parts.memory + suffix,
    pureSystemPrompt: parts.base + parts.memory + suffix,
  }
}
