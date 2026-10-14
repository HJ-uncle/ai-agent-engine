import { buildSync } from 'esbuild'
import { spawnSync } from 'node:child_process'
// Real SQLite/WAL, real ReAct and canonical root/child ownership. Only provider streams are scripted.
// Integration receipts are asserted independently from model-spy dispatch and never mean processed.
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext, Message } from '../../agent-context/types.js'
import type { LLMAdapter, LLMAdapterOptions, LLMStreamChunk } from '../../llm-adapter/types.js'
import type { RunOutcome } from '../../subagent/types.js'
import type { Transaction } from '@libsql/client'
import { ReActStrategy } from '../../agent-loop/react.js'
import { observeRequest } from '../../llm-adapter/request-attempt.js'
import { getDb, closeDb, initDb } from '../../../storage/sqlite/db.js'
import { LocalSqliteProcessClient } from '../../../storage/sqlite/local-process-client.js'
import { RootRunStore } from '../../../storage/root-runs/index.js'
import { JSONLConversationHistory } from '../../../storage/conversation/jsonl-history.js'
import { createConversationHistory } from '../../../storage/conversation/factory.js'
import { serializeConversationHistory, bindHistoryGeneration } from '../../../storage/conversation/serialization.js'
import { admissionProjectingHistory, readAdmissionSeed } from '../../../storage/root-admission/projection.js'
import { ensureUserAdmissionSchema, readDatabaseNamespace, prepareUserAdmission, userAdmissionDigest } from '../../../storage/root-admission/index.js'
import { readAuthenticatedSQLiteHistory } from '../../../storage/conversation/sqlite-origin.js'
import { SubagentStore } from '../../subagent/store.js'
import { SubagentRunner } from '../../subagent/runner.js'
import { CollaborationStore } from '../store.js'
import { CollaborationRuntime } from '../runtime.js'
import { ExecutionOwners, type ExecutionOwner } from '../execution-owner.js'
import * as jsonlBoundary from '../jsonl-react-boundary.js'
import * as sqliteBoundary from '../sqlite-react-boundary.js'
import { SQLiteConversationHistory } from '../../../storage/conversation/history.js'
import { installProductionCollaborationBoundary } from '../production-boundary.js'
import { jsonlHistoryIdentity, readAuthenticatedJSONLHistory } from '../../../storage/conversation/jsonl-origin.js'
import { invalidateSQLiteDeliveryStatements, sqliteHistoryScope } from '../delivery-schema.js'
import type { CollaborationProducer } from '../types.js'

