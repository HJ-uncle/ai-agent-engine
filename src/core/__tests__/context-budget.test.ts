import { afterEach, describe, expect, it, vi } from 'vitest'
import { configuredContextWindowBudget, effectiveContextWindow, parseContextWindowBudget } from '../context-budget.js'

afterEach(() => vi.unstubAllEnvs())

describe('per-request context policy', () => {
  it('defaults large and unknown models to 268K while retaining smaller true capabilities', () => {
    vi.stubEnv('CONTEXT_WINDOW_BUDGET', '')
    expect(effectiveContextWindow(1_000_000)).toBe(268_000)
    expect(effectiveContextWindow()).toBe(268_000)
    expect(effectiveContextWindow(128_000)).toBe(128_000)
    expect(effectiveContextWindow(1_000_000, 64_000)).toBe(64_000)
  })

  it('applies an explicit policy without resurrecting legacy TOKEN_BUDGET or OSM multiplication', () => {
    vi.stubEnv('TOKEN_BUDGET', '900')
    vi.stubEnv('OSM_MODE', 'max')
    vi.stubEnv('CONTEXT_WINDOW_BUDGET', '400000')
    expect(effectiveContextWindow(1_000_000)).toBe(400_000)
    expect(effectiveContextWindow(128_000)).toBe(128_000)
  })

  it.each([null, '', 'invalid', '2e5', '1.5', true, false, 0, -1, Infinity, Number.MAX_SAFE_INTEGER + 1])
    ('defensively defaults invalid configuration %s', value => {
      expect(parseContextWindowBudget(value)).toBeUndefined()
      expect(configuredContextWindowBudget(value)).toBe(268_000)
    })

  it('accepts exact positive integer configuration', () => {
    expect(parseContextWindowBudget(' 268000 ')).toBe(268_000)
    expect(parseContextWindowBudget(128_000)).toBe(128_000)
  })
})
