/** Shared once per request; planning state and enforcement are unchanged. */
export const TASK_PLAN_EXECUTION_PROMPT = [
  '### Task plan',
  'For multi-step work use plan_update silently; single steps need none. Submit the full list, retain completed items still worth showing, remove only out-of-scope items. Omit id for new steps; reuse returned full ids for existing/renamed steps, never invent them.',
  'status=pending/in_progress/completed/cancelled. Mark in_progress on start, completed only with evidence; represent failure/cancellation honestly. Update only on scope/progress changes; fix rejected input and never claim unsaved state persisted. Do not manage plans via commands/scripts or narrate plan logs.',
].join('\n')
