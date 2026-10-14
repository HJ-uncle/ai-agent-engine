/** Fastify inject -> actual registered async tools -> held child ReAct; no listener or real provider. */
import fs from 'node:fs'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext, Message } from '../../../../core/agent-context/types.js'
import * as database from '../../../../storage/sqlite/db.js'
import { LocalSqliteProcessClient } from '../../../../storage/sqlite/local-process-client.js'
import { rootRunStore } from '../../../../storage/root-runs/index.js'
import { createConversationHistory } from '../../../../storage/conversation/factory.js'
import * as boundary from '../../../../core/collaboration/production-boundary.js'
import * as modelResolver from '../../../../core/llm-adapter/resolve-model.js'
import { resolveCapabilities } from '../../../../core/model-capabilities/index.js'
import { activeStreams } from '../../../../core/stream-pipeline/stream-bus.js'
import { chatRoutes } from '../chat.js'

const headers = { 'x-aether-tool-profile': 'code', 'x-aether-run-lifetime': 'durable', 'x-aether-subagent-protocol': '2' }
const barrier = () => { let release!: () => void; const promise = new Promise<void>(yes => { release = yes }); return { promise, release } }
let directory: string, app: FastifyInstance, db: LocalSqliteProcessClient, contexts: AgentContext[]
const releases: (() => void)[] = []
const gate = () => { const value = barrier(); releases.push(value.release); return value }
beforeEach(async () => {
  await database.closeDb()
  fs.mkdirSync('.e2e-tmp', { recursive: true }); directory = fs.mkdtempSync(path.resolve('.e2e-tmp/chat-async-subagents-'))
  for (const [key, value] of Object.entries({ DATA_DIR: path.join(directory, 'fixture.db'), WORKSPACE_ROOT: directory,
    MEMORY_DB_PATH: path.join(directory, 'memory.db'), AETHER_GLOBAL_DIR: path.join(directory, 'global'), SKILLS_ROOT: path.join(directory, 'skills'),
    ENABLE_LONG_TERM_MEMORY: 'false', OSM_MODE: 'off', LOG_LEVEL: 'silent', QA_LOG_ENABLED: 'false' })) vi.stubEnv(key, value)
  db = new LocalSqliteProcessClient({ url: 'file:' + path.join(directory, 'fixture.db').replaceAll('\\', '/') })
  vi.spyOn(database, 'getDb').mockImplementation(() => db); await database.initDb()
  contexts = []
  const install = boundary.installProductionCollaborationBoundary
  vi.spyOn(boundary, 'installProductionCollaborationBoundary').mockImplementation(ctx => { install(ctx); contexts.push(ctx) })
  vi.spyOn(modelResolver, 'resolveModelConfig').mockImplementation(async ({ model }) => ({ model: model ?? 'root-scripted', provider: 'fixture',
    capabilities: resolveCapabilities({ model: 'gpt-4o', provider: 'openai' }), thinkingEnabled: false }))
  app = Fastify(); app.decorateRequest('authContext', null)
  app.addHook('onRequest', async (request, reply) => { Object.assign(request, { authContext: { tenantId: 'default' } }); reply.raw.setTimeout = () => reply.raw })
})
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  for (const [key, bus] of activeStreams) { if (bus.disconnectTimeout) clearTimeout(bus.disconnectTimeout); await bus.endOrdered(); activeStreams.delete(key) }
  await app.close(); await database.closeDb(); expect((await db.closeWithReceipt()).healthy).toBe(true)
  await (await import('../../../../storage/memory/db.js')).closeMemoryDb()
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (path.dirname(directory) !== path.resolve('.e2e-tmp') || !path.basename(directory).startsWith('chat-async-subagents-')) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 })
})

