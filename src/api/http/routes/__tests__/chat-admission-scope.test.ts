/** Real receipt route + native stores: session isolation, late materialization and bounded archive scope. No listener/provider. */
import fs from 'node:fs'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Message } from '../../../../core/agent-context/types.js'
import { createConversationHistory } from '../../../../storage/conversation/factory.js'
import { RootRunStore } from '../../../../storage/root-runs/index.js'
import { prepareUserAdmission, readDatabaseNamespace, userAdmissionDigest } from '../../../../storage/root-admission/index.js'
import { admissionProjectingHistory, readAdmissionSeed } from '../../../../storage/root-admission/projection.js'
import { closeDb, getDb, initDb } from '../../../../storage/sqlite/db.js'
import type { LocalSqliteProcessClient } from '../../../../storage/sqlite/local-process-client.js'
import { registerUserAdmissionRoutes } from '../chat-admission.js'

const fixtureRoot = path.resolve('.e2e-tmp')
const transport = { toolProfile: 'general', runLifetime: 'durable', subagentProtocol: 2 as const }
let fixture: string, db: LocalSqliteProcessClient, nextTenant = 0
const apps: FastifyInstance[] = []
beforeAll(async () => {
  fs.mkdirSync(fixtureRoot, { recursive: true })
  fixture = fs.mkdtempSync(path.join(fixtureRoot, 'admission-scope-'))
  vi.stubEnv('DATA_DIR', path.join(fixture, 'agent.db'))
  db = getDb() as LocalSqliteProcessClient
  await initDb()
}, 30_000)
afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()))
  vi.restoreAllMocks()
})
afterAll(async () => {
  closeDb(); expect((await db.closeWithReceipt()).healthy).toBe(true)
  vi.unstubAllEnvs()
  if (path.dirname(fixture) !== fixtureRoot || !path.basename(fixture).startsWith('admission-scope-')) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

async function admitted(backend: 'jsonl' | 'sqlite') {
  vi.stubEnv('HISTORY_BACKEND', backend)
  const scope = { tenantId: `receipt-scope-${++nextTenant}`, sessionId: 'z-owned' }
  const history = createConversationHistory(), roots = new RootRunStore()
  await roots.initialize()
  const namespace = await readDatabaseNamespace(db)
  const body: Record<string, unknown> = { sessionId: scope.sessionId, message: 'Synthetic scoped receipt requirement', model: 'NO_PROVIDER' }
  const selector = { protocolVersion: 1 as const, namespace, owner: 'work' as const, predecessor: null }
  body.admission = { ...selector, requestKey: 'scoped-receipt', bodyDigest: userAdmissionDigest(body, transport, selector) }
  const accepted = await roots.createUserAdmission(scope.tenantId, 'NO_PROVIDER', [], body, prepareUserAdmission(body, transport)!)
  const seed = await readAdmissionSeed(db, scope, accepted.run.runId)
  await admissionProjectingHistory(history, seed.anchor).append(seed.message, scope)
  const app = Fastify(); apps.push(app); app.decorateRequest('authContext', null)
  app.addHook('onRequest', async request => {
    Object.assign(request, { authContext: { tenantId: request.headers['x-test-tenant'] ?? scope.tenantId } })
  })
  await registerUserAdmissionRoutes(app, roots, history)
  const payload = { sessionId: scope.sessionId, namespace, requestKey: accepted.receipt.requestKey, bodyDigest: accepted.receipt.bodyDigest }
  const receipt = (tenantId?: string) => app.inject({ method: 'POST', url: '/chat/admission/receipt', payload,
    ...(tenantId ? { headers: { 'x-test-tenant': tenantId } } : {}) })
  const assistant: Message & { conversationId: string } = { id: accepted.run.assistantMessageId, role: 'assistant',
    content: 'Owned persisted result', conversationId: accepted.run.turnId }
  return { scope, history, roots, accepted, receipt, assistant }
}

describe.each(['jsonl', 'sqlite'] as const)('%s admission receipt exact session', backend => {
  it('ignores an identical assistant ID and turn in another session, then observes a late owned append', async () => {
    const { scope, history, receipt, assistant } = await admitted(backend)
    const otherScope = { ...scope, sessionId: 'a-unrelated' }
    await history.append({ ...assistant, content: 'Foreign session result' }, otherScope)
    const missing = await receipt()
    expect(missing.statusCode, missing.body).toBe(200)
    expect(missing.json().data.projection.assistant.state).toBe('unwritten')
    expect(await history.getMessageById(assistant.id!, scope.tenantId, scope.sessionId)).toBeNull()

    // A second storage instance models a just-finished writer; an earlier miss
    // must not turn into a negative cache hiding the materialized result.
    await createConversationHistory().append(assistant, scope)
    const written = await receipt()
    expect(written.statusCode, written.body).toBe(200)
    expect(written.json().data.projection.assistant).toMatchObject({ state: 'persisted', messageId: assistant.id })
    expect(await history.getMessageById(assistant.id!, scope.tenantId, scope.sessionId)).toMatchObject({ content: 'Owned persisted result', conversationId: assistant.conversationId })
    expect(await history.getMessageById(assistant.id!, scope.tenantId, otherScope.sessionId)).toMatchObject({ content: 'Foreign session result' })
  })

  it('does not accept the same session and message IDs from another tenant', async () => {
    const { scope, history, receipt, assistant } = await admitted(backend)
    const foreignTenant = scope.tenantId + '-foreign'
    await history.append(assistant, { ...scope, tenantId: foreignTenant })
    expect((await receipt()).json().data.projection.assistant.state).toBe('unwritten')
    expect((await receipt(foreignTenant)).json().data).toMatchObject({ status: 'absent' })
    expect(await history.getMessageById(assistant.id!, scope.tenantId, scope.sessionId)).toBeNull()
  })

  it.each(['role', 'turn'] as const)('still rejects a mismatched owned assistant %s', async mismatch => {
    const { scope, history, receipt, assistant } = await admitted(backend)
    await history.append({ ...assistant, ...(mismatch === 'role' ? { role: 'user' as const } : { conversationId: 'foreign-turn' }) }, scope)
    const response = await receipt()
    expect(response.statusCode, response.body).toBe(503)
    expect(response.body).toContain('ADMISSION_ASSISTANT_PROJECTION_CONFLICT')
  })
})

it('JSONL receipt misses never open or load another session archive', async () => {
  const { scope, history, receipt } = await admitted('jsonl')
  for (let index = 0; index < 6; index++) {
    await history.append({ id: `unrelated-${index}`, role: 'tool', content: 'Synthetic unrelated archive '.repeat(8192) },
      { ...scope, sessionId: `a-unrelated-${index}` })
  }
  const reads = vi.spyOn(fs.promises, 'readFile'), opens = vi.spyOn(fs.promises, 'open')
  const streams = vi.spyOn(fs, 'createReadStream'), directories = vi.spyOn(fs, 'readdirSync')
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await receipt()
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json().data.projection.assistant.state).toBe('unwritten')
  }
  const accessed = [...reads.mock.calls, ...opens.mock.calls, ...streams.mock.calls]
    .map(args => String(args[0])).filter(file => file.endsWith('.jsonl')).map(file => path.resolve(file))
  const expected = path.join(fixture, 'sessions', scope.tenantId, scope.sessionId + '.jsonl')
  expect(accessed.length).toBeGreaterThan(0)
  expect([...new Set(accessed)]).toEqual([expected])
  expect(directories.mock.calls.map(args => path.resolve(String(args[0])))).not.toContain(path.dirname(expected))
})

