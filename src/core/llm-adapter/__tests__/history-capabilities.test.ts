import { afterEach, describe, expect, it, vi } from 'vitest'
import { AnthropicAdapter } from '../anthropic.js'
import { OllamaAdapter } from '../ollama.js'
import { OpenAIAdapter } from '../openai.js'
import { createLLMAdapter, resolveAdapterOptionsWithDbConfig } from '../factory.js'
import { resolveCapabilities } from '../../model-capabilities/index.js'
import { systemConfigStore } from '../../../storage/sqlite/system-config.js'
import type { Message } from '../../agent-context/index.js'

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks() })

const summary = '【历史上下文摘要】保留 CRLF；不要改动用户手写文件。'
const extractedAttachment = 'Retained attachment: DECISION=43; reuse the same idempotency key.'
const messages: Message[] = [
  { role: 'system', content: summary, metadata: { isCompactSummary: true } },
  { role: 'user', content: 'uploaded-contract-display-only', modelInputContent: extractedAttachment },
  { role: 'user', content: '继续修复' },
]
const systemPrompt = 'You are a coding assistant.'

describe('compacted constraints reach the real provider request', () => {
  it.each(['anthropic', 'ollama', 'openai'] as const)('%s complete and stream preserve history and system prompt', async provider => {
    const payloads: any[] = []
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      payloads.push(body)
      if (provider === 'ollama') {
        const result = { model: 'test', message: { content: 'ok' }, done: true, prompt_eval_count: 3, eval_count: 1 }
        return new Response(JSON.stringify(result) + (body.stream ? '\n' : ''), { headers: { 'content-type': 'application/json' } })
      }
      if (provider === 'openai') {
        if (!body.stream) return Response.json({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } })
        return new Response('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
      }
      if (!body.stream) return Response.json({ id: 'a', type: 'message', role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 3, output_tokens: 1 }, stop_reason: 'end_turn' })
      const frames = [
        { type: 'message_start', message: { id: 'a', type: 'message', role: 'assistant', model: 'claude-test', content: [], usage: { input_tokens: 3, output_tokens: 0 }, stop_reason: null } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ]
      return new Response(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const adapter = provider === 'anthropic'
      ? new AnthropicAdapter('claude-test', 'test-key', 'http://model.invalid', { 'X-Access-Token': 'test-token' })
      : provider === 'ollama' ? new OllamaAdapter('local', 'http://model.invalid')
      : new OpenAIAdapter('test-model', 'test-key', 'http://model.invalid')
    await adapter.complete(messages, { model: adapter.model, systemPrompt })
    for await (const _chunk of adapter.stream(messages, { model: adapter.model, systemPrompt })) { /* consume SDK transport */ }
    expect(payloads).toHaveLength(2)
    for (const payload of payloads) {
      const text = JSON.stringify(payload)
      expect(text.split(summary)).toHaveLength(2)
      expect(text).toContain(systemPrompt)
      expect(text).toContain('继续修复')
      expect(text.split(extractedAttachment)).toHaveLength(2)
      expect(text).not.toContain('uploaded-contract-display-only')
      if (provider === 'anthropic') {
        expect(payload.system).toBe(systemPrompt)
        expect(payload.messages[0].role).toBe('user')
      }
    }
    expect(messages[1].content).toBe('uploaded-contract-display-only')
  })
})

describe('native Ollama adapter limits', () => {
  it.each(['qwen3-vl', 'deepseek-r1', 'llava', 'gpt-4o'])('keeps %s on /api/chat with unsupported capabilities disabled', async model => {
    vi.stubEnv('LLM_FALLBACK_MODEL', '')
    const capabilities = resolveCapabilities({ provider: 'ollama', model, dbOverrides: { toolCalling: true }, overrides: { vision: true, video: true, audio: true, parallelTools: true } })
    expect(capabilities).toMatchObject({ toolCalling: false, parallelTools: false, vision: false, video: false, audio: false })
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => Response.json({ message: { content: 'ok' }, prompt_eval_count: 3, eval_count: 1 }))
    vi.stubGlobal('fetch', fetchMock)
    await createLLMAdapter({ provider: 'ollama', model, baseUrl: 'http://local.invalid' }).complete([{ role: 'user', content: 'hi' }])
    expect(fetchMock.mock.calls[0][0]).toBe('http://local.invalid/api/chat')
  })

  it('does not disable implemented OpenAI/Anthropic tool and vision support', () => {
    for (const provider of ['openai', 'anthropic']) {
      expect(resolveCapabilities({ provider, model: provider === 'openai' ? 'gpt-4o' : 'claude-sonnet-4' }))
        .toMatchObject({ toolCalling: true, vision: true, parallelTools: true })
    }
    expect(resolveCapabilities({ provider: 'ollama', model: 'claude-sonnet-4', baseUrl: 'http://gateway.invalid/anthropic' })).toMatchObject({ vision: true, toolCalling: true })
  })

  it('does not substitute cloud family endpoints for a local model during DB resolution', async () => {
    vi.spyOn(systemConfigStore, 'get').mockImplementation(async key => ({ LLM_PROVIDER: 'ollama', LLM_PRIMARY_MODEL: 'qwen3', QWEN_BASE_URL: 'https://cloud.invalid' } as Record<string, string>)[key] ?? null)
    vi.stubEnv('OLLAMA_BASE_URL', 'http://localhost:11435')
    const options = await resolveAdapterOptionsWithDbConfig()
    expect(options).toMatchObject({ provider: 'ollama', model: 'qwen3', baseUrl: 'http://localhost:11435' })
  })
})
