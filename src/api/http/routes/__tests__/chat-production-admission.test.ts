/** Actual Fastify inject -> root/child ReAct -> mailbox -> durable result. Scripted adapter only; no listener/model. */
import fs from 'node:fs'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext, Message } from '../../../../core/agent-context/types.js'
import * as database from '../../../../storage/sqlite/db.js'
import { LocalSqliteProcessClient } from '../../../../storage/sqlite/local-process-client.js'
import { rootRunStore } from '../../../../storage/root-runs/index.js'
import { CronStore } from '../../../../storage/cron/index.js'
import { CronRunStore } from '../../../../storage/cron/runs.js'
import { createConversationHistory } from '../../../../storage/conversation/factory.js'
import { prepareUserAdmission, userAdmissionDigest } from '../../../../storage/root-admission/index.js'
import { readAdmissionSeed } from '../../../../storage/root-admission/projection.js'
import * as boundary from '../../../../core/collaboration/production-boundary.js'
import { serviceForOwner } from '../../../../core/collaboration/execution-owner.js'
import { getCollaborationRuntime } from '../../../../core/collaboration/runtime.js'
import * as modelResolver from '../../../../core/llm-adapter/resolve-model.js'
import { resolveCapabilities } from '../../../../core/model-capabilities/index.js'
import { activeStreams } from '../../../../core/stream-pipeline/stream-bus.js'
import { chatRoutes } from '../chat.js'

const tenant = 'default', transport = { toolProfile: 'code', runLifetime: 'durable', subagentProtocol: 2 as const }
const headers = { 'x-aether-tool-profile': 'code', 'x-aether-run-lifetime': 'durable', 'x-aether-subagent-protocol': '2' }
let directory: string, app: FastifyInstance, db: LocalSqliteProcessClient, contexts: AgentContext[], calls: Message[][], sentIds: string[]
beforeEach(async () => {
  await database.closeDb()
  fs.mkdirSync('.e2e-tmp', { recursive: true }); directory = fs.mkdtempSync(path.resolve('.e2e-tmp/chat-production-admission-'))
  for (const [key, value] of Object.entries({ DATA_DIR: path.join(directory, 'fixture.db'), WORKSPACE_ROOT: directory,
    MEMORY_DB_PATH: path.join(directory, 'memory.db'), AETHER_GLOBAL_DIR: path.join(directory, 'global'), SKILLS_ROOT: path.join(directory, 'skills'),
    ENABLE_LONG_TERM_MEMORY: 'false', OSM_MODE: 'off', LOG_LEVEL: 'silent', QA_LOG_ENABLED: 'false' })) vi.stubEnv(key, value)
  fs.writeFileSync(path.join(directory, 'fixture.txt'), 'Exact child disk evidence')
  db = new LocalSqliteProcessClient({ url: 'file:' + path.join(directory, 'fixture.db').replaceAll('\\', '/') })
  vi.spyOn(database, 'getDb').mockImplementation(() => db); await database.initDb()
  contexts = []; calls = []; sentIds = []
  const install = boundary.installProductionCollaborationBoundary
  vi.spyOn(boundary, 'installProductionCollaborationBoundary').mockImplementation(ctx => { install(ctx); contexts.push(ctx) })
  vi.spyOn(modelResolver, 'resolveModelConfig').mockImplementation(async ({ model }) => ({ model: model ?? 'scripted-only', provider: 'fixture',
    capabilities: resolveCapabilities({ model: 'gpt-4o', provider: 'openai' }), thinkingEnabled: false }))
  vi.spyOn(modelResolver, 'createAdapterFromResolved').mockImplementation(config => ({ provider: 'fixture', model: config.model,
    countTokens: text => Math.ceil(text.length / 4), complete: async () => { throw new Error('UNEXPECTED_COMPLETION') },
    async *stream(messages) {
      calls.push(messages)
      const root = contexts.find(ctx => !ctx.runId), child = contexts.find(ctx => ctx.runId)
      if (!root) throw new Error('PRODUCTION_ROOT_BOUNDARY_MISSING')
      const runtime = getCollaborationRuntime()
      if (calls.length === 1) {
        expect(messages.some(message => String(message.content).includes('Exact admitted parent input'))).toBe(true)
        const sent = await runtime.send(serviceForOwner(root.executionOwner!).producerForExecution(root.executionOwner!), {
          recipientParticipantId: 'root:' + root.rootRunId, message: 'Parent canonical mailbox evidence', requestKey: 'root-self' })
        sentIds.push(sent.messageId)
        yield { done: true, finishReason: 'tool_calls', toolCalls: [{ id: 'actual-child', index: 0, name: 'subagent', args: JSON.stringify({ task: 'Exact actual child task', description: 'Admission child', model: 'scripted-only' }) }] }
      } else if (calls.length === 2) {
        if (!child) throw new Error('PRODUCTION_CHILD_BOUNDARY_MISSING')
        expect(messages.some(message => String(message.content).includes('Exact actual child task'))).toBe(true)
        const producer = serviceForOwner(child.executionOwner!).producerForExecution(child.executionOwner!)
        for (const [recipientParticipantId, message] of [['child:' + child.sessionId, 'Child canonical mailbox evidence'], ['root:' + root.rootRunId, 'Child to parent canonical evidence']]) {
          const sent = await runtime.send(producer, { recipientParticipantId, message, requestKey: recipientParticipantId }); sentIds.push(sent.messageId)
        }
        yield { done: true, finishReason: 'tool_calls', toolCalls: [{ id: 'actual-read', index: 0, name: 'read_file', args: JSON.stringify({ path: path.join(directory, 'fixture.txt') }) }] }
      } else if (calls.length === 3) {
        expect(messages.some(message => String(message.content).includes('Child canonical mailbox evidence'))).toBe(true)
        expect(messages.some(message => message.role === 'tool' && String(message.content).includes('Exact child disk evidence'))).toBe(true)
        yield { done: true, finishReason: 'stop', content: 'Exact actual child final' }
      } else {
        expect(calls).toHaveLength(4)
        for (const evidence of ['Parent canonical mailbox evidence', 'Child to parent canonical evidence', 'Exact actual child final']) expect(messages.some(message => String(message.content).includes(evidence))).toBe(true)
        yield { done: true, finishReason: 'stop', content: 'Exact actual parent final' }
      }
    },
  }))
  app = Fastify(); app.decorateRequest('authContext', null)
  app.addHook('onRequest', async (request, reply) => { Object.assign(request, { authContext: { tenantId: tenant } }); reply.raw.setTimeout = () => reply.raw })
})
afterEach(async () => {
  for (const [key, bus] of activeStreams) { if (bus.disconnectTimeout) clearTimeout(bus.disconnectTimeout); await bus.endOrdered(); activeStreams.delete(key) }
  await app.close(); database.closeDb(); expect((await db.closeWithReceipt()).healthy).toBe(true)
  await (await import('../../../../storage/memory/db.js')).closeMemoryDb()
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (path.dirname(directory) !== path.resolve('.e2e-tmp') || !path.basename(directory).startsWith('chat-production-admission-')) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 })
})

