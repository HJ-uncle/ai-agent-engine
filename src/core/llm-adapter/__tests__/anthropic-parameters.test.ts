import { afterEach, describe, expect, it, vi } from 'vitest'
import { AnthropicAdapter } from '../anthropic.js'
import type { LLMAdapterOptions } from '../types.js'
import type { Message } from '../../agent-context/types.js'

afterEach(() => vi.unstubAllGlobals())

async function capture(stream: boolean, options: Partial<LLMAdapterOptions> = {}, messages: Message[] = [{ role: 'user', content: 'ready' }]) {
  let sent: Record<string, unknown> | undefined
  vi.stubGlobal('fetch', vi.fn(async (_url, init: RequestInit) => {
    sent = JSON.parse(String(init.body)) as Record<string, unknown>
    const message = { id: 'fixture', type: 'message', role: 'assistant', model: 'qwen3.8-flash', content: [{ type: 'text', text: 'ready' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } }
    if (!stream) return new Response(JSON.stringify(message), { headers: { 'content-type': 'application/json' } })
    const frames = [
      { type: 'message_start', message: { ...message, content: [], stop_reason: null } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'ready' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ]
    return new Response(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
  }))
  const adapter = new AnthropicAdapter('qwen3.8-flash', 'fixture-key', 'http://fixture.invalid/anthropic', { 'X-Access-Token': 'fixture-token' })
  const configured = { model: adapter.model, ...options }
  if (stream) { for await (const _chunk of adapter.stream(messages, configured)) { /* drain the actual SDK stream */ } }
  else await adapter.complete(messages, configured)
  return sent!
}

describe.each([false, true])('Anthropic wire parameters (stream=%s)', stream => {
  it('keeps cancelled reasoning in storage while omitting its empty unsigned assistant wire block', async () => {
    const messages: Message[] = [
      { id: 'task', role: 'user', content: 'Finish the original task.' },
      { id: 'partial', role: 'assistant', content: '', reasoningContent: 'Retained display reasoning.', metadata: { partial: true, status: 'cancelled' } },
    ]
    const retained = structuredClone(messages)
    const sent = await capture(stream, { requestContext: 'Continue the same task.' }, messages)
    expect(sent.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'user' })]))
    expect((sent.messages as Array<{ role: string }>).some(message => message.role === 'assistant')).toBe(false)
    expect(messages).toEqual(retained)
  })
  it('preserves partial public output and confirmed tool pairs when continuing', async () => {
    const messages: Message[] = [
      { role: 'user', content: 'Finish the task.' },
      { role: 'assistant', content: 'Retained partial output.', reasoningContent: 'Display thought.', metadata: { partial: true } },
      { role: 'assistant', content: '', toolCall: { id: 'verified', name: 'read_file', args: { path: 'result.txt' } } },
      { role: 'tool', content: 'Confirmed file content.', toolCallId: 'verified' },
    ]
    const sent = await capture(stream, { requestContext: 'Continue the same task.' }, messages)
    const wire = JSON.stringify(sent.messages)
    expect(wire).toContain('Retained partial output.')
    expect(wire).toContain('Confirmed file content.')
    expect(wire).toContain('"type":"tool_use"')
    expect(wire).toContain('"tool_use_id":"verified"')
    expect(wire).not.toContain('Display thought.')
  })
  it.each([0, 0.2, 0.5])('forwards explicit temperature %s including zero', async temperature => {
    expect(await capture(stream, { temperature, thinkingEnabled: false })).toMatchObject({ temperature, thinking: { type: 'disabled' } })
  })
  it('preserves the provider default when no temperature is supplied', async () => {
    expect(await capture(stream)).not.toHaveProperty('temperature')
  })
  it('keeps compatible gateway thinking independent of sampling', async () => {
    expect(await capture(stream, { temperature: 0.35, thinkingEnabled: true, thinkingConfig: { enable_thinking: true } })).toMatchObject({ temperature: 0.35, enable_thinking: true })
  })
  it('uses the required sampling value for native extended thinking', async () => {
    expect(await capture(stream, { temperature: 0.2, thinkingEnabled: true, thinkingConfig: { thinking: { type: 'enabled', budget_tokens: 1024 } } })).toMatchObject({ temperature: 1, thinking: { type: 'enabled', budget_tokens: 1024 } })
  })
  it.each(['MiniMax-M2.5', 'glm-5.3'])('uses the provider-required thinking switch for %s', async model => {
    const params = await capture(stream, { model, thinkingEnabled: false })
    expect(params).toMatchObject({ enable_thinking: true })
    expect(params).not.toHaveProperty('thinking')
    expect(params).not.toHaveProperty('reasoning_effort')
  })
  it.each(['MiniMax-M2.5', 'glm-5.3'])('forces the provider-required switch for %s when thinking is omitted', async model => {
    const params = await capture(stream, { model })
    expect(params).toMatchObject({ enable_thinking: true })
    expect(params).not.toHaveProperty('thinking')
    expect(params).not.toHaveProperty('reasoning_effort')
  })
  it('omits unsupported native thinking fields for Kimi', async () => {
    const params = await capture(stream, { model: 'kimi-k2.6', thinkingEnabled: false })
    expect(params).not.toHaveProperty('thinking')
    expect(params).not.toHaveProperty('enable_thinking')
  })
  it('caps unbounded Kimi output at the gateway limit', async () => {
    expect(await capture(stream, { model: 'kimi-k2.6', unboundedOutput: true })).toMatchObject({ max_tokens: 262144 })
  })
  it('keeps the shared gateway cap for other Kimi variants', async () => {
    expect(await capture(stream, { model: 'kimi-k2.5', unboundedOutput: true })).toMatchObject({ max_tokens: 393216 })
  })
})
