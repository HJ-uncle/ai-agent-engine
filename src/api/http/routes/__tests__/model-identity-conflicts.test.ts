// Real Fastify + SQLite: duplicate saves, deleted identity reuse and concurrent admission.
import Fastify, { type FastifyInstance } from 'fastify'
import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as database from '../../../../storage/sqlite/db.js'
import { ModelsStore } from '../../../../storage/sqlite/models.js'
import { LocalSqliteProcessClient } from '../../../../storage/sqlite/local-process-client.js'
import { up as modelSchema } from '../../../../storage/sqlite/migrations/007_add_models_management.js'
import { up as capabilitySchema } from '../../../../storage/sqlite/migrations/014_add_model_capabilities.js'
import { modelsRoutes } from '../models.js'

vi.hoisted(() => { process.env.ENCRYPTION_KEY = 'a1'.repeat(32) })
vi.mock('../../../../core/llm-adapter/factory.js', () => ({ createLLMAdapter: vi.fn() }))
const input = { provider: 'openai', modelId: 'identity-model', apiKey: 'synthetic-credential-1234',
  baseUrl: 'https://example.com/v1', displayName: 'Original', capabilityOverrides: { thinking: true } }
let db: Client
let app: FastifyInstance
let store: ModelsStore

beforeEach(async () => {
  db = createClient({ url: 'file::memory:' })
  vi.spyOn(database, 'getDb').mockReturnValue(db)
  await modelSchema(db)
  await capabilitySchema(db)
  store = new ModelsStore()
  app = Fastify()
  app.decorateRequest('authContext', null)
  app.addHook('onRequest', async request => {
    Object.assign(request, { authContext: { method: 'jwt', roles: ['admin'], tenantId: request.headers['x-tenant'] ?? 'default' } })
  })
  await app.register(modelsRoutes)
})
afterEach(async () => {
  await app.close()
  vi.restoreAllMocks()
  db.close()
  if (db instanceof LocalSqliteProcessClient) await db.whenClosed()
})

const create = (payload: Record<string, unknown> = input, tenant = 'default') =>
  app.inject({ method: 'POST', url: '/api/v1/models', headers: { 'x-tenant': tenant }, payload })
const rawRows = async () => (await db.execute('SELECT * FROM models ORDER BY id')).rows