describe.each(['jsonl', 'sqlite'])('%s actual production creator admission', backend => {
  it('preserves an explicit empty attachment-only legacy input through actual ReAct projection', async () => {
    vi.stubEnv('HISTORY_BACKEND', backend)
    vi.mocked(modelResolver.createAdapterFromResolved).mockImplementation(config => ({ provider: 'fixture', model: config.model,
      countTokens: text => Math.ceil(text.length / 4), complete: async () => { throw new Error('UNEXPECTED_COMPLETION') },
      async *stream(messages) { calls.push(messages); yield { done: true, finishReason: 'stop', content: 'Attachment final' } },
    }))
    await app.register(chatRoutes)
    const response = await app.inject({ method: 'POST', url: '/chat', headers, payload: { sessionId: 'attachment-only', message: '',
      model: 'scripted-only', workspacePaths: [directory], memoryScope: 'off', skills: [], mcpServers: [], knowledgeBases: [], attachments: [{ name: path.join(directory, 'fixture.txt'), type: 'text/plain' }] } })
    expect(response.statusCode, response.body).toBe(200); expect(response.body).toContain('Attachment final'); expect(calls).toHaveLength(1)
    expect(contexts).toHaveLength(1)
    const root = (await rootRunStore.list(tenant, 'attachment-only'))[0], scope = { tenantId: tenant, sessionId: 'attachment-only' }
    const seed = await readAdmissionSeed(db, scope, root.runId)
    expect(seed.message.content).toBe(''); expect(seed.projected).toBe(true); expect(seed.seedJson).not.toContain('Exact child disk evidence')
    expect(calls[0].some(message => String(message.content).includes('Exact child disk evidence'))).toBe(true)
    const rows = await createConversationHistory().getFullHistory(scope)
    expect(rows.filter(row => row.id === root.userMessageId)).toHaveLength(1)
    expect(rows.find(row => row.id === root.userMessageId)?.content).toBe('')
  })
  it.each(['modern', 'legacy', 'cron'])('%s installs exact root and child boundaries through real /chat', async mode => {
    vi.stubEnv('HISTORY_BACKEND', backend)
    await app.register(chatRoutes, { liveChildRecovery: true, newStreamPublication: true, durableChildRecovery: true })
    let sessionId = 'actual-' + mode
    let body: Record<string, unknown> = { sessionId, message: 'Exact admitted parent input', model: 'scripted-only', workspacePaths: [directory], memoryScope: 'off', thinkingMode: false, skills: [], mcpServers: [], knowledgeBases: [] }
    let occurrenceId: string | undefined
    if (mode === 'cron') {
      const jobs = new CronStore(), runs = new CronRunStore(db), now = Math.floor(Date.now() / 60000) * 60000
      const job = await jobs.create(tenant, { name: 'Actual route occurrence', message: String(body.message), thinkingMode: false,
        configuration: { version: 2, schedule: { kind: 'interval', everyMinutes: 1, anchorAt: now }, target: { kind: 'standalone' }, notificationPolicy: 'silent', toolProfile: 'code' } })
      await db.execute({ sql: 'UPDATE cron_jobs SET next_run_at=? WHERE id=?', args: [now, job.id] })
      const occurrence = (await runs.claimDue((await jobs.getById(job.id, tenant))!, now, now + 60000, now + 1))!
      occurrenceId = occurrence.id; sessionId = occurrence.sessionId
      body = { sessionId, message: occurrence.snapshot.message, automationRunId: occurrence.id, cronJobId: occurrence.jobId, thinkingMode: false, toolProfile: 'code' }
    } else if (mode === 'modern') {
      const context = await rootRunStore.userAdmissionContext(tenant, sessionId)
      const selector = { protocolVersion: 1 as const, namespace: context.namespace, owner: 'work' as const, predecessor: context.predecessor }
      body.admission = { ...selector, requestKey: 'exact-route', bodyDigest: userAdmissionDigest(body, transport, selector) }
    }
    const response = await app.inject({ method: 'POST', url: '/chat', headers, payload: body })
    expect(response.statusCode, response.body).toBe(200); expect(response.body).toContain('Exact actual parent final'); expect(calls).toHaveLength(4)
    const root = (await rootRunStore.list(tenant, sessionId))[0], scope = { tenantId: tenant, sessionId }
    expect(root.status).toBe('succeeded'); expect(contexts).toHaveLength(2)
    const seed = await readAdmissionSeed(db, scope, root.runId)
    expect(seed.message.content).toBe('Exact admitted parent input'); expect(seed.projected).toBe(true)
    const rows = await createConversationHistory().getFullHistory(scope)
    expect(rows.filter(row => row.id === root.userMessageId)).toHaveLength(1)
    expect(rows.find(row => row.id === root.assistantMessageId)?.content).toBe('Exact actual parent final')
    const child = (await db.execute('SELECT run_id FROM subagent_runs')).rows
    expect(child).toHaveLength(1)
    const deliveryTable = backend === 'jsonl' ? 'collaboration_jsonl_deliveries' : 'collaboration_deliveries'
    const receipts = (await db.execute('SELECT message_id,state FROM ' + deliveryTable)).rows
    expect(receipts.filter(row => sentIds.includes(String(row.message_id)))).toHaveLength(3)
    expect(receipts.every(row => row.state === 'integrated')).toBe(true)
    if (mode === 'modern') {
      expect((await rootRunStore.findUserAdmission(tenant, sessionId, prepareUserAdmission(body, transport)!))!.run.runId).toBe(root.runId)
      const replay = await app.inject({ method: 'POST', url: '/chat', headers, payload: body })
      expect(replay.statusCode).toBe(200); expect(calls).toHaveLength(4)
    } else expect(JSON.parse(seed.receiptJson).provenance).toMatchObject(mode === 'cron' ? { kind: 'cron', runId: occurrenceId } : { kind: 'legacy-chat' })
  })
})
