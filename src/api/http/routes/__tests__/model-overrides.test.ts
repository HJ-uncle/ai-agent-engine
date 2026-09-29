// Real Fastify + SQLite contracts. Only the database location and unused LLM factory are substituted.
import Fastify, { type FastifyInstance } from 'fastify'
import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as database from '../../../../storage/sqlite/db.js'
import { ModelsStore } from '../../../../storage/sqlite/models.js'
import { up as modelSchema } from '../../../../storage/sqlite/migrations/007_add_models_management.js'
import { up as capabilitySchema } from '../../../../storage/sqlite/migrations/014_add_model_capabilities.js'
import { modelsRoutes } from '../models.js'

vi.hoisted(() => { process.env.ENCRYPTION_KEY = 'a1'.repeat(32) })
vi.mock('../../../../core/llm-adapter/factory.js', () => ({ createLLMAdapter: vi.fn() }))
let db: Client
let app: FastifyInstance
let store: ModelsStore
let id: string
const overrides = { vision: false, thinking: true, parallelTools: false, contextWindow: 123456 }

beforeEach(async () => {
  db = createClient({ url: 'file::memory:' })
  vi.spyOn(database, 'getDb').mockReturnValue(db)
  await modelSchema(db)
  await capabilitySchema(db)
  store = new ModelsStore()
  const model = await store.createModel({ tenantId: 'default', provider: 'openai', modelId: 'gpt-4o',
    apiKey: 'synthetic-key-only-1234', baseUrl: 'https://example.com/v1', displayName: 'Before',
    isEnabled: true, capabilities: overrides })
  id = model.id
  app = Fastify()
  app.decorateRequest('authContext', null)
  app.addHook('onRequest', async (request) => {
    Object.assign(request, { authContext: { method: 'jwt', roles: ['admin'], tenantId: request.headers['x-tenant'] ?? 'default' } })
  })
  await app.register(modelsRoutes)
})
afterEach(async () => { await app.close(); vi.restoreAllMocks(); db.close() })

async function patch(body: unknown) {
  return app.inject({ method: 'PUT', url: `/api/v1/models/${id}`, payload: body as Record<string, unknown> })
}

describe('D1 model capability updates', () => {
  it('renames without writing inferred capabilities or losing persisted overrides', async () => {
    const listed = (await app.inject('/api/v1/models')).json().data[0]
    expect(listed.capabilityOverrides).toEqual(overrides)
    expect(listed.resolvedCapabilities).toMatchObject({ ...overrides, toolCalling: true })
    expect(listed.capabilities).toEqual(listed.resolvedCapabilities)
    expect(listed.apiKey).toBe('...1234')
    const response = await patch({ displayName: 'After' })
    expect(response.statusCode).toBe(200)
    expect(response.json().data.capabilityOverrides).toEqual(overrides)
    expect((await store.getModelById(id, 'default'))?.capabilities).toEqual(overrides)
  })

  it('updates one override and preserves unknown stored keys and encrypted credentials', async () => {
    await db.execute({ sql: 'UPDATE models SET capabilities = ? WHERE id = ?', args: [JSON.stringify({ ...overrides, futureCapability: { mode: 'keep' } }), id] })
    const before = (await db.execute({ sql: 'SELECT api_key FROM models WHERE id = ?', args: [id] })).rows[0].api_key
    const response = await patch({ capabilityOverrides: { thinking: false } })
    expect(response.statusCode).toBe(200)
    expect(response.json().data.capabilityOverrides).toEqual({ ...overrides, thinking: false, futureCapability: { mode: 'keep' } })
    expect((await db.execute({ sql: 'SELECT api_key FROM models WHERE id = ?', args: [id] })).rows[0].api_key).toBe(before)
  })

  it('distinguishes omission, per-key null, whole null, and explicit false', async () => {
    await patch({ capabilityOverrides: {} })
    expect((await store.getModelById(id, 'default'))?.capabilities).toEqual(overrides)
    const inherited = await patch({ capabilityOverrides: { vision: null } })
    expect(inherited.json().data.capabilityOverrides).toEqual({ thinking: true, parallelTools: false, contextWindow: 123456 })
    expect(inherited.json().data.resolvedCapabilities.vision).toBe(true)
    const explicit = await patch({ capabilityOverrides: { vision: false } })
    expect(explicit.json().data.resolvedCapabilities.vision).toBe(false)
    const reset = await patch({ capabilityOverrides: null })
    expect(reset.json().data.capabilityOverrides).toBeNull()
    expect(reset.json().data.resolvedCapabilities.vision).toBe(true)
    expect((await store.getModelById(id, 'default'))?.capabilities).toBeNull()
  })

  it('merges independent concurrent store edits instead of last-writer replacement', async () => {
    await Promise.all([
      store.updateModel(id, 'default', { capabilityOverrides: { vision: true } }),
      store.updateModel(id, 'default', { capabilityOverrides: { thinking: false } }),
    ])
    expect((await store.getModelById(id, 'default'))?.capabilities).toEqual({ ...overrides, vision: true, thinking: false })
  })

  it('keeps legacy write alias partial and rejects ambiguous aliases', async () => {
    expect((await patch({ capabilities: { thinking: false } })).json().data.capabilityOverrides).toEqual({ ...overrides, thinking: false })
    expect((await patch({ capabilities: {}, capabilityOverrides: null })).statusCode).toBe(400)
  })

  it.each([{ vision: 'false' }, { contextWindow: 0 }, { contextWindow: 1.5 }, { unknown: true }, [], true])('rejects invalid patch %j before changing model', async (capabilityOverrides) => {
    expect((await patch({ displayName: 'must-not-save', capabilityOverrides })).statusCode).toBe(400)
    expect((await store.getModelById(id, 'default'))?.displayName).toBe('Before')
    expect((await store.getModelById(id, 'default'))?.capabilities).toEqual(overrides)
  })

  it('creates with sparse overrides and returns the same split contract', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/models', payload: {
      provider: 'openai', modelId: 'gpt-4o-mini', apiKey: 'synthetic-key-only-5678', baseUrl: 'https://example.com/v1',
      capabilityOverrides: { thinking: false, vision: null },
    } })
    expect(response.statusCode).toBe(200)
    expect(response.json().data.capabilityOverrides).toEqual({ thinking: false })
    expect(response.json().data.resolvedCapabilities.vision).toBe(true)
    expect(response.json().data.apiKey).toBe('...5678')
  })

  it('cannot overwrite another tenant or a deleted model', async () => {
    const response = await app.inject({ method: 'PUT', url: `/api/v1/models/${id}`, headers: { 'x-tenant': 'other' }, payload: { capabilityOverrides: null } })
    expect(response.statusCode).toBe(404)
    await store.deleteModel(id, 'default')
    expect(await store.updateModel(id, 'default', { capabilityOverrides: null })).toBeNull()
    const raw = (await db.execute({ sql: 'SELECT capabilities FROM models WHERE id = ?', args: [id] })).rows[0].capabilities
    expect(JSON.parse(String(raw))).toEqual(overrides)
  })
})
