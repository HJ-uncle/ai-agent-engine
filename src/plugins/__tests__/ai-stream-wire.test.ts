import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { streamPluginCapability, type CapabilityAccess } from '../capability-runtime.js'
import type { PluginStreamEvent } from '../capability-stream-types.js'
import type { ModelConfig } from '../../storage/sqlite/models.js'

// Only configuration storage and HTTP transport are fixtures. Resolution, adapter
// construction, provider SSE parsing and the public plugin stream are real.
const mocks = vi.hoisted(() => ({ models: vi.fn(), whitelists: vi.fn(), configuration: vi.fn() }))
vi.mock('../../storage/sqlite/models.js', () => ({ ModelsStore: class { getModels = mocks.models; getWhitelists = mocks.whitelists } }))
vi.mock('../../storage/sqlite/system-config.js', () => ({ systemConfigStore: { get: mocks.configuration } }))

type Protocol = 'openai' | 'anthropic'
const syntheticKey = 'synthetic-wire-key-never-return'
const privateReasoning = 'PRIVATE-WIRE-REASONING-NEVER-RETURN'
const configuredModel: ModelConfig = { id: 'stream-configured', tenantId: 'fixture', provider: 'deepseek', modelId: 'deepseek-v4.1-flash',
  apiKey: syntheticKey, baseUrl: 'https://fixture.invalid/v1', apiFormat: 'auto', isEnabled: true,
  capabilities: { thinking: true, contextWindow: 24_000 }, createdAt: 0, updatedAt: 0 }
let access: CapabilityAccess, requests: Array<{ url: string; body: Record<string, unknown> }>, events: PluginStreamEvent[]

beforeEach(() => {
  requests = []; events = []
  vi.stubEnv('LLM_FALLBACK_MODEL', '')
  access = { id: 'stream-review', revision: 1, grants: ['ai.run'],
    manifest: { apiVersion: 1, id: 'stream-review', name: 'Stream review', description: 'Protocol fixture', version: '1.0.0', runtime: 'node', tools: [], permissions: { requested: ['ai.run'] } },
    getSettings: async () => ({}), setSettings: async value => value }
  access.refresh = async () => access
  mocks.configuration.mockResolvedValue(null)
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetAllMocks() })

