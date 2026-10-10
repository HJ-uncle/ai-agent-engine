import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLLMAdapter } from '../factory.js'
import type { Message } from '../../agent-context/types.js'

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks() })

const image = 'data:image/png;base64,aGVsbG8='
const messages: Message[] = [
  { role: 'user', content: [{ type: 'text', text: 'Inspect the screenshot' }, { type: 'image_url', image_url: { url: image } }] },
  { role: 'assistant', content: '', toolCall: { id: 'image-tool', name: 'read_image', args: { path: 'layout.png' } } },
  { role: 'tool', toolCallId: 'image-tool', content: JSON.stringify({ filename: 'layout.png', dataUrl: image }) },
]

describe('explicit vision configuration reaches compatible provider wire', () => {
  it.each([
    { provider: 'deepseek', model: 'deepseek-v4.1-flash', vision: true, expected: true },
    { provider: 'deepseek', model: 'deepseek-v4.1-flash', vision: false, expected: false },
    { provider: 'deepseek', model: 'deepseek-chat', vision: undefined, expected: false },
    { provider: 'qwen', model: 'qwen-code', vision: true, expected: true },
    { provider: 'qwen', model: 'qwen3.8-flash', vision: false, expected: false },
    { provider: 'qwen', model: 'qwen3.8-flash', vision: undefined, expected: true },
  ])('$provider $model honors vision=$vision for complete and stream', async ({ provider, model, vision, expected }) => {
    vi.stubEnv('LLM_FALLBACK_MODEL', '')
    const bodies: { messages: unknown[] }[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)); bodies.push(body)
      const choice = { message: { role: 'assistant', content: 'checked' }, finish_reason: 'stop' }
      const usage = { prompt_tokens: 123, completion_tokens: 1 }
      if (!body.stream) return Response.json({ model, choices: [choice], usage })
      return new Response('data: ' + JSON.stringify({ model,
        choices: [{ index: 0, delta: { content: 'checked' }, finish_reason: 'stop' }], usage })
        + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    }))
    // Conflicting family defaults prove capabilities have the highest priority.
    const adapter = createLLMAdapter({ provider, model, apiKey: 'fixture-key', baseUrl: 'http://model.invalid',
      capabilities: vision === undefined ? undefined : { vision },
      ...(vision === undefined ? {} : provider === 'deepseek' ? { deepseek: { vision: !vision } } : { qwen: { vision: !vision } }) })
    await adapter.complete(messages, { model, thinkingEnabled: false })
    for await (const _chunk of adapter.stream(messages, { model, thinkingEnabled: false })) { /* inspect SDK requests */ }
    expect(bodies).toHaveLength(2)
    for (const body of bodies) {
      const wire = JSON.stringify(body.messages)
      expect(wire.split(image).length - 1).toBe(expected ? 2 : 0)
      expect(wire.includes('"type":"image_url"')).toBe(expected)
      expect(wire).toContain('Inspect the screenshot')
      expect(wire).toContain('image-tool')
    }
    expect(JSON.stringify(messages)).toContain(image)
  })
})
