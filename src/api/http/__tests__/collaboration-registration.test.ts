/** Production buildServer, frozen instance auth, actual loopback requests and
 * native SQLite/JSONL delivery. No route-registration, auth, store or provider mocks. */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { beforeAll, afterAll, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../server.js'
import { initDb, getDb, closeDb } from '../../../storage/sqlite/db.js'
import { closeMemoryDb } from '../../../storage/memory/db.js'
import { RootRunStore } from '../../../storage/root-runs/index.js'
import { getExecutionOwners, type ExecutionOwner, type ChildTicket } from '../../../core/collaboration/execution-owner.js'
import { getCollaborationRuntime } from '../../../core/collaboration/runtime.js'
import { controllerSubject } from '../../../core/collaboration/controller-origin.js'
import { getRuntimeIdentity } from '../../../runtime/identity.js'
import { getSubagentStore } from '../../../core/subagent/store.js'
import { SQLiteConversationHistory } from '../../../storage/conversation/history.js'
import { JSONLConversationHistory } from '../../../storage/conversation/jsonl-history.js'
import { jsonlHistoryIdentity } from '../../../storage/conversation/jsonl-origin.js'
import type { SQLiteDeliveryConsumer } from '../../../core/collaboration/sqlite-delivery.js'
import type { JSONLDeliveryConsumer } from '../../../core/collaboration/jsonl-delivery.js'
import type { CollaborationReceipt } from '../../../core/collaboration/types.js'

let directory: string, app: FastifyInstance, endpoint: string
const token = 'synthetic-production-controller-instance-only'
const cleanups: (() => Promise<void>)[] = []
const headers = { 'x-aether-instance-token': token, 'content-type': 'application/json' }
async function request(url: string, init: RequestInit = {}) {
  const result = await fetch(endpoint + url, { ...init, headers: { ...headers, ...init.headers } })
  return { status: result.status, body: await result.json() as { code: number; data: Record<string, unknown>; message: string } }
}
beforeAll(async () => {
  await closeDb(); await closeMemoryDb()
  fs.mkdirSync('.e2e-tmp', { recursive: true })
  directory = fs.mkdtempSync(path.resolve('.e2e-tmp/production-controller-'))
  for (const [name, value] of Object.entries({ DATA_DIR: path.join(directory, 'fixture.db'), AUTH_ENABLED: 'false',
    AETHER_INSTANCE_TOKEN: token, AETHER_GLOBAL_DIR: path.join(directory, 'global'), WORKSPACE_ROOT: directory,
    SKILLS_ROOT: path.join(directory, 'skills'), MCP_CONFIG_PATH: path.join(directory, 'mcp.json'),
    PUBLIC_DIR: path.join(directory, 'absent-public'), ENABLE_LONG_TERM_MEMORY: 'false', LOG_LEVEL: 'silent', QA_LOG_ENABLED: 'false' })) vi.stubEnv(name, value)
  fs.mkdirSync(path.join(directory, 'skills'))
  await initDb(); app = await buildServer(); endpoint = await app.listen({ host: '127.0.0.1', port: 0 })
}, 30_000)
afterAll(async () => {
  for (const close of cleanups.splice(0)) await close()
  await app?.close()
  for (const receipt of await Promise.all([closeDb(), closeMemoryDb()])) if (receipt) expect(receipt.healthy, JSON.stringify(receipt)).toBe(true)
  vi.unstubAllEnvs()
  // Leave isolated receipts on failure; no public files or business DB are touched.
}, 30_000)
it('publishes collaboration capabilities through the real /api/v1 server prefix and instance gate', async () => {
  const result = await request('/api/v1/collaboration/capabilities')
  expect(result.status).toBe(200)
  expect(result.body.data).toMatchObject({ protocolVersion: 1, durableQueueReceipts: true, receiptPagination: true,
    mailboxConsumer: false, runtimeCommunication: false, asynchronousAgentTools: false, userControllerMutation: false, jsonlDelivery: false })
  const rejected = await fetch(endpoint + '/api/v1/collaboration/capabilities')
  expect(rejected.status).toBe(401)
})
it.each(['sqlite', 'jsonl'] as const)('real server accepts exactly one child input and exposes its durable receipt: %s', async backend => {
  const db = getDb(), roots = new RootRunStore(() => db), owners = getExecutionOwners(), runtime = getCollaborationRuntime()
  const sessionId = 'production-controller-' + backend
  const root = await roots.create('default', sessionId, 'synthetic-no-provider', [directory], { message: 'Synthetic parent', memoryScope: 'off' })
  const stored = (await roots.get('default', root.runId))!
  const owner: ExecutionOwner = await owners.admitRoot({ tenantId: 'default', rootRunId: root.runId, rootAttemptId: stored.attemptId,
    controller: new AbortController(), controllerSubject: controllerSubject({ kind: 'instance', tenantId: 'default', instanceId: getRuntimeIdentity().instanceId }, 'local-instance') })
  owners.registerCompletion(owner, Promise.resolve())
  const producer = owners.producer(owner), binding = runtime.executionBinding(producer)
  const ticket: ChildTicket = owners.reserveChild(owner)
  const child = await runtime.admitChild(producer, { tenantId: 'default', rootSessionId: sessionId, parentSessionId: sessionId,
    parentConversationId: root.turnId, parentMessageId: 'synthetic-dispatch', parentToolCallId: randomUUID(), task: 'Synthetic child', description: backend,
    modelId: 'synthetic-no-provider', continuation: { readOnly: true, systemPrompt: '', toolNames: [], workspacePaths: [directory] } })
  const childOwner = owners.attachChild(ticket, child.mutation.header.runId, child.producer), recipient = runtime.executionBinding(child.producer)
  let closed = false
  const close = async () => {
    if (closed) return
    const terminal = await getSubagentStore().appendHeader('default', recipient.invocationRunId, 'finished', { status: 'cancelled', finishedAt: Date.now() })
    if (!terminal) throw new Error('Synthetic owned child disappeared before its terminal receipt')
    owners.completeChild(ticket, { runId: terminal.header.runId, terminalSeq: terminal.header.lastSeq, projection: 'suppressed' })
    await roots.finishOwned(owner, { status: 'cancelled', stopReason: 'synthetic_contract_complete' }); await owners.joinRoot(owner); owners.releaseRoot(owner); closed = true
  }
  cleanups.push(close)
  const base = '/api/v1/collaboration/roots/' + encodeURIComponent(root.runId)
  const query = new URLSearchParams({ rootAttemptId: binding.rootAttemptId, rootSessionId: sessionId })
  const context = await request(base + '/controller-context?' + new URLSearchParams({ rootSessionId: sessionId, recipientParticipantId: recipient.participantId }))
  expect(context.status, JSON.stringify(context.body)).toBe(200)
  expect(context.body.data.recipient).toMatchObject({ participantId: recipient.participantId, invocationRunId: recipient.invocationRunId })
  const message = { recipientParticipantId: recipient.participantId, recipientInvocationRunId: recipient.invocationRunId,
    message: 'Exact synthetic follow-up ' + backend, requestKey: 'request-' + backend }
  const accepted = await request(base + '/messages?' + query, { method: 'POST', body: JSON.stringify(message) })
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200)
  const receipt = accepted.body.data.receipt as CollaborationReceipt
  expect(receipt).toMatchObject({ requestKey: message.requestKey, state: 'queued', recipientParticipantId: recipient.participantId })
  const duplicate = await request(base + '/messages?' + query, { method: 'POST', body: JSON.stringify(message) })
  expect(duplicate.body.data.receipt).toEqual(receipt)
  const read = await request(base + '/controller-receipts/' + message.requestKey + '?' + query, { headers: { Connection: 'close' } })
  expect(read.body.data.receipt).toEqual(receipt)
  const historyScope = { tenantId: 'default', sessionId: recipient.sessionId }
  const seed = { id: 'synthetic-child-seed-' + backend, role: 'user' as const, content: 'Synthetic child', conversationId: recipient.turnId }
  const raw = backend === 'sqlite' ? new SQLiteConversationHistory() : new JSONLConversationHistory()
  await raw.append(seed, historyScope)
  const consumer = backend === 'sqlite'
    ? await runtime.bindSQLiteDelivery(child.producer, { db, ...historyScope, anchorId: seed.id, executionOwner: childOwner })
    : await runtime.bindJSONLDelivery(child.producer, { origin: jsonlHistoryIdentity(raw as JSONLConversationHistory)!, ...historyScope, anchorId: seed.id, executionOwner: childOwner })
  const consumed = backend === 'sqlite' ? await runtime.consumeSQLiteDelivery(consumer as SQLiteDeliveryConsumer) : await runtime.consumeJSONLDelivery(consumer as JSONLDeliveryConsumer)
  expect(consumed.receipts.map(item => item.messageId)).toEqual([receipt.messageId])
  const snapshot = backend === 'sqlite' ? await runtime.sqliteDeliverySnapshot(consumer as SQLiteDeliveryConsumer, false) : await runtime.jsonlDeliverySnapshot(consumer as JSONLDeliveryConsumer, false)
  expect(JSON.stringify(snapshot)).toContain(message.message)
  const again = backend === 'sqlite' ? await runtime.consumeSQLiteDelivery(consumer as SQLiteDeliveryConsumer) : await runtime.consumeJSONLDelivery(consumer as JSONLDeliveryConsumer)
  expect(again.receipts).toHaveLength(0)
  const rows = await db.execute({ sql: 'SELECT count(*) AS n FROM collaboration_messages WHERE tenant_id=? AND root_run_id=?', args: ['default', root.runId] })
  expect(Number(rows.rows[0].n)).toBe(1)
  const stale = await request(base + '/messages?' + query, { method: 'POST', body: JSON.stringify({ ...message, requestKey: 'stale-' + backend, recipientInvocationRunId: 'wrong-invocation' }) })
  expect(stale.status).toBe(409)
  await close()
}, 30_000)