describe('model identity writes', () => {
  it('returns an actionable 409 without changing the existing active configuration', async () => {
    const first = await create()
    expect(first.statusCode).toBe(200)
    const before = await rawRows()
    const duplicate = await create({ ...input, displayName: 'Must not replace', apiKey: 'different-synthetic-key-5678' })
    expect(duplicate.statusCode).toBe(409)
    expect(duplicate.json()).toMatchObject({ code: 40901,
      data: { reason: 'MODEL_ALREADY_EXISTS', existingModelId: first.json().data.id } })
    expect(duplicate.json().message).toContain('请编辑已有模型')
    expect(duplicate.body).not.toMatch(/SQLITE|UNIQUE|synthetic|api_key/)
    expect(await rawRows()).toEqual(before)
  })

  it('edits its own model through PUT while retaining its unique identity and masked credential', async () => {
    const first = (await create()).json().data
    const before = (await rawRows())[0]
    const edited = await app.inject({ method: 'PUT', url: `/api/v1/models/${first.id}`, payload: {
      provider: input.provider, modelId: input.modelId, displayName: 'Edited', apiKey: first.apiKey, isEnabled: true,
    } })
    expect(edited.statusCode).toBe(200)
    expect(edited.json().data).toMatchObject({ id: first.id, modelId: input.modelId, provider: input.provider, displayName: 'Edited', isEnabled: true })
    expect((await rawRows())[0].api_key).toBe(before.api_key)
    expect(await rawRows()).toHaveLength(1)
  })

  it('allows the same model identity in another tenant and provider without exposing other tenant IDs', async () => {
    const first = (await create()).json().data
    const other = await create(input, 'other')
    expect(other.statusCode).toBe(200)
    expect(other.json().data.id).not.toBe(first.id)
    expect((await create({ ...input, provider: 'custom' })).statusCode).toBe(200)
    const conflict = await create(input, 'other')
    expect(conflict.statusCode).toBe(409)
    expect(conflict.json().data.existingModelId).toBe(other.json().data.id)
    expect(conflict.body).not.toContain(first.id)
  })

  it('restores a deleted identity atomically with only the newly submitted configuration', async () => {
    const first = (await create()).json().data
    await store.updateModel(first.id, 'default', { isEnabled: true, version: 'old-version' })
    await store.deleteModel(first.id, 'default')
    expect(await store.getModels('default')).toEqual([])
    const restored = await create({ provider: input.provider, modelId: input.modelId,
      apiKey: 'restored-synthetic-key-5678', baseUrl: 'https://new.example.com/v1' })
    expect(restored.statusCode).toBe(200)
    expect(restored.json().data).toMatchObject({ id: first.id, apiKey: '...5678', isEnabled: false,
      baseUrl: 'https://new.example.com/v1', capabilityOverrides: null, displayName: null, version: null })
    expect((await rawRows())[0].deleted_at).toBeNull()
    expect(await rawRows()).toHaveLength(1)
    expect((await store.getModelById(first.id, 'default'))?.apiKey).toBe('restored-synthetic-key-5678')
  })

  it.each([false, true])('admits only one concurrent create when deleted=%s', async deleted => {
    let restoredId: string | undefined
    if (deleted) {
      restoredId = (await create()).json().data.id
      await store.deleteModel(restoredId!, 'default')
    }
    const results = await Promise.all([
      create({ ...input, displayName: 'Writer A' }), create({ ...input, displayName: 'Writer B' }),
    ])
    expect(results.map(result => result.statusCode).sort()).toEqual([200, 409])
    const winner = results.find(result => result.statusCode === 200)!.json().data
    const rejected = results.find(result => result.statusCode === 409)!.json()
    expect(rejected).toMatchObject({ code: 40901, data: { reason: 'MODEL_ALREADY_EXISTS', existingModelId: winner.id } })
    if (restoredId) expect(winner.id).toBe(restoredId)
    expect(await store.getModels('default')).toHaveLength(1)
    expect((await store.getModelById(winner.id, 'default'))?.displayName).toBe(winner.displayName)
    expect(await rawRows()).toHaveLength(1)
  })

  it('preserves tenant and deletion boundaries for stale edits', async () => {
    const first = (await create()).json().data
    const other = await app.inject({ method: 'PUT', url: `/api/v1/models/${first.id}`, headers: { 'x-tenant': 'other' }, payload: { displayName: 'cross-tenant' } })
    expect(other.statusCode).toBe(404)
    await store.deleteModel(first.id, 'default')
    const before = await rawRows()
    const deleted = await app.inject({ method: 'PUT', url: `/api/v1/models/${first.id}`, payload: { displayName: 'stale-edit' } })
    expect(deleted.statusCode).toBe(404)
    expect(await rawRows()).toEqual(before)
  })

  it.each(['createModel', 'updateModel'] as const)('does not expose or misclassify unrelated %s storage failures', async operation => {
    const id = (await create()).json().data.id
    const before = await rawRows()
    vi.spyOn(ModelsStore.prototype, operation).mockRejectedValueOnce(new Error('SQLITE_IOERR synthetic-secret database-path'))
    const failed = operation === 'createModel' ? await create({ ...input, modelId: 'another' })
      : await app.inject({ method: 'PUT', url: `/api/v1/models/${id}`, payload: { displayName: 'must-not-save' } })
    expect(failed.statusCode).toBe(500)
    expect(failed.json()).toMatchObject({ code: 50000, data: null })
    expect(failed.body).not.toMatch(/SQLITE|synthetic|database-path|MODEL_ALREADY_EXISTS/)
    expect(await rawRows()).toEqual(before)
  })

  it('keeps the database unique constraint authoritative', async () => {
    await create()
    await expect(db.execute({ sql: `INSERT INTO models (id, tenant_id, provider, model_id, api_key, base_url)
      VALUES (?, ?, ?, ?, ?, ?)`, args: ['bypass-attempt', 'default', input.provider, input.modelId, 'synthetic', input.baseUrl] }))
      .rejects.toThrow(/UNIQUE/)
    expect(await rawRows()).toHaveLength(1)
  })

  it('uses the same conditional restore and duplicate contract through the production SQLite process', async () => {
    db.close()
    db = new LocalSqliteProcessClient({ url: 'file::memory:' })
    vi.mocked(database.getDb).mockReturnValue(db)
    await modelSchema(db)
    await capabilitySchema(db)
    const first = await create()
    expect(first.statusCode).toBe(200)
    const id = first.json().data.id
    await store.deleteModel(id, 'default')
    const results = await Promise.all([create(), create()])
    expect(results.map(result => result.statusCode).sort()).toEqual([200, 409])
    expect(results.find(result => result.statusCode === 200)!.json().data.id).toBe(id)
    expect(results.find(result => result.statusCode === 409)!.json()).toMatchObject({ code: 40901,
      data: { reason: 'MODEL_ALREADY_EXISTS', existingModelId: id } })
    expect(await rawRows()).toHaveLength(1)
  })
})
