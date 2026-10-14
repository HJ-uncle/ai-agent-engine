/** Actual Fastify route injection and real WAL receipts; no listening socket, provider, Electron or dispatcher. */
import fs from 'node:fs'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { rootRunStore } from '../../../../storage/root-runs/index.js'
import { prepareUserAdmission, readDatabaseNamespace, userAdmissionDigest, type EngineDatabaseNamespace } from '../../../../storage/root-admission/index.js'
import * as database from '../../../../storage/sqlite/db.js'
import { chatRoutes } from '../chat.js'
import * as modelResolver from '../../../../core/llm-adapter/resolve-model.js'
import { createConversationHistory } from '../../../../storage/conversation/factory.js'
import { admissionProjectingHistory, readAdmissionSeed } from '../../../../storage/root-admission/projection.js'
import { resolveCapabilities } from '../../../../core/model-capabilities/index.js'
import { activeStreams } from '../../../../core/stream-pipeline/stream-bus.js'
import * as collaboratorPreparation from '../../../../core/subagent/collaborators.js'

let fixture: string, app: FastifyInstance, namespace: EngineDatabaseNamespace
const tenant = 'synthetic-wq2-api-tenant', session = 'synthetic-wq2-api-session'
const transport = { toolProfile: 'general', runLifetime: 'durable', subagentProtocol: 2 as const }
function requestBody(message = 'synthetic API user seed') {
  const body: Record<string, unknown> = { sessionId: session, message, model: 'NO_REAL_MODEL', memoryScope: 'off', thinkingMode: false, skills: [], mcpServers: [], knowledgeBases: [] }
  const selector = { protocolVersion: 1 as const, namespace, owner: 'work' as const, predecessor: null }
  body.admission = { ...selector, requestKey: 'exact-api-key', bodyDigest: userAdmissionDigest(body, transport, selector) }
  return body
}
const headers = { 'x-aether-tool-profile': 'general', 'x-aether-run-lifetime': 'durable', 'x-aether-subagent-protocol': '2' }
beforeAll(async () => {
  fs.mkdirSync('.e2e-tmp', { recursive: true }); fixture = fs.mkdtempSync(path.resolve('.e2e-tmp/wq2-admission-api-'))
  for (const [key, value] of Object.entries({ DATA_DIR: path.join(fixture, 'api.db'), HISTORY_BACKEND: 'jsonl',
    WORKSPACE_ROOT: path.join(fixture, 'scratch'), MEMORY_DB_PATH: path.join(fixture, 'memory.db'), AETHER_GLOBAL_DIR: path.join(fixture, 'global'),
    SKILLS_ROOT: path.join(fixture, 'skills'), ENABLE_LONG_TERM_MEMORY: 'false', OSM_MODE: 'off', LOG_LEVEL: 'silent', QA_LOG_ENABLED: 'false' })) vi.stubEnv(key, value)
  fs.mkdirSync(path.join(fixture, 'scratch'), { recursive: true })
  await database.initDb()
  vi.spyOn(modelResolver, 'resolveModelConfig').mockImplementation(async () => { throw new Error('ADMISSION_API_MUST_NOT_RESOLVE_MODELS') })
  vi.spyOn(modelResolver, 'createAdapterFromResolved').mockImplementation(() => { throw new Error('ADMISSION_API_MUST_NOT_CALL_MODELS') })
  vi.spyOn(collaboratorPreparation, 'prepareCollaborators').mockImplementation(async () => { throw new Error('EXACT_REPLAY_MUST_NOT_PREPARE_COLLABORATORS') })
  app = Fastify(); app.decorateRequest('authContext', null)
  app.addHook('onRequest', async (request, reply) => {
    Object.assign(request, { authContext: { tenantId: request.headers['x-test-tenant'] ?? tenant } })
    // LightMyRequest has no socket timer; the real SSE sink is still exercised.
    reply.raw.setTimeout = () => reply.raw
  })
  await app.register(chatRoutes)
  namespace = await readDatabaseNamespace(database.getDb())
}, 30_000)
afterAll(async () => {
  for (const [key, bus] of activeStreams) if (key.startsWith(tenant + ':')) {
    if (bus.disconnectTimeout) clearTimeout(bus.disconnectTimeout)
    bus.end(); activeStreams.delete(key)
  }
  await app.close()
  const db = database.getDb() as import('../../../../storage/sqlite/local-process-client.js').LocalSqliteProcessClient
  database.closeDb(); expect((await db.closeWithReceipt()).healthy).toBe(true)
  await (await import('../../../../storage/memory/db.js')).closeMemoryDb()
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (!path.resolve(fixture).startsWith(path.resolve('.e2e-tmp') + path.sep)) throw new Error('Unsafe API fixture cleanup')
  fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 }); expect(fs.existsSync(fixture)).toBe(false)
})

