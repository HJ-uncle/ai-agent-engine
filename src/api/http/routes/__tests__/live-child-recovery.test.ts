/** Real HTTP, actual chat admission/publication and independent native WAL child
 * commits. Only model adapter output is synthetic; no provider/Electron. */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { Transaction, TransactionMode } from '@libsql/client'
import * as resolver from '../../../../core/llm-adapter/resolve-model.js'
import { resolveCapabilities } from '../../../../core/model-capabilities/index.js'
import { initDb, getDb, closeDb } from '../../../../storage/sqlite/db.js'
import { LocalSqliteProcessClient } from '../../../../storage/sqlite/local-process-client.js'
import { closeMemoryDb } from '../../../../storage/memory/db.js'
import { SQLiteAgentStore } from '../../../../storage/agent/index.js'
import { createConversationHistory } from '../../../../storage/conversation/factory.js'
import type { Message } from '../../../../core/agent-context/types.js'
import { rootRunStore } from '../../../../storage/root-runs/index.js'
import { SubagentStore } from '../../../../core/subagent/store.js'
import { resetParentChildRecovery } from '../../../../core/subagent/child-usage-authority.js'
import { childRecoveryService } from '../live-child-recovery.js'
import { activeStreams, type StreamBus } from '../../../../core/stream-pipeline/stream-bus.js'
import { chatRoutes, stopAllOwnedExecutions } from '../chat.js'

const barrier = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }
const tenantId = 'p5a-actor', sessionId = 'p5a-session'
let root: string, mainId: string, app: FastifyInstance, base: string, bus: StreamBus, peer: LocalSqliteProcessClient
let mainGate: ReturnType<typeof barrier>, compactGate: ReturnType<typeof barrier>, compactEntered: boolean, body: Promise<string> | undefined
const signals: AbortSignal[] = []
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  root = path.resolve('.e2e-tmp', 'p5a-http-' + randomUUID()); fs.mkdirSync(root, { recursive: true })
  for (const [key, value] of Object.entries({ DATA_DIR: path.join(root, 'agent.db'), MEMORY_DB_PATH: path.join(root, 'memory.db'),
    KNOWLEDGE_DB_PATH: path.join(root, 'knowledge.db'), AETHER_GLOBAL_DIR: path.join(root, 'global'), SKILLS_ROOT: path.join(root, 'skills'),
    WORKSPACE_ROOT: root, HISTORY_BACKEND: 'jsonl', ENABLE_LONG_TERM_MEMORY: 'false', AUTH_ENABLED: 'false',
    QA_LOG_ENABLED: 'false', OSM_MODE: 'off', DEFAULT_SECURITY_MODE: 'standard', LOG_LEVEL: 'silent' })) vi.stubEnv(key, value)
  fs.mkdirSync(path.join(root, 'skills')); await initDb()
  peer = new LocalSqliteProcessClient({ url: 'file:' + path.join(root, 'agent.db').replaceAll('\\', '/') })
  mainGate = barrier(); compactGate = barrier(); compactEntered = false; body = undefined; signals.length = 0
  mainId = (await new SQLiteAgentStore().create(tenantId, { name: 'P5a synthetic parent', model: 'p5a-main', skills: [], mcpServers: [], knowledgeBases: [], allowedTools: [] })).id
  vi.spyOn(resolver, 'resolveModelConfig').mockImplementation(async () => ({ model: 'p5a-main', provider: 'fixture', capabilities: resolveCapabilities({ model: 'gpt-4o', provider: 'openai' }), thinkingEnabled: false }))
  vi.spyOn(resolver, 'createAdapterFromResolved').mockImplementation(() => ({ provider: 'fixture', model: 'p5a-main', countTokens: text => Math.ceil(text.length / 4),
    complete: async () => { compactEntered = true; await compactGate.promise; return { content: 'P5A_COMPACT_SUMMARY', promptTokens: 20, completionTokens: 10, finishReason: 'stop' } },
    async *stream(_messages, options) { if (options?.signal) signals.push(options.signal); await mainGate.promise; yield { done: true, finishReason: 'stop', content: 'P5A_FINAL', promptTokens: 11, completionTokens: 6 } },
  }))
  app = Fastify(); app.decorateRequest('authContext', null)
  app.addHook('onRequest', async request => { Object.assign(request, { authContext: { tenantId: request.headers['x-test-actor'] ?? tenantId } }) })
})
afterEach(async () => {
  mainGate.release(); compactGate.release(); if (body) await body
  await stopAllOwnedExecutions('P5a contract cleanup'); await app.close()
  for (const [key, current] of activeStreams) if (key.startsWith(tenantId + ':')) { if (current.disconnectTimeout) clearTimeout(current.disconnectTimeout); activeStreams.delete(key) }
  expect((await peer.closeWithReceipt()).healthy).toBe(true)
  for (const receipt of await Promise.all([closeMemoryDb(), closeDb()])) if (receipt) expect(receipt.healthy).toBe(true)
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers()
  if (!root.startsWith(path.resolve('.e2e-tmp') + path.sep)) throw new Error('Unsafe P5a fixture cleanup')
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 })
})
async function start(modern = true, registration?: { newStreamPublication?: boolean; liveChildRecovery?: boolean }) {
  await app.register(chatRoutes, registration ?? { newStreamPublication: modern, liveChildRecovery: modern })
  base = await app.listen({ host: '127.0.0.1', port: 0 })
  const response = await fetch(base + '/chat', { method: 'POST', headers: { 'content-type': 'application/json', 'x-aether-run-lifetime': 'durable', 'x-aether-subagent-protocol': '2' },
    body: JSON.stringify({ sessionId, agentId: mainId, model: 'p5a-main', message: 'Synthetic live snapshot contract', memoryScope: 'off', workspacePaths: [root] }) })
  body = response.text(); await vi.waitFor(() => expect(activeStreams.has(tenantId + ':' + sessionId)).toBe(true))
  bus = activeStreams.get(tenantId + ':' + sessionId)!
}
async function child(id: string, tokens: number, publish = true, turn?: string, name?: string) {
  const run = (await rootRunStore.latest(tenantId, sessionId))!
  const store = new SubagentStore(peer)
  const created = await store.createRunDelta({ tenantId, runId: id, rootSessionId: sessionId, parentSessionId: sessionId,
    parentConversationId: turn ?? run.turnId, parentMessageId: 'dispatch-' + id, parentToolCallId: 'tool-' + id,
    childSessionId: 'child-' + id, modelId: 'synthetic-child', task: 'synthetic child', description: 'isolated', ...(name ? { agentName: name } : {}) })
  const used = (await store.recordUsageDelta(tenantId, id, { invocationId: id + '-first', promptTokens: tokens, completionTokens: 0 }))!
  if (publish) { await bus.publish('\x00__subagent_event__' + JSON.stringify(created.event)); await bus.publish('\x00__subagent_event__' + JSON.stringify(used.event)) }
  return used.header
}
async function read(url: string, actor?: string) {
  const response = await fetch(base + url, { headers: actor ? { 'x-test-actor': actor } : {} }), raw = await response.text()
  expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(256 * 1024)
  return { status: response.status, json: JSON.parse(raw) }
}
const snapshotUrl = '/chat/snapshot?sessionId=' + sessionId + '&childRecoveryProtocol=1'
const pageUrl = (id: string, cursor?: string | null) => '/chat/snapshot/children?sessionId=' + sessionId + '&childRecoveryProtocol=1&snapshotId=' + encodeURIComponent(id) + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '')
const lookupUrl = (id: string, runId: string) => '/chat/snapshot/children/' + encodeURIComponent(runId) + '?sessionId=' + sessionId + '&childRecoveryProtocol=1&snapshotId=' + encodeURIComponent(id)
const projectionUrl = (id: string, cursor?: string | null) => '/chat/snapshot/projection?sessionId=' + sessionId + '&childRecoveryProtocol=1&snapshotId=' + encodeURIComponent(id) + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '')

