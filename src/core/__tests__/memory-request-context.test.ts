import { describe, expect, it } from 'vitest'
import { buildMemoryRequestContext, memoryRequestTokenBudget } from '../memory-request-context.js'
import { estimateTokens } from '../utils/tokens.js'
import { estimateRequestInput } from '../agent-loop/finalization.js'

describe('shared recalled and client memory budget', () => {
  it('keeps the ordinary budget bounded and reduces it for small model windows', () => {
    expect(memoryRequestTokenBudget()).toBe(2000)
    expect(memoryRequestTokenBudget(1_000_000)).toBe(2000)
    expect(memoryRequestTokenBudget(8_000)).toBe(640)
  })

  it('omits an empty memory payload rather than creating an artificial turn', () => {
    expect(buildMemoryRequestContext('', '')).toBe('')
    expect(buildMemoryRequestContext('   ', '\n  ')).toBe('')
  })

  it('retains bounded recalled source data and supplied client memory together', () => {
    const recalled = 'SOURCE_FIXTURE_3472 recordedAt=123456789 summary: 简体中文。'
    const inline = '<memory id="CLIENT_FIXTURE_9238">金额保留两位小数。</memory>'
    const result = buildMemoryRequestContext(recalled, inline)
    expect(result).toContain(recalled)
    expect(result).toContain(inline)
    expect(estimateTokens(result)).toBeLessThanOrEqual(memoryRequestTokenBudget())
  })

  it('bounds both inputs together so client XML cannot bypass the recall token budget', () => {
    const recalled = 'RECALL_BOUNDARY_8571 这是虚构的历史偏好。'.repeat(1_000)
    const inline = '<memory>CLIENT_BOUNDARY_1893 这是虚构的客户端偏好。</memory>'.repeat(1_000)
    const result = buildMemoryRequestContext(recalled, inline, 16_000)
    expect(result.length).toBeGreaterThan(0)
    expect(estimateTokens(result)).toBeLessThanOrEqual(memoryRequestTokenBudget(16_000))
    expect(result.length).toBeLessThan(recalled.length + inline.length)
    expect(recalled).toHaveLength('RECALL_BOUNDARY_8571 这是虚构的历史偏好。'.length * 1_000)
    expect(inline).toHaveLength('<memory>CLIENT_BOUNDARY_1893 这是虚构的客户端偏好。</memory>'.length * 1_000)
  })

  it('does not split a Unicode surrogate pair when truncating oversized client data', () => {
    const result = buildMemoryRequestContext('', 'UNICODE_FIXTURE_2371 🧠🚀中文'.repeat(2_000), 8_000)
    expect(estimateTokens(result)).toBeLessThanOrEqual(memoryRequestTokenBudget(8_000))
    for (let index = 0; index < result.length; index++) {
      const code = result.charCodeAt(index)
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = result.charCodeAt(++index)
        expect(next >= 0xdc00 && next <= 0xdfff).toBe(true)
      } else expect(code < 0xdc00 || code > 0xdfff).toBe(true)
    }
  })

  it('signals omitted content even when the later client source is entirely excluded', () => {
    const budget = memoryRequestTokenBudget(8_000)
    let low = 0, high = 10_000
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      const candidate = 'R'.repeat(middle)
      if (buildMemoryRequestContext(candidate, '', 8_000).includes(candidate)) low = middle
      else high = middle - 1
    }
    const largestRecall = 'R'.repeat(low)
    expect(largestRecall.length).toBeGreaterThan(0)
    const result = buildMemoryRequestContext(largestRecall, 'CLIENT_OMITTED_9201 '.repeat(1_000), 8_000)
    expect(result).toMatch(/excerpt|not loaded|omitt|节选|未加载|省略/i)
    expect(estimateRequestInput([], undefined, [], result)).toBeLessThanOrEqual(budget)
  })
})
