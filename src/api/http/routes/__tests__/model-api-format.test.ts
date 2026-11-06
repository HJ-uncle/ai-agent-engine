/** Real SQLite + Fastify API-format persistence and test-request contracts; no external LLM calls. */
import Fastify, { type FastifyInstance } from 'fastify'
import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as database from '../../../../storage/sqlite/db.js'
import { ModelsStore, type ModelConfig } from '../../../../storage/sqlite/models.js'
import { up as modelSchema } from '../../../../storage/sqlite/migrations/007_add_models_management.js'
import { up as capabilitySchema } from '../../../../storage/sqlite/migrations/014_add_model_capabilities.js'
import { up as apiFormatSchema } from '../../../../storage/sqlite/migrations/032_add_model_api_format.js'
import { encrypt } from '../../../../utils/encryption.js'
import { modelsRoutes } from '../models.js'

const mocks = vi.hoisted(() => {
  process.env.ENCRYPTION_KEY = 'a1'.repeat(32)
  const complete = vi.fn(async () => ({
    content: 'hello', promptTokens: 1, completionTokens: 1, finishReason: 'stop' as const,
  }))
  return { complete, createAdapter: vi.fn(() => ({ complete })) }
})
vi.mock('../../../../core/llm-adapter/factory.js', () => ({ createLLMAdapter: mocks.createAdapter }))

let db: Client
let app: FastifyInstance
let store: ModelsStore
let id: string
const savedKey = 'synthetic-api-format-key-1234'
const connection = {
  provider: 'custom', modelId: 'gpt-4o-fixture', apiKey: savedKey,
  baseUrl: 'https://example.com/original-gateway',
}

beforeEach(async () => {
  mocks.createAdapter.mockClear()
  mocks.complete.mockClear()
  db = createClient({ url: 'file::memory:' })
  vi.spyOn(database, 'getDb').mockReturnValue(db)
  await modelSchema(db)
  await capabilitySchema(db)
  // Insert before the new migration so compatibility is checked against a real legacy row.
  await db.execute({
    sql: 'INSERT INTO models (id, tenant_id, provider, model_id, api_key, base_url) VALUES (?, ?, ?, ?, ?, ?)',
    args: ['legacy-format-model', 'default', 'custom', 'legacy-model', encrypt(savedKey), connection.baseUrl],
  })
  await apiFormatSchema(db)
  store = new ModelsStore()
  const model = await store.createModel({
    ...connection, tenantId: 'default', isEnabled: true, apiFormat: 'anthropic',
    displayName: 'Saved format', capabilities: { vision: false, contextWindow: 256000 },
  })
  id = model.id
  app = Fastify()
  app.decorateRequest('authContext', null)
  app.addHook('onRequest', async (request) => {
    Object.assign(request, { authContext: { method: 'jwt', roles: ['admin'], tenantId: 'default' } })
  })
  await app.register(modelsRoutes)
})

afterEach(async () => {
  await app?.close()
  vi.restoreAllMocks()
  db?.close()
})

function create(payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST', url: '/api/v1/models',
    payload: { ...connection, modelId: 'created-format-model', ...payload },
  })
}

function patch(payload: Record<string, unknown>) {
  return app.inject({ method: 'PUT', url: `/api/v1/models/${id}`, payload })
}

async function listed(modelId: string): Promise<ModelConfig | undefined> {
  const response = await app.inject('/api/v1/models')
  expect(response.statusCode).toBe(200)
  return (response.json().data as ModelConfig[]).find(model => model.id === modelId)
}

