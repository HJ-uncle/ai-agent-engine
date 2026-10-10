import { describe, expect, it, vi } from 'vitest'
import { estimateModelMessageTokens } from '../model-context.js'
import { estimateProviderRequestInput, multimodalSummaryText } from '../multimodal-context.js'
import { estimateTokens } from '../tokens.js'
import { buildCompactSummarizeFn } from '../../agent-loop/compact-prompt.js'
import { largeNativePng } from './fixtures/native-image.js'
import type { Message } from '../../agent-context/types.js'

const image = largeNativePng()
const parts = [{ type: 'text', text: 'Keep DECISION=43 and inspect this layout.' }, { type: 'image_url', image_url: { url: image.url } }]

describe('native image context differs from encoded text', () => {
  it('budgets a real 256KiB PNG by image dimensions without mutating retained pixels', () => {
    expect(image.buffer.length).toBeGreaterThan(256 * 1024)
    const message = { role: 'user' as const, content: 'See screenshot.', modelInputContent: parts }
    expect(estimateModelMessageTokens(message)).toBeLessThan(4_000)
    expect(estimateModelMessageTokens({ role: 'tool', content: JSON.stringify({ filename: 'layout.png', dataUrl: image.url, hasDataUrl: true }) })).toBeLessThan(4_000)
    expect(message.modelInputContent[1].image_url!.url).toBe(image.url)
  })

  it('retains expensive accounting for base64 inside plain text or nested tool data', () => {
    expect(estimateModelMessageTokens({ role: 'user', content: image.url })).toBeGreaterThan(200_000)
    expect(estimateModelMessageTokens({ role: 'tool', content: JSON.stringify({ log: { dataUrl: image.url } }) })).toBeGreaterThan(200_000)
  })

  it('keeps real OpenAI and Anthropic wire image observations semantic', () => {
    const openai = { messages: [{ role: 'user', content: parts }] }
    const anthropic = { messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: image.base64 } }] }] }
    expect(estimateTokens(JSON.stringify(openai))).toBeGreaterThan(200_000)
    expect(estimateProviderRequestInput(openai)).toBeLessThan(4_000)
    expect(estimateProviderRequestInput(anthropic)).toBeLessThan(4_000)
    expect(estimateProviderRequestInput({ messages: [{ role: 'user', content: [{ type: 'text', text: image.url }] }] })).toBeGreaterThan(200_000)
  })

  it('summarizes native image identity and retrieval instead of sending pixel bytes as text', async () => {
    const complete = vi.fn(async (_messages: Message[]) => ({ content: '<summary>DECISION=43; retained layout image can be recovered from image-message.</summary>' }))
    const source = { id: 'image-message', role: 'user' as const, content: 'See uploaded layout.png.', modelInputContent: parts }
    const result = await buildCompactSummarizeFn({ complete }, { archiveAvailable: true, contextWindow: 100_000 })([source])
    const prompt = String(complete.mock.calls[0][0][0].content)
    expect(prompt).toContain('DECISION=43')
    expect(prompt).toContain('Retained image: mime=image/png; sha256=')
    expect(prompt).toContain('messageId=image-message')
    expect(prompt).not.toContain(image.base64)
    expect(result).toContain('DECISION=43')
    expect(source.modelInputContent).toEqual(parts)
    expect(multimodalSummaryText(JSON.stringify({ dataUrl: image.url, filename: 'layout.png' }), true)).not.toContain(image.base64)
    expect(multimodalSummaryText(image.url)).toBe(image.url)
  })
})
