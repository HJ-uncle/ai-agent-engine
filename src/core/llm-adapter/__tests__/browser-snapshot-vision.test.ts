/** Browser snapshots reach the real provider serializers as one native image plus
 * full bounded page semantics; transport is intercepted, with no browser or model. */
import { afterEach, expect, it, vi } from 'vitest'
import { AnthropicAdapter } from '../anthropic.js'
import { OpenAIAdapter } from '../openai.js'
import type { Message } from '../../agent-context/types.js'
import { browserOutputPresentation } from '../../utils/browser-output.js'
import { estimateModelMessageTokens } from '../../utils/model-context.js'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDdwAAAAASUVORK5CYII='
const base64 = Buffer.concat([Buffer.from(png, 'base64'), Buffer.alloc(600_000)]).toString('base64')
const dataUrl = `data:image/png;base64,${base64}`

it.each([
  { provider: 'openai', vision: true }, { provider: 'openai', vision: false },
  { provider: 'anthropic', vision: true }, { provider: 'anthropic', vision: false },
] as const)('$provider complete/stream preserve page refs and honor vision=$vision', async ({ provider, vision }) => {
  const bodies: Array<{ messages: unknown[] }> = []
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { messages: unknown[]; stream?: boolean }
    bodies.push(body)
    if (provider === 'openai') {
      if (!body.stream) return Response.json({ choices: [{ message: { content: 'checked' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 2 } })
      return new Response('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'checked' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 2 } })
        + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    }
    if (!body.stream) return Response.json({ id: 'a', type: 'message', role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: 'checked' }], usage: { input_tokens: 1000, output_tokens: 2 }, stop_reason: 'end_turn' })
    const frames = [
      { type: 'message_start', message: { id: 'a', type: 'message', role: 'assistant', model: 'claude-test', content: [], usage: { input_tokens: 1000, output_tokens: 0 }, stop_reason: null } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'checked' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }, { type: 'message_stop' },
    ]
    return new Response(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
  }))
  const output = JSON.stringify({ tab: { tabId: 'owned-tab', title: 'Board', url: 'https://example.test/board', navigationId: 3 },
    text: 'Page body '.repeat(200) + 'PAGE_SEMANTICS_AFTER_1024', elements: [{ role: 'button', name: 'Continue', ref: '3:42' }],
    viewport: { width: 1280, height: 720, deviceScaleFactor: 2 }, truncated: false,
    screenshot: { dataUrl, width: 1, height: 1 },
    interaction: { type: 'click', x: 10, y: 20, navigationId: 2, pageUrl: 'https://example.test/before',
      viewport: { width: 1280, height: 720 }, screenshot: { dataUrl, width: 1, height: 1 } },
  })
  const presentation = browserOutputPresentation(output, undefined, true)!
  const receipt: Message = { role: 'tool', toolName: 'browser_snapshot', toolCallId: 'read-page',
    content: presentation.displayOutput, modelInputContent: presentation.modelVisionContent }
  const messages: Message[] = [
    { role: 'user', content: 'Inspect the page.' },
    { role: 'assistant', content: '', toolCall: { id: 'read-page', name: 'browser_snapshot', args: { tabId: 'owned-tab' } } }, receipt,
  ]
  const adapter = provider === 'openai' ? new OpenAIAdapter('gpt-4o', 'fixture-key', 'http://model.invalid', vision)
    : new AnthropicAdapter('claude-test', 'fixture-key', 'http://model.invalid', undefined, vision)
  await adapter.complete(messages, { model: adapter.model })
  for await (const _chunk of adapter.stream(messages, { model: adapter.model })) { /* inspect actual SDK requests */ }
  expect(bodies).toHaveLength(2)
  for (const body of bodies) {
    const wire = JSON.stringify(body.messages)
    expect(wire.split(base64).length - 1).toBe(vision ? 1 : 0)
    expect(wire).toContain('PAGE_SEMANTICS_AFTER_1024')
    expect(wire).toContain('3:42')
    expect(wire).toContain('owned-tab')
    if (vision) expect(wire).toContain(provider === 'openai' ? '"type":"image_url"' : '"type":"image"')
    else expect(wire).toContain('vision is disabled')
  }
  expect(estimateModelMessageTokens(receipt)).toBeLessThan(4000)
  expect(receipt.content).toBe(presentation.displayOutput)
  expect(JSON.parse(String(receipt.content)).interaction.screenshot.dataUrl).toBe(dataUrl)
})
