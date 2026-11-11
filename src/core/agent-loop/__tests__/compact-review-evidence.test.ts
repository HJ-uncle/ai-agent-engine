/** Prompt-boundary tests only: a mock digest cannot verify a model's semantics. */
import { describe, expect, it, vi } from 'vitest'
import type { Message } from '../../agent-context/types.js'
import { buildCompactSummarizeFn } from '../compact-prompt.js'

const oldHash = `sha256:${'a'.repeat(64)}`, newHash = `sha256:${'b'.repeat(64)}`
const source: Message[] = [
  { id: 'scope', role: 'user', content: 'Review D:/approved/deck.pptx, five pages. Keep already reviewed unchanged pages and disclose gaps.' },
  { id: 'receipt', role: 'tool', toolCallId: 'render-1', content: `[tool result cleared]\nD:/approved/deck.pptx ${oldHash} page=1; render succeeded, pixels unavailable.` },
  { id: 'review-1', role: 'assistant', content: `D:/approved/deck.pptx @ ${oldHash} page 1: visually checked; title and image are readable, no clipping.` },
  { id: 'review-2', role: 'assistant', content: `D:/approved/deck.pptx @ ${oldHash} page 2: visually checked; footer overlaps the chart.` },
  { id: 'render-only', role: 'tool', toolCallId: 'render-3', content: `[tool result cleared]\nD:/approved/deck.pptx ${oldHash} page=3; render succeeded, pixels unavailable. No review verdict recorded.` },
  { id: 'blanket-claim', role: 'assistant', content: 'All five pages look perfect.' },
  { id: 'coverage-correction', role: 'user', content: 'Pages 4 and 5 have never been rendered or reviewed; that blanket claim is unsupported.' },
  { id: 'changed-version', role: 'tool', content: `Edit saved D:/approved/deck.pptx @ ${newHash}; changed page 2 only, fixing footer position. No new render or verdict yet.` },
]

function expectReviewPolicy(prompt: string): void {
  // These are the distinct evidence boundaries implicated by the real round-5
  // summary, not assertions that the mocked model actually obeyed them.
  expect(prompt).toContain('not an earlier recorded review')
  expect(prompt).toContain('source message IDs')
  expect(prompt).toContain('unsupported assistant completion claims, render-only receipts, and unreviewed content')
  expect(prompt).toContain('a reviewed range is not the whole file')
  expect(prompt).toContain('old-version checks do not certify changed content')
}

describe('visual review evidence in compaction requests', () => {
  it.each([false, true])('retains mixed verdicts, claims and version changes at the provider boundary (archive=%s)', async archiveAvailable => {
    const complete = vi.fn(async (_messages: Message[]) => ({ content: '<summary>Fixture output, not semantic acceptance.</summary>' }))
    const before = structuredClone(source)
    const summarize = buildCompactSummarizeFn({ complete }, { archiveAvailable, contextWindow: 100_000 })
    await summarize(source)
    expect(complete).toHaveBeenCalledTimes(1)
    const prompt = String(complete.mock.calls[0][0][0].content)
    expectReviewPolicy(prompt)
    for (const message of source) {
      expect(prompt).toContain(String(message.content))
      if (archiveAvailable) expect(prompt).toContain(`messageId=${message.id}`)
    }
    expect(source).toEqual(before)
  })

  it('keeps the evidence distinction when archived summaries are reduced again', async () => {
    const prompts: string[] = []
    const complete = vi.fn(async (messages: Message[]) => {
      const prompt = String(messages[0].content); prompts.push(prompt)
      return { content: prompt.includes('[part 1]') ? 'Fixture final digest.'
        : `Recorded page 1 verdict belongs to ${oldHash}; changed page 2 at ${newHash} needs review.` }
    })
    const messages: Message[] = [...source, { id: 'ordinary-history', role: 'assistant', content: 'Ordinary completed project detail. '.repeat(2500) }]
    await buildCompactSummarizeFn({ complete }, { archiveAvailable: true, contextWindow: 12_000, maxOutputTokens: 512 })(messages)
    expect(prompts.length).toBeGreaterThan(2)
    expect(prompts.some(prompt => prompt.includes('[part 1]'))).toBe(true)
    for (const prompt of prompts) expectReviewPolicy(prompt)
    const reduction = prompts.find(prompt => prompt.includes('[part 1]'))!
    expect(reduction).toContain(oldHash)
    expect(reduction).toContain(newHash)
  })
})
