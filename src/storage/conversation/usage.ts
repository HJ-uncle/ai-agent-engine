import type { Message } from '../../core/agent-context/types.js'

/** Provider billing counters; context occupancy is a snapshot, never a sum. */
export const BILLING_USAGE_KEYS = [
  'systemPromptTokens', 'systemToolsTokens', 'messagesTokens', 'skillTokens',
  'promptTokens', 'completionTokens', 'totalTokens', 'ragTokens',
  'builtinToolsTokens', 'mcpToolsTokens', 'toolResultsTokens', 'userInputTokens',
  'cacheHitTokens', 'cacheMissTokens', 'reasoningTokens',
] as const

export function emptyBillingUsage(): Record<string, number> {
  return Object.fromEntries(BILLING_USAGE_KEYS.map(key => [key, 0]))
}

export function addMessageUsage(total: Record<string, number>, message: Message): void {
  for (const key of BILLING_USAGE_KEYS) {
    if (key === 'totalTokens') continue
    const value = message.usage?.[key]
    if (typeof value === 'number' && Number.isFinite(value)) total[key] = (total[key] ?? 0) + value
  }
  const billedTotal = message.usage?.totalTokens
  const input = message.usage?.promptTokens, output = message.usage?.completionTokens
  total.totalTokens = (total.totalTokens ?? 0) + (typeof billedTotal === 'number' && Number.isFinite(billedTotal)
    ? billedTotal : (typeof input === 'number' && Number.isFinite(input) ? input : 0)
      + (typeof output === 'number' && Number.isFinite(output) ? output : 0))
}
