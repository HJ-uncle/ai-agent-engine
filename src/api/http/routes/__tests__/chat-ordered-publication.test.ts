/** Real Fastify route, ReAct, delegated child, file/history effects and native SQLite.
 * Only the model adapter is synthetic; publication COMMIT ACK is held/faulted. */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import type { InStatement, Transaction, TransactionMode } from '@libsql/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LLMAdapter } from '../../../../core/llm-adapter/types.js'
import type { Message } from '../../../../core/agent-context/types.js'
import { resolveCapabilities } from '../../../../core/model-capabilities/index.js'
import * as resolver from '../../../../core/llm-adapter/resolve-model.js'
import { initDb, getDb, closeDb } from '../../../../storage/sqlite/db.js'
import { closeMemoryDb } from '../../../../storage/memory/db.js'
import { SQLiteAgentStore } from '../../../../storage/agent/index.js'
import { createConversationHistory } from '../../../../storage/conversation/factory.js'
import { rootRunStore } from '../../../../storage/root-runs/index.js'
import { userAdmissionDigest } from '../../../../storage/root-admission/index.js'
import { readAdmissionSeed } from '../../../../storage/root-admission/projection.js'
import { getSubagentStore } from '../../../../core/subagent/store.js'
import { activeStreams, StreamBus as StreamBusClass, type StreamBus } from '../../../../core/stream-pipeline/stream-bus.js'
import { getExecutionOwners } from '../../../../core/collaboration/execution-owner.js'
import { chatRoutes, stopAllOwnedExecutions, stopOwnedRoot } from '../chat.js'

