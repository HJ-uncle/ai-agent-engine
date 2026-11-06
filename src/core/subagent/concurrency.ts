export const DEFAULT_SUBAGENT_CONCURRENCY = 5
export const MAX_SUBAGENT_CONCURRENCY = 16

export function parseSubagentConcurrency(value: unknown): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value.trim()))) return undefined
  const count = Number(value)
  return Number.isInteger(count) && count >= 1 && count <= MAX_SUBAGENT_CONCURRENCY ? count : undefined
}

/** Retain the prior environment clamp for existing deployments. API writes are strict. */
export function configuredSubagentConcurrency(value: unknown = process.env.SUBAGENT_CONCURRENCY_LIMIT): number {
  const count = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN
  return Number.isInteger(count) && count > 0 ? Math.min(count, MAX_SUBAGENT_CONCURRENCY) : DEFAULT_SUBAGENT_CONCURRENCY
}
