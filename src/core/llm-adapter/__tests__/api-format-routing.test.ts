/** Stored formats drive real SDK request paths; all fetches are local responses. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { createLLMAdapter, resolveAdapterOptionsWithDbConfig } from '../factory.js'
import { createAdapterFromResolved, resolveModelConfig } from '../resolve-model.js'
import type { ApiFormat } from '../protocol.js'
import type { AgentContext } from '../../agent-context/index.js'
import { describeImageWithVisionProxy } from '../../../tools/file/vision-proxy.js'

const mocks = vi.hoisted(() => ({ records: vi.fn(async (): Promise<unknown[]> => []), setting: vi.fn(async (_key: string): Promise<string | null> => null) }))
vi.mock('../../../storage/sqlite/models.js', () => ({ ModelsStore: class { getModels = mocks.records; async getWhitelists() { return [] } } }))
vi.mock('../../../storage/sqlite/system-config.js', () => ({ systemConfigStore: { get: mocks.setting } }))

beforeEach(() => {
  vi.stubEnv('LLM_FALLBACK_MODEL', '')
  mocks.records.mockReset().mockResolvedValue([])
  mocks.setting.mockReset().mockResolvedValue(null)
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks() })

function response(format: Exclude<ApiFormat, 'auto'>, stream: boolean): Response {
  if (!stream) return Response.json(format === 'anthropic'
    ? { id: 'message', type: 'message', role: 'assistant', model: 'fixture', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 1 } }
    : { id: 'message', choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } })
  const frames = format === 'anthropic' ? [
    { type: 'message_start', message: { id: 'message', type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: null, usage: { input_tokens: 3, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ] : [{ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }]
  return new Response(frames.map(frame => ('type' in frame ? `event: ${frame.type}\n` : '') + `data: ${JSON.stringify(frame)}\n\n`).join('')
    + (format === 'openai' ? 'data: [DONE]\n\n' : ''), { headers: { 'content-type': 'text/event-stream' } })
}

describe('explicit API format routing', () => {
  it.each([
    { apiFormat: 'openai' as const, provider: 'anthropic', model: 'deepseek-chat', baseUrl: 'https://fixture.invalid/gateway/anthropic' },
    { apiFormat: 'openai' as const, provider: 'ollama', model: 'qwen3', baseUrl: 'https://fixture.invalid/custom' },
    { apiFormat: 'anthropic' as const, provider: 'deepseek', model: 'deepseek-chat', baseUrl: 'https://fixture.invalid/custom' },
    { apiFormat: 'anthropic' as const, provider: 'qwen', model: 'qwen3', baseUrl: 'https://fixture.invalid/v2/proxy' },
  ])('$apiFormat overrides $provider and URL/model inference for complete and stream', async config => {
    const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      requests.push({ url: String(url), headers: new Headers(init?.headers), body })
      return response(config.apiFormat, body.stream === true)
    }))
    const adapter = createLLMAdapter({ ...config, apiKey: 'synthetic-test-key' })
    expect(adapter.provider).toBe(config.apiFormat)
    expect((await adapter.complete([{ role: 'user', content: 'hello' }])).content).toBe('ok')
    let streamed = ''
    for await (const chunk of adapter.stream([{ role: 'user', content: 'hello' }])) streamed += chunk.content ?? ''
    expect(streamed).toBe('ok')
    expect(requests).toHaveLength(2)
    for (const request of requests) {
      expect(request.url).toContain(config.baseUrl)
      expect(new URL(request.url).pathname.endsWith(config.apiFormat === 'anthropic' ? '/v1/messages' : '/chat/completions')).toBe(true)
      expect(request.body.model).toBe(config.model)
      expect(request.body).not.toHaveProperty('apiFormat')
      expect(request.headers.get(config.apiFormat === 'anthropic' ? 'x-api-key' : 'authorization')).toBe(config.apiFormat === 'anthropic' ? 'synthetic-test-key' : 'Bearer synthetic-test-key')
    }
  })

  it.each([
    ['deepseek', 'deepseek-chat', 'https://fixture.invalid/anthropic', 'anthropic'],
    ['ollama', 'qwen3', 'https://fixture.invalid', 'ollama'],
    ['qwen', 'qwen3', 'https://fixture.invalid', 'qwen'],
    ['deepseek', 'deepseek-chat', 'https://fixture.invalid', 'deepseek'],
  ])('auto preserves %s routing to %s', (provider, model, baseUrl, expected) => {
    expect(createLLMAdapter({ provider, model, baseUrl, apiKey: 'fixture-key', apiFormat: 'auto' }).provider).toBe(expected)
  })

  it('uses protocol-specific default credentials only when connection overrides are omitted', async () => {
    mocks.setting.mockImplementation(async key => ({ OPENAI_API_KEY: 'openai-key', OPENAI_BASE_URL: 'https://openai.invalid', ANTHROPIC_API_KEY: 'anthropic-key', ANTHROPIC_BASE_URL: 'https://anthropic.invalid' }[key] ?? null))
    expect(await resolveAdapterOptionsWithDbConfig({ provider: 'anthropic', model: 'deepseek-chat', apiFormat: 'openai' })).toMatchObject({ apiFormat: 'openai', apiKey: 'openai-key', baseUrl: 'https://openai.invalid' })
    expect(await resolveAdapterOptionsWithDbConfig({ provider: 'deepseek', model: 'qwen3', apiFormat: 'anthropic' })).toMatchObject({ apiFormat: 'anthropic', apiKey: 'anthropic-key', baseUrl: 'https://anthropic.invalid' })
  })

  it('preserves stored formats through primary resolution, child inheritance/model changes, and explicit auto reset', async () => {
    mocks.records.mockResolvedValue([
      { id: 'parent-id', modelId: 'parent-model', provider: 'custom', baseUrl: 'https://parent.invalid', apiKey: 'parent-key', isEnabled: true, apiFormat: 'anthropic' },
      { id: 'child-id', modelId: 'child-model', provider: 'anthropic', baseUrl: 'https://child.invalid/anthropic', apiKey: 'child-key', isEnabled: true, apiFormat: 'openai' },
    ])
    const parent = await resolveModelConfig({ tenantId: 'fixture', model: 'parent-id', overrides: { apiFormat: undefined } })
    expect(parent.apiFormat).toBe('anthropic')
    expect(createAdapterFromResolved(parent).provider).toBe('anthropic')
    expect(await resolveModelConfig({ tenantId: 'fixture', model: parent.model, parent })).toBe(parent)
    const child = await resolveModelConfig({ tenantId: 'fixture', model: 'child-model', parent })
    expect(child).toMatchObject({ apiFormat: 'openai', apiKey: 'child-key', baseUrl: 'https://child.invalid/anthropic' })
    expect(createAdapterFromResolved(child).provider).toBe('openai')
    const reset = await resolveModelConfig({ tenantId: 'fixture', model: 'child-model', overrides: { apiFormat: 'auto' } })
    expect(createAdapterFromResolved(reset).provider).toBe('anthropic')
  })

  it('vision proxy uses the utility model saved protocol, key, endpoint and capability override', async () => {
    mocks.records.mockResolvedValue([{ id: 'vision-id', modelId: 'custom-vision-model', provider: 'custom',
      baseUrl: 'https://vision.invalid/custom', apiKey: 'vision-key', apiFormat: 'anthropic',
      isEnabled: true, capabilities: { vision: true } }])
    const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
      requests.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) })
      return response('anthropic', false)
    }))
    const fixtureRoot = resolve('.e2e-tmp')
    mkdirSync(fixtureRoot, { recursive: true })
    const fixture = mkdtempSync(join(fixtureRoot, 'api-format-vision-'))
    try {
      const imagePath = join(fixture, 'pixel.png')
      writeFileSync(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64'))
      const ctx = { tenantId: 'fixture', utilityModel: 'custom-vision-model', logger: { info: vi.fn(), error: vi.fn() } } as unknown as AgentContext
      expect(await describeImageWithVisionProxy(imagePath, ctx)).toMatchObject({ success: true })
      expect(requests).toHaveLength(1)
      expect(requests[0].url).toBe('https://vision.invalid/custom/v1/messages')
      expect(requests[0].headers.get('x-api-key')).toBe('vision-key')
      expect(requests[0].body.model).toBe('custom-vision-model')
      expect(JSON.stringify(requests[0].body.messages)).toContain('"type":"image"')
    } finally {
      if (dirname(fixture) !== fixtureRoot || !basename(fixture).startsWith('api-format-vision-')) throw new Error('Unsafe fixture cleanup')
      rmSync(fixture, { recursive: true, force: true })
    }
  })
})
