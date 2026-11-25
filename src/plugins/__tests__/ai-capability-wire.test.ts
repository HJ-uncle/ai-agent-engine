import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invokePluginCapability, type CapabilityAccess } from '../capability-runtime.js'
import type { ModelConfig } from '../../storage/sqlite/models.js'

const mocks = vi.hoisted(() => ({ models: vi.fn(), whitelists: vi.fn(), configuration: vi.fn() }))
vi.mock('../../storage/sqlite/models.js', () => ({ ModelsStore: class { getModels = mocks.models; getWhitelists = mocks.whitelists } }))
vi.mock('../../storage/sqlite/system-config.js', () => ({ systemConfigStore: { get: mocks.configuration } }))

const model: ModelConfig = { id: 'configured-model', tenantId: 'fixture', provider: 'deepseek', modelId: 'deepseek-v4.1-flash',
  apiKey: 'synthetic-key-never-return', baseUrl: 'https://fixture.invalid/anthropic', apiFormat: 'anthropic', isEnabled: true,
  capabilities: { thinking: true, vision: true, contextWindow: 24_000 }, createdAt: 0, updatedAt: 0 }
const access: CapabilityAccess = { id: 'review', revision: 1, grants: ['ai.run'],
  manifest: { apiVersion: 1, id: 'review', name: 'Review', description: 'Review session', version: '1.0.0', runtime: 'node',
    tools: [{ name: 'review', description: 'Review', entry: 'main.mjs', inputSchema: {} }], permissions: { requested: ['ai.run'] } },
  getSettings: async () => ({}), setSettings: async value => value }
let requests: Array<Record<string, unknown>>
function response(content: unknown[], stopReason = 'end_turn', outputTokens = 12): Response {
  return Response.json({ id: 'synthetic-response', type: 'message', role: 'assistant', model: model.modelId, content,
    stop_reason: stopReason, stop_sequence: null, usage: { input_tokens: 30, output_tokens: outputTokens } })
}
function call(args: Record<string, unknown> = {}) {
  return invokePluginCapability(access, 'fixture', { capability: 'ai.run', method: 'run', expectedRevision: 1,
    args: { modelId: model.id, prompt: 'Review the selected messages.', ...args } })
}
beforeEach(() => {
  requests = []
  vi.stubEnv('LLM_FALLBACK_MODEL', '')
  mocks.models.mockResolvedValue([structuredClone(model)])
  mocks.whitelists.mockResolvedValue([{ modelId: model.modelId, thinkingMode: true,
    thinkingConfig: { thinking: { type: 'disabled' } }, responseThinkingField: 'thinking' }])
  mocks.configuration.mockResolvedValue(null)
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)); requests.push(body)
    // Deterministic replay of the observed gateway failure: the omitted SDK
    // options choose 4096, exhausted before any visible answer is produced.
    return body.max_tokens === 4096
      ? response([{ type: 'thinking', thinking: 'private synthetic reasoning' }], 'max_tokens', 4096)
      : response([{ type: 'text', text: 'Verified review.' }])
  }))
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetAllMocks() })

