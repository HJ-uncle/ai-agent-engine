import { afterEach, expect, it, vi } from 'vitest'
import { AnthropicAdapter } from '../anthropic.js'
import { OpenAIAdapter } from '../openai.js'
import type { LLMRequestAttemptEvent } from '../types.js'
import type { Message } from '../../agent-context/types.js'
import { estimateRequestInput } from '../../agent-loop/finalization.js'
import { largeNativePng } from '../../utils/__tests__/fixtures/native-image.js'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
const image = largeNativePng()

it.each(['openai', 'anthropic'] as const)('%s complete and stream keep real image pixels while observing their semantic token cost', async provider => {
  const bodies: any[] = [], events: LLMRequestAttemptEvent[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)); bodies.push(body)
    if (provider === 'openai') {
      if (!body.stream) return Response.json({ choices: [{ message: { content: 'checked' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1100, completion_tokens: 3 } })
      return new Response('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'checked' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1100, completion_tokens: 3 } })
        + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    }
    if (!body.stream) return Response.json({ id: 'a', type: 'message', role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: 'checked' }], usage: { input_tokens: 1100, output_tokens: 3 }, stop_reason: 'end_turn' })
    const frames = [
      { type: 'message_start', message: { id: 'a', type: 'message', role: 'assistant', model: 'claude-test', content: [], usage: { input_tokens: 1100, output_tokens: 0 }, stop_reason: null } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'checked' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
      { type: 'message_stop' },
    ]
    return new Response(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
  }))
  const adapter = provider === 'openai' ? new OpenAIAdapter('gpt-4o', 'test-key', 'http://model.invalid', true)
    : new AnthropicAdapter('claude-test', 'test-key', 'http://model.invalid', { 'X-Access-Token': 'test-token' })
  const messages: Message[] = [{ id: 'image-request', role: 'user', content: 'UI shows layout.png', modelInputContent: [
    { type: 'text', text: 'Inspect the retained image. DECISION=43.' }, { type: 'image_url', image_url: { url: image.url } },
  ] }]
  const estimate = estimateRequestInput(messages, undefined, [])
  const options = { model: adapter.model, contextWindow: 100_000, maxTokens: 100_000 - estimate, requestInputTokenEstimate: estimate,
    systemPrompt: 'Follow the retained project policy. '.repeat(80),
    tools: [{ name: 'read_file', description: 'Read exact retained source.', parameters: { type: 'object' as const },
      execute: async () => ({ success: true as const, output: '' }) }],
    onRequestAttempt: (event: LLMRequestAttemptEvent) => { events.push(event) } }
  await adapter.complete(messages, options)
  for await (const _chunk of adapter.stream(messages, options)) { /* consume real SDK transport */ }
  expect(bodies).toHaveLength(2)
  for (const body of bodies) {
    const wire = JSON.stringify(body.messages)
    expect(wire.split(image.base64)).toHaveLength(2)
    expect(wire).not.toContain('UI shows layout.png')
    if (provider === 'anthropic') { expect(wire).toContain('"type":"image"'); expect(wire).not.toContain('"type":"image_url"') }
    else expect(wire).toContain('"type":"image_url"')
    expect(body.max_tokens ?? body.max_completion_tokens).toBeLessThan(options.maxTokens)
  }
  const starts = events.filter(event => event.type === 'start')
  expect(starts).toHaveLength(2)
  for (const event of starts) {
    expect(event.estimatedInputTokens).toBeLessThan(4_000)
    expect(event.maxOutputTokens! + event.estimatedInputTokens!).toBeLessThanOrEqual(100_000)
  }
  expect(messages[0].content).toBe('UI shows layout.png')
  expect((messages[0].modelInputContent![1] as any).image_url.url).toBe(image.url)
})
