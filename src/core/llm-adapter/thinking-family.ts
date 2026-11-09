export type ThinkingFamily = 'deepseek' | 'qwen'

/** Model identity outranks a gateway host that serves several model families.
 * Generic transport providers (openai/anthropic/custom) do not identify a family. */
export function resolveThinkingFamily(model: string, provider?: string, baseUrl?: string): ThinkingFamily | undefined {
  if (/deepseek/i.test(model)) return 'deepseek'
  if (/qwen|qwq/i.test(model)) return 'qwen'
  if (/claude|gemini|kimi|minimax|glm|llama|mistral|(?:^|[/:])(?:gpt[-_]|o[1-9](?:[-_]|$))/i.test(model)) return undefined
  const explicit = provider?.trim().toLowerCase()
  if (explicit === 'deepseek') return 'deepseek'
  if (explicit === 'qwen' || explicit === 'dashscope') return 'qwen'
  if (['google', 'gemini', 'minimax', 'glm', 'zhipu', 'moonshot', 'mistral'].includes(explicit ?? '')) return undefined
  if (/deepseek/i.test(baseUrl ?? '')) return 'deepseek'
  if (/qwen|qwq|dashscope|aliyuncs/i.test(baseUrl ?? '')) return 'qwen'
  return undefined
}
