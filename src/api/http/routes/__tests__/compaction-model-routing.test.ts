import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDb, getDb, initDb } from '../../../../storage/sqlite/db.js'
import { ModelsStore } from '../../../../storage/sqlite/models.js'
import { createConversationHistory } from '../../../../storage/conversation/factory.js'
import { rootRunStore } from '../../../../storage/root-runs/index.js'
import { resolveModelConfig, type ResolvedModelConfig } from '../../../../core/llm-adapter/resolve-model.js'
import { estimateRequestInput } from '../../../../core/agent-loop/finalization.js'
import { autoCompactSession, conversationRoutes } from '../conversation.js'

// These are synthetic credentials in Vitest's isolated database, never operator settings.
vi.hoisted(() => { process.env.ENCRYPTION_KEY = 'c7'.repeat(32) })
beforeAll(async () => { await initDb() })
afterAll(() => { closeDb() })

interface WireRequest { url: string; headers: Headers; body: Record<string, unknown> }
let app: FastifyInstance
let history: ReturnType<typeof createConversationHistory>
let requests: WireRequest[]
let fixture = 0
let tenantId: string
let sessionId: string
let rejectSummary: boolean

beforeEach(async () => {
  fixture++
  tenantId = `compaction-routing-tenant-${fixture}`
  sessionId = `compaction-routing-session-${fixture}`
  requests = []
  rejectSummary = false
  for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY', 'DASHSCOPE_API_KEY', 'QWEN_API_KEY',
    'OPENAI_BASE_URL', 'ANTHROPIC_BASE_URL', 'DEEPSEEK_BASE_URL', 'QWEN_BASE_URL', 'LLM_FALLBACK_MODEL', 'LLM_SUMMARIZE_MODEL']) vi.stubEnv(key, '')
  vi.stubEnv('LLM_PROVIDER', 'openai')
  vi.stubEnv('LLM_PRIMARY_MODEL', 'gpt-4o-mini')
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : undefined
    const url = request?.url ?? String(input)
    const headers = new Headers(init?.headers ?? request?.headers)
    const content = init?.body ?? await request?.clone().text()
    const body = JSON.parse(String(content)) as Record<string, unknown>
    requests.push({ url, headers, body })
    if (rejectSummary) return new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Synthetic summary unavailable' } }),
      { status: 400, headers: { 'content-type': 'application/json' } })
    const model = String(body.model)
    const payload = url.includes('/messages')
      ? { id: 'fixture-summary', type: 'message', role: 'assistant', model, content: [{ type: 'text', text: '<summary>Verified retained requirements.</summary>' }],
        stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 39, output_tokens: 8 } }
      : { id: 'fixture-summary', object: 'chat.completion', created: 1, model,
        choices: [{ index: 0, message: { role: 'assistant', content: '<summary>Verified retained requirements.</summary>' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 39, completion_tokens: 8, total_tokens: 47 } }
    return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } })
  }))
  history = createConversationHistory()
  app = Fastify()
  app.decorateRequest('authContext', null)
  app.addHook('onRequest', async request => {
    Object.assign(request, { authContext: { tenantId: request.headers['x-test-tenant'] ?? tenantId } })
  })
  await app.register(conversationRoutes)
})