it('JSONL scoped lookup preserves archived assistant evidence and honors later deletion', async () => {
  const { scope, history, roots, accepted, receipt, assistant } = await admitted('jsonl')
  await history.append(assistant, scope)
  for (let index = 0; index < 8; index++) await history.append({ id: `later-${index}`, role: index % 2 ? 'assistant' : 'user', content: 'Later synthetic turn '.repeat(20) }, scope)
  await roots.update(scope.tenantId, accepted.run.runId, { status: 'succeeded' })
  await history.compress(scope, async () => 'Synthetic summary without original assistant text', { force: true, keepRecentTokens: 0 })
  expect((await history.getFullHistory(scope)).some(message => message.id === assistant.id)).toBe(false)
  const archived = await receipt()
  expect(archived.statusCode, archived.body).toBe(200)
  expect(archived.json().data.projection.assistant).toMatchObject({ state: 'persisted', messageId: assistant.id })
  expect(await history.getMessageById(assistant.id!, scope.tenantId, scope.sessionId)).toMatchObject({ content: assistant.content })
  await history.deleteMessage(assistant.id!, scope.tenantId)
  expect((await receipt()).json().data.projection.assistant.state).toBe('unwritten')
  expect(await history.getMessageById(assistant.id!, scope.tenantId, scope.sessionId)).toBeNull()
})