describe('P5a live fixed child recovery HTTP', () => {
  it('exposes current execution independently while the terminal frame has not advanced the exact live publication prefix', async () => {
    await start()
    const cursor = bus.lastEventId
    const pending = await read(snapshotUrl)
    expect(pending.status).toBe(200)
    expect(pending.json.data).toMatchObject({ source: 'live', finished: false, eventId: cursor,
      run: { status: 'running' }, executionRun: { status: 'running' } })
    const terminalGate = barrier(), publish = bus.publish.bind(bus)
    let terminalHeld = false
    vi.spyOn(bus, 'publish').mockImplementation(async chunk => {
      if (chunk.startsWith('\x00__run__') && JSON.parse(chunk.slice('\x00__run__'.length)).status === 'succeeded') {
        terminalHeld = true; await terminalGate.promise
      }
      return publish(chunk)
    })
    try {
      mainGate.release()
      await vi.waitFor(() => expect(terminalHeld).toBe(true))
      const frozen = bus.snapshot()
      const recovered = await read(snapshotUrl)
      expect(recovered.status).toBe(200)
      expect(recovered.json.data).toMatchObject({ source: 'live', finished: false, eventId: frozen.eventId,
        run: { runId: pending.json.data.run.runId, status: 'running' },
        executionRun: { runId: pending.json.data.run.runId, status: 'succeeded' } })
      expect(recovered.json.data.projection).toEqual(frozen.projection)
      expect(bus.abortController.signal.aborted).toBe(false)
    } finally { terminalGate.release() }
  }, 25_000)

  it('returns exact first/page/lookup authority with archived late projection positions and no full child helpers', async () => {
    await start(); for (let index = 0; index < 70; index++) await child('run-' + index, 2)
    await child('older-turn', 7, false, 'prior-turn')
    const forbidden = ['listRunViewsForParent', 'listRunsForParent', 'getViewsAtSequences', 'getSnapshotsAtSequences'] as const
    const spies = forbidden.map(method => vi.spyOn(SubagentStore.prototype, method).mockImplementation(async () => { throw new Error('MODERN_FULL_CHILD_HELPER_FORBIDDEN') }))
    const first = await read(snapshotUrl); expect(first.status).toBe(200)
    const data = first.json.data, recovery = data.subagentRecovery
    expect(data).not.toHaveProperty('subagentRuns'); expect(data).not.toHaveProperty('subagentWatermarks'); expect(data).not.toHaveProperty('sessionSubagentUsage')
    expect(recovery).toMatchObject({ source: 'live-published', includedCount: 64, totalPublishedCount: 70, hasMore: true, usage: { totalTokens: 147, count: 71, unknown: 0 } })
    expect(data.subagentProjectionArchive.totalCount).toBe(70)
    expect(data.projection.every((frame: Record<string, unknown>) => frame.subagentEvent === undefined)).toBe(true)
    const earlier = recovery.refs[0]
    const updated = (await new SubagentStore(peer).recordUsageDelta(tenantId, earlier.identity.runId, { invocationId: 'future', promptTokens: 900, completionTokens: 0 }))!
    await bus.publish('\x00__subagent_event__' + JSON.stringify(updated.event)); await child('future-child', 700)
    await new SubagentStore(peer).recordUsageDelta(tenantId, 'older-turn', { invocationId: 'other-future', promptTokens: 600, completionTokens: 0 })
    const next = await read(pageUrl(recovery.snapshotId, recovery.nextCursor))
    expect(next.status).toBe(200); expect(next.json.data.refs).toHaveLength(6)
    expect(next.json.data.fence).toEqual(recovery.fence); expect(next.json.data.usage).toEqual(recovery.usage)
    expect((await read(lookupUrl(recovery.snapshotId, earlier.identity.runId))).json.data.item.atSeq).toBe(earlier.atSeq)
    expect((await read(lookupUrl(recovery.snapshotId, 'future-child'))).json.data.item).toBeNull()
    const archiveUrl = projectionUrl(recovery.snapshotId)
    const archive = await read(archiveUrl); expect(archive.status).toBe(200); expect(archive.json.data.entries).toHaveLength(64)
    const tail = await read(archiveUrl + '&cursor=' + encodeURIComponent(archive.json.data.nextCursor))
    expect(tail.json.data.entries).toHaveLength(6)
    expect([...archive.json.data.entries, ...tail.json.data.entries].map(entry => entry.runId)).toEqual(Array.from({ length: 70 }, (_, index) => 'run-' + index))
    expect(tail.json.data.entries.at(-1).projectionIndex).toBeLessThan(data.subagentProjectionArchive.originalProjectionCount)
    expect(data.projectionIndices).toHaveLength(data.projection.length)
    expect((await read(pageUrl(recovery.snapshotId, archive.json.data.nextCursor))).json.data.reason).toBe('invalid_token')
    expect((await read(projectionUrl(recovery.snapshotId, recovery.nextCursor))).json.data.reason).toBe('invalid_token')
    const another = (await read(snapshotUrl)).json.data.subagentRecovery
    expect((await read(pageUrl(another.snapshotId, recovery.nextCursor))).json.data.reason).toBe('cursor_snapshot_mismatch')
    expect((await read(projectionUrl(another.snapshotId, archive.json.data.nextCursor))).json.data.reason).toBe('cursor_snapshot_mismatch')
    for (const spy of spies) { expect(spy).not.toHaveBeenCalled(); spy.mockRestore() }
  }, 45_000)

  it('holds actual HTTP snapshot until child evidence COMMIT ACK, without leaking a future checkpoint', async () => {
    await start(); await child('held', 5)
    const delta = (await new SubagentStore(peer).recordUsageDelta(tenantId, 'held', { invocationId: 'held-future', promptTokens: 80, completionTokens: 0 }))!
    const entered = barrier(), release = barrier(), db = getDb(), real = db.transaction.bind(db)
    const spy = vi.spyOn(db, 'transaction').mockImplementation(async (mode?: TransactionMode) => {
      const tx: Transaction = await real(mode), execute = tx.execute.bind(tx), commit = tx.commit.bind(tx); let childWrite = false
      vi.spyOn(tx, 'execute').mockImplementation(async statement => { const sql = typeof statement === 'string' ? statement : Array.isArray(statement) ? String(statement[0]) : statement.sql; if (sql.startsWith('INSERT INTO parent_published_child_versions')) childWrite = true; return execute(statement) })
      vi.spyOn(tx, 'commit').mockImplementation(async () => { await commit(); if (childWrite) { entered.release(); await release.promise } })
      return tx
    })
    const publishing = bus.publish('\x00__subagent_event__' + JSON.stringify(delta.event)); await entered.promise
    let responded = false; const pending = read(snapshotUrl).then(result => { responded = true; return result })
    await peer.execute('SELECT 1'); expect(responded).toBe(false)
    release.release(); await publishing; const snapshot = await pending
    expect(snapshot.status).toBe(200); expect(snapshot.json.data.subagentRecovery.refs[0].atSeq).toBe(delta.header.lastSeq)
    expect(snapshot.json.data.subagentRecovery.usage.totalTokens).toBe(85)
    spy.mockRestore(); expect(bus.finished).toBe(false); expect(signals.every(signal => !signal.aborted)).toBe(true)
  }, 25_000)

  it('rejects cross scope, forged tokens, expired leases, generation changes and missing checkpoints as bounded recovery', async () => {
    await start(); await child('scope-child', 9); const recovery = (await read(snapshotUrl)).json.data.subagentRecovery
    expect((await read(pageUrl(recovery.snapshotId), 'foreign-actor')).status).toBe(409)
    expect((await read(pageUrl(recovery.snapshotId).replace('sessionId=' + sessionId, 'sessionId=foreign-session'))).status).toBe(409)
    expect((await read(pageUrl(recovery.snapshotId) + '&tenantId=foreign&rootRunId=forged')).status).toBe(200)
    expect((await read(pageUrl(recovery.snapshotId) + '&limit=1&limit=2')).json.data.reason).toBe('invalid_limit')
    expect((await read(snapshotUrl + '&sessionId=' + sessionId)).json.data.reason).toBe('invalid_selector')
    const split = recovery.snapshotId.indexOf('.') + 1, token = recovery.snapshotId.slice(0, split) + (recovery.snapshotId[split] === 'a' ? 'b' : 'a') + recovery.snapshotId.slice(split + 1)
    expect((await read(pageUrl(token))).json.data).toMatchObject({ recoveryRequired: true, reason: 'invalid_token' })
    vi.setSystemTime(Date.now() + 600_001)
    expect((await read(pageUrl(recovery.snapshotId))).json.data.reason).toBe('snapshot_expired')
    const fresh = (await read(snapshotUrl)).json.data.subagentRecovery
    await peer.execute({ sql: 'DELETE FROM subagent_checkpoints WHERE tenant_id=? AND run_id=?', args: [tenantId, 'scope-child'] })
    await peer.execute({ sql: 'DELETE FROM subagent_events WHERE tenant_id=? AND run_id=?', args: [tenantId, 'scope-child'] })
    expect((await read(pageUrl(fresh.snapshotId))).json.data.reason).toBe('missing_checkpoint')
    const tx = await peer.transaction('write'); await resetParentChildRecovery(tx, tenantId, sessionId); await tx.commit(); tx.close()
    expect((await read(pageUrl(fresh.snapshotId))).status).toBe(409)
    expect(bus.abortController.signal.aborted).toBe(false)
  }, 25_000)

  it('keeps the legacy default and refuses an explicitly requested modern protocol when disabled', async () => {
    await start(false); expect((await read(snapshotUrl)).json.data.reason).toBe('protocol_unavailable')
    const legacy = await read('/chat/snapshot?sessionId=' + sessionId)
    expect(legacy.status).toBe(200); expect(legacy.json.data).toHaveProperty('subagentRuns')
    expect(legacy.json.data).not.toHaveProperty('subagentRecovery')
  }, 25_000)

  it.each([{ newStreamPublication: false, liveChildRecovery: true }, { newStreamPublication: true, liveChildRecovery: false }])('requires both trusted registration gates: %j', async registration => {
    await start(true, registration)
    expect((await read(snapshotUrl + '&liveChildRecovery=true&newStreamPublication=true')).json.data.reason).toBe('protocol_unavailable')
    expect((await read(snapshotUrl.replace('childRecoveryProtocol=1', 'childRecoveryProtocol=2'))).json.data.reason).toBe('invalid_selector')
    expect((await read(pageUrl('fake') + '&liveChildRecovery=true')).json.data.reason).toBe('protocol_unavailable')
    expect((await read('/chat/snapshot?sessionId=' + sessionId)).status).toBe(200)
    expect(bus.abortController.signal.aborted).toBe(false)
  }, 25_000)

  it('refuses a modern snapshot without its current live owner while the actual legacy persisted path remains usable', async () => {
    await start(); await child('completed-child', 12); mainGate.release(); await body
    expect(bus.finished).toBe(true)
    activeStreams.delete(tenantId + ':' + sessionId)
    const failed = await read(snapshotUrl); expect(failed.status).toBe(409); expect(failed.json.data.reason).toBe('live_owner_unavailable')
    const legacy = await read('/chat/snapshot?sessionId=' + sessionId)
    expect(legacy.status).toBe(200); expect(legacy.json.data.source).toBe('persisted')
    expect(legacy.json.data.subagentRuns.map((run: { runId: string }) => run.runId)).toContain('completed-child')
  }, 25_000)

  it.each(['subagent', 'metadata.subagent'] as const)('preserves non-child tool result content and exact original projection positions when archiving %s', async nested => {
    await start(); const header = await child('nested-child', 12)
    const view = await new SubagentStore(peer).getRunView(tenantId, header.runId, { atSeq: header.lastSeq })
    await bus.publish('ORDINARY_BEFORE')
    await bus.publish('\x00__tool_start__' + JSON.stringify({ toolCallId: 'outer-tool', name: 'subagent', args: { task: 'retained' } }))
    await bus.publish('\x00__tool_end__' + JSON.stringify({ toolCallId: 'outer-tool', name: 'subagent', output: 'ORDINARY_TOOL_OUTPUT', success: true,
      ...(nested === 'subagent' ? { subagent: view, metadata: { ordinary: 'RETAINED_METADATA' } } : { metadata: { subagent: view, ordinary: 'RETAINED_METADATA' } }) }))
    await bus.publish('ORDINARY_AFTER')
    const original = bus.snapshot(), snapshot = await read(snapshotUrl); expect(snapshot.status).toBe(200)
    const data = snapshot.json.data
    const resultFrame = data.projection.find((frame: { toolEnd?: { toolCallId: string } }) => frame.toolEnd?.toolCallId === 'outer-tool')
    expect(resultFrame).toBeDefined()
    const result = resultFrame.toolEnd
    expect(result).toMatchObject({ output: 'ORDINARY_TOOL_OUTPUT', success: true, metadata: { ordinary: 'RETAINED_METADATA' } })
    expect(result).not.toHaveProperty('subagent'); expect(result.metadata).not.toHaveProperty('subagent')
    const archive = await read(projectionUrl(data.subagentRecovery.snapshotId)); expect(archive.status).toBe(200)
    const entry = archive.json.data.entries.find((entry: { field: string }) => entry.field === 'toolEnd')
    expect(entry).toMatchObject({ field: 'toolEnd', nested, runId: header.runId, atSeq: header.lastSeq, toolId: 'outer-tool', toolName: 'subagent' })
    expect(original.projection[entry.projectionIndex]).toHaveProperty('toolEnd')
    expect(data.projection[data.projectionIndices.indexOf(entry.projectionIndex)].toolEnd.output).toBe('ORDINARY_TOOL_OUTPUT')
    expect(data.projectionIndices).toEqual([...data.projectionIndices].sort((a: number, b: number) => a - b))
    for (let index = 0; index < data.projection.length; index++) {
      const captured = original.projection[data.projectionIndices[index]]
      if (!captured.toolEnd) expect(data.projection[index]).toEqual(captured)
    }
    expect(data.subagentProjectionArchive.originalProjectionCount).toBe(original.projection.length)
    expect(archive.json.data.originalProjectionCount).toBe(original.projection.length)
  }, 25_000)

  it.each(['toolEnd', 'toolResult'] as const)('removes every duplicate direct/metadata/meta body in %s while retaining one exact ref and ordinary positions', async field => {
    await start(); const header = await child('duplicate-child', 12)
    const view = await new SubagentStore(peer).getRunView(tenantId, header.runId, { atSeq: header.lastSeq })
    expect(view).not.toBeNull()
    await bus.publish('DUPLICATE_BEFORE')
    await bus.publish('\x00__tool_start__' + JSON.stringify({ toolCallId: 'duplicate-tool', name: 'subagent', args: { task: 'ordinary args' } }))
    await bus.publish((field === 'toolEnd' ? '\x00__tool_end__' : '\x00__tool_result__') + JSON.stringify({ toolCallId: 'duplicate-tool', name: 'subagent',
      output: 'ORDINARY_DUPLICATE_OUTPUT', status: 'completed', success: true, subagent: view,
      metadata: { ordinary: 'KEEP_METADATA', subagent: view }, meta: { ordinary: 'KEEP_META', subagent: view } }))
    await bus.publish('DUPLICATE_AFTER')
    const original = bus.snapshot(), result = await read(snapshotUrl); expect(result.status).toBe(200)
    const data = result.json.data, frame = data.projection.find((item: Record<string, { toolCallId?: string }>) => item[field]?.toolCallId === 'duplicate-tool')
    expect(frame).toBeDefined()
    expect(frame[field]).toMatchObject({ output: 'ORDINARY_DUPLICATE_OUTPUT', success: true, status: 'completed', metadata: { ordinary: 'KEEP_METADATA' }, meta: { ordinary: 'KEEP_META' } })
    expect(frame[field]).not.toHaveProperty('subagent'); expect(frame[field].metadata).not.toHaveProperty('subagent'); expect(frame[field].meta).not.toHaveProperty('subagent')
    const archive = await read(projectionUrl(data.subagentRecovery.snapshotId)); expect(archive.status).toBe(200)
    const refs = archive.json.data.entries.filter((entry: { field: string }) => entry.field === field)
    expect(refs).toHaveLength(1)
    expect(refs[0]).toMatchObject({ field, runId: header.runId, atSeq: header.lastSeq, nestedLocations: ['subagent', 'metadata.subagent', 'meta.subagent'] })
    expect(refs[0]).not.toHaveProperty('nested')
    expect(original.projection[refs[0].projectionIndex]).toHaveProperty(field)
    expect(data.projection[data.projectionIndices.indexOf(refs[0].projectionIndex)]).toEqual(frame)
    expect((await read(lookupUrl(data.subagentRecovery.snapshotId, header.runId))).json.data.item.atSeq).toBe(header.lastSeq)
    expect(data.projectionIndices).toEqual([...data.projectionIndices].sort((a, b) => a - b))
    expect(bus.abortController.signal.aborted).toBe(false)
  }, 25_000)

  it.each(['toolEnd', 'toolResult'] as const)('admits meta-only %s from exact SQL publication without a legacy watermark', async field => {
    await start(); const header = await child('meta-only-child', 9, false)
    const view = await new SubagentStore(peer).getRunView(tenantId, header.runId, { atSeq: header.lastSeq })
    expect(view).not.toBeNull()
    await bus.publish((field === 'toolEnd' ? '\x00__tool_end__' : '\x00__tool_result__') + JSON.stringify({ toolCallId: 'meta-only-tool', name: 'subagent',
      output: 'META_ONLY_ORDINARY_OUTPUT', meta: { ordinary: 'KEEP_META_ONLY', subagent: view } }))
    expect(bus.snapshot().subagentWatermarks ?? []).toEqual([])
    const response = await read(snapshotUrl); expect(response.status).toBe(200)
    const data = response.json.data, frame = data.projection.find((item: Record<string, { toolCallId?: string }>) => item[field]?.toolCallId === 'meta-only-tool')
    expect(frame).toBeDefined(); expect(frame[field]).toEqual({ toolCallId: 'meta-only-tool', name: 'subagent', output: 'META_ONLY_ORDINARY_OUTPUT', meta: { ordinary: 'KEEP_META_ONLY' } })
    expect(data.subagentRecovery.refs).toHaveLength(1); expect(data.subagentRecovery.refs[0].atSeq).toBe(header.lastSeq)
    const archive = await read(projectionUrl(data.subagentRecovery.snapshotId)); expect(archive.status).toBe(200)
    expect(archive.json.data.entries).toHaveLength(1)
    expect(archive.json.data.entries[0]).toMatchObject({ field, runId: header.runId, atSeq: header.lastSeq, nested: 'meta.subagent' })
    expect((await read(lookupUrl(data.subagentRecovery.snapshotId, header.runId))).json.data.item.atSeq).toBe(header.lastSeq)
    expect(bus.abortController.signal.aborted).toBe(false)
  }, 25_000)

  it.each(['run', 'seq', 'scope'] as const)('rejects conflicting duplicate %s receipts before parent append without cancelling the executor', async conflict => {
    await start(); const header = await child('conflict-child', 5)
    const view = await new SubagentStore(peer).getRunView(tenantId, header.runId, { atSeq: header.lastSeq })
    expect(view).not.toBeNull()
    const secondary = { ...view, ...(conflict === 'run' ? { runId: 'UNPUBLISHED_SECONDARY_RUN' } : conflict === 'seq' ? { lastSeq: header.lastSeq + 99 } : { parentToolCallId: 'OTHER_DISPATCH' }) }
    const before = bus.snapshot().eventId
    await expect(bus.publish('\x00__tool_end__' + JSON.stringify({ toolCallId: 'conflicting-tool', name: 'subagent', output: 'ORDINARY_CONFLICT_OUTPUT', subagent: view, metadata: { subagent: secondary } })))
      .rejects.toMatchObject({ reason: 'evidence_unavailable', cause: { reason: 'conflicting_child_receipts' } })
    expect(bus.snapshot().eventId).toBe(before)
    const response = await read(snapshotUrl); expect(response.status).toBe(409); expect(response.json.data).toEqual({ recoveryRequired: true, reason: 'evidence_unavailable' })
    expect(JSON.stringify(response.json)).not.toContain('UNPUBLISHED_SECONDARY_RUN')
    expect(bus.finished).toBe(true); expect(bus.abortController.signal.aborted).toBe(false)
    expect(signals.every(signal => !signal.aborted)).toBe(true)
  }, 25_000)

  it.each(['toolEnd', 'toolResult'] as const)('refuses an injected meta-only %s outside the signed published prefix', async field => {
    await start(); await child('published-original', 3)
    const unadmitted = await child('unpublished-meta', 7, false)
    const view = await new SubagentStore(peer).getRunView(tenantId, unadmitted.runId, { atSeq: unadmitted.lastSeq })
    const original = bus.snapshot.bind(bus)
    vi.spyOn(bus, 'snapshot').mockImplementation(() => { const snapshot = original(); return { ...snapshot, projection: [...snapshot.projection, { [field]: { toolCallId: 'unpublished-tool', name: 'subagent', meta: { subagent: view } } }] } })
    const response = await read(snapshotUrl); expect(response.status).toBe(409); expect(response.json.data.reason).toBe('projection_prefix_mismatch')
    expect(response.json.data).not.toHaveProperty('projection'); expect(bus.abortController.signal.aborted).toBe(false)
  }, 25_000)

  it.each([false, true])('checks retained exact source evidence when an older receipt uses a newer frozen ref (source removed=%s)', async removeSource => {
    await start(); const header = await child('historical-child', 4)
    const view = await new SubagentStore(peer).getRunView(tenantId, header.runId, { atSeq: header.lastSeq })
    await bus.publish('\x00__tool_end__' + JSON.stringify({ toolCallId: 'historical-tool', name: 'subagent', output: 'HISTORICAL_OUTER', subagent: view, meta: { subagent: view } }))
    const updated = (await new SubagentStore(peer).recordUsageDelta(tenantId, header.runId, { invocationId: 'historical-next', promptTokens: 20, completionTokens: 0 }))!
    await bus.publish('\x00__subagent_event__' + JSON.stringify(updated.event))
    if (removeSource) await peer.execute({ sql: 'DELETE FROM subagent_checkpoints WHERE tenant_id=? AND run_id=? AND seq=?', args: [tenantId, header.runId, header.lastSeq] })
    const response = await read(snapshotUrl)
    if (removeSource) { expect(response.status).toBe(409); expect(response.json.data.reason).toBe('projection_prefix_mismatch') }
    else {
      expect(response.status).toBe(200)
      const archive = await read(projectionUrl(response.json.data.subagentRecovery.snapshotId)); expect(archive.status).toBe(200)
      const ref = archive.json.data.entries.find((entry: { field: string }) => entry.field === 'toolEnd'); expect(ref).toBeDefined()
      expect(ref).toMatchObject({ runId: header.runId, atSeq: updated.header.lastSeq, sourceAtSeq: header.lastSeq, nestedLocations: ['subagent', 'meta.subagent'] })
      expect((await read(lookupUrl(response.json.data.subagentRecovery.snapshotId, header.runId))).json.data.item.atSeq).toBe(updated.header.lastSeq)
    }
    expect(bus.abortController.signal.aborted).toBe(false)
  }, 25_000)

  it.each([null, 'malformed', { runId: 'invalid-nested', lastSeq: 0 }])('cannot emit an injected malformed secondary child body: %j', async malformed => {
    await start(); const header = await child('valid-primary', 4), view = await new SubagentStore(peer).getRunView(tenantId, header.runId, { atSeq: header.lastSeq })
    const original = bus.snapshot.bind(bus)
    vi.spyOn(bus, 'snapshot').mockImplementation(() => { const snapshot = original(); return { ...snapshot, projection: [...snapshot.projection, { toolResult: { toolCallId: 'malformed-tool', subagent: view, meta: { subagent: malformed } } }] } })
    const response = await read(snapshotUrl); expect(response.status).toBe(409); expect(response.json.data.reason).toBe('invalid_identity')
    expect(response.json.data).not.toHaveProperty('projection'); expect(bus.abortController.signal.aborted).toBe(false)
  }, 25_000)

  it.each([null, 'malformed', []])('refuses malformed pure child producer frames before append: %j', async malformed => {
    await start(); const before = bus.snapshot().eventId
    await expect(bus.publish('\x00__subagent_event__' + JSON.stringify(malformed))).rejects.toMatchObject({ reason: 'evidence_unavailable', cause: { reason: 'invalid_identity' } })
    expect(bus.snapshot().eventId).toBe(before)
    const response = await read(snapshotUrl); expect(response.status).toBe(409); expect(response.json.data.reason).toBe('evidence_unavailable')
    expect(bus.abortController.signal.aborted).toBe(false); expect(signals.every(signal => !signal.aborted)).toBe(true)
  }, 25_000)

  it.each([null, 'malformed', []])('cannot inline injected malformed pure child projection frames: %j', async malformed => {
    await start(); await child('valid-event-primary', 4)
    const original = bus.snapshot.bind(bus)
    vi.spyOn(bus, 'snapshot').mockImplementation(() => { const snapshot = original(); return { ...snapshot, projection: [...snapshot.projection, { subagentEvent: malformed, content: 'KEEP_ORDINARY_IF_VALID' }] } })
    const response = await read(snapshotUrl); expect(response.status).toBe(409); expect(response.json.data.reason).toBe('invalid_identity')
    expect(response.json.data).not.toHaveProperty('projection'); expect(bus.abortController.signal.aborted).toBe(false)
  }, 25_000)

  it('requires a committed projection header, rolls back wrong-prefix refs, and distinguishes an empty retained archive', async () => {
    await start()
    const empty = await read(snapshotUrl); expect(empty.status).toBe(200)
    const emptyRecovery = empty.json.data.subagentRecovery, service = childRecoveryService(), auth = { tenantId, parentSessionId: sessionId }
    expect((await read(projectionUrl(emptyRecovery.snapshotId))).json.data).toMatchObject({ totalCount: 0, entries: [], hasMore: false, nextCursor: null })
    await expect(service.retainProjection(auth, emptyRecovery.snapshotId, [], empty.json.data.subagentProjectionArchive.originalProjectionCount)).rejects.toMatchObject({ reason: 'projection_already_retained' })
    const header = await child('retention-child', 8)
    const current = (await read(snapshotUrl)).json.data.subagentRecovery
    const { generation: _generation, eventSequence, revision: _revision, usageRevision: _usageRevision, ...scope } = current.fence
    const unretained = await service.issue(scope, 64, eventSequence)
    expect((await read(projectionUrl(unretained.data.snapshotId))).json.data.reason).toBe('projection_unavailable')
    await expect(service.retainProjection(auth, unretained.data.snapshotId, [{ projectionIndex: 0, field: 'subagentEvent', runId: header.runId, atSeq: header.lastSeq + 1 }], 1)).rejects.toMatchObject({ reason: 'projection_prefix_mismatch' })
    expect((await read(projectionUrl(unretained.data.snapshotId))).json.data.reason).toBe('projection_unavailable')
    await service.retainProjection(auth, unretained.data.snapshotId, [{ projectionIndex: 0, field: 'subagentEvent', runId: header.runId, atSeq: header.lastSeq }], 1)
    expect((await read(projectionUrl(unretained.data.snapshotId))).json.data.entries[0].atSeq).toBe(header.lastSeq)
    await peer.execute({ sql: 'UPDATE child_recovery_projection_refs SET entry_json=? WHERE run_id=?', args: [JSON.stringify({ runId: 'forged', projectionIndex: 0, atSeq: header.lastSeq }), header.runId] })
    expect((await read(projectionUrl(unretained.data.snapshotId))).json.data.reason).toBe('projection_corrupt')
    expect(bus.abortController.signal.aborted).toBe(false)
  }, 25_000)

  it('bounds the complete modern snapshot envelope when ordinary parent text exceeds the explicit transport budget', async () => {
    await start(); await child('budget-child', 3); await bus.publish('界'.repeat(100_000))
    const result = await read(snapshotUrl); expect(result.status).toBe(409); expect(result.json.data.reason).toBe('response_budget')
    expect(bus.finished).toBe(false); expect(signals.every(signal => !signal.aborted)).toBe(true)
  }, 25_000)

  it('uses a byte boundary for the entire projection HTTP envelope without skipping exact entries', async () => {
    await start(); const childHeader = await child('archive-budget', 10)
    const recovery = (await read(snapshotUrl)).json.data.subagentRecovery
    const { generation: _generation, eventSequence, revision: _revision, usageRevision: _usageRevision, ...scope } = recovery.fence
    const service = childRecoveryService(), lease = await service.issue(scope, 64, eventSequence)
    await service.retainProjection({ tenantId, parentSessionId: sessionId }, lease.data.snapshotId, [0, 1].map(projectionIndex => ({ projectionIndex,
      field: 'toolEnd' as const, nested: 'subagent' as const, runId: childHeader.runId, atSeq: childHeader.lastSeq, toolId: 'tool-' + projectionIndex, toolName: '界'.repeat(45_000) })), 2)
    const first = await read(projectionUrl(lease.data.snapshotId) + '&limit=2'); expect(first.status).toBe(200)
    expect(first.json.data).toMatchObject({ totalCount: 2, originalProjectionCount: 2, hasMore: true })
    expect(first.json.data.entries).toHaveLength(1); expect(first.json.data.entries[0].projectionIndex).toBe(0)
    expect(first.json.data.entries[0].toolName).toBe('界'.repeat(45_000))
    const second = await read(projectionUrl(lease.data.snapshotId, first.json.data.nextCursor) + '&limit=2')
    expect(second.json.data).toMatchObject({ totalCount: 2, hasMore: false, nextCursor: null })
    expect(second.json.data.entries).toHaveLength(1); expect(second.json.data.entries[0].projectionIndex).toBe(1)
    const tooWide = await service.issue(scope, 64, eventSequence)
    await service.retainProjection({ tenantId, parentSessionId: sessionId }, tooWide.data.snapshotId, [{ projectionIndex: 0, field: 'toolEnd', nested: 'subagent', runId: childHeader.runId,
      atSeq: childHeader.lastSeq, toolName: 'x'.repeat(261_960) }], 1)
    const rejected = await read(projectionUrl(tooWide.data.snapshotId)); expect(rejected.status).toBe(409); expect(rejected.json.data.reason).toBe('oversized_identity')
    expect(bus.abortController.signal.aborted).toBe(false)
  }, 25_000)

  it('counts the actual lookup HTTP wrapper when a fault-injected foundation result alone exactly fills its budget', async () => {
    await start(); await child('lookup-edge', 4)
    const recovery = (await read(snapshotUrl)).json.data.subagentRecovery, service = childRecoveryService()
    const edge = await service.lookup({ tenantId, parentSessionId: sessionId }, recovery.snapshotId, 'lookup-edge')
    expect(edge.item).not.toBeNull()
    edge.item!.identity.agentName = ''
    edge.item!.identity.agentName = 'x'.repeat(256 * 1024 - Buffer.byteLength(JSON.stringify(edge)))
    expect(Buffer.byteLength(JSON.stringify(edge))).toBe(256 * 1024)
    const spy = vi.spyOn(service, 'lookup').mockResolvedValueOnce(edge)
    const response = await read(lookupUrl(recovery.snapshotId, 'lookup-edge'))
    expect(response.status).toBe(409); expect(response.json.data.reason).toBe('response_budget')
    spy.mockRestore()
    expect((await read(lookupUrl(recovery.snapshotId, 'lookup-edge'))).status).toBe(200)
    expect(bus.abortController.signal.aborted).toBe(false)
  }, 25_000)

  it('rejects a single oversized exact identity without truncating it or aborting the running task', async () => {
    await start(); await child('wide', 1, true, undefined, '界'.repeat(100_000))
    const failed = await read(snapshotUrl); expect(failed.status).toBe(409); expect(failed.json.data.reason).toBe('oversized_identity')
    expect(failed.json).not.toHaveProperty('subagentRecovery'); expect(bus.finished).toBe(false); expect(bus.abortController.signal.aborted).toBe(false)
  }, 25_000)

  it('serves the aligned live prefix during real held compaction without taking the summarizer history lock', async () => {
    vi.stubEnv('AUTO_COMPACT_THRESHOLD_RATIO', '0')
    const history = createConversationHistory()
    for (let index = 0; index < 8; index++) await history.append({ role: index % 2 ? 'assistant' : 'user', content: 'Prior complete exchange ' + index, conversationId: 'prior-' + Math.floor(index / 2), tokens: 6 } as Message & { conversationId: string }, { tenantId, sessionId })
    await start(); await child('compact-child', 11); mainGate.release()
    await vi.waitFor(() => expect(compactEntered).toBe(true), { timeout: 5_000 })
    const snapshot = await read(snapshotUrl); expect(snapshot.status).toBe(200)
    expect(snapshot.json.data.run.compaction.phase).toBe('running')
    expect(snapshot.json.data.subagentRecovery).toMatchObject({ totalPublishedCount: 1, usage: { totalTokens: 11, count: 1 } })
    expect(snapshot.json.data.history.some((message: Message) => message.content === 'Prior complete exchange 0')).toBe(true)
    compactGate.release(); await body
  }, 25_000)
})
