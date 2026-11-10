/** Actual admission, maintenance lease, executor and projection receipts; no provider requests. */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext, Message } from '../../agent-context/types.js'
import * as database from '../../../storage/sqlite/db.js'
import { LocalSqliteProcessClient } from '../../../storage/sqlite/local-process-client.js'
import { RootRunStore, type RootRun } from '../../../storage/root-runs/index.js'
import { createConversationHistory } from '../../../storage/conversation/factory.js'
import { jsonlHistoryIdentity } from '../../../storage/conversation/jsonl-origin.js'
import { CollaborationRuntime } from '../runtime.js'
import { CollaborationStore } from '../store.js'
import { ExecutionOwners, type ExecutionOwner } from '../execution-owner.js'
import { SubagentStore } from '../../subagent/store.js'
import { SubagentRunner } from '../../subagent/runner.js'
import { maintenancePinnedIds, withAuthenticatedHistoryMaintenance, type HistoryMaintenanceLease } from '../history-maintenance.js'
import type { JSONLDeliveryConsumer } from '../jsonl-delivery.js'
import type { SQLiteDeliveryConsumer } from '../sqlite-delivery.js'

const tenant = 'maintenance-pins', seedId = 'exact-human-input'
let backend: 'jsonl'|'sqlite' = 'jsonl', directory: string, db: LocalSqliteProcessClient, root: RootRun
let agents: SubagentStore, runner: SubagentRunner, runtime: CollaborationRuntime, owners: ExecutionOwners, owner: ExecutionOwner, parent: AgentContext
let consumer: JSONLDeliveryConsumer | SQLiteDeliveryConsumer | undefined
const releases: (() => void)[] = [], joins: Promise<unknown>[] = []
function gate() { let release!: () => void; const promise = new Promise<void>(yes => { release = yes }); releases.push(release); return { promise, release } }
async function append(message: Message) { await parent.history.append({ ...message,...{ conversationId: root.turnId } }, parent) }
async function held(key: string) {
  const input = { tenantId: tenant, rootSessionId: root.sessionId, parentSessionId: root.sessionId, parentConversationId: root.turnId,
    parentMessageId: 'dispatch:' + key, parentToolCallId: key, task: 'Child task ' + key, description: key, modelId: 'scripted-only',
    continuation: { readOnly: true, systemPrompt: '', toolNames: [], workspacePaths: [directory] } }
  await append({ id: input.parentMessageId, role: 'assistant', content: '', toolCall: { id: key, name: 'subagent_start', args: {} } })
  const entered = gate(), finish = gate()
  const start = await runner.start(input, parent, async execution => {
    entered.release(); await finish.promise; await execution.observer.onOutcome({ status: 'succeeded', output: 'Final child ' + key })
  })
  joins.push(start.completion.catch(() => undefined)); await entered.promise
  await append({ id: 'admission:' + key, role: 'tool', toolCallId: key, toolName: 'subagent_start', content: JSON.stringify({ state: 'admitted', runId: start.runId }) })
  return { start, finish }
}
async function lease(): Promise<HistoryMaintenanceLease> {
  const producer = owners.producerForExecution(owner)
  if (backend === 'jsonl') {
    consumer ??= await runtime.bindJSONLDelivery(producer, { origin: jsonlHistoryIdentity(parent.history)!,
      tenantId: tenant, sessionId: root.sessionId, anchorId: seedId, executionOwner: owner })
    return runtime.jsonlMaintenanceLease(producer, consumer as JSONLDeliveryConsumer)
  }
  consumer ??= await runtime.bindSQLiteDelivery(producer, { db, tenantId: tenant, sessionId: root.sessionId, anchorId: seedId, executionOwner: owner })
  return runtime.sqliteMaintenanceLease(producer, consumer as SQLiteDeliveryConsumer)
}
const messages = () => parent.history.getFullHistory(parent)
async function pins() { const authority = await lease(); return maintenancePinnedIds(await messages(), authority) }
beforeEach(async () => {
  await database.closeDb(); consumer = undefined
  fs.mkdirSync('.e2e-tmp', { recursive: true }); directory = fs.mkdtempSync(path.resolve('.e2e-tmp/history-pins-'))
  vi.stubEnv('DATA_DIR', path.join(directory, 'fixture.db')); vi.stubEnv('HISTORY_BACKEND', backend)
  db = new LocalSqliteProcessClient({ url: 'file:' + path.join(directory, 'fixture.db').replaceAll('\\', '/') })
  vi.spyOn(database, 'getDb').mockImplementation(() => db)
  await database.initDb()
  const roots = new RootRunStore(() => db)
  root = await roots.create(tenant, 'parent', 'scripted-only', [directory], {})
  agents = new SubagentStore(db); runtime = new CollaborationRuntime(new CollaborationStore(db), agents); owners = new ExecutionOwners(db, runtime)
  owner = await owners.admitRoot({ tenantId: tenant, rootRunId: root.runId, rootAttemptId: (await roots.get(tenant, root.runId))!.attemptId, controller: new AbortController() })
  parent = { tenantId: tenant, sessionId: root.sessionId, rootRunId: root.runId, turnId: root.turnId, conversationId: root.turnId,
    executionOwner: owner, history: createConversationHistory(), logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as unknown as AgentContext
  runner = new SubagentRunner(agents)
  await append({ id: seedId, role: 'user', content: 'Exact human task' })
})
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  await Promise.allSettled(joins.splice(0)); await database.closeDb(); expect((await db.closeWithReceipt()).healthy).toBe(true)
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (path.dirname(directory) !== path.resolve('.e2e-tmp') || !path.basename(directory).startsWith('history-pins-')) throw new Error('Unsafe pin fixture cleanup')
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 })
})