describe('WQ2 actual admission HTTP reconciliation', () => {
  it('discovers a stable namespace and scoped predecessor without exposing private request config', async () => {
    const first = await app.inject('/chat/admission/context?sessionId=' + session)
    expect(first.statusCode).toBe(200); expect(first.json().data).toMatchObject({ protocolVersion: 1, namespace, predecessor: null })
    const body = requestBody(), admission = prepareUserAdmission(body, transport)!
    const accepted = await rootRunStore.createUserAdmission(tenant, 'NO_REAL_MODEL', [], body, admission)
    const current = await app.inject('/chat/admission/context?sessionId=' + session)
    expect(current.json().data.predecessor).toEqual({ runId: accepted.run.runId, attemptId: accepted.receipt.attemptId, version: accepted.run.version })
    expect(JSON.stringify(current.json())).not.toContain('synthetic API user seed')
    const foreign = await app.inject({ url: '/chat/admission/context?sessionId=' + session, headers: { 'x-test-tenant': 'other-tenant' } })
    expect(foreign.json().data.predecessor).toBe(null)
  })
  it('queries exact accepted/absent receipts and rejects foreign source or changed body', async () => {
    const body = requestBody(), admission = prepareUserAdmission(body, transport)!
    const payload = { sessionId: session, namespace, requestKey: admission.requestKey, bodyDigest: admission.bodyDigest }
    const accepted = await app.inject({ method: 'POST', url: '/chat/admission/receipt', payload })
    expect(accepted.statusCode).toBe(200)
    expect(accepted.json().data).toMatchObject({ status: 'accepted', receipt: { assistantIdentityKind: 'admission-anchor' }, projection: { user: { state: 'pending' }, assistant: { state: 'unwritten' } } })
    const absent = await app.inject({ method: 'POST', url: '/chat/admission/receipt', payload, headers: { 'x-test-tenant': 'other-tenant' } })
    expect(absent.json().data).toMatchObject({ status: 'absent' }); expect(absent.json().data).not.toHaveProperty('receipt')
    const changed = await app.inject({ method: 'POST', url: '/chat/admission/receipt', payload: { ...payload, bodyDigest: 'f'.repeat(64) } })
    expect(changed.statusCode).toBe(409)
    const wrongNamespace = await app.inject({ method: 'POST', url: '/chat/admission/receipt', payload: { ...payload, namespace: { ...namespace, generation: 'wrong-generation' } } })
    expect(wrongNamespace.statusCode).toBe(409)
    expect(modelResolver.resolveModelConfig).not.toHaveBeenCalled(); expect(modelResolver.createAdapterFromResolved).not.toHaveBeenCalled()
    expect(collaboratorPreparation.prepareCollaborators).not.toHaveBeenCalled()
  })
  it('replays POST /chat by exact key before any model/config execution, with zero blind readmission', async () => {
    const response = await app.inject({ method: 'POST', url: '/chat', payload: requestBody(), headers })
    expect(response.statusCode, response.body).toBe(200); expect(response.headers['content-type']).toContain('text/event-stream')
    const roots = await rootRunStore.list(tenant, session)
    expect(roots).toHaveLength(1); expect(response.body).toContain(roots[0].runId)
    expect(modelResolver.resolveModelConfig).not.toHaveBeenCalled(); expect(modelResolver.createAdapterFromResolved).not.toHaveBeenCalled()
    const conflict = await app.inject({ method: 'POST', url: '/chat', payload: requestBody('same key changed body'), headers })
    expect(conflict.statusCode).toBe(409); expect((await rootRunStore.list(tenant, session))).toHaveLength(1)
  })
  it('distinguishes assistant admission anchor from the actual persisted final projection identity', async () => {
    const accepted = (await rootRunStore.findUserAdmission(tenant, session, prepareUserAdmission(requestBody(), transport)!))!
    const seed = await readAdmissionSeed(database.getDb(), { tenantId: tenant, sessionId: session }, accepted.run.runId)
    const history = admissionProjectingHistory(createConversationHistory(), seed.anchor)
    await history.append(seed.message, { tenantId: tenant, sessionId: session })
    await history.append({ id: 'synthetic-final-projection-id', role: 'assistant', content: 'FINAL_PROJECTED_RESULT', conversationId: seed.anchor.turnId } as import('../../../../core/agent-context/types.js').Message, { tenantId: tenant, sessionId: session })
    await rootRunStore.update(tenant, accepted.run.runId, { status: 'succeeded', assistantMessageId: 'synthetic-final-projection-id' })
    const payload = { sessionId: session, namespace, requestKey: accepted.receipt.requestKey, bodyDigest: accepted.receipt.bodyDigest }
    const response = await app.inject({ method: 'POST', url: '/chat/admission/receipt', payload })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json().data).toMatchObject({ receipt: { assistantMessageId: seed.anchor.assistantAnchorId, assistantIdentityKind: 'admission-anchor' },
      projection: { user: { state: 'projected' }, assistant: { state: 'persisted', anchorMessageId: seed.anchor.assistantAnchorId, messageId: 'synthetic-final-projection-id' } } })
    expect(response.json().data.projection.rootVersion).toBeGreaterThan(accepted.receipt.rootVersion)
  })
  it('executes a new keyed actual route once through a synthetic in-process adapter, then replays without a second execution', async () => {
    let streamCalls = 0
    vi.mocked(collaboratorPreparation.prepareCollaborators).mockRestore()
    vi.mocked(modelResolver.resolveModelConfig).mockImplementation(async ({ model }) => ({ model: model ?? 'synthetic-direct-route', provider: 'fixture',
      capabilities: resolveCapabilities({ model: 'gpt-4o', provider: 'openai' }), thinkingEnabled: false }))
    vi.mocked(modelResolver.createAdapterFromResolved).mockImplementation(config => ({ provider: 'fixture', model: config.model,
      countTokens: text => Math.ceil(text.length / 4), complete: async () => { throw new Error('UNEXPECTED_COMPLETION') },
      async *stream() { streamCalls++; yield { done: true, finishReason: 'stop', content: 'SYNTHETIC_ACTUAL_ROUTE_FINAL', promptTokens: 11, completionTokens: 5 } },
    }))
    const context = (await app.inject('/chat/admission/context?sessionId=' + session)).json().data
    const body: Record<string, unknown> = { ...requestBody('second synthetic admitted user'), workspacePaths: [path.join(fixture, 'scratch')] }
    const selector = { protocolVersion: 1 as const, namespace, owner: 'work' as const, predecessor: context.predecessor }
    body.admission = { ...selector, requestKey: 'second-exact-api-key', bodyDigest: userAdmissionDigest(body, transport, selector) }
    const response = await app.inject({ method: 'POST', url: '/chat', payload: body, headers })
    expect(response.statusCode, response.body).toBe(200); expect(response.body).toContain('SYNTHETIC_ACTUAL_ROUTE_FINAL')
    expect(streamCalls).toBe(1)
    const accepted = (await rootRunStore.findUserAdmission(tenant, session, prepareUserAdmission(body, transport)!))!
    expect(accepted.run.status).toBe('succeeded')
    const seed = await readAdmissionSeed(database.getDb(), { tenantId: tenant, sessionId: session }, accepted.run.runId)
    expect(seed.projected).toBe(true)
    const rows = await createConversationHistory().getFullHistory({ tenantId: tenant, sessionId: session })
    expect(rows.filter(row => row.id === seed.anchor.userMessageId)).toHaveLength(1)
    expect(rows.find(row => row.id === accepted.run.assistantMessageId)?.content).toBe('SYNTHETIC_ACTUAL_ROUTE_FINAL')
    const replay = await app.inject({ method: 'POST', url: '/chat', payload: body, headers })
    expect(replay.statusCode, replay.body).toBe(200); expect(streamCalls).toBe(1)
    expect((await rootRunStore.list(tenant, session))).toHaveLength(2)
  })
})
