/** Per-request context policy, separate from provider capabilities and cumulative run budgets. */
export const DEFAULT_CONTEXT_WINDOW_BUDGET = 268_000

export function parseContextWindowBudget(value: unknown): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value.trim()))) return undefined
  const tokens = Number(value)
  return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : undefined
}

export function configuredContextWindowBudget(value: unknown = process.env.CONTEXT_WINDOW_BUDGET): number {
  return parseContextWindowBudget(value) ?? DEFAULT_CONTEXT_WINDOW_BUDGET
}

/** Small models and explicit child budgets remain authoritative; OSM never expands this window. */
export function effectiveContextWindow(modelWindow?: number, explicitBudget?: number): number {
  return Math.min(configuredContextWindowBudget(),
    parseContextWindowBudget(modelWindow) ?? Number.POSITIVE_INFINITY,
    parseContextWindowBudget(explicitBudget) ?? Number.POSITIVE_INFINITY)
}
