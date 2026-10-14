/**
 * Arm a positive deadline without overflowing Node's 32-bit timer delay.
 * Long explicit deadlines are split into safe timer-sized segments; callers
 * still receive a single cancellation function and no deadline is added when
 * they choose the unlimited (omitted/zero) form themselves.
 */
export function scheduleDeadline(callback: () => void, delayMs: number): () => void {
  const deadline = Date.now() + delayMs
  let timer: ReturnType<typeof setTimeout> | undefined
  let cancelled = false
  const arm = (): void => {
    if (cancelled) return
    const remaining = deadline - Date.now()
    if (remaining <= 0) { timer = undefined; callback(); return }
    timer = setTimeout(arm, Math.min(remaining, 2_147_483_647))
    timer.unref?.()
  }
  arm()
  return () => { cancelled = true; if (timer) clearTimeout(timer) }
}