function configure(protocol: Protocol) {
  mocks.models.mockResolvedValue([{ ...configuredModel, apiFormat: protocol === 'anthropic' ? 'anthropic' : 'auto',
    baseUrl: protocol === 'anthropic' ? 'https://fixture.invalid/anthropic' : 'https://fixture.invalid/v1' }])
  if (protocol === 'anthropic') mocks.whitelists.mockResolvedValue([{ modelId: configuredModel.modelId, thinkingMode: true,
    thinkingConfig: { thinking: { type: 'disabled' } }, responseThinkingField: 'thinking' }])
  else {
    mocks.whitelists.mockResolvedValue([])
    mocks.configuration.mockImplementation(async (key: string) => key === 'DEEPSEEK_THINKING_EFFORT' ? 'low' : key === 'DEEPSEEK_LOG_CACHE_HITS' ? 'false' : null)
  }
}
const openaiFrame = (value: Record<string, unknown>) => 'data: ' + JSON.stringify(value) + '\n\n'
const anthropicFrame = (type: string, value: Record<string, unknown> = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`
function wire(protocol: Protocol) {
  if (protocol === 'openai') return {
    first: openaiFrame({ id: 'wire-stream', model: configuredModel.modelId, choices: [{ index: 0, delta: { reasoning_content: privateReasoning }, finish_reason: null }] })
      + openaiFrame({ id: 'wire-stream', model: configuredModel.modelId, choices: [{ index: 0, delta: { content: 'First ' }, finish_reason: null }] }),
    tail: openaiFrame({ id: 'wire-stream', model: configuredModel.modelId, choices: [{ index: 0, delta: { content: 'answer.' }, finish_reason: null }] })
      + openaiFrame({ id: 'wire-stream', model: configuredModel.modelId, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
      // OpenAI sends usage after the stop choice, with no choices on that final frame.
      + openaiFrame({ id: 'wire-stream', model: configuredModel.modelId, choices: [], usage: { prompt_tokens: 30, completion_tokens: 12, total_tokens: 42 } })
      + 'data: [DONE]\n\n',
  }
  return {
    first: anthropicFrame('message_start', { message: { id: 'wire-stream', type: 'message', role: 'assistant', model: configuredModel.modelId,
      content: [], stop_reason: null, usage: { input_tokens: 30, output_tokens: 0 } } })
      + anthropicFrame('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } })
      + anthropicFrame('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: privateReasoning } })
      + anthropicFrame('content_block_stop', { index: 0 })
      + anthropicFrame('content_block_start', { index: 1, content_block: { type: 'text', text: '' } })
      + anthropicFrame('content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'First ' } })
      // The installed SDK 0.20 line decoder retains the final newline until
      // another line arrives (also covered by anthropic-usage-stream.test.ts).
      // A legal heartbeat flushes that frame while the provider remains open.
      + anthropicFrame('ping'),
    tail: anthropicFrame('content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'answer.' } })
      + anthropicFrame('content_block_stop', { index: 1 })
      + anthropicFrame('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } })
      + anthropicFrame('message_stop'),
  }
}
function installFetch(response: () => Response) {
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) })
    return response()
  }))
}
function call(args: Record<string, unknown> = {}) {
  return streamPluginCapability(access, 'fixture', { capability: 'ai.run', method: 'stream', expectedRevision: 1,
    args: { modelId: configuredModel.id, prompt: 'Review the selected messages.', systemPrompt: 'Evaluate only observed evidence.', ...args } }, event => { events.push(event) })
}

describe('plugin AI streaming over real configured provider adapters', () => {
  it.each(['openai', 'anthropic'] as const)('%s delivers its first public delta before EOF and retains final usage without exposing thinking', async protocol => {
    configure(protocol)
    const chunks = wire(protocol), encoder = new TextEncoder()
    let controller!: ReadableStreamDefaultController<Uint8Array>, closed = false, completed = false
    installFetch(() => new Response(new ReadableStream<Uint8Array>({
      start(value) { controller = value; controller.enqueue(encoder.encode(chunks.first)) },
      cancel() { closed = true },
    }), { headers: { 'content-type': 'text/event-stream' } }))
    const pending = call().then(value => { completed = true; return value })
    void pending.catch(() => undefined)
    try {
      await vi.waitFor(() => expect(events.some(event => event.type === 'text-delta')).toBe(true))
      expect(completed).toBe(false)
      expect(events.filter(event => event.type === 'text-delta')).toEqual([{ type: 'text-delta', text: 'First ' }])
      expect(events.some(event => event.type === 'complete')).toBe(false)
      expect(requests).toHaveLength(1)
    } finally {
      if (controller && !closed) { controller.enqueue(encoder.encode(chunks.tail)); controller.close(); closed = true }
    }
    expect(await pending).toEqual({ text: 'First answer.', model: configuredModel.modelId, usage: { inputTokens: 30, outputTokens: 12 } })
    expect(events.map(event => event.type)).toEqual(['started', 'text-delta', 'text-delta', 'complete'])
    expect(JSON.stringify(events)).not.toContain(privateReasoning)
    expect(JSON.stringify(events)).not.toContain(syntheticKey)
    const body = requests[0].body
    expect(body.stream).toBe(true)
    expect(body.model).toBe(configuredModel.modelId)
    const outputBudget = body[protocol === 'anthropic' ? 'max_tokens' : 'max_completion_tokens'] as number
    expect(outputBudget).toBeGreaterThan(4096)
    expect(outputBudget).toBeLessThan(24_000)
    if (protocol === 'anthropic') {
      expect(body.thinking).toEqual({ type: 'disabled' })
      expect(JSON.stringify(body.system)).toContain('Evaluate only observed evidence.')
    } else {
      expect(body.reasoning_effort).toBe('low')
      expect(body.stream_options).toMatchObject({ include_usage: true })
      expect(JSON.stringify(body.messages)).toContain('Evaluate only observed evidence.')
    }
  })

  it.each(['openai', 'anthropic'] as const)('%s preserves an explicit output budget through the streaming request path', async protocol => {
    configure(protocol)
    const chunks = wire(protocol)
    installFetch(() => new Response(chunks.first + chunks.tail, { headers: { 'content-type': 'text/event-stream' } }))
    expect(await call({ maxTokens: 1800 })).toMatchObject({ text: 'First answer.', usage: { inputTokens: 30, outputTokens: 12 } })
    expect(requests).toHaveLength(1)
    expect(requests[0].body[protocol === 'anthropic' ? 'max_tokens' : 'max_completion_tokens']).toBe(1800)
  })

  it('validates JSON response format after a streaming provider completes', async () => {
    configure('openai')
    const stream = openaiFrame({ id: 'json-stream', model: configuredModel.modelId, choices: [{ index: 0, delta: { content: '{\"ok\":true}' }, finish_reason: null }] })
      + openaiFrame({ id: 'json-stream', model: configuredModel.modelId, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 2 } })
      + 'data: [DONE]\n\n'
    installFetch(() => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }))
    await expect(call({ responseFormat: 'json' })).resolves.toMatchObject({ text: '{\"ok\":true}' })
  })
})
