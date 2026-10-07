import { describe, expect, it } from 'vitest'
import { estimateTokens } from '../tokens.js'

describe('estimateTokens', () => {
  it('uses a conservative estimate for long data-URI payloads', () => {
    const payload = `new URL("data:image/svg+xml,${'A'.repeat(1_000_000)}", import.meta.url)`
    const estimated = estimateTokens(payload)

    // A four-characters-per-token estimate would be about 250k. Dense encoded
    // payloads tokenize much less efficiently and must trigger compaction early.
    expect(estimated).toBeGreaterThan(700_000)
  })

  it('keeps ordinary source and prose on the regular estimate path', () => {
    const text = 'const answer = 42\n'.repeat(1_000)
    expect(estimateTokens(text)).toBe(Math.ceil(text.length * 0.25))
  })
})