describe.each(['jsonl', 'sqlite'])('%s actual async model tools', backend => {
  it('actual cancel tool stays pending until the held child stops and then returns its exact cancelled result', async () => {
    vi.stubEnv('HISTORY_BACKEND', backend)
    const { registry } = await (await import('../../../../tools/registry-factory.js')).createToolRegistry({ toolProfile: 'code', allowedTools: ['subagent_start', 'subagent_cancel'], allowedMcpServers: [] })
    expect(registry.has('subagent_start')).toBe(true); expect(registry.has('subagent_cancel')).toBe(true)
    const entered = gate(), finish = gate(); let parentCalls = 0, runId = ''
    vi.spyOn(modelResolver, 'createAdapterFromResolved').mockImplementation(config => ({ provider: 'fixture', model: config.model,
      countTokens: text => Math.ceil(text.length / 4), complete: async () => { throw new Error('UNEXPECTED_COMPLETION') },
      async *stream(messages) {
        if (config.model === 'child-cancel') { entered.release(); await finish.promise; yield { done: true, finishReason: 'stop', content: 'Must not become a successful cancelled child' }; return }
        parentCalls++
        if (parentCalls === 1) yield { done: true, finishReason: 'tool_calls', toolCalls: [{ id: 'cancel-start', index: 0, name: 'subagent_start', args: JSON.stringify({ task: 'Actual cancel target', model: 'child-cancel' }) }] }
        else if (parentCalls === 2) {
          await entered.promise; runId = JSON.parse(String(messages.find(message => message.role === 'tool' && message.toolCallId === 'cancel-start')!.content)).runId
          yield { done: true, finishReason: 'tool_calls', toolCalls: [{ id: 'cancel-request', index: 0, name: 'subagent_cancel', args: JSON.stringify({ runId, timeoutMs: 0 }) }] }
        } else if (parentCalls === 3) {
          expect(JSON.parse(String(messages.find(message => message.role === 'tool' && message.toolCallId === 'cancel-request')!.content)).state).toBe('pending')
          expect(contexts.find(ctx => ctx.runId)?.signal?.aborted).toBe(true)
          expect((await db.execute('SELECT status FROM subagent_runs')).rows[0].status).toBe('cancelling')
          finish.release()
          yield { done: true, finishReason: 'tool_calls', toolCalls: [{ id: 'cancel-join', index: 0, name: 'subagent_cancel', args: JSON.stringify({ runId, timeoutMs: 30000 }) }] }
        } else {
          expect(parentCalls).toBe(4)
          const receipt = messages.find(message => message.role === 'tool' && message.toolCallId === 'cancel-join')!
          expect(receipt.metadata?.subagentObservation).toMatchObject({ state: 'completed', run: { runId, status: 'cancelled' } })
          yield { done: true, finishReason: 'stop', content: 'Actual cancellation joined' }
        }
      },
    }))
    await app.register(chatRoutes)
    const response = await app.inject({ method: 'POST', url: '/chat', headers, payload: { sessionId: 'cancel-route', message: 'Start then cancel child', model: 'root-cancel', workspacePaths: [directory], memoryScope: 'off', thinkingMode: false, skills: [], mcpServers: [], knowledgeBases: [] } })
    expect(response.statusCode).toBe(200); expect(response.body).toContain('Actual cancellation joined'); expect(parentCalls).toBe(4)
    const rows = await createConversationHistory().getFullHistory({ tenantId: 'default', sessionId: 'cancel-route' })
    expect(rows.filter(message => message.role === 'tool' && message.toolCallId === 'cancel-start')).toHaveLength(1)
    expect(rows.find(message => message.id === 'subagent-result:' + runId)?.metadata?.subagent).toMatchObject({ status: 'cancelled' })
    expect((await rootRunStore.list('default', 'cancel-route'))[0].status).toBe('succeeded')
  })
  it('actual parent final output remains draining until the asynchronous child executor and independent projection really settle', async () => {
    vi.stubEnv('HISTORY_BACKEND', backend)
    const { registry } = await (await import('../../../../tools/registry-factory.js')).createToolRegistry({ toolProfile: 'code', allowedTools: ['subagent_start'], allowedMcpServers: [] })
    expect(registry.has('subagent_start')).toBe(true)
    const entered = gate(), finish = gate(); let parentCalls = 0
    vi.spyOn(modelResolver, 'createAdapterFromResolved').mockImplementation(config => ({ provider: 'fixture', model: config.model,
      countTokens: text => Math.ceil(text.length / 4), complete: async () => { throw new Error('UNEXPECTED_COMPLETION') },
      async *stream() {
        if (config.model === 'child-drain') { entered.release(); await finish.promise; yield { done: true, finishReason: 'stop', content: 'Exact async child after parent final' }; return }
        parentCalls++
        if (parentCalls === 1) yield { done: true, finishReason: 'tool_calls', toolCalls: [{ id: 'drain-start', index: 0, name: 'subagent_start', args: JSON.stringify({ task: 'Actual drain target', model: 'child-drain' }) }] }
        else { await entered.promise; yield { done: true, finishReason: 'stop', content: 'Actual parent final before child join' } }
      },
    }))
    await app.register(chatRoutes)
    let settled = false
    const pending = app.inject({ method: 'POST', url: '/chat', headers, payload: { sessionId: 'drain-route', message: 'Start child then finish parent', model: 'root-drain', workspacePaths: [directory], memoryScope: 'off', thinkingMode: false, skills: [], mcpServers: [], knowledgeBases: [] } }).then(response => { settled = true; return response })
    try {
      await expect.poll(async () => (await db.execute('SELECT phase FROM collaboration_roots')).rows[0]?.phase).toBe('draining')
      expect(settled).toBe(false); expect((await db.execute('SELECT status FROM subagent_runs')).rows[0].status).toBe('running')
      finish.release(); const response = await pending
      expect(response.statusCode).toBe(200); expect(response.body).toContain('Actual parent final before child join')
      expect((await rootRunStore.list('default', 'drain-route'))[0].status).toBe('succeeded')
      const child = (await db.execute('SELECT run_id FROM subagent_runs')).rows[0]
      const rows = await createConversationHistory().getFullHistory({ tenantId: 'default', sessionId: 'drain-route' })
      expect(rows.find(message => message.id === 'subagent-result:' + child.run_id)).toMatchObject({ role: 'assistant', metadata: { subagentNotification: { parentToolCallId: 'drain-start' }, subagent: { status: 'succeeded' } } })
    } finally { finish.release(); await pending }
  })
  it('start returns while child is held, parent/child send with real identities, and wait keeps one result per call plus independent completion', async () => {
    vi.stubEnv('HISTORY_BACKEND', backend)
    const { registry } = await (await import('../../../../tools/registry-factory.js')).createToolRegistry({ toolProfile: 'code', allowedTools: ['subagent_start', 'subagent_wait', 'subagent_send', 'subagent_participants', 'subagent_inbox'], allowedMcpServers: [] })
    expect(registry.has('subagent_start')).toBe(true); expect(registry.has('subagent_wait')).toBe(true)
    const entered = gate(), finish = gate(); let parentCalls = 0, childCalls = 0, runId = '', childSessionId = ''
    const providerInputs: Message[][] = []
    vi.spyOn(modelResolver, 'createAdapterFromResolved').mockImplementation(config => ({ provider: 'fixture', model: config.model,
      countTokens: text => Math.ceil(text.length / 4), complete: async () => { throw new Error('UNEXPECTED_COMPLETION') },
      async *stream(messages) {
        providerInputs.push(messages)
        const root = contexts.find(ctx => !ctx.runId)!
        if (config.model === 'child-scripted') {
          childCalls++
          const child = contexts.find(ctx => !!ctx.runId)!
          expect(child.tools.has('subagent_start')).toBe(false); expect(child.tools.has('subagent')).toBe(false)
          if (childCalls === 1) {
            entered.release(); await finish.promise
            yield { done: true, finishReason: 'tool_calls', toolCalls: [{ id: 'child-participants', index: 0, name: 'subagent_participants', args: '{}' }] }
          } else if (childCalls === 2) {
            expect(messages.some(message => String(message.content).includes('Actual parent to child message'))).toBe(true)
            yield { done: true, finishReason: 'tool_calls', toolCalls: [{ id: 'child-reply', index: 0, name: 'subagent_send', args: JSON.stringify({ recipientParticipantId: 'root:' + root.rootRunId, message: 'Actual child to parent reply' }) }] }
          } else {
            expect(childCalls).toBe(3); yield { done: true, finishReason: 'stop', content: 'Actual async child final' }
          }
          return
        }
        parentCalls++
        if (parentCalls === 1) {
          yield { done: true, finishReason: 'tool_calls', toolCalls: [{ id: 'async-start', index: 0, name: 'subagent_start', args: JSON.stringify({ task: 'Actual asynchronous child task', model: 'child-scripted' }) }] }
        } else if (parentCalls === 2) {
          await entered.promise
          const receipt = messages.find(message => message.role === 'tool' && message.toolCallId === 'async-start')!
          const admission = JSON.parse(String(receipt.content)); expect(admission.state).toBe('admitted')
          runId = admission.runId; childSessionId = admission.childSessionId
          expect((await db.execute('SELECT status FROM subagent_runs')).rows[0].status).toBe('running')
          yield { done: true, finishReason: 'tool_calls', toolCalls: [{ id: 'parent-send', index: 0, name: 'subagent_send', args: JSON.stringify({ recipientParticipantId: 'child:' + childSessionId, message: 'Actual parent to child message' }) }] }
        } else if (parentCalls === 3) {
          expect(messages.some(message => message.toolCallId === 'parent-send' && String(message.content).includes('queued'))).toBe(true)
          yield { done: true, finishReason: 'tool_calls', toolCalls: [
            { id: 'parent-participants', index: 0, name: 'subagent_participants', args: '{"limit":1}' },
            { id: 'parent-inbox', index: 1, name: 'subagent_inbox', args: '{}' },
          ] }
        } else if (parentCalls === 4) {
          yield { done: true, finishReason: 'tool_calls', toolCalls: [{ id: 'parent-poll', index: 0, name: 'subagent_wait', args: JSON.stringify({ runId, timeoutMs: 0 }) }] }
        } else if (parentCalls === 5) {
          expect(messages.some(message => message.role === 'tool' && message.toolCallId === 'parent-poll' && JSON.parse(String(message.content)).state === 'pending')).toBe(true)
          finish.release()
          yield { done: true, finishReason: 'tool_calls', toolCalls: [{ id: 'parent-join', index: 0, name: 'subagent_wait', args: JSON.stringify({ runId, timeoutMs: 30000 }) }] }
        } else {
          expect(parentCalls).toBe(6)
          expect(messages.filter(message => message.role === 'tool' && message.toolCallId === 'async-start')).toHaveLength(1)
          expect(messages.some(message => message.role === 'tool' && message.toolCallId === 'parent-join' && String(message.content).includes('Actual async child final'))).toBe(true)
          expect(messages.some(message => message.role === 'assistant' && message.metadata?.subagentNotification && String(message.content).includes('Actual async child final'))).toBe(true)
          expect(messages.some(message => String(message.content).includes('Actual child to parent reply'))).toBe(true)
          yield { done: true, finishReason: 'stop', content: 'Actual async parent final' }
        }
      },
    }))
    await app.register(chatRoutes)
    const response = await app.inject({ method: 'POST', url: '/chat', headers, payload: { sessionId: 'async-route', message: 'Start and coordinate actual child',
      model: 'root-scripted', workspacePaths: [directory], memoryScope: 'off', thinkingMode: false, skills: [], mcpServers: [], knowledgeBases: [] } })
    expect(response.statusCode, response.body).toBe(200); expect(response.body).toContain('Actual async parent final')
    expect(parentCalls).toBe(6); expect(childCalls).toBe(3)
    const root = (await rootRunStore.list('default', 'async-route'))[0], rows = await createConversationHistory().getFullHistory({ tenantId: 'default', sessionId: 'async-route' })
    expect(root.status).toBe('succeeded')
    expect(rows.filter(message => message.role === 'tool' && message.toolCallId === 'async-start')).toHaveLength(1)
    expect(rows.filter(message => message.id === 'subagent-result:' + runId)).toHaveLength(1)
    expect(rows.find(message => message.id === 'subagent-result:' + runId)).toMatchObject({ role: 'assistant', metadata: { subagentNotification: { runId, parentToolCallId: 'async-start' } } })
    const mail = (await db.execute('SELECT sender_participant_id,recipient_participant_id FROM collaboration_messages ORDER BY seq')).rows
    expect(mail).toEqual([{ sender_participant_id: 'root:' + root.runId, recipient_participant_id: 'child:' + childSessionId }, { sender_participant_id: 'child:' + childSessionId, recipient_participant_id: 'root:' + root.runId }])
    const deliveryTable = backend === 'jsonl' ? 'collaboration_jsonl_deliveries' : 'collaboration_deliveries'
    expect((await db.execute('SELECT state FROM ' + deliveryTable)).rows).toEqual([{ state: 'integrated' }, { state: 'integrated' }])
    for (const messages of providerInputs) {
      const resultIds = messages.filter(message => message.role === 'tool').map(message => message.toolCallId)
      expect(new Set(resultIds).size).toBe(resultIds.length)
    }
  })
})
