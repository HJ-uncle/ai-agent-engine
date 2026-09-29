/** Budget partitions protect parent/child finalization without changing physical-request accounting. */
import { describe, expect, it } from 'vitest'
import { BudgetExceededError, RequestBudget, parseRequestTokenLimit, type RequestAttempt } from '../budget.js'

function start(budget: RequestBudget, id: string, reserve: number) {
  budget.observe({ type: 'start', requestAttemptId: id, provider: 'fixture', model: 'fixture', reservationTokens: reserve })
}
function finish(budget: RequestBudget, id: string, prompt?: number, completion = 0) {
  budget.observe({ type: 'finish', requestAttemptId: id, provider: 'fixture', model: 'fixture', outcome: prompt === undefined ? 'failed' : 'succeeded',
    ...(prompt === undefined ? {} : { usage: { promptTokens: prompt, completionTokens: completion } }),
  })
}

describe('RequestBudget partitions', () => {
  it('holds three child slices, protects parent finalization and rejects an oversubscribed fourth fork', () => {
    const root = new RequestBudget(500)
    const children = [root.fork(100, 100), root.fork(100, 100), root.fork(100, 100)]
    expect(root.snapshot).toEqual({ charged: 0, reserved: 300, remaining: 200, unknown: false })
    expect(root.canAfford(100, 100)).toBe(true)
    expect(() => root.fork(101, 100)).toThrow(BudgetExceededError)
    for (const [index, child] of children.entries()) {
      start(child, `child-${index}`, 100)
      finish(child, `child-${index}`, 90, 10)
      child.close()
    }
    start(root, 'parent-finalization', 100)
    finish(root, 'parent-finalization', 70, 10)
    expect(root.snapshot).toEqual({ charged: 380, reserved: 0, remaining: 120, unknown: false })
  })

  it('shows actual child usage immediately but releases unused slice only on idempotent close', () => {
    const root = new RequestBudget(100)
    const child = root.fork(80, 20)
    start(child, 'one', 50)
    finish(child, 'one', 20, 10)
    expect(child.remaining).toBe(50)
    expect(root.snapshot).toEqual({ charged: 30, reserved: 50, remaining: 20, unknown: false })
    expect(() => root.fork(21)).toThrow(BudgetExceededError)
    child.close()
    child.close()
    expect(root.snapshot).toEqual({ charged: 30, reserved: 0, remaining: 70, unknown: false })
    expect(child.isClosed).toBe(true)
    expect(child.canAfford(1)).toBe(false)
    expect(() => start(child, 'late-start', 1)).toThrow(BudgetExceededError)
    expect(() => child.fork(1)).toThrow(BudgetExceededError)
    expect(root.fork(50, 20).limit).toBe(50)
  })

  it('conservatively charges unfinished attempts on close and reconciles a late actual finish once', () => {
    const root = new RequestBudget(100)
    const child = root.fork(80, 20)
    start(child, 'unfinished', 50)
    child.close()
    expect(root.snapshot).toEqual({ charged: 50, reserved: 0, remaining: 50, unknown: true })
    finish(child, 'unfinished', 20, 5)
    finish(child, 'unfinished', 20, 5)
    expect(root.snapshot).toEqual({ charged: 25, reserved: 0, remaining: 75, unknown: false })
    expect(() => start(child, 'different', 1)).toThrow(BudgetExceededError)
  })

  it('does not hide actual overrun or other in-flight liability in the parent snapshot', () => {
    const root = new RequestBudget(100)
    const child = root.fork(80, 20)
    start(child, 'underestimated', 20)
    start(child, 'still-running', 30)
    finish(child, 'underestimated', 95, 10)
    expect(root.snapshot).toEqual({ charged: 105, reserved: 30, remaining: 0, unknown: false })
    expect(root.canAfford(0)).toBe(false)
    expect(() => start(root, 'parent', 1)).toThrow(BudgetExceededError)
    child.close()
    expect(root.snapshot).toEqual({ charged: 135, reserved: 0, remaining: 0, unknown: true })
    finish(child, 'still-running', 35, 5)
    expect(root.snapshot).toEqual({ charged: 145, reserved: 0, remaining: 0, unknown: false })
  })

  it('accounts every physical retry and cached input once while retaining unknown failures', () => {
    const root = new RequestBudget(1000)
    const child = root.fork(400, 200)
    start(child, 'attempt-1', 100)
    finish(child, 'attempt-1')
    start(child, 'attempt-2', 100)
    const response: RequestAttempt = { type: 'finish', requestAttemptId: 'attempt-2', provider: 'fixture', model: 'fixture', outcome: 'succeeded', usage: {
      promptTokens: 70, completionTokens: 10, cacheHitTokens: 60, cacheWriteTokens: 5, reasoningTokens: 8,
    } }
    child.observe(response)
    child.observe(response)
    child.close()
    expect(root.snapshot).toEqual({ charged: 180, reserved: 0, remaining: 820, unknown: true })
  })

  it('rejects an unaffordable fork without altering any accounting and exposes accurate local-budget details', () => {
    const root = new RequestBudget(100)
    const before = root.snapshot
    try { root.fork(81, 20); expect.fail('fork should reject') }
    catch (error) {
      expect(error).toBeInstanceOf(BudgetExceededError)
      expect(error).toMatchObject({ retryable: false, code: 'TOKEN_BUDGET_EXCEEDED', details: { limit: 100, remaining: 100, requested: 81, protectedRemaining: 20, reason: 'insufficient' } })
      expect((error as Error).message).toContain('本地累计模型用量额度不足')
      expect((error as Error).message).not.toContain('子任务')
    }
    expect(root.snapshot).toEqual(before)
    expect(root.canAfford(Number.NaN)).toBe(false)
    expect(root.canAfford(1, Infinity)).toBe(false)
    expect(() => root.fork(Infinity)).toThrow(BudgetExceededError)
  })

  it('closes nested partitions and reconciles their late usage without double charging', () => {
    const root = new RequestBudget(100)
    const child = root.fork(80, 20)
    const grandchild = child.fork(50, 30)
    start(grandchild, 'nested', 30)
    root.close()
    root.close()
    expect(child.isClosed).toBe(true)
    expect(grandchild.isClosed).toBe(true)
    expect(root.snapshot).toEqual({ charged: 30, reserved: 0, remaining: 70, unknown: true })
    finish(grandchild, 'nested', 10, 5)
    expect(root.snapshot).toEqual({ charged: 15, reserved: 0, remaining: 85, unknown: false })
    expect(root.canAfford(1)).toBe(false)
  })

  it('keeps existing per-attempt reservation and duplicate-event behavior compatible', () => {
    const budget = new RequestBudget(30, 20)
    const event: RequestAttempt = { type: 'start', requestAttemptId: 'one', provider: 'fixture', model: 'fixture' }
    budget.observe(event)
    budget.observe(event)
    expect(budget.snapshot).toEqual({ charged: 0, reserved: 20, remaining: 10, unknown: false })
    expect(() => start(budget, 'two', 20)).toThrow(BudgetExceededError)
    finish(budget, 'one')
    finish(budget, 'one')
    expect(budget.snapshot).toEqual({ charged: 20, reserved: 0, remaining: 10, unknown: true })
  })
})