describe('plugin AI uses the configured model request path', () => {
  it('inherits the configured context window and thinking settings instead of silently using 4096', async () => {
    const result = await call()
    expect(requests).toHaveLength(1)
    expect(requests[0].max_tokens).toBeGreaterThan(4096)
    expect(requests[0].max_tokens).toBeLessThan(24_000)
    expect(requests[0].thinking).toEqual({ type: 'disabled' })
    expect(result).toMatchObject({ text: 'Verified review.', model: model.modelId })
    expect(JSON.stringify(result)).not.toContain('synthetic-key')
  })

  it('honors an explicit output budget without increasing it for reasoning', async () => {
    expect(await call({ maxTokens: 1800 })).toMatchObject({ text: 'Verified review.' })
    expect(requests[0].max_tokens).toBe(1800)
    expect(requests[0].thinking).toEqual({ type: 'disabled' })
  })

  it('applies per-call thinking and sampling parameters without changing saved model settings', async () => {
    expect(await call({ thinking: false, temperature: 0.2 })).toMatchObject({ text: 'Verified review.' })
    expect(requests[0].thinking).toEqual({ type: 'disabled' })
    expect(requests[0].temperature).toBe(0.2)
  })

  it('passes bounded multimodal content through the configured provider wire', async () => {
    await call({ prompt: undefined, messages: [{ role: 'user', content: [
      { type: 'text', text: '检查这张图' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw==', detail: 'low' } },
    ] }] })
    const user = (requests[0].messages as any[]).find((message: any) => message.role === 'user')
    expect(user.content).toEqual([
      { type: 'text', text: '检查这张图' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw==' } },
    ])
  })

  it('exposes safe model capabilities without credentials', async () => {
    const result = await invokePluginCapability({ ...access, grants: ['models.read'], manifest: { ...access.manifest, permissions: { requested: ['models.read'] } } }, 'fixture', {
      capability: 'models.read', method: 'list', expectedRevision: 1, args: {},
    }) as { models: Array<Record<string, unknown>> }
    expect(result.models[0]).toMatchObject({ id: model.id, modelId: model.modelId, capabilities: { thinking: true, contextWindow: 24_000 } })
    expect(result.models[0]).not.toHaveProperty('apiKey')
    expect(result.models[0]).not.toHaveProperty('baseUrl')
  })

  it('rejects a conflicting per-call thinking override before dispatch', async () => {
    await expect(call({ thinking: false, reasoningEffort: 'high' })).rejects.toMatchObject({ code: 'PLUGIN_ARGUMENTS', statusCode: 400 })
    expect(requests).toHaveLength(0)
  })

  it('enforces JSON response format even when a provider does not expose native JSON mode', async () => {
    await expect(call({ responseFormat: 'json' })).rejects.toMatchObject({ code: 'PLUGIN_AI_FORMAT', statusCode: 502 })
    vi.stubGlobal('fetch', vi.fn(async () => response([{ type: 'text', text: '{\"ok\":true}' }])))
    await expect(call({ responseFormat: 'json' })).resolves.toMatchObject({ text: '{\"ok\":true}' })
  })

  it('inherits the saved DeepSeek adapter configuration on the OpenAI protocol', async () => {
    mocks.models.mockResolvedValue([{ ...model, apiFormat: 'auto', baseUrl: 'https://fixture.invalid/v1' }])
    mocks.whitelists.mockResolvedValue([])
    mocks.configuration.mockImplementation(async (key: string) => key === 'DEEPSEEK_THINKING_EFFORT' ? 'low' : key === 'DEEPSEEK_LOG_CACHE_HITS' ? 'false' : null)
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)))
      return Response.json({ model: model.modelId, choices: [{ message: { content: 'Verified review.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 30, completion_tokens: 12 } })
    }))
    expect(await call()).toMatchObject({ text: 'Verified review.' })
    expect(requests[0].reasoning_effort).toBe('low')
    expect(requests[0].max_completion_tokens).toBeGreaterThan(4096)
    expect(requests[0].max_completion_tokens).toBeLessThan(24_000)
  })

  it('keeps input plus explicit output within the saved context window', async () => {
    await call({ maxTokens: 32_768, systemPrompt: 'Evaluate message accuracy.' })
    expect(requests[0].max_tokens).toBeLessThan(24_000)
    expect(requests[0].max_tokens).toBeGreaterThan(4096)
  })

  it.each([
    { stopReason: 'max_tokens', content: [{ type: 'thinking', thinking: 'private synthetic reasoning' }], code: 'PLUGIN_AI_OUTPUT_LIMIT' },
    { stopReason: 'max_tokens', content: [{ type: 'text', text: 'unfinished result' }], code: 'PLUGIN_AI_OUTPUT_LIMIT' },
    { stopReason: 'end_turn', content: [{ type: 'thinking', thinking: 'private synthetic reasoning' }], code: 'PLUGIN_AI_EMPTY' },
    { stopReason: 'end_turn', content: [{ type: 'text', text: ' \n ' }], code: 'PLUGIN_AI_EMPTY' },
  ])('rejects $code instead of returning a successful empty/partial report', async ({ stopReason, content, code }) => {
    vi.stubGlobal('fetch', vi.fn(async () => response(content, stopReason, 4096)))
    await expect(call()).rejects.toMatchObject({ code, statusCode: 502 })
  })

  it('rejects a disabled model before any provider request', async () => {
    mocks.models.mockResolvedValue([{ ...model, isEnabled: false }])
    await expect(call()).rejects.toMatchObject({ code: 'PLUGIN_MODEL' })
    expect(fetch).not.toHaveBeenCalled()
  })
})
