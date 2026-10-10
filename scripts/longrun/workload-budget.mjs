// Pure configuration validation; importing this never starts a test run.
const MAX_TIMER_MS = 2147483647

function duration(value, name, fallback) {
  const parsed = value === undefined || value === '' ? fallback : Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a finite positive duration`)
  const milliseconds = Math.floor(parsed)
  if (milliseconds < 1 || milliseconds > MAX_TIMER_MS) throw new Error(`${name} must fit a positive Node timer duration`)
  return milliseconds
}

export function workloadBudget(env = process.env) {
  return {
    maxMs: duration(env.LONGRUN_MAX_MS, 'LONGRUN_MAX_MS', 120 * 60000),
    stageTimeoutMs: duration(env.LONGRUN_STAGE_TIMEOUT_MS, 'LONGRUN_STAGE_TIMEOUT_MS', 20 * 60000),
    maxAttempts: 3,
  }
}

export function orchestrationBudget(env = process.env) {
  const minutes = env.LONGRUN_MAX_MINUTES === undefined || env.LONGRUN_MAX_MINUTES === '' ? 120 : Number(env.LONGRUN_MAX_MINUTES)
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('LONGRUN_MAX_MINUTES must be a finite positive duration')
  const budget = workloadBudget({ LONGRUN_MAX_MS: String(minutes * 60000), LONGRUN_STAGE_TIMEOUT_MS: env.LONGRUN_STAGE_TIMEOUT_MS })
  const finalizationGraceMs=60000
  return { ...budget, finalizationGraceMs, totalDeadlineMs: duration(budget.maxMs + finalizationGraceMs + 20 * 60000, 'orchestrator totalDeadlineMs') }
}
