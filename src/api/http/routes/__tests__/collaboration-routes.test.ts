// Real loopback HTTP and SQLite receipts. Authentication is the only substituted boundary.
// No network model, browser, business DB or user workspace is involved.
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthContext } from '../../../../auth/types.js'
import { LocalSqliteProcessClient } from '../../../../storage/sqlite/local-process-client.js'
import { SubagentStore } from '../../../../core/subagent/store.js'
import { CollaborationStore } from '../../../../core/collaboration/store.js'
import { CollaborationRuntime } from '../../../../core/collaboration/runtime.js'
import * as runtimes from '../../../../core/collaboration/runtime.js'
import type { CollaborationReceipt, CollaborationRootScope } from '../../../../core/collaboration/types.js'
import { collaborationRoutes } from '../collaboration.js'

let directory: string, db: LocalSqliteProcessClient, app: FastifyInstance, runtime: CollaborationRuntime
let endpoint: string, participantId: string, receipt: CollaborationReceipt
const scope: CollaborationRootScope = { tenantId: 'tenant-a', rootRunId: 'root-a', rootAttemptId: 'attempt-a', rootSessionId: 'session-a' }
const query = new URLSearchParams({ rootAttemptId: scope.rootAttemptId, rootSessionId: scope.rootSessionId }).toString()
async function request(url: string, actor = 'alice', init: RequestInit = {}) {
  const response = await fetch(endpoint + url, { ...init, headers: { 'x-fixture-actor': actor, ...init.headers } })
  return { status: response.status, body: await response.json() as { code: number; message: string; data: Record<string, unknown> } }
}

beforeEach(async () => {
  directory = path.resolve('.e2e-tmp', `g3-http-${randomUUID()}`); fs.mkdirSync(directory, { recursive: true })
  db = new LocalSqliteProcessClient({ url: `file:${path.join(directory, 'fixture.db').replaceAll('\\', '/')}` })
  await db.execute(`CREATE TABLE root_runs(seq INTEGER PRIMARY KEY AUTOINCREMENT,tenant_id TEXT NOT NULL,session_id TEXT NOT NULL,
    run_id TEXT NOT NULL UNIQUE,turn_id TEXT NOT NULL,state TEXT NOT NULL)`)
  await db.execute({ sql: 'INSERT INTO root_runs(tenant_id,session_id,run_id,turn_id,state) VALUES (?,?,?,?,?)', args: [scope.tenantId, scope.rootSessionId, scope.rootRunId, 'turn-a', JSON.stringify({ status: 'running', attemptId: scope.rootAttemptId, sessionId: scope.rootSessionId, turnId: 'turn-a' })] })
  runtime = new CollaborationRuntime(new CollaborationStore(db), new SubagentStore(db))
  const root = await runtime.admitRoot(scope)
  const child = await runtime.admitChild(root, { tenantId: scope.tenantId, rootSessionId: scope.rootSessionId, parentSessionId: scope.rootSessionId,
    parentConversationId: 'turn-a', parentMessageId: 'dispatch', parentToolCallId: 'synthetic-child', task: 'synthetic', description: 'synthetic', modelId: 'fixture-no-model' })
  participantId = `child:${child.mutation.header.childSessionId}`
  receipt = await runtime.send(root, { recipientParticipantId: participantId, message: 'synthetic private mailbox body', requestKey: 'receipt-one' })
  vi.spyOn(runtimes, 'getCollaborationRuntime').mockReturnValue(runtime)
  app = Fastify(); app.decorateRequest('authContext', null)
  app.addHook('onRequest', async request => {
    const actor = request.headers['x-fixture-actor']
    const authenticated = request as FastifyRequest & { authContext?: AuthContext }
    authenticated.authContext = actor === 'none' ? { method: 'none', tenantId: 'tenant-a' }
      : { method: 'jwt', tenantId: actor === 'bob' ? 'tenant-b' : 'tenant-a', userId: actor === 'bob' ? 'bob' : 'alice' }
  })
  await app.register(collaborationRoutes)
  endpoint = await app.listen({ host: '127.0.0.1', port: 0 })
})
afterEach(async () => {
  await app?.close(); vi.restoreAllMocks(); db.close(); await db.whenClosed()
  if (!directory.startsWith(path.resolve('.e2e-tmp') + path.sep)) throw new Error('Unsafe HTTP fixture cleanup')
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 })
})

