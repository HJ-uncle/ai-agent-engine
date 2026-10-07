/** Verify serialized provider requests, including retries, rather than merely hiding reasoning UI. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '../../agent-context/types.js'
import type { LLMAdapter, LLMStreamChunk } from '../types.js'
import { OpenAIAdapter } from '../openai.js'
import { DeepSeekAdapter } from '../deepseek.js'
import { QwenAdapter } from '../qwen.js'
import { AnthropicAdapter } from '../anthropic.js'
import { OllamaAdapter } from '../ollama.js'
import { FallbackAdapter } from '../retry.js'
import { resolveCapabilities } from '../../model-capabilities/index.js'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
const messages: Message[] = [
  { role: 'user', content: 'inspect project' },
  { role: 'assistant', content: '', toolCall: { id: 'tool-1', name: 'read_file', args: { path: 'README.md' } } },
  { role: 'tool', content: 'project description', toolCallId: 'tool-1' },
]

function mockOpenAI(adapter: LLMAdapter, baseURL: string, mode: 'complete' | 'stream') {
  const create = vi.fn(async (_params: Record<string, unknown>) => mode === 'complete'
    ? { model: adapter.model, choices: [{ message: { role: 'assistant', content: 'done', reasoning_content: 'provider evidence' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } }
    : (async function* () {
      yield { model: adapter.model, choices: [{ delta: { content: 'done', reasoning_content: 'provider evidence' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } }
    })())
  Object.defineProperty(adapter, 'client', { value: { baseURL, chat: { completions: { create } } }, configurable: true })
  return create
}

async function request(adapter: LLMAdapter, mode: 'complete' | 'stream') {
  const options = { model: adapter.model, thinkingEnabled: false, reasoningEffort: 'medium' as const,
    // Explicit Off wins over stale provider configuration from a previous run.
    thinkingConfig: { enable_thinking: true, reasoning_effort: 'high' }, responseThinkingField: 'reasoning_content' }
  if (mode === 'complete') return [await adapter.complete(messages, options)]
  const chunks: LLMStreamChunk[] = []
  for await (const chunk of adapter.stream(messages, options)) chunks.push(chunk)
  return chunks
}

describe('explicit thinking Off on the provider wire', () => {
  const providers = [
    { name: 'DeepSeek gateway', model: 'deepseek-v4.1-flash', baseURL: 'https://gateway.invalid/v1',
      build: (model: string, url: string) => new DeepSeekAdapter(model, 'test-key', url), expected: { enable_thinking: false, reasoning_effort: 'low' } },
    { name: 'DeepSeek official', model: 'deepseek-v4.1-flash', baseURL: 'https://api.deepseek.com/v1',
      build: (model: string, url: string) => new DeepSeekAdapter(model, 'test-key', url), expected: { thinking: { type: 'disabled' } } },
    { name: 'OpenAI compatible DeepSeek', model: 'deepseek-v4.1-flash', baseURL: 'https://gateway.invalid/v1',
      build: (model: string, url: string) => new OpenAIAdapter(model, 'test-key', url), expected: { enable_thinking: false, reasoning_effort: 'low' } },
    { name: 'Qwen', model: 'qwen3-plus', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      build: (model: string, url: string) => new QwenAdapter(model, 'test-key', url), expected: { enable_thinking: false } },
  ]
  for (const provider of providers) {
    it.each(['complete', 'stream'] as const)(provider.name + ' %s sends Off without fabricating reasoning history', async mode => {
      const adapter = provider.build(provider.model, provider.baseURL)
      const create = mockOpenAI(adapter, provider.baseURL, mode)
      const chunks = await request(adapter, mode)
      const params = create.mock.calls[0][0]
      expect(params).toMatchObject(provider.expected)
      if (!('reasoning_effort' in provider.expected)) expect(params).not.toHaveProperty('reasoning_effort')
      const assistant = (params.messages as Array<Record<string, unknown>>).find(message => message.role === 'assistant')
      expect(assistant).toHaveProperty('tool_calls')
      expect(assistant).not.toHaveProperty('reasoning_content')
      // If an upstream ignores Off we keep its evidence visible instead of pretending it obeyed.
      expect(chunks.some(chunk => chunk.reasoningContent === 'provider evidence')).toBe(true)
    })
  }

  it.each(['complete', 'stream'] as const)('Anthropic protocol %s uses disabled even for a DeepSeek model id', async mode => {
    const adapter = new AnthropicAdapter('deepseek-v4.1-flash', 'test-key', 'https://gateway.invalid/anthropic')
    const create = vi.fn(async (_params: Record<string, unknown>) => ({ content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 5, output_tokens: 1 }, stop_reason: 'end_turn' }))
    const stream = vi.fn((_params: Record<string, unknown>) => ({
      async *[Symbol.asyncIterator]() { yield { type: 'message_stop' } },
      finalMessage: async () => ({ model: adapter.model, usage: { input_tokens: 5, output_tokens: 1 }, stop_reason: 'end_turn' }),
      abort: vi.fn(),
    }))
    Object.defineProperty(adapter, 'client', { value: { messages: { create, stream } } })
    await request(adapter, mode)
    const params = mode === 'complete' ? create.mock.calls[0][0] : stream.mock.calls[0][0]
    expect(params.thinking).toEqual({ type: 'disabled' })
    expect(params).not.toHaveProperty('enable_thinking')
    expect(params).not.toHaveProperty('reasoning_effort')
  })

  it.each(['complete', 'stream'] as const)('Ollama native %s uses think:false for a Qwen model', async mode => {
    const adapter = new OllamaAdapter('qwen3', 'http://ollama.invalid')
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(JSON.stringify({ model: 'qwen3', message: { content: 'done' }, done: true, done_reason: 'stop', prompt_eval_count: 5, eval_count: 1 }) + '\n'))
    vi.stubGlobal('fetch', fetchMock)
    await request(adapter, mode)
    const params = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as Record<string, unknown>
    expect(params.think).toBe(false)
    expect(params).not.toHaveProperty('enable_thinking')
    expect(params).not.toHaveProperty('reasoning_effort')
  })

  it.each(['o3', 'unknown-compatible-model'])('does not inject medium effort or invent switches for %s', async model => {
    const adapter = new OpenAIAdapter(model, 'test-key', 'https://model.invalid')
    const create = mockOpenAI(adapter, 'https://model.invalid', 'complete')
    await request(adapter, 'complete')
    expect(create.mock.calls[0][0]).not.toHaveProperty('reasoning_effort')
    expect(create.mock.calls[0][0]).not.toHaveProperty('thinking')
    expect(create.mock.calls[0][0]).not.toHaveProperty('enable_thinking')
  })

  it.each(['complete', 'stream'] as const)('does not drop a rejected Off switch and retry with provider defaults (%s)', async mode => {
    const adapter = new DeepSeekAdapter('deepseek-v4.1-flash', 'test-key', 'https://gateway.invalid/v1')
    const create = mockOpenAI(adapter, 'https://gateway.invalid/v1', mode)
    create.mockRejectedValueOnce(Object.assign(new Error("Unsupported parameter: 'enable_thinking'"), { status: 400 }))
    await expect(request(adapter, mode)).rejects.toThrow('enable_thinking')
    expect(create).toHaveBeenCalledTimes(1)
  })

  it.each(['complete', 'stream'] as const)('does not leak DeepSeek switches into a fallback model (%s)', async mode => {
    const primary = new DeepSeekAdapter('deepseek-v4.1-flash', 'test-key', 'https://gateway.invalid/v1')
    const fallback = new OpenAIAdapter('ordinary-model', 'test-key', 'https://fallback.invalid/v1')
    const primaryCreate = mockOpenAI(primary, 'https://gateway.invalid/v1', mode)
    const fallbackCreate = mockOpenAI(fallback, 'https://fallback.invalid/v1', mode)
    primaryCreate.mockRejectedValueOnce(Object.assign(new Error('Service unavailable'), { status: 503 }))
    await request(new FallbackAdapter({ primary, fallbacks: [fallback] }), mode)
    expect(primaryCreate.mock.calls[0][0]).toMatchObject({ enable_thinking: false, reasoning_effort: 'low' })
    expect(fallbackCreate).toHaveBeenCalledOnce()
    expect(fallbackCreate.mock.calls[0][0].model).toBe('ordinary-model')
    expect(fallbackCreate.mock.calls[0][0]).not.toHaveProperty('enable_thinking')
    expect(fallbackCreate.mock.calls[0][0]).not.toHaveProperty('reasoning_effort')
    expect(fallbackCreate.mock.calls[0][0]).not.toHaveProperty('thinking')
  })

  it('keeps ordinary compatibility retries while retaining Off', async () => {
    const adapter = new OpenAIAdapter('deepseek-v4.1-flash', 'test-key', 'https://gateway.invalid/v1')
    const create = mockOpenAI(adapter, 'https://gateway.invalid/v1', 'complete')
    create.mockRejectedValueOnce(Object.assign(new Error("Unsupported parameter: 'temperature'"), { status: 400 }))
    await adapter.complete(messages, { model: adapter.model, thinkingEnabled: false, temperature: 0.2 })
    expect(create).toHaveBeenCalledTimes(2)
    expect(create.mock.calls[1][0]).toMatchObject({ enable_thinking: false, reasoning_effort: 'low' })
    expect(create.mock.calls[1][0]).not.toHaveProperty('temperature')
  })

  it('recognizes a legacy off configuration without generating placeholder reasoning', async () => {
    const adapter = new DeepSeekAdapter('deepseek-v4.1-flash', 'test-key', 'https://gateway.invalid/v1')
    const create = mockOpenAI(adapter, 'https://gateway.invalid/v1', 'complete')
    await adapter.complete(messages, { model: adapter.model, thinkingConfig: { enable_thinking: false, reasoning_effort: 'low' } })
    const assistant = (create.mock.calls[0][0].messages as Array<Record<string, unknown>>).find(message => message.role === 'assistant')
    expect(assistant).not.toHaveProperty('reasoning_content')
  })

  it('retains adapter defaults when no user intent was supplied', async () => {
    const adapter = new DeepSeekAdapter('deepseek-v4.1-flash', 'test-key', 'https://gateway.invalid/v1')
    const create = mockOpenAI(adapter, 'https://gateway.invalid/v1', 'complete')
    await adapter.complete(messages, { model: adapter.model })
    expect(create.mock.calls[0][0].reasoning_effort).toBe('medium')
    expect(create.mock.calls[0][0]).not.toHaveProperty('enable_thinking')
  })

  it.each(['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4.1-pro', 'deepseek-v4.1-flash'])('recognizes thinking support for %s', model => {
    expect(resolveCapabilities({ model, provider: 'openai' }).thinking).toBe(true)
  })
})