afterEach(async () => {
  await app.close()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

async function prepareHistory(modelId?: string, selectedTenant = tenantId): Promise<void> {
  for (let index = 0; index < 8; index++) await history.append({ id: `${selectedTenant}-${index}`, role: index % 2 ? 'assistant' : 'user',
    content: `Preserve requirement ${index}: implement and verify the fixture. `.repeat(24), ...(index % 2 && modelId ? { modelId } : {}) },
  { tenantId: selectedTenant, sessionId })
}

async function savedModel(modelId: string, provider: string, baseUrl: string, apiKey: string, selectedTenant = tenantId): Promise<void> {
  const record = await new ModelsStore().createModel({ tenantId: selectedTenant, modelId, provider, baseUrl, apiKey, isEnabled: true,
    capabilities: { contextWindow: 128_000 } })
  const encrypted = await getDb().execute({ sql: 'SELECT api_key FROM models WHERE id=?', args: [record.id] })
  expect(encrypted.rows[0].api_key).not.toBe(apiKey)
  expect(record.apiKey).toBe(apiKey)
}

async function compress(parent?: ResolvedModelConfig, selectedTenant = tenantId) {
  return autoCompactSession(selectedTenant, sessionId, { info: vi.fn() }, parent)
}

describe('compaction uses the selected model connection', () => {
  it('decrypts the tenant DeepSeek model and preserves its Anthropic-compatible endpoint and headers without OPENAI_API_KEY', async () => {
    const model = 'deepseek-v4.1-flash'
    await savedModel(model, 'deepseek', 'https://fixture.invalid/apps/anthropic', 'synthetic-deepseek-key')
    await prepareHistory()
    const tokensBefore = estimateRequestInput(await history.getFullHistory({ tenantId, sessionId }), undefined, [])
    const parent = await resolveModelConfig({ tenantId, model, overrides: { extraHeaders: { 'X-Access-Token': 'synthetic-gateway-header' } } })
    expect(parent.apiKey).toBe('synthetic-deepseek-key')
    await compress(parent)
    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe('https://fixture.invalid/apps/anthropic/v1/messages')
    // Token-plan gateways deliberately remove the SDK's duplicate API-key auth header.
    expect(requests[0].headers.get('x-api-key')).toBeNull()
    expect(requests[0].headers.get('x-access-token')).toBe('synthetic-gateway-header')
    expect(requests[0].body.model).toBe(model)
    expect((await history.getFullHistory({ tenantId, sessionId }))[0].content).toContain('Verified retained requirements.')
    expect(estimateRequestInput(await history.getFullHistory({ tenantId, sessionId }), undefined, [])).toBeLessThan(tokensBefore)
  })

  it('uses the selected OpenAI-compatible model record instead of global OpenAI credentials', async () => {
    const model = 'fixture-openai-model'
    await savedModel(model, 'custom', 'https://openai-fixture.invalid/v1', 'synthetic-openai-key')
    await prepareHistory(model)
    await compress()
    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe('https://openai-fixture.invalid/v1/chat/completions')
    expect(requests[0].headers.get('authorization')).toBe('Bearer synthetic-openai-key')
    expect(requests[0].body.model).toBe(model)
  })

  it('lets a changed composer model and request credentials override a prior run and stale database connection', async () => {
    await savedModel('previous-model', 'custom', 'https://previous.invalid/v1', 'synthetic-previous-key')
    await savedModel('next-model', 'custom', 'https://stale.invalid/v1', 'synthetic-stale-key')
    await prepareHistory('previous-model')
    const run = await rootRunStore.create(tenantId, sessionId, 'previous-model', [], { model: 'previous-model' })
    await rootRunStore.update(tenantId, run.runId, { status: 'succeeded' })
    const parent = await resolveModelConfig({ tenantId, model: 'next-model', overrides: { apiKey: 'synthetic-current-key',
      baseUrl: 'https://current.invalid/v1', provider: 'custom', extraHeaders: { 'X-Fixture': 'current-header' } } })
    await compress(parent)
    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe('https://current.invalid/v1/chat/completions')
    expect(requests[0].headers.get('authorization')).toBe('Bearer synthetic-current-key')
    expect(requests[0].headers.get('x-fixture')).toBe('current-header')
    expect(requests[0].body.model).toBe('next-model')
    expect(JSON.stringify(await history.getFullHistory({ tenantId, sessionId }))).not.toContain('synthetic-current-key')
  })

  it('recovers the latest root model and stored non-secret endpoint when no in-memory connection is available', async () => {
    await savedModel('old-run-model', 'custom', 'https://old-run.invalid/v1', 'synthetic-old-run-key')
    await savedModel('latest-run-model', 'custom', 'https://db-latest.invalid/v1', 'synthetic-latest-key')
    await prepareHistory('old-run-model')
    const oldRun = await rootRunStore.create(tenantId, sessionId, 'old-run-model', [], {})
    await rootRunStore.update(tenantId, oldRun.runId, { status: 'succeeded' })
    const latestRun = await rootRunStore.create(tenantId, sessionId, 'latest-run-model', [], {
      modelBaseUrl: 'https://request-latest.invalid/v1', modelProvider: 'custom', modelApiKey: 'must-not-persist' })
    await rootRunStore.update(tenantId, latestRun.runId, { status: 'succeeded' })
    expect((await rootRunStore.get(tenantId, latestRun.runId))?.request).not.toHaveProperty('modelApiKey')
    await compress()
    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe('https://request-latest.invalid/v1/chat/completions')
    expect(requests[0].headers.get('authorization')).toBe('Bearer synthetic-latest-key')
    expect(requests[0].body.model).toBe('latest-run-model')
  })

  it('finds the last assistant model in legacy history without root runs', async () => {
    await savedModel('legacy-model', 'custom', 'https://legacy.invalid/v1', 'synthetic-legacy-key')
    await prepareHistory('legacy-model')
    await compress()
    expect(requests[0].url).toBe('https://legacy.invalid/v1/chat/completions')
    expect(requests[0].body.model).toBe('legacy-model')
  })

  it('resolves the authenticated tenant connection when another tenant has the same model ID', async () => {
    const otherTenant = `${tenantId}-other`
    await savedModel('shared-model-name', 'custom', 'https://tenant-a.invalid/v1', 'synthetic-tenant-a-key')
    await savedModel('shared-model-name', 'custom', 'https://tenant-b.invalid/v1', 'synthetic-tenant-b-key', otherTenant)
    await prepareHistory('shared-model-name', otherTenant)
    await compress(undefined, otherTenant)
    expect(requests[0].url).toBe('https://tenant-b.invalid/v1/chat/completions')
    expect(requests[0].headers.get('authorization')).toBe('Bearer synthetic-tenant-b-key')
    expect(await history.getFullHistory({ tenantId, sessionId })).toEqual([])
  })

  it('preserves the original model history and full archive when the selected provider rejects compression', async () => {
    await savedModel('failure-model', 'custom', 'https://failure.invalid/v1', 'synthetic-failure-key')
    await prepareHistory('failure-model')
    const ctx = { tenantId, sessionId }
    const before = await history.getFullHistory(ctx)
    const archiveBefore = (await history.getArchive!(ctx)).messages
    rejectSummary = true
    await expect(compress()).rejects.toThrow('Synthetic summary unavailable')
    expect(requests).toHaveLength(1)
    expect(await history.getFullHistory(ctx)).toEqual(before)
    expect((await history.getArchive!(ctx)).messages).toEqual(archiveBefore)
  })

  it('background compression reuses the active resolved connection and gateway headers in memory', async () => {
    await prepareHistory()
    const parent: ResolvedModelConfig = { model: 'in-memory-model', provider: 'custom', apiKey: 'synthetic-parent-key',
      baseUrl: 'https://parent.invalid/v1', extraHeaders: { 'X-Parent-Token': 'synthetic-parent-header' }, capabilities: { contextWindow: 128_000 } }
    await autoCompactSession(tenantId, sessionId, { info: vi.fn() }, parent)
    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe('https://parent.invalid/v1/chat/completions')
    expect(requests[0].headers.get('authorization')).toBe('Bearer synthetic-parent-key')
    expect(requests[0].headers.get('x-parent-token')).toBe('synthetic-parent-header')
    expect(requests[0].body.model).toBe('in-memory-model')
  })

  it('a dedicated summarizer uses its own saved connection without inheriting another model credential', async () => {
    await savedModel('dedicated-summarizer', 'custom', 'https://dedicated.invalid/v1', 'synthetic-dedicated-key')
    await prepareHistory()
    vi.stubEnv('LLM_SUMMARIZE_MODEL', 'dedicated-summarizer')
    const parent: ResolvedModelConfig = { model: 'main-model', provider: 'anthropic', apiKey: 'synthetic-main-key',
      baseUrl: 'https://main.invalid/anthropic', extraHeaders: { 'X-Main-Token': 'must-not-inherit' }, capabilities: { contextWindow: 128_000 } }
    await autoCompactSession(tenantId, sessionId, { info: vi.fn() }, parent)
    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe('https://dedicated.invalid/v1/chat/completions')
    expect(requests[0].headers.get('authorization')).toBe('Bearer synthetic-dedicated-key')
    expect(requests[0].headers.get('x-main-token')).toBeNull()
    expect(requests[0].body.model).toBe('dedicated-summarizer')
  })

  it('removes the old manual compression endpoint without changing history or making a provider request', async () => {
    await prepareHistory()
    const before = await history.getFullHistory({ tenantId, sessionId })
    const response = await app.inject({ method: 'POST', url: `/conversation/compress?sessionId=${sessionId}` })
    expect(response.statusCode).toBe(404)
    expect(requests).toHaveLength(0)
    expect(await history.getFullHistory({ tenantId, sessionId })).toEqual(before)
  })
})