const tenantId = 'p4-parent'
const barrier = () => { let release!: () => void; const promise = new Promise<void>(yes => { release = yes }); return { promise, release } }
let root: string, mainId: string, childId: string
const apps: FastifyInstance[] = [], holds: ReturnType<typeof barrier>[] = []
const calls: Array<{ model: string; session: string }> = []
const signals: AbortSignal[] = []
let compactionCalls = 0
function hold() { const value = barrier(); holds.push(value); return value }
beforeEach(async () => {
  root = path.resolve('.e2e-tmp', 'p4-publication-' + randomUUID()); fs.mkdirSync(root, { recursive: true })
  for (const [key, value] of Object.entries({ DATA_DIR: path.join(root, 'agent.db'), MEMORY_DB_PATH: path.join(root, 'memory.db'),
    KNOWLEDGE_DB_PATH: path.join(root, 'knowledge.db'), AETHER_GLOBAL_DIR: path.join(root, 'global'), SKILLS_ROOT: path.join(root, 'skills'),
    WORKSPACE_ROOT: root, HISTORY_BACKEND: 'jsonl', ENABLE_LONG_TERM_MEMORY: 'false', AUTH_ENABLED: 'false',
    QA_LOG_ENABLED: 'false', OSM_MODE: 'off', DEFAULT_SECURITY_MODE: 'standard', LOG_LEVEL: 'silent' })) vi.stubEnv(key, value)
  fs.mkdirSync(path.join(root, 'skills')); await initDb()
  const agents = new SQLiteAgentStore()
  mainId = (await agents.create(tenantId, { name: 'Synthetic parent', model: 'p4-main', skills: [], mcpServers: [], knowledgeBases: [], allowedTools: [] })).id
  childId = (await agents.create(tenantId, { name: 'Synthetic child', model: 'p4-child', skills: [], mcpServers: [], knowledgeBases: [], allowedTools: ['write_file'] })).id
  vi.spyOn(resolver, 'resolveModelConfig').mockImplementation(async ({ model, parent }) => ({ model: model ?? parent?.model ?? 'p4-main',
    provider: 'fixture', capabilities: resolveCapabilities({ model: 'gpt-4o', provider: 'openai' }), thinkingEnabled: false }))
  vi.spyOn(resolver, 'createAdapterFromResolved').mockImplementation(config => {
    const adapter: LLMAdapter = { provider: 'fixture', model: config.model, countTokens: text => Math.ceil(text.length / 4),
      complete: async () => { compactionCalls++; return { content: 'SYNTHETIC_COMPACTION_SUMMARY', promptTokens: 20, completionTokens: 10, finishReason: 'stop' } },
      async *stream(messages, options) {
        const task = String(messages.find(message => message.role === 'user')?.content ?? 'task')
        const session = task.includes('peer') ? 'peer' : 'primary'
        calls.push({ model: config.model, session }); if (options?.signal) signals.push(options.signal)
        if (config.model === 'p4-child' && !messages.some(message => message.role === 'tool' && message.toolName === 'write_file')) {
          yield { done: true, finishReason: 'tool_calls', promptTokens: 10, completionTokens: 5,
            toolCalls: [{ id: 'p4-write', name: 'write_file', args: JSON.stringify({ path: 'child-' + session + '.txt', data: 'DURABLE_CHILD_' + session }), index: 0 }] }
          return
        }
        yield { done: true, finishReason: 'stop', content: (config.model === 'p4-child' ? 'CHILD_RESULT_' : 'MAIN_RESULT_') + session,
          promptTokens: 11, completionTokens: 6 }
      },
    }
    return adapter
  })
  calls.length = 0; signals.length = 0; compactionCalls = 0
})
afterEach(async () => {
  for (const value of holds.splice(0)) value.release()
  await stopAllOwnedExecutions('P4 fixture cleanup')
  for (const app of apps.splice(0)) await app.close()
  for (const [key, bus] of activeStreams) if (key.startsWith(tenantId + ':')) {
    if (bus.disconnectTimeout) clearTimeout(bus.disconnectTimeout)
    activeStreams.delete(key)
  }
  for (const receipt of await Promise.all([closeMemoryDb(), closeDb()])) if (receipt) expect(receipt.healthy, JSON.stringify(receipt)).toBe(true)
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (!root.startsWith(path.resolve('.e2e-tmp') + path.sep)) throw new Error('Unsafe P4 fixture cleanup')
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 })
})
async function app(newStreamPublication = false) {
  const server = Fastify(); apps.push(server)
  server.decorateRequest('authContext', null)
  server.addHook('onRequest', async request => { Object.assign(request, { authContext: { tenantId } }) })
  await server.register(chatRoutes, { newStreamPublication })
  return server.listen({ host: '127.0.0.1', port: 0 })
}
function chat(base: string, sessionId: string, protocol?: 2, extras: Record<string, unknown> = {}, query = '') {
  return fetch(base + '/chat' + query, { method: 'POST', headers: { 'content-type': 'application/json', 'x-aether-run-lifetime': 'durable',
    ...(protocol ? { 'x-aether-subagent-protocol': String(protocol) } : {}) },
    body: JSON.stringify({ sessionId, agentId: mainId, model: 'p4-main', message: 'Synthetic ' + (sessionId.includes('peer') ? 'peer' : 'primary') + ' task',
      collaborators: [{ agentId: childId }], memoryScope: 'off', workspacePaths: [root], ...extras }) })
}
async function bus(sessionId: string): Promise<StreamBus> {
  await vi.waitFor(() => expect(activeStreams.has(tenantId + ':' + sessionId)).toBe(true))
  return activeStreams.get(tenantId + ':' + sessionId)!
}
const sqlOf = (statement: InStatement) => typeof statement === 'string' ? statement : Array.isArray(statement) ? String(statement[0]) : statement.sql
function publicationBarrier(mode: 'hold-terminal-ack' | 'fail-child-commit') {
  const entered = hold(), release = hold(), db = getDb(), transaction = db.transaction.bind(db)
  let triggered = false, enteredAck = false
  vi.spyOn(db, 'transaction').mockImplementation(async (modeName?: TransactionMode) => {
    const tx: Transaction = await transaction(modeName), execute = tx.execute.bind(tx), commit = tx.commit.bind(tx)
    let ownsTarget = false
    vi.spyOn(tx, 'execute').mockImplementation(async statement => {
      if (!triggered && sqlOf(statement).startsWith('INSERT INTO parent_published_child_versions')) {
        const args = typeof statement !== 'string' && !Array.isArray(statement) && Array.isArray(statement.args) ? statement.args : []
        if (mode === 'fail-child-commit' || args[10] !== null) { triggered = true; ownsTarget = true }
      }
      return execute(statement)
    })
    vi.spyOn(tx, 'commit').mockImplementation(async () => {
      if (ownsTarget && mode === 'fail-child-commit') { enteredAck = true; entered.release(); throw new Error('SYNTHETIC_PUBLICATION_COMMIT_FAILED') }
      await commit()
      if (ownsTarget) { enteredAck = true; entered.release(); await release.promise }
    })
    return tx
  })
  return { entered, release, wasEntered: () => enteredAck }
}

