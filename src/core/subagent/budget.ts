/** Accounting is per physical provider request, including failed retries with unknown billing. */
export type RequestAttempt = {
  type: 'start'
  requestAttemptId: string
  provider: string
  model: string
  estimatedInputTokens?: number
  maxOutputTokens?: number
  reservationTokens?: number
} | {
  type: 'finish'
  requestAttemptId: string
  provider: string
  model: string
  outcome: 'succeeded' | 'failed' | 'cancelled'
  usage?: { promptTokens: number; completionTokens: number; cacheHitTokens?: number; cacheMissTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number; unknown?: boolean }
}

/** Cumulative spend is unlimited unless the operator explicitly configures a finite positive cap. */
export function parseRequestTokenLimit(value: string | undefined): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : Infinity
}

export interface BudgetFailureDetails {
  limit: number
  remaining: number
  requested: number
  protectedRemaining?: number
  reason?: 'insufficient' | 'closed'
}

export class BudgetExceededError extends Error {
  readonly code = 'TOKEN_BUDGET_EXCEEDED'
  readonly retryable = false
  constructor(readonly details?: BudgetFailureDetails) {
    super(details?.reason === 'closed'
      ? '本次任务的用量预算已结算，未发送新的模型请求。'
      : '本次任务的本地累计模型用量额度不足，未发送新的模型请求。')
    this.name = 'BudgetExceededError'
  }
}

export interface BudgetSnapshot {
  charged: number
  reserved: number
  remaining: number
  unknown: boolean
}

interface AttemptState {
  reserved: number
  settled: boolean
  charged?: number
  unknown?: boolean
}

/** A fork holds its entire slice until close; unused tokens cannot be spent by a sibling. */
export class RequestBudget {
  private readonly attempts = new Map<string, AttemptState>()
  private readonly children = new Set<RequestBudget>()
  private closed = false

  constructor(readonly limit: number = Infinity, readonly defaultReservation = 8192) {
    if ((limit !== Infinity && !Number.isFinite(limit)) || limit <= 0) throw new RangeError('Budget limit must be positive or Infinity')
    if (!Number.isFinite(defaultReservation) || defaultReservation <= 0) throw new RangeError('Default reservation must be a positive finite number')
  }

  get isClosed(): boolean { return this.closed }
  get remaining(): number { return this.snapshot.remaining }

  canAfford(tokens: number, protectedRemaining = 0): boolean {
    if (this.closed || !Number.isFinite(tokens) || tokens < 0 || !Number.isFinite(protectedRemaining) || protectedRemaining < 0) return false
    const current = this.snapshot
    return current.charged + current.reserved + Math.ceil(tokens) + Math.ceil(protectedRemaining) <= this.limit
  }

  fork(limit: number, protectedRemaining = 0): RequestBudget {
    const amount = Math.ceil(limit)
    if (amount < 1 || !this.canAfford(amount, protectedRemaining)) {
      throw this.exceeded(amount, protectedRemaining)
    }
    // Admission and insertion are synchronous, so concurrent siblings cannot acquire the same slice.
    const child = new RequestBudget(amount, this.defaultReservation)
    this.children.add(child)
    return child
  }

  observe(event: RequestAttempt): void {
    if (event.type === 'start') {
      if (this.attempts.has(event.requestAttemptId)) return
      const estimate = event.reservationTokens ?? (
        event.estimatedInputTokens !== undefined
          ? event.estimatedInputTokens + (event.maxOutputTokens ?? 4096)
          : this.defaultReservation
      )
      const reserved = Math.max(1, Math.ceil(estimate))
      if (!this.canAfford(reserved)) throw this.exceeded(reserved)
      this.attempts.set(event.requestAttemptId, { reserved, settled: false })
      return
    }
    const attempt = this.attempts.get(event.requestAttemptId)
    if (!attempt || attempt.settled) return
    attempt.settled = true
    const usage = event.usage
    if (usage && Number.isFinite(usage.promptTokens) && Number.isFinite(usage.completionTokens)) {
      // Report actual spend even when an estimate was too small; never clamp it to the reservation or cap.
      attempt.charged = Math.max(0, usage.promptTokens) + Math.max(0, usage.completionTokens)
      attempt.unknown = usage.unknown === true
    } else {
      attempt.charged = attempt.reserved
      attempt.unknown = true
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const child of this.children) child.close()
    // Unfinished attempts remain conservatively charged at their reservation. Keeping their identities
    // allows a late finish to replace that estimate with actual usage without charging it twice.
  }

  get snapshot(): BudgetSnapshot {
    let charged = 0
    let reserved = 0
    let unknown = false
    for (const attempt of this.attempts.values()) {
      if (attempt.settled) {
        charged += attempt.charged ?? attempt.reserved
        unknown ||= attempt.unknown ?? true
      } else if (this.closed) {
        charged += attempt.reserved
        unknown = true
      } else reserved += attempt.reserved
    }
    for (const child of this.children) {
      const current = child.snapshot
      charged += current.charged
      unknown ||= current.unknown
      // While open, the unspent slice stays held. Any overrun and in-flight liability are visible
      // immediately to the parent, rather than hidden until close or silently clipped to the slice.
      reserved += child.closed ? current.reserved : Math.max(current.reserved, child.limit - current.charged)
    }
    return { charged, reserved, remaining: Math.max(0, this.limit - charged - reserved), unknown }
  }

  private exceeded(requested: number, protectedRemaining = 0): BudgetExceededError {
    return new BudgetExceededError({
      limit: this.limit, remaining: this.remaining, requested, protectedRemaining,
      reason: this.closed ? 'closed' : 'insufficient',
    })
  }
}