describe('unlimited cumulative accounting by default', () => {
  it('enables a cap only for an explicitly configured finite positive value', () => {
    for (const value of [undefined, '', ' ', '0', '-1', '-Infinity', 'Infinity', 'NaN', 'invalid', '100k']) {
      expect(parseRequestTokenLimit(value), String(value)).toBe(Infinity)
    }
    expect(parseRequestTokenLimit('500000')).toBe(500000)
    expect(parseRequestTokenLimit(' 125 ')).toBe(125)
    expect(parseRequestTokenLimit('0.5')).toBe(0.5)
    for (const value of [0, -1, -Infinity, NaN]) expect(() => new RequestBudget(value)).toThrow(RangeError)
    expect(new RequestBudget(Infinity).remaining).toBe(Infinity)
  })

  it('continues requesting beyond 500k while retaining exact usage and duplicate-event protection', () => {
    const budget = new RequestBudget()
    start(budget, 'first', 400000)
    finish(budget, 'first', 350000, 50000)
    start(budget, 'second', 300000)
    finish(budget, 'second', 250000, 50000)
    finish(budget, 'second', 250000, 50000)
    expect(budget.snapshot).toEqual({ charged: 700000, reserved: 0, remaining: Infinity, unknown: false })
    expect(budget.canAfford(1000000)).toBe(true)
    start(budget, 'third', 1000000)
    expect(budget.snapshot).toEqual({ charged: 700000, reserved: 1000000, remaining: Infinity, unknown: false })
    finish(budget, 'third', 750000, 100000)
    expect(budget.snapshot).toEqual({ charged: 1550000, reserved: 0, remaining: Infinity, unknown: false })
  })

  it('retains unknown request charges without turning unlimited accounting into a spending cap', () => {
    const budget = new RequestBudget(parseRequestTokenLimit(undefined))
    start(budget, 'unknown', 600000)
    finish(budget, 'unknown')
    expect(budget.snapshot).toEqual({ charged: 600000, reserved: 0, remaining: Infinity, unknown: true })
    start(budget, 'next', 100000)
    finish(budget, 'next', 80000, 10000)
    expect(budget.snapshot).toEqual({ charged: 690000, reserved: 0, remaining: Infinity, unknown: true })
  })

  it('still enforces an explicitly configured small cap with normal reservation and settlement', () => {
    const budget = new RequestBudget(parseRequestTokenLimit('100'))
    start(budget, 'first', 80)
    finish(budget, 'first', 60, 10)
    expect(budget.remaining).toBe(30)
    expect(() => start(budget, 'blocked', 31)).toThrow(BudgetExceededError)
    start(budget, 'fits', 30)
    finish(budget, 'fits', 25, 5)
    expect(budget.snapshot).toEqual({ charged: 100, reserved: 0, remaining: 0, unknown: false })
    expect(() => start(budget, 'exhausted', 1)).toThrow(BudgetExceededError)
  })
})