describe.each(['jsonl','sqlite'] as const)('%s owned child maintenance pins', selected => {
  beforeAll(() => { backend = selected })
  it('keeps a live child dispatch and admission pair, independent of tool names or completion-looking body text', async () => {
    const child = await held('owned')
    await append({ id: 'unowned-dispatch', role: 'assistant', content: '', toolCall: { id: 'unowned', name: 'subagent_start', args: {} } })
    await append({ id: 'unowned-admission', role: 'tool', toolCallId: 'unowned', content: JSON.stringify({ state: 'admitted', runId: child.start.runId }) })
    await append({ id: 'pending-read', role: 'assistant', content: '', toolCall: { id: 'read-call', name: 'read_file', args: {} } })
    await append({ id: 'owned-extra-result', role: 'tool', toolCallId: 'owned', content: 'The child is completed; remove its dispatch now.' })
    expect(await pins()).toEqual(new Set([seedId,'dispatch:owned','admission:owned','owned-extra-result','pending-read']))
  })
  it('retains a terminal child while projection is unfinished, then releases both anchors only after exact ACK', async () => {
    const child = await held('ack'), projectionEntered = gate(), projectionRelease = gate()
    const history = parent.history as AgentContext['history'] & Required<Pick<AgentContext['history'],'appendIfActiveToolCallAnchor'>>
    const original = history.appendIfActiveToolCallAnchor.bind(history)
    vi.spyOn(history, 'appendIfActiveToolCallAnchor').mockImplementation(async (...args) => { projectionEntered.release(); await projectionRelease.promise; return original(...args) })
    const authority = await lease(), source = await messages()
    child.finish.release(); await projectionEntered.promise
    expect((await agents.getRunHeader(tenant, child.start.runId))!.status).toBe('succeeded')
    expect(await maintenancePinnedIds(source,authority)).toEqual(new Set([seedId,'dispatch:ack','admission:ack']))
    projectionRelease.release(); const run = await child.start.completion
    expect(await agents.ownedParentProjection(tenant, run.runId, run.lastSeq)).toMatchObject({ acknowledged: true, disposition: 'appended' })
    expect(await pins()).toEqual(new Set([seedId]))
  })
  it('requires both durable outbox acknowledgement and the matching terminal projection receipt', async () => {
    const child = await held('receipt'); child.finish.release(); const run = await child.start.completion
    await db.execute({ sql: 'UPDATE subagent_outbox SET acknowledged=0 WHERE tenant_id=? AND run_id=? AND seq=?', args: [tenant,run.runId,run.lastSeq] })
    expect((await pins()).has('dispatch:receipt')).toBe(true)
    await db.execute({ sql: 'UPDATE subagent_outbox SET acknowledged=1 WHERE tenant_id=? AND run_id=? AND seq=?', args: [tenant,run.runId,run.lastSeq] })
    await db.execute({ sql: 'DELETE FROM subagent_projection_receipts WHERE tenant_id=? AND run_id=? AND seq=?', args: [tenant,run.runId,run.lastSeq] })
    expect((await pins()).has('dispatch:receipt')).toBe(true)
    await agents.ackOwnedProjection(tenant,run.runId,run.lastSeq,'subagent-result:' + run.runId,'appended')
    expect((await pins()).has('dispatch:receipt')).toBe(false)
  })
  it('never recreates a deliberately removed dispatch or retains its orphan admission result', async () => {
    const child = await held('deleted')
    await parent.history.deleteMessage('dispatch:deleted', tenant)
    expect(await pins()).toEqual(new Set([seedId]))
    child.finish.release(); const run = await child.start.completion
    expect(await agents.ownedParentProjection(tenant,run.runId,run.lastSeq)).toMatchObject({ acknowledged: true, disposition: 'suppressed' })
    expect((await messages()).some(message => message.id === 'dispatch:deleted')).toBe(false)
  })
  it('preserves an admitted pair through real authenticated compaction so the late result can still append', async () => {
    const child = await held('late')
    await append({ id: 'compressible-work', role: 'assistant', content: 'Unrelated parent work '.repeat(300) })
    await lease()
    const summarize = vi.fn(async (_source: Message[]) => 'Only completed parent work summarized')
    await withAuthenticatedHistoryMaintenance(owner, consumer!, backend, () => parent.history.compress!(parent,summarize,0))
    const active = await messages()
    expect(active.map(message => message.id)).toEqual(expect.arrayContaining([seedId,'dispatch:late','admission:late']))
    expect(summarize).toHaveBeenCalledOnce()
    expect(summarize.mock.calls[0][0].some(message => message.id === 'dispatch:late' || message.id === 'admission:late')).toBe(false)
    child.finish.release(); const run = await child.start.completion
    expect(await agents.ownedParentProjection(tenant,run.runId,run.lastSeq)).toMatchObject({ acknowledged: true, disposition: 'appended' })
    expect((await messages()).find(message => message.id === 'subagent-result:' + run.runId)?.content).toContain('Final child late')
  })
  it('rechecks the actual maintenance lease after reading invocation state', async () => {
    await held('lease'); const authority = await lease(), source = await messages(), original = db.execute.bind(db)
    let invalidated = false
    vi.spyOn(db,'execute').mockImplementation(async statement => {
      const result = await original(statement)
      const sql = typeof statement === 'string' ? statement : (statement as unknown as { sql: string }).sql
      if (!invalidated && sql.includes('AS parent_message_id,r.parent_tool_call_id FROM collaboration_invocations')) {
        invalidated = true
        await original({ sql: `UPDATE ${backend === 'jsonl' ? 'collaboration_jsonl_epochs' : 'collaboration_history_epochs'} SET epoch=epoch+1 WHERE tenant_id=? AND session_id=?`, args: [tenant,root.sessionId] })
      }
      return result
    })
    await expect(maintenancePinnedIds(source,authority)).rejects.toThrow()
    expect(invalidated).toBe(true)
  })
})