describe('model API format', () => {
  it('migrates an existing row to auto without changing its credentials', async () => {
    expect(await listed('legacy-format-model')).toMatchObject({ apiFormat: 'auto', apiKey: '...1234' })
    expect(await store.getModelById('legacy-format-model', 'default')).toMatchObject({
      apiFormat: 'auto', apiKey: savedKey, baseUrl: connection.baseUrl,
    })
  })

  it.each(['auto', 'openai', 'anthropic'] as const)('persists and reads an explicitly created %s format', async apiFormat => {
    const response = await create({ apiFormat })
    expect(response.statusCode).toBe(200)
    const created = response.json().data as ModelConfig
    expect(created).toMatchObject({ apiFormat, apiKey: '...1234', provider: 'custom' })
    expect(await listed(created.id)).toMatchObject({ apiFormat })
    expect(await store.getModelById(created.id, 'default')).toMatchObject({ apiFormat, apiKey: savedKey })
  })

  it.each([{}, { apiFormat: null }, { apiFormat: '' }])('normalizes a default create input %j to auto', async input => {
    const response = await create(input)
    expect(response.statusCode).toBe(200)
    expect(response.json().data.apiFormat).toBe('auto')
    expect((await store.getModelById(response.json().data.id, 'default'))?.apiFormat).toBe('auto')
  })

  it('preserves an omitted format and changes only the selected connection field', async () => {
    const renamed = await patch({ displayName: 'Renamed' })
    expect(renamed.statusCode).toBe(200)
    expect(renamed.json().data.apiFormat).toBe('anthropic')
    const changed = await patch({ apiFormat: 'openai' })
    expect(changed.statusCode).toBe(200)
    expect(await listed(id)).toMatchObject({ apiFormat: 'openai', displayName: 'Renamed' })
    expect(await store.getModelById(id, 'default')).toMatchObject({
      ...connection, apiFormat: 'openai', displayName: 'Renamed',
      capabilities: { vision: false, contextWindow: 256000 },
    })
  })

  it.each([null, '', 'auto'])('resets an explicit saved format using %j', async apiFormat => {
    const response = await patch({ apiFormat })
    expect(response.statusCode).toBe(200)
    expect(response.json().data.apiFormat).toBe('auto')
    expect((await store.getModelById(id, 'default'))?.apiFormat).toBe('auto')
  })

  it('restores a deleted identity with the new format rather than the tombstone format', async () => {
    await store.deleteModel(id, 'default')
    const response = await create({ modelId: connection.modelId, apiFormat: 'openai' })
    expect(response.statusCode).toBe(200)
    expect(response.json().data).toMatchObject({ id, apiFormat: 'openai' })
    expect((await store.getModelById(id, 'default'))?.apiFormat).toBe('openai')
  })

  it('tests a temporary model using its explicitly selected format', async () => {
    const temporary = { ...connection, provider: 'deepseek', modelId: 'deepseek-chat', apiFormat: 'anthropic' }
    const response = await app.inject({ method: 'POST', url: '/api/v1/models/new/test', payload: temporary })
    expect(response.statusCode).toBe(200)
    expect(response.json().data.success).toBe(true)
    expect(mocks.createAdapter).toHaveBeenCalledOnce()
    expect(mocks.createAdapter).toHaveBeenLastCalledWith(expect.objectContaining({
      provider: temporary.provider, model: temporary.modelId, baseUrl: temporary.baseUrl,
      apiKey: savedKey, apiFormat: 'anthropic',
    }))
    expect(await store.getModels('default')).toHaveLength(2)
  })

  it('tests a saved model with its stored format and decrypted key', async () => {
    const response = await app.inject({ method: 'POST', url: `/api/v1/models/${id}/test` })
    expect(response.statusCode).toBe(200)
    expect(response.json().data.success).toBe(true)
    expect(mocks.createAdapter).toHaveBeenLastCalledWith(expect.objectContaining({
      provider: connection.provider, model: connection.modelId, baseUrl: connection.baseUrl,
      apiKey: savedKey, apiFormat: 'anthropic',
    }))
  })

  it('tests current unsaved connection choices while reusing the saved key', async () => {
    const response = await app.inject({
      method: 'POST', url: `/api/v1/models/${id}/test`,
      payload: { provider: 'anthropic', modelId: 'different-model', baseUrl: 'https://example.com/anthropic', apiFormat: 'openai' },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().data.success).toBe(true)
    expect(mocks.createAdapter).toHaveBeenLastCalledWith(expect.objectContaining({
      provider: 'anthropic', model: 'different-model', baseUrl: 'https://example.com/anthropic',
      apiKey: savedKey, apiFormat: 'openai',
    }))
    expect(await store.getModelById(id, 'default')).toMatchObject({ ...connection, apiFormat: 'anthropic' })
  })

  it.each([null, ''])('resets a temporary test format with %j without changing the stored format', async apiFormat => {
    const response = await app.inject({ method: 'POST', url: `/api/v1/models/${id}/test`, payload: { apiFormat } })
    expect(response.statusCode).toBe(200)
    expect(response.json().data.success).toBe(true)
    expect(mocks.createAdapter).toHaveBeenLastCalledWith(expect.objectContaining({ apiFormat: 'auto', apiKey: savedKey }))
    expect((await store.getModelById(id, 'default'))?.apiFormat).toBe('anthropic')
  })

  it.each(['responses', 'OpenAI', true, 1, {}, []])('rejects invalid format %j before writes or provider calls', async apiFormat => {
    const created = await create({ apiFormat })
    const updated = await patch({ apiFormat, displayName: 'must-not-save' })
    const tested = await app.inject({ method: 'POST', url: `/api/v1/models/${id}/test`, payload: { apiFormat } })
    const temporary = await app.inject({ method: 'POST', url: '/api/v1/models/new/test', payload: { ...connection, apiFormat } })
    const detected = await app.inject({
      method: 'POST', url: '/api/v1/models/detect-capabilities',
      payload: { provider: 'custom', modelId: 'gpt-4o', apiFormat },
    })
    for (const response of [created, updated, tested, temporary, detected]) expect(response.statusCode).toBe(400)
    expect(mocks.createAdapter).not.toHaveBeenCalled()
    expect(mocks.complete).not.toHaveBeenCalled()
    expect(await store.getModels('default')).toHaveLength(2)
    expect(await store.getModelById(id, 'default')).toMatchObject({ apiFormat: 'anthropic', displayName: 'Saved format' })
  })

  it('resolves capabilities for the selected format instead of native Ollama when explicitly overridden', async () => {
    const detect = (apiFormat: string) => app.inject({
      method: 'POST', url: '/api/v1/models/detect-capabilities',
      payload: { provider: 'ollama', modelId: 'gpt-4o', baseUrl: 'https://example.com/gateway', apiFormat },
    })
    const automatic = await detect('auto')
    expect(automatic.statusCode).toBe(200)
    expect(automatic.json().data).toMatchObject({ vision: false, toolCalling: false })
    for (const apiFormat of ['openai', 'anthropic']) {
      const explicit = await detect(apiFormat)
      expect(explicit.statusCode).toBe(200)
      expect(explicit.json().data).toMatchObject({ vision: true, toolCalling: true })
    }
    const created = await create({ provider: 'ollama', modelId: 'gpt-4o', apiFormat: 'openai' })
    expect(created.statusCode).toBe(200)
    expect(created.json().data.resolvedCapabilities).toMatchObject({ vision: true, toolCalling: true })
    expect(mocks.createAdapter).not.toHaveBeenCalled()
  })
})