describe('collaboration HTTP inspection protocol', () => {
  it('declares queue inspection truthfully while consumer, async tools and JSONL delivery remain unsupported', async () => {
    const result = await request('/collaboration/capabilities')
    expect(result.status).toBe(200)
    expect(result.body.data).toMatchObject({ durableQueueReceipts: true, mailboxConsumer: false, runtimeCommunication: false,
      asynchronousAgentTools: false, userControllerMutation: false, jsonlDelivery: false })
  })
  it('reads a durable accepted receipt over actual loopback HTTP after a separate reconnect', async () => {
    const result = await request(`/collaboration/roots/root-a/receipts/${receipt.messageId}?${query}`)
    expect(result.status).toBe(200); expect(result.body.data).toEqual(receipt)
    expect(JSON.stringify(result.body)).not.toContain('private mailbox body')
    const reconnect = await request(`/collaboration/roots/root-a/receipts/${receipt.messageId}?${query}`, 'alice', { headers: { Connection: 'close' } })
    expect(reconnect.body.data).toEqual(receipt)
    expect((await db.execute('SELECT count(*) AS count FROM collaboration_messages')).rows[0].count).toBe(1)
  })
  it.each([
    ['other authenticated tenant', 'bob', query, 404],
    ['missing controller authentication', 'none', query, 403],
    ['stale attempt', 'alice', 'rootAttemptId=old&rootSessionId=session-a', 404],
    ['stale session', 'alice', 'rootAttemptId=attempt-a&rootSessionId=other', 404],
    ['missing scope', 'alice', '', 400],
  ])('rejects %s without leaking message identity/body', async (_name, actor, queryString, status) => {
    const result = await request(`/collaboration/roots/root-a/receipts/${receipt.messageId}?${queryString}&tenantId=tenant-a`, actor)
    expect(result.status).toBe(status)
    expect(JSON.stringify(result.body)).not.toContain(receipt.messageId)
    expect(JSON.stringify(result.body)).not.toContain('private mailbox body')
    expect((await db.execute('SELECT state FROM collaboration_messages')).rows[0].state).toBe('queued')
  })
  it('bounds participant pages and scopes their cursor independently from receipt pages', async () => {
    const first = await request(`/collaboration/roots/root-a/participants?${query}&limit=1`)
    expect(first.status).toBe(200); expect(first.body.data.entries).toHaveLength(1)
    expect(first.body.data.hasMore).toBe(true)
    const cursor = String(first.body.data.nextCursor)
    const next = await request(`/collaboration/roots/root-a/participants?${query}&limit=1&cursor=${encodeURIComponent(cursor)}`)
    expect(next.status).toBe(200)
    expect(next.body.data.hasMore).toBe(false)
    const wrong = await request(`/collaboration/roots/root-a/participants/${encodeURIComponent(participantId)}/receipts?${query}&cursor=${encodeURIComponent(cursor)}`)
    expect(wrong.status).toBe(400)
    const oversized = await request(`/collaboration/roots/root-a/participants?${query}&limit=100000`)
    expect(oversized.status).toBe(400)
  })
  it('returns bounded receipt metadata with queued state and no task body or invented delivery ACK', async () => {
    const result = await request(`/collaboration/roots/root-a/participants/${encodeURIComponent(participantId)}/receipts?${query}&limit=1`)
    expect(result.status).toBe(200)
    expect(result.body.data.entries).toEqual([receipt])
    expect(JSON.stringify(result.body)).not.toContain('private mailbox body')
    expect(Buffer.byteLength(JSON.stringify(result.body))).toBeLessThan(2048)
  })
  it('POST body cannot manufacture a root/sibling sender, producer token or foreign tenant authority', async () => {
    const result = await request(`/collaboration/roots/root-a/messages?${query}`, 'alice', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ senderParticipantId: 'root:root-a', rootRunId: 'root-a',
        rootAttemptId: 'attempt-a', tenantId: 'tenant-b', producer: {}, recipientParticipantId: participantId, message: 'forged', requestKey: 'forged' }) })
    expect(result.status).toBe(501)
    expect(result.body.code).toBe(50101)
    expect((await db.execute('SELECT count(*) AS count FROM collaboration_messages')).rows[0].count).toBe(1)
  })
  it('ordinary HTTP GET never performs startup interruption/recovery', async () => {
    await request(`/collaboration/roots/root-a/participants?${query}`)
    await request(`/collaboration/roots/root-a/receipts/${receipt.messageId}?${query}`)
    expect((await db.execute('SELECT phase FROM collaboration_roots')).rows[0].phase).toBe('open')
    expect((await db.execute('SELECT state FROM collaboration_messages')).rows[0].state).toBe('queued')
  })
})