function frameBarrier(matches: (chunk: string) => boolean) {
  const entered = hold(), release = hold(), publish = StreamBusClass.prototype.publish
  let held = false
  vi.spyOn(StreamBusClass.prototype, 'publish').mockImplementation(async function (this: StreamBus, chunk) {
    if (!held && matches(chunk)) { held = true; entered.release(); await release.promise }
    return publish.call(this, chunk)
  })
  return { entered, release, wasEntered: () => held }
}

describe('awaited real chat producer publication', () => {
  it('keeps attachment-only display text empty while the real file content reaches the synthetic model exactly once', async () => {
    const fileName = '.ae/attachments/only-file.txt', marker = 'SYNTHETIC_ATTACHMENT_ONLY_CONTENT'
    fs.mkdirSync(path.join(root, '.ae/attachments'), { recursive: true })
    fs.writeFileSync(path.join(root, fileName), marker)
    const base = await app(true), sessionId = 'integrated-attachment-only'
    const transport = { toolProfile: 'general', runLifetime: 'durable', subagentProtocol: 2 as const }
    const context = (await (await fetch(base + '/chat/admission/context?sessionId=' + sessionId)).json()).data
    const selector = { protocolVersion: 1 as const, namespace: context.namespace, owner: 'work' as const, predecessor: null }
    const body = { sessionId, agentId: mainId, model: 'p4-main', message: '', collaborators: [], memoryScope: 'off', workspacePaths: [root],
      attachments: [{ name: fileName, type: 'text/plain' }] }
    const admission = { ...selector, requestKey: 'attachment-only-key', bodyDigest: userAdmissionDigest(body, transport, selector) }
    let observedInput: Message['content'] | undefined
    const factory = resolver.createAdapterFromResolved
    vi.mocked(factory).mockImplementation(config => ({ provider: 'fixture', model: config.model, countTokens: text => Math.ceil(text.length / 4),
      complete: async () => { throw new Error('UNEXPECTED_ATTACHMENT_COMPLETION') },
      async *stream(messages) { calls.push({ model: config.model, session: 'attachment-only' }); observedInput = messages.find(message => message.role === 'user')?.content
        yield { done: true, finishReason: 'stop', content: 'ATTACHMENT_ONLY_RESULT', promptTokens: 11, completionTokens: 5 } },
    }))
    const response = await chat(base, sessionId, 2, { ...body, admission })
    expect(response.status).toBe(200); expect(await response.text()).toContain('ATTACHMENT_ONLY_RESULT')
    expect(observedInput).toContain(marker)
    const terminal = (await rootRunStore.latest(tenantId, sessionId))!
    expect(terminal.status).toBe('succeeded')
    const seed = await readAdmissionSeed(getDb(), { tenantId, sessionId }, terminal.runId)
    expect(seed.projected).toBe(true)
    const history = await createConversationHistory().getFullHistory({ tenantId, sessionId })
    const users = history.filter(message => message.id === seed.anchor.userMessageId)
    expect(users).toHaveLength(1)
    expect(users[0]).toMatchObject({ content: '', metadata: { attachments: [{ name: fileName, type: 'text/plain' }] } })
    expect(users[0].modelInputContent).toContain(marker)
    expect(seed.message.content).toBe('')
    const replay = await chat(base, sessionId, 2, { ...body, admission })
    expect(replay.status).toBe(200); expect(await replay.text()).toContain(terminal.runId)
    expect(calls).toHaveLength(1)
    expect((await rootRunStore.list(tenantId, sessionId))).toHaveLength(1)
  }, 25_000)

  it('integrates exact keyed admission with held child publication and replays without a second producer', async () => {
    const base = await app(true), sessionId = 'integrated-keyed-publication'
    const transport = { toolProfile: 'general', runLifetime: 'durable', subagentProtocol: 2 as const }
    const contextResponse = await fetch(base + '/chat/admission/context?sessionId=' + sessionId, {
      headers: { 'x-aether-run-lifetime': 'durable', 'x-aether-subagent-protocol': '2' },
    })
    expect(contextResponse.status).toBe(200)
    const context = (await contextResponse.json()).data
    expect(context).toMatchObject({ tenantId, sessionId, transport, predecessor: null })
    const selector = { protocolVersion: 1 as const, namespace: context.namespace, owner: 'work' as const, predecessor: null }
    const body = { sessionId, agentId: mainId, model: 'p4-main', message: 'Synthetic primary task',
      collaborators: [{ agentId: childId }], memoryScope: 'off', workspacePaths: [root] }
    const admission = { ...selector, requestKey: 'integrated-exact-key', bodyDigest: userAdmissionDigest(body, transport, selector) }
    const gate = publicationBarrier('hold-terminal-ack')
    const response = await chat(base, sessionId, 2, { admission }), result = response.text(), current = await bus(sessionId)
    expect(response.status).toBe(200)
    await vi.waitFor(() => expect(gate.wasEntered()).toBe(true), { timeout: 2_000 })
    const running = (await rootRunStore.latest(tenantId, sessionId))!
    expect(running.status).toBe('running')
    expect((await rootRunStore.list(tenantId, sessionId))).toHaveLength(1)
    expect(fs.readFileSync(path.join(root, 'child-primary.txt'), 'utf8')).toBe('DURABLE_CHILD_primary')
    expect(calls.filter(call => call.model === 'p4-main')).toHaveLength(0)
    expect(current.finished).toBe(false)
    gate.release.release()
    expect(await result).toContain('MAIN_RESULT_primary')
    const terminal = (await rootRunStore.latest(tenantId, sessionId))!
    expect(terminal).toMatchObject({ runId: running.runId, status: 'succeeded' })
    const seed = await readAdmissionSeed(getDb(), { tenantId, sessionId }, terminal.runId)
    expect(seed.projected).toBe(true)
    const history = await createConversationHistory().getFullHistory({ tenantId, sessionId })
    expect(history.filter(message => message.id === seed.anchor.userMessageId)).toHaveLength(1)
    expect(history.find(message => message.id === terminal.assistantMessageId)?.content).toBe('MAIN_RESULT_primary')
    const publicationRows = await getDb().execute('SELECT count(*) AS count FROM parent_published_child_versions')
    expect(Number(publicationRows.rows[0].count)).toBeGreaterThan(0)
    const beforeReplay = calls.length
    const replay = await chat(base, sessionId, 2, { admission })
    expect(replay.status).toBe(200); expect(await replay.text()).toContain(terminal.runId)
    expect(calls).toHaveLength(beforeReplay)
    expect((await rootRunStore.list(tenantId, sessionId))).toHaveLength(1)
    expect((await getSubagentStore().listRunViewsForParent(tenantId, sessionId))).toHaveLength(1)
    expect(activeStreams.get(tenantId + ':' + sessionId)).toBe(current)
    expect((await getDb().execute('SELECT count(*) AS count FROM parent_published_child_versions')).rows[0].count).toBe(publicationRows.rows[0].count)
    const receipt = await fetch(base + '/chat/admission/receipt', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, namespace: context.namespace, requestKey: admission.requestKey, bodyDigest: admission.bodyDigest }) })
    expect(receipt.status).toBe(200)
    expect((await receipt.json()).data).toMatchObject({ status: 'accepted', receipt: { rootRunId: terminal.runId },
      projection: { user: { state: 'projected' }, assistant: { state: 'persisted', messageId: terminal.assistantMessageId } } })
  }, 25_000)

  it('holds parent content and end until the exact terminal child evidence COMMIT ACK while preserving legacy output', async () => {
    const base = await app(true), gate = publicationBarrier('hold-terminal-ack'), sessionId = 'p4-held-end'
    const response = await chat(base, sessionId), body = response.text(), current = await bus(sessionId)
    await vi.waitFor(() => expect(gate.wasEntered()).toBe(true), { timeout: 2_000 })
    await getDb().execute('SELECT 1')
    expect(fs.readFileSync(path.join(root, 'child-primary.txt'), 'utf8')).toBe('DURABLE_CHILD_primary')
    expect((await getSubagentStore().listRunViewsForParent(tenantId, sessionId))[0].status).toBe('succeeded')
    expect(calls.filter(call => call.model === 'p4-main')).toHaveLength(0)
    expect(current.events.some(event => event.chunk.includes('MAIN_RESULT'))).toBe(false)
    expect(current.finished).toBe(false)
    expect((await rootRunStore.latest(tenantId, sessionId))?.status).toBe('running')
    gate.release.release()
    const result = await body
    expect(result).toContain('MAIN_RESULT_primary')
    expect(result).toContain('"schemaVersion":1')
    expect((await rootRunStore.latest(tenantId, sessionId))?.status).toBe('succeeded')
    expect(current.finished).toBe(true)
    expect(signals.every(signal => !signal.aborted)).toBe(true)
    const persisted = await createConversationHistory().getFullHistory({ tenantId, sessionId })
    expect(persisted.some(message => message.role === 'assistant' && message.content === 'MAIN_RESULT_primary')).toBe(true)
  }, 25_000)

  it('joins the same held child publication before the real owned stop can acknowledge terminal cancellation', async () => {
    const base = await app(true), gate = publicationBarrier('hold-terminal-ack'), sessionId = 'p4-held-stop'
    const response = await chat(base, sessionId, 2), body = response.text(), current = await bus(sessionId)
    await vi.waitFor(() => expect(gate.wasEntered()).toBe(true), { timeout: 2_000 })
    const latest = (await rootRunStore.latest(tenantId, sessionId))!, run = (await rootRunStore.get(tenantId, latest.runId))!
    const owner = getExecutionOwners().find(tenantId, run.runId, run.attemptId)!
    const record = getExecutionOwners().record(owner)
    let acknowledged = false
    const stopping = stopOwnedRoot(tenantId, sessionId, run.runId, 'Synthetic user stop').then(result => { acknowledged = true; return result })
    await vi.waitFor(() => expect(record.controller.signal.aborted).toBe(true))
    await getDb().execute('SELECT 1')
    expect(acknowledged).toBe(false); expect(current.finished).toBe(false)
    gate.release.release()
    expect(await stopping).toBe(true); await body
    expect((await rootRunStore.latest(tenantId, sessionId))?.status).toBe('cancelled')
    expect(current.snapshot().projection.find(frame => frame.run)?.run).toMatchObject({ status: 'cancelled' })
    expect(calls.filter(call => call.model === 'p4-main')).toHaveLength(0)
  }, 25_000)

  it('reports observation recovery after evidence failure while the child, executor, peer and history all complete', async () => {
    const primaryBase = await app(true), peerBase = await app(), gate = publicationBarrier('fail-child-commit')
    const primaryResponse = await chat(primaryBase, 'p4-failed-evidence', 2), primaryBody = primaryResponse.text()
    const current = await bus('p4-failed-evidence')
    await vi.waitFor(() => expect(gate.wasEntered()).toBe(true), { timeout: 2_000 })
    const peerResponse = await chat(peerBase, 'p4-peer', 2), peerBody = await peerResponse.text()
    await primaryBody
    await vi.waitFor(async () => expect((await rootRunStore.latest(tenantId, 'p4-failed-evidence'))?.status).toBe('succeeded'))
    expect(peerBody).toContain('MAIN_RESULT_peer')
    expect((await rootRunStore.latest(tenantId, 'p4-peer'))?.status).toBe('succeeded')
    expect(current.snapshot()).toMatchObject({ finished: true, publicationRecovery: { reason: 'evidence_unavailable' } })
    expect(current.disconnectTimeout).toBeNull()
    expect(current.abortController.signal.aborted).toBe(false)
    expect(signals.every(signal => !signal.aborted)).toBe(true)
    expect(fs.readFileSync(path.join(root, 'child-primary.txt'), 'utf8')).toBe('DURABLE_CHILD_primary')
    expect(fs.readFileSync(path.join(root, 'child-peer.txt'), 'utf8')).toBe('DURABLE_CHILD_peer')
    const history = await createConversationHistory().getFullHistory({ tenantId, sessionId: 'p4-failed-evidence' })
    expect(history.some(message => message.role === 'assistant' && message.content === 'MAIN_RESULT_primary')).toBe(true)
    expect((await getSubagentStore().listRunViewsForParent(tenantId, 'p4-failed-evidence'))[0].status).toBe('succeeded')
    expect(calls.filter(call => call.model === 'p4-main')).toHaveLength(2)
  }, 25_000)

  it('does not allow a body or query to enable the unadvertised trusted new-stream evidence authority', async () => {
    const base = await app(), result = await chat(base, 'p4-default', undefined, { newStreamPublication: true }, '?newStreamPublication=true')
    expect(result.status).toBe(200)
    expect(await result.text()).toContain('MAIN_RESULT_primary')
    const count = await getDb().execute('SELECT count(*) AS count FROM parent_publication_state')
    expect(Number(count.rows[0].count)).toBe(0)
  }, 25_000)

  it('awaits the first user seed before advertising a producer or dispatching either model', async () => {
    const base = await app(), gate = frameBarrier(chunk => chunk.startsWith('\x00__user_message__'))
    const pending = chat(base, 'p4-user-seed', 2)
    await vi.waitFor(() => expect(gate.wasEntered()).toBe(true), { timeout: 2_000 })
    await getDb().execute('SELECT 1')
    expect(calls).toHaveLength(0)
    expect(activeStreams.has(tenantId + ':p4-user-seed')).toBe(false)
    expect((await rootRunStore.latest(tenantId, 'p4-user-seed'))?.status).toBe('running')
    gate.release.release()
    expect(await (await pending).text()).toContain('MAIN_RESULT_primary')
  }, 25_000)

  it('awaits the ReAct outcome callback publication after durable success before the bus end', async () => {
    const base = await app(), gate = frameBarrier(chunk => chunk.startsWith('\x00__run__') && JSON.parse(chunk.slice('\x00__run__'.length)).status === 'succeeded')
    const response = await chat(base, 'p4-outcome', 2), body = response.text(), current = await bus('p4-outcome')
    await vi.waitFor(() => expect(gate.wasEntered()).toBe(true), { timeout: 2_000 })
    await getDb().execute('SELECT 1')
    expect((await rootRunStore.latest(tenantId, 'p4-outcome'))?.status).toBe('succeeded')
    expect(current.finished).toBe(false)
    gate.release.release(); expect(await body).toContain('MAIN_RESULT_primary')
    expect(current.finished).toBe(true)
  }, 25_000)

  it('awaits real post-turn compaction publication before summarization and end', async () => {
    vi.stubEnv('AUTO_COMPACT_THRESHOLD_RATIO', '0')
    // The actual compactor deliberately leaves the latest six messages intact.
    // Prior complete exchanges make this real session eligible for maintenance.
    const history = createConversationHistory()
    for (let index = 0; index < 8; index++) await history.append({ role: index % 2 ? 'assistant' : 'user', content: 'Prior complete exchange ' + index,
      conversationId: 'prior-' + Math.floor(index / 2), tokens: 6 } as Message & { conversationId: string }, { tenantId, sessionId: 'p4-compaction' })
    const base = await app(), gate = frameBarrier(chunk => chunk.startsWith('\x00__run__') && JSON.parse(chunk.slice('\x00__run__'.length)).compaction?.phase === 'running')
    const response = await chat(base, 'p4-compaction', 2), body = response.text(), current = await bus('p4-compaction')
    await vi.waitFor(() => expect(gate.wasEntered()).toBe(true), { timeout: 2_000 })
    await getDb().execute('SELECT 1')
    expect(compactionCalls).toBe(0); expect(current.finished).toBe(false)
    expect((await rootRunStore.latest(tenantId, 'p4-compaction'))?.compaction?.phase).toBe('running')
    gate.release.release(); await body
    expect(compactionCalls).toBe(1); expect(current.finished).toBe(true)
    expect((await rootRunStore.latest(tenantId, 'p4-compaction'))?.compaction?.phase).toBe('succeeded')
    expect((await createConversationHistory().getFullHistory({ tenantId, sessionId: 'p4-compaction' })).some(message => message.metadata?.isCompactSummary === true)).toBe(true)
  }, 25_000)
})