vi.mock('../../../storage/todo/index.js', () => ({ TodoStore: class { async list() { return [] } } }))
let directory: string, db: LocalSqliteProcessClient, observer: LocalSqliteProcessClient
let agents: SubagentStore, runtime: CollaborationRuntime, owners: ExecutionOwners, owner: ExecutionOwner, producer: CollaborationProducer
let backend: 'sqlite' | 'jsonl' = 'jsonl'
let raw: JSONLConversationHistory | SQLiteConversationHistory, ctx: AgentContext, llm: LLMAdapter, outcomes: RunOutcome[]
let rootRunId: string, turnId: string, userId: string
const task = 'Implement the exact current human task.'
const scope = { tenantId: 'production-jsonl-tenant', sessionId: 'parent-session' }
const logger = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() })
function context(history: AgentContext['history'], executionOwner = owner, sessionId = scope.sessionId): AgentContext {
  return { ...scope, sessionId, rootRunId, turnId, userMessageId: userId, executionOwner,
    inheritContext: false, modelCaps: { contextWindow: 100_000 }, tokenBudget: 100_000,
    logger: logger(), history, tools: { list: () => [], has: () => true, executionMode: () => 'serial',
      execute: async () => ({ success: true, output: 'owned scripted tool result' }) },
    runObserver: { onOutcome: async (value: RunOutcome) => { outcomes.push(value) } },
  } as unknown as AgentContext
}
async function run(input: string | null = null, target = ctx, model = llm,
  onFrame?: (frame: string) => Promise<void>): Promise<string[]> {
  const frames: string[] = []
  for await (const frame of new ReActStrategy(model, { maxIterations: 3, maxOutputTokens: 100 }).run(input, target)) {
    frames.push(frame); await onFrame?.(frame)
  }
  return frames
}
const count = async (table: string) => Number((await observer.execute(`SELECT count(*) AS n FROM ${table}`)).rows[0].n)
const epoch = async () => Number((await observer.execute({ sql: 'SELECT epoch FROM collaboration_jsonl_epochs WHERE tenant_id=? AND session_id=?', args: [scope.tenantId, scope.sessionId] })).rows[0]?.epoch ?? 0)
async function seed() {
  const value = await readAdmissionSeed(db, scope, rootRunId)
  await ctx.history.append(value.message, scope)
  if (ctx.jsonlDelivery) await jsonlBoundary.bindJSONLReActBoundary(ctx.jsonlDelivery, ctx, userId)
  else await sqliteBoundary.bindSQLiteReActBoundary(ctx.sqliteDelivery!, ctx, userId)
}
async function child(key = 'dispatch-one') {
  const input = { tenantId: scope.tenantId, rootSessionId: scope.sessionId, parentSessionId: scope.sessionId,
    parentConversationId: turnId, parentMessageId: 'dispatch-message', parentToolCallId: key,
    task: 'Delegated task', description: key, modelId: 'scripted-only',
    continuation: { readOnly: true, systemPrompt: '', toolNames: [], workspacePaths: [] } }
  const admitted = await runtime.admitChild(producer, input)
  return { ...admitted, input, target: 'child:' + admitted.mutation.header.childSessionId }
}
async function mail(body = 'Peer evidence', key: string = randomUUID()) {
  const sender = await child()
  return runtime.send(sender.producer, { recipientParticipantId: 'root:' + rootRunId, message: body, requestKey: key })
}
beforeEach(async () => {
  const old = getDb() as LocalSqliteProcessClient; await closeDb(); await old.whenClosed()
  directory = path.resolve('.e2e-tmp', 'collaboration-compaction-' + randomUUID()); fs.mkdirSync(directory, { recursive: true })
  vi.stubEnv('DATA_DIR', path.join(directory, 'fixture.db')); vi.stubEnv('HISTORY_BACKEND', backend)
  db = getDb() as LocalSqliteProcessClient
  observer = new LocalSqliteProcessClient({ url: 'file:' + path.join(directory, 'fixture.db').replaceAll('\\', '/') })
  await initDb()
  await ensureUserAdmissionSchema(db)
  const roots = new RootRunStore(() => db), namespace = await readDatabaseNamespace(db)
  const selector = { protocolVersion: 1 as const, namespace, owner: 'code' as const, predecessor: null }
  const transport = { toolProfile: 'general', runLifetime: 'durable', subagentProtocol: 2 as const }
  const body: Record<string, unknown> = { sessionId: scope.sessionId, message: task, model: 'scripted-only' }
  body.admission = { ...selector, requestKey: 'root-admission', bodyDigest: userAdmissionDigest(body, transport, selector) }
  const admitted = await roots.createUserAdmission(scope.tenantId, 'scripted-only', [], body, prepareUserAdmission(body, transport)!)
  rootRunId = admitted.run.runId; turnId = admitted.run.turnId; userId = admitted.run.userMessageId
  agents = new SubagentStore(db); runtime = new CollaborationRuntime(new CollaborationStore(db), agents)
  owners = new ExecutionOwners(db, runtime)
  owner = await owners.admitRoot({ tenantId: scope.tenantId, rootRunId, rootAttemptId: admitted.receipt.attemptId, controller: new AbortController() })
  producer = owners.producer(owner)
  raw = backend === 'jsonl' ? new JSONLConversationHistory() : new SQLiteConversationHistory()
  const history = admissionProjectingHistory(bindHistoryGeneration(serializeConversationHistory(raw), scope.tenantId, scope.sessionId),
    { rootRunId, turnId, userMessageId: userId, assistantAnchorId: admitted.receipt.assistantMessageId })
  outcomes = []; ctx = context(history); installProductionCollaborationBoundary(ctx)
  llm = { model: 'scripted-only', provider: 'test', complete: vi.fn(), countTokens: () => 0,
    stream: vi.fn(async function* (): AsyncGenerator<LLMStreamChunk> { yield { done: true, content: 'Final scripted response.' } }) }
})
afterEach(async () => {
  vi.restoreAllMocks(); await closeDb(); observer.close()
  await Promise.all([db.whenClosed(), observer.whenClosed()]); vi.unstubAllEnvs()
  if (path.dirname(directory) !== path.resolve('.e2e-tmp') || !path.basename(directory).startsWith('collaboration-compaction-')) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

async function maintain<T>(action: () => Promise<T>): Promise<T> {
  // The exact before control has the old direct-maintenance call. The real
  // automatic ReAct contracts below do not use this compatibility branch.
  if (ctx.jsonlDelivery && 'maintainJSONLReActHistory' in jsonlBoundary)
    return jsonlBoundary.maintainJSONLReActHistory(ctx.jsonlDelivery, ctx, action)
  if (ctx.sqliteDelivery && 'maintainSQLiteReActHistory' in sqliteBoundary)
    return sqliteBoundary.maintainSQLiteReActHistory(ctx.sqliteDelivery, ctx, action)
  return action()
}
async function consume() {
  return ctx.jsonlDelivery ? jsonlBoundary.consumeJSONLReActIteration(ctx.jsonlDelivery, ctx)
    : sqliteBoundary.consumeSQLiteReActIteration(ctx.sqliteDelivery!, ctx)
}
async function receipt(id: string) { return backend === 'jsonl' ? runtime.jsonlDeliveryReceipt(producer, id) : runtime.sqliteDeliveryReceipt(producer, id) }
async function active() { return backend === 'jsonl' ? (await readAuthenticatedJSONLHistory(ctx.history, scope))! : (await readAuthenticatedSQLiteHistory(ctx.history, scope))! }
async function identity(id: string) {
  if (backend === 'sqlite') return (await observer.execute({ sql: 'SELECT * FROM conversations WHERE tenant_id=? AND session_id=? AND message_id=?', args: [scope.tenantId, scope.sessionId, id] })).rows[0]
  const snapshot = await jsonlHistoryIdentity(ctx.history)!.inspect(scope), rows = snapshot.rows.filter(row => row.id === id)
  return { fileIdentity: snapshot.fileIdentity, rows }
}
async function maintenanceCount() { try { return await count('collaboration_history_maintenance') } catch { return 0 } }
async function addTool(id: string, body: string) {
  await raw.append({ id: id + '-call', role: 'assistant', content: '', toolCall: { id, name: 'read_file', args: { path: 'fixture-only' } }, conversationId: turnId }, scope)
  await raw.append({ id: id + '-result', role: 'tool', content: body, toolCallId: id, toolName: 'read_file', conversationId: turnId }, scope)
}

describe.each(['jsonl', 'sqlite'] as const)('%s exact private compaction continuity', selected => {
  beforeAll(() => { backend = selected })
  it('actual ReAct automatically micro-compacts and reaches one provider dispatch with the original seed and peer receipt', async () => {
    await seed(); const accepted = await mail('Micro peer evidence'); await consume()
    const before = await identity(userId), peerBefore = await receipt(accepted.messageId)
    await addTool('huge-output', 'Complete file output '.repeat(5000))
    ctx.modelCaps = { contextWindow: 6000 }; ctx.tokenBudget = 6000
    await run()
    expect(llm.stream).toHaveBeenCalledTimes(1)
    expect(outcomes.at(-1)?.status).toBe('succeeded')
    expect(await identity(userId)).toEqual(before)
    expect(await receipt(accepted.messageId)).toEqual(peerBefore)
    const messages = vi.mocked(llm.stream).mock.calls[0][0]
    expect(messages.find(message => message.id === userId)?.content).toBe(task)
    expect(messages.find(message => message.id === 'huge-output-result')?.content).toBe('[tool result cleared]')
    expect(await maintenanceCount()).toBe(1)
  })

  it('actual ReAct automatically summarizes long current-turn work and continues with its exact original input', async () => {
    await seed(); const accepted = await mail('Long peer evidence '.repeat(1000)); await consume()
    const before = await identity(userId)
    await raw.append({ id: 'long-current-work', role: 'assistant', content: 'Long current work '.repeat(2500), conversationId: turnId }, scope)
    llm.complete = vi.fn(async () => ({ content: '<summary>Exact previous work evidence and remaining work.</summary>', promptTokens: 1, completionTokens: 1, finishReason: 'stop' as const }))
    ctx.modelCaps = { contextWindow: 12000 }; ctx.tokenBudget = 12000
    await run()
    expect(llm.complete).toHaveBeenCalled()
    if (backend === 'sqlite') expect(String(vi.mocked(llm.complete).mock.calls[0][0][0].content)).not.toContain('[user, verbatim]')
    expect(llm.stream).toHaveBeenCalledTimes(1); expect(outcomes.at(-1)?.status).toBe('succeeded')
    expect(await identity(userId)).toEqual(before)
    expect((await receipt(accepted.messageId))?.state).toBe('suppressed')
    const messages = vi.mocked(llm.stream).mock.calls[0][0]
    expect(messages.filter(message => message.id === userId)).toHaveLength(1)
    expect(messages.some(message => message.role === 'system' && String(message.content).includes('Exact previous work evidence'))).toBe(true)
    expect(await maintenanceCount()).toBeGreaterThan(0)
  })

  it('retires covered mail once, preserves retained physical origins and keeps unresolved dispatch anchors through repeated summaries', async () => {
    await seed(); const original = await identity(userId), old = await mail('Covered exact evidence'); await consume()
    await raw.append({ id: 'pending-dispatch', role: 'assistant', content: '', toolCall: { id: 'pending-call', name: 'subagent', args: { task: 'still executing' } }, conversationId: turnId }, scope)
    const dispatchBefore = await identity('pending-dispatch')
    const recent = await mail('Retained exact evidence', 'recent-key'); await consume()
    const recentReceipt = (await receipt(recent.messageId))!, recentBefore = await identity(recentReceipt.historyMessageId)
    const summarize = vi.fn(async (_messages: Message[]) => 'Current same-turn summary')
    await maintain(() => ctx.history.compress!(ctx, summarize, 1))
    expect(summarize).toHaveBeenCalled()
    expect(summarize.mock.calls[0][0].some((message: Message) => message.id === userId || message.id === 'pending-dispatch')).toBe(false)
    expect(await identity(userId)).toEqual(original); expect(await identity('pending-dispatch')).toEqual(dispatchBefore)
    expect(await identity(recentReceipt.historyMessageId)).toEqual(recentBefore)
    expect((await receipt(old.messageId))?.state).toBe('suppressed'); expect((await receipt(recent.messageId))?.state).toBe('integrated')
    expect((await active()).some(message => message.id === recentReceipt.historyMessageId)).toBe(true)
    await maintain(() => ctx.history.compress!(ctx, async () => 'Second exact current-turn summary', 0))
    expect(await identity(userId)).toEqual(original); expect(await identity('pending-dispatch')).toEqual(dispatchBefore)
    expect((await receipt(recent.messageId))?.state).toBe('suppressed')
    const newest = await mail('New mail after two summaries', 'newest-key'); expect((await consume()).receipts).toHaveLength(1)
    await run(); expect(llm.stream).toHaveBeenCalledTimes(1); expect(outcomes.at(-1)?.status).toBe('succeeded')
    expect((await receipt(newest.messageId))?.state).toBe('integrated')
    expect((await consume()).receipts).toHaveLength(0)
    expect(await maintenanceCount()).toBe(2)
  })

  it('does not use maintenance to recover a replaced seed or accept a copied boundary', async () => {
    await seed(); await addTool('ordinary-output', 'tool output')
    if (ctx.jsonlDelivery) await expect(jsonlBoundary.maintainJSONLReActHistory({ ...ctx.jsonlDelivery }, ctx, async () => undefined)).rejects.toMatchObject({ code: 'forbidden' })
    else await expect(sqliteBoundary.maintainSQLiteReActHistory({ ...ctx.sqliteDelivery! }, ctx, async () => undefined)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(maintain(() => ctx.history.compress!(ctx, async () => {
      if (backend === 'jsonl') {
        await observer.execute({ sql: 'UPDATE collaboration_jsonl_epochs SET epoch=epoch+1 WHERE tenant_id=? AND session_id=?', args: [scope.tenantId, scope.sessionId] })
        const file = path.join(directory, 'sessions', scope.tenantId, scope.sessionId + '.jsonl')
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(task, 'Changed input inside slow summary'))
      } else await observer.batch([...invalidateSQLiteDeliveryStatements(sqliteHistoryScope(scope.tenantId, scope.sessionId)),
        { sql: 'UPDATE conversations SET content=? WHERE tenant_id=? AND session_id=? AND message_id=?', args: ['Changed input inside slow summary', scope.tenantId, scope.sessionId, userId] }], 'write')
      return 'Stale summary must never commit'
    }, 0))).rejects.toThrow()
    await run(); expect(llm.stream).not.toHaveBeenCalled(); expect(outcomes.at(-1)?.status).toBe('failed')
    expect(await maintenanceCount()).toBe(0)
  })

  it('requires the actual private consumer and owner even when all readable maintenance fields are known', async () => {
    await seed()
    const internal = await import('../history-maintenance.js')
    const action = vi.fn(async () => undefined)
    await expect(internal.withAuthenticatedHistoryMaintenance({ ...owner } as ExecutionOwner, {} as never, backend, action)).rejects.toThrow('Forged execution capability')
    await expect(internal.withAuthenticatedHistoryMaintenance(owner, {} as never, backend, action)).rejects.toMatchObject({ code: 'forbidden' })
    expect(action).not.toHaveBeenCalled(); expect(await maintenanceCount()).toBe(0)
    await run(); expect(llm.stream).toHaveBeenCalledTimes(1)
  })

  it('preserves the exact live child dispatch through compression and root drain waits for its real terminal projection', async () => {
    await seed()
    const input = { tenantId: scope.tenantId, rootSessionId: scope.sessionId, parentSessionId: scope.sessionId,
      parentConversationId: turnId, parentMessageId: 'owned-live-dispatch', parentToolCallId: 'owned-live-call',
      task: 'Exact delegated child task', description: 'Held actual canonical child', modelId: 'scripted-only',
      continuation: { readOnly: true, systemPrompt: '', toolNames: [], workspacePaths: [] } }
    await raw.append({ id: input.parentMessageId, role: 'assistant', content: '', toolCall: { id: input.parentToolCallId, name: 'subagent', args: {} }, conversationId: turnId }, scope)
    await raw.append({ id: 'compressible-work', role: 'assistant', content: 'Other parent work', conversationId: turnId }, scope)
    const originalDispatch = await identity(input.parentMessageId)
    let entered!: () => void, release!: () => void, childProducer: CollaborationProducer | undefined, sentId = ''
    const ready = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const childModel: LLMAdapter = { ...llm, stream: vi.fn(async function* () { entered(); await gate; yield { done: true, content: 'Exact child terminal response' } }) }
    const pending = new SubagentRunner(agents).run(input, ctx, async execution => {
      childProducer = owners.producerForExecution(execution.executionOwner!)
      expect(childProducer).not.toBe(producer)
      const target = context(createConversationHistory(), execution.executionOwner!, execution.snapshot.childSessionId)
      delete target.userMessageId; target.runId = execution.snapshot.runId; target.runObserver = execution.observer; target.signal = execution.signal
      installProductionCollaborationBoundary(target)
      const sent = await runtime.send(producer, { recipientParticipantId: 'child:' + execution.snapshot.childSessionId, message: 'Exact parent evidence for this child', requestKey: 'held-child-mail' })
      sentId = sent.messageId
      await run(input.task, target, childModel)
    })
    try {
      await Promise.race([ready, pending.then(() => { throw new Error('Child settled before provider gate') })])
      expect(childProducer).toBeDefined()
      await maintain(() => ctx.history.compress!(ctx, async () => 'Parent work while exact child continues', 0))
      expect(await identity(input.parentMessageId)).toEqual(originalDispatch)
      let settled = false
      const draining = owners.drain(owner, 'finish').then(proof => { settled = true; return proof })
      await expect.poll(async () => (await observer.execute('SELECT phase FROM collaboration_roots')).rows[0].phase).toBe('draining')
      expect(settled).toBe(false)
      release(); const result = await pending; await draining
      expect(result.status).toBe('succeeded'); expect(settled).toBe(true)
      const projected = (await ctx.history.getFullHistory(scope)).find(message => message.id === 'subagent-result:' + result.runId)
      expect(projected).toMatchObject({ role: 'tool', toolCallId: input.parentToolCallId })
      expect(String(projected!.content)).toContain('Exact child terminal response')
      expect(vi.mocked(childModel.stream).mock.calls[0][0].map(message => message.role)).toEqual(['user', 'user'])
      const deliveryTable = backend === 'jsonl' ? 'collaboration_jsonl_deliveries' : 'collaboration_deliveries'
      expect((await observer.execute({ sql: `SELECT recipient_invocation_run_id FROM ${deliveryTable} WHERE message_id=?`, args: [sentId] })).rows[0].recipient_invocation_run_id).toBe(result.runId)
      expect((await ctx.history.getFullHistory(scope)).some(message => String(message.content).includes('Exact parent evidence for this child'))).toBe(false)
    } finally { release(); await pending.catch(() => undefined) }
  })
})

describe('JSONL durable private compaction recovery', () => {
  beforeAll(() => { backend = 'jsonl' })
  it.each(['reservation-ACK', 'final-ACK', 'partial-write', 'sync-ACK'] as const)('reconciles %s without repeating summary generation, moving the seed or replaying retired mail', async kind => {
    await seed(); const accepted = await mail('Archive exact peer evidence'); await consume()
    const before = await identity(userId), native = db.transaction.bind(db), open = fs.promises.open.bind(fs.promises)
    let lost = false
    if (kind.endsWith('ACK') && kind !== 'sync-ACK') vi.spyOn(db, 'transaction').mockImplementation(async mode => {
      const tx = await native(mode); let target = false
      return new Proxy(tx, { get(value, property) {
        if (property === 'execute') return async (statement: Parameters<Transaction['execute']>[0]) => {
          const sql = typeof statement === 'string' ? statement : statement.sql
          target ||= kind === 'reservation-ACK' ? sql.includes('INSERT INTO collaboration_history_maintenance') : sql.includes("UPDATE collaboration_history_maintenance SET state='committed'")
          return value.execute(statement)
        }
        if (property === 'commit') return async () => { await value.commit(); if (target && !lost) { lost = true; throw new Error('lost maintenance ACK') } }
        const method = Reflect.get(value, property); return typeof method === 'function' ? method.bind(value) : method
      } })
    })
    else vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args)
      if (args[1] !== 'r+') return handle
      return new Proxy(handle, { get(value, property) {
        if (property === 'write' && kind === 'partial-write') return async (buffer: Uint8Array, offset: number, length: number, position: number) => {
          if (!lost) { lost = true; await value.write(buffer, offset, Math.floor(length / 3), position); throw new Error('lost maintenance file write') }
          return value.write(buffer, offset, length, position)
        }
        if (property === 'sync' && kind === 'sync-ACK') return async () => { await value.sync(); if (!lost) { lost = true; throw new Error('lost maintenance sync ACK') } }
        const method = Reflect.get(value, property); return typeof method === 'function' ? method.bind(value) : method
      } })
    })
    const summarize = vi.fn(async () => 'Durable exact summary')
    await expect(maintain(() => ctx.history.compress!(ctx, summarize, 0))).rejects.toThrow('lost maintenance')
    expect(lost).toBe(true)
    // A fresh history instance reconciles only the reserved exact bytes before
    // appending new work, including a complete row whose final ACK was lost.
    const reopened = new JSONLConversationHistory()
    await reopened.append({ id: 'after-maintenance', role: 'assistant', content: 'Continue after durable recovery', conversationId: turnId }, scope)
    expect(summarize).toHaveBeenCalledTimes(1); expect(await identity(userId)).toEqual(before)
    expect((await receipt(accepted.messageId))?.state).toBe('suppressed')
    expect(await maintenanceCount()).toBe(1)
    expect((await observer.execute('SELECT state FROM collaboration_history_maintenance')).rows[0].state).toBe('committed')
    await run(); expect(llm.stream).toHaveBeenCalledTimes(1); expect(outcomes.at(-1)?.status).toBe('succeeded')
    const file = path.join(directory, 'sessions', scope.tenantId, scope.sessionId + '.jsonl')
    const summaries = fs.readFileSync(file, 'utf8').split('\n').flatMap(line => { try { const row = JSON.parse(line); return row.type === 'summary' ? [row] : [] } catch { return [] } })
    expect(summaries).toHaveLength(1)
  })

  it.each(['exact-recovery', 'changed-physical-prefix'] as const)('fresh native process uses only the persisted maintenance receipt for %s', async kind => {
    await seed(); const accepted = await mail('Exact prefix peer evidence'); await consume()
    const originalInput = await identity(userId), native = db.transaction.bind(db)
    let lost = false
    const fault = vi.spyOn(db, 'transaction').mockImplementation(async mode => {
      const tx = await native(mode); let reserved = false
      return new Proxy(tx, { get(value, property) {
        if (property === 'execute') return async (statement: Parameters<Transaction['execute']>[0]) => {
          reserved ||= (typeof statement === 'string' ? statement : statement.sql).includes('INSERT INTO collaboration_history_maintenance')
          return value.execute(statement)
        }
        if (property === 'commit') return async () => { await value.commit(); if (reserved && !lost) { lost = true; throw new Error('fresh process reservation ACK lost') } }
        const method = Reflect.get(value, property); return typeof method === 'function' ? method.bind(value) : method
      } })
    })
    await expect(maintain(() => ctx.history.compress!(ctx, async () => 'Exact restart continuation summary', 0))).rejects.toThrow('reservation ACK lost')
    fault.mockRestore()
    const archive = path.join(directory, 'sessions', scope.tenantId, scope.sessionId + '.jsonl')
    if (kind === 'changed-physical-prefix') fs.writeFileSync(archive, fs.readFileSync(archive, 'utf8').replace('Exact prefix peer evidence', 'WRONG prefix peer evidence'))
    const childFile = path.join(directory, 'restart-child.mjs')
    buildSync({ entryPoints: [path.resolve('src/core/collaboration/__tests__/fixtures/jsonl-maintenance-restart.ts')], outfile: childFile,
      bundle: true, packages: 'external', platform: 'node', format: 'esm' })
    const child = spawnSync(process.execPath, [childFile, JSON.stringify({ ...scope, turnId, anchorId: userId })], { cwd: process.cwd(), env: process.env,
      encoding: 'utf8', windowsHide: true, timeout: 15000 })
    expect(child.error).toBeUndefined(); expect(child.status, child.stderr).toBe(0)
    const result = JSON.parse(child.stdout.trim().split('\n').at(-1)!)
    expect(result.pid).not.toBe(process.pid); expect(result.healthyClose).toBe(true)
    expect(result.recovered).toBe(kind === 'exact-recovery')
    if (kind === 'exact-recovery') {
      expect(result.anchor).toMatchObject({ id: userId, role: 'user', content: task })
      expect(result.receiptStates).toEqual(['committed']); expect(result.summaryRows).toBe(1)
      expect(result.messageIds).toContain('fresh-process-marker')
      expect(await identity(userId)).toEqual(originalInput)
      expect((await receipt(accepted.messageId))?.state).toBe('suppressed')
      await run(); expect(llm.stream).toHaveBeenCalledTimes(1)
    } else {
      expect(result.error).toContain('physical record changed')
      expect(fs.readFileSync(archive, 'utf8')).not.toContain('fresh-process-marker')
      await raw.clear(scope, { tombstone: false })
      const next = new JSONLConversationHistory()
      await next.append({ id: 'fresh-after-clear', role: 'user', content: 'Explicitly new task' }, scope)
      expect((await observer.execute('SELECT state FROM collaboration_history_maintenance')).rows[0].state).toBe('invalidated')
      expect((await next.getFullHistory(scope)).map(message => message.id)).toEqual(['fresh-after-clear'])
    }
  })
})
