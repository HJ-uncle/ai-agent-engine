// Real SQLite/WAL, real ReAct and canonical root/child ownership. Only provider streams are scripted.
// Integration receipts are asserted independently from model-spy dispatch and never mean processed.
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import type { AgentContext, Message } from '../../agent-context/types.js'
import type { LLMAdapter, LLMAdapterOptions, LLMStreamChunk } from '../../llm-adapter/types.js'
import type { RunOutcome } from '../../subagent/types.js'
import type { Transaction } from '@libsql/client'
import { ReActStrategy } from '../../agent-loop/react.js'
import { observeRequest } from '../../llm-adapter/request-attempt.js'
import { getDb, closeDb, initDb } from '../../../storage/sqlite/db.js'
import { LocalSqliteProcessClient } from '../../../storage/sqlite/local-process-client.js'
import { RootRunStore } from '../../../storage/root-runs/index.js'
import { SQLiteConversationHistory } from '../../../storage/conversation/history.js'
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
import { createSQLiteReActBoundary, bindSQLiteReActBoundary } from '../sqlite-react-boundary.js'
import { invalidateSQLiteDeliveryStatements, sqliteHistoryScope } from '../delivery-schema.js'
import type { CollaborationProducer } from '../types.js'

vi.mock('../../../storage/todo/index.js', () => ({ TodoStore: class { async list() { return [] } } }))
let directory: string, db: LocalSqliteProcessClient, observer: LocalSqliteProcessClient
let agents: SubagentStore, runtime: CollaborationRuntime, owners: ExecutionOwners, owner: ExecutionOwner, producer: CollaborationProducer
let raw: SQLiteConversationHistory, ctx: AgentContext, llm: LLMAdapter, outcomes: RunOutcome[]
let rootRunId: string, turnId: string, userId: string
const task = 'Implement the exact current human task.'
const scope = { tenantId: 'sqlite-react-tenant', sessionId: 'parent-session' }
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
const epoch = async () => Number((await observer.execute({ sql: 'SELECT epoch FROM collaboration_history_epochs WHERE tenant_id=? AND session_id=?', args: [scope.tenantId, scope.sessionId] })).rows[0]?.epoch ?? 0)
async function seed() {
  const value = await readAdmissionSeed(db, scope, rootRunId)
  await ctx.history.append(value.message, scope)
  await bindSQLiteReActBoundary(ctx.sqliteDelivery!, ctx, userId)
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
  directory = path.resolve('.e2e-tmp', 'sqlite-react-' + randomUUID()); fs.mkdirSync(directory, { recursive: true })
  vi.stubEnv('DATA_DIR', path.join(directory, 'fixture.db')); vi.stubEnv('HISTORY_BACKEND', 'sqlite')
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
  raw = new SQLiteConversationHistory()
  const history = admissionProjectingHistory(bindHistoryGeneration(serializeConversationHistory(raw), scope.tenantId, scope.sessionId),
    { rootRunId, turnId, userMessageId: userId, assistantAnchorId: admitted.receipt.assistantMessageId })
  outcomes = []; ctx = context(history); ctx.sqliteDelivery = createSQLiteReActBoundary(ctx)
  llm = { model: 'scripted-only', provider: 'test', complete: vi.fn(), countTokens: () => 0,
    stream: vi.fn(async function* (): AsyncGenerator<LLMStreamChunk> { yield { done: true, content: 'Final scripted response.' } }) }
})
afterEach(async () => {
  vi.restoreAllMocks(); await closeDb(); observer.close()
  await Promise.all([db.whenClosed(), observer.whenClosed()]); vi.unstubAllEnvs()
  if (path.dirname(directory) !== path.resolve('.e2e-tmp') || !path.basename(directory).startsWith('sqlite-react-')) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

it('preserves the admitted human plus both peers and the actual current tool exchange when inheritance is disabled', async () => {
  await raw.append({ id: 'prior-human', role: 'user', content: 'Prior turn', conversationId: 'old-turn' }, scope)
  await seed()
  const first = await mail('First peer evidence')
  const consumer = await runtime.bindSQLiteDelivery(producer, { db, ...scope, anchorId: userId })
  await runtime.consumeSQLiteDelivery(consumer)
  await raw.append({ id: 'current-assistant', role: 'assistant', content: 'Working', toolCall: { id: 'tool-one', name: 'step', args: {} }, conversationId: turnId }, scope)
  await raw.append({ id: 'current-tool', role: 'tool', content: 'Actual tool evidence', toolCallId: 'tool-one', conversationId: turnId }, scope)
  const second = await mail('Second peer evidence'); await runtime.consumeSQLiteDelivery(consumer)
  await run()
  expect(llm.stream).toHaveBeenCalledTimes(1)
  const messages = vi.mocked(llm.stream).mock.calls[0][0]
  const receipt1 = await runtime.sqliteDeliveryReceipt(producer, first.messageId), receipt2 = await runtime.sqliteDeliveryReceipt(producer, second.messageId)
  expect(messages.map(message => message.id)).toEqual([userId, receipt1!.historyMessageId, 'current-assistant', 'current-tool', receipt2!.historyMessageId])
  expect(messages[0].content).toBe(task)
  expect(messages.filter(message => String(message.content).startsWith('[对等 Agent 消息]'))).toHaveLength(2)
  expect(outcomes.at(-1)?.status).toBe('succeeded')
})
it('uses the authenticated SQLite origin reader even when no private consumer was requested', async () => {
  await seed(); const accepted = await mail()
  await runtime.consumeSQLiteDelivery(await runtime.bindSQLiteDelivery(producer, { db, ...scope, anchorId: userId }))
  delete ctx.sqliteDelivery; await run()
  expect(vi.mocked(llm.stream).mock.calls[0][0].map(message => message.id)).toEqual([userId, (await runtime.sqliteDeliveryReceipt(producer, accepted.messageId))!.historyMessageId])
})
it('refuses an independently edited root input before first binding rather than adopting its readable ID', async () => {
  const admitted = await readAdmissionSeed(db, scope, rootRunId)
  await ctx.history.append(admitted.message, scope); await mail()
  await observer.execute({ sql: 'UPDATE conversations SET content=? WHERE message_id=?', args: ['Replaced task with same ID', userId] })
  await run()
  expect(llm.stream).not.toHaveBeenCalled(); expect(await count('collaboration_deliveries')).toBe(0)
  expect(outcomes.at(-1)).toMatchObject({ status: 'failed', stopReason: 'runtime_error' })
})
it.each(['compress', 'micro-compact'] as const)('atomically invalidates %s, suppresses retained peer origin and rejects rebind or replay', async kind => {
  for (let n = 0; n < 5; n++) await raw.append({ id: 'old-' + n, role: 'assistant', content: 'Old evidence', conversationId: 'old-turn' }, scope)
  await seed(); const accepted = await mail()
  const consumer = await runtime.bindSQLiteDelivery(producer, { db, ...scope, anchorId: userId }); await runtime.consumeSQLiteDelivery(consumer)
  await raw.append({ id: 'compact-tool', role: 'tool', content: 'large evidence '.repeat(500), toolCallId: 'old-call', conversationId: turnId }, scope)
  const prior = await epoch()
  if (kind === 'compress') await raw.compress(scope, async () => 'Owned summary', 3)
  else expect((await raw.microCompactToolResults(scope, { keepRecent: 0 })).cleared).toBe(1)
  expect(await epoch()).toBe(prior + 1)
  expect(await runtime.sqliteDeliveryReceipt(producer, accepted.messageId)).toMatchObject({ state: 'suppressed', reason: 'history_changed' })
  await expect(runtime.consumeSQLiteDelivery(consumer)).rejects.toMatchObject({ code: 'conflict' })
  await expect(bindSQLiteReActBoundary(ctx.sqliteDelivery!, ctx, userId)).rejects.toMatchObject({ code: 'conflict' })
  const projection = await readAuthenticatedSQLiteHistory(ctx.history, { ...scope, inheritContext: false })
  expect(projection![0].id).toBe(userId); expect(projection!.some(message => String(message.content).startsWith('[对等 Agent 消息]'))).toBe(false)
  await run(); expect(llm.stream).not.toHaveBeenCalled(); expect(await count('collaboration_deliveries')).toBe(1)
})
it('does not increment epoch for a no-op micro compact, and rolls invalidation back with a failed tool update', async () => {
  await seed(); const accepted = await mail(); const consumer = await runtime.bindSQLiteDelivery(producer, { db, ...scope, anchorId: userId })
  await runtime.consumeSQLiteDelivery(consumer); const prior = await epoch()
  expect((await raw.microCompactToolResults(scope)).cleared).toBe(0); expect(await epoch()).toBe(prior)
  await raw.append({ id: 'tool', role: 'tool', content: 'mutable evidence', toolCallId: 'call' }, scope)
  await db.execute("CREATE TRIGGER fail_tool_update BEFORE UPDATE ON conversations WHEN OLD.role='tool' BEGIN SELECT RAISE(ABORT,'owned update failure'); END")
  await expect(raw.microCompactToolResults(scope, { keepRecent: 0 })).rejects.toThrow('owned update failure')
  expect(await epoch()).toBe(prior); expect((await runtime.sqliteDeliveryReceipt(producer, accepted.messageId))?.state).toBe('integrated')
})
it('rolls compaction epoch and receipts back when rebuilding history fails', async () => {
  for (let n = 0; n < 3; n++) await raw.append({ id: 'old-' + n, role: 'assistant', content: 'Old evidence' }, scope)
  await seed(); const accepted = await mail(); await runtime.consumeSQLiteDelivery(await runtime.bindSQLiteDelivery(producer, { db, ...scope, anchorId: userId }))
  const prior = await epoch(), previousRows = (await observer.execute('SELECT * FROM conversations ORDER BY id')).rows
  await db.execute("CREATE TRIGGER fail_summary BEFORE INSERT ON conversations WHEN NEW.role='system' BEGIN SELECT RAISE(ABORT,'owned rebuild failure'); END")
  await expect(raw.compress(scope, async () => 'Summary', 2)).rejects.toThrow('owned rebuild failure')
  expect(await epoch()).toBe(prior); expect((await observer.execute('SELECT * FROM conversations ORDER BY id')).rows).toEqual(previousRows)
  expect((await runtime.sqliteDeliveryReceipt(producer, accepted.messageId))?.state).toBe('integrated')
})
it.each(['metadata', 'prefix'] as const)('does not authenticate a forged %s peer as the current human anchor', async forgery => {
  await seed(); await mail()
  await raw.append({ id: forgery === 'prefix' ? 'peer:unreceipted' : 'forged-row', role: 'user', content: 'Ordinary untrusted user text',
    conversationId: turnId, metadata: { collaborationDelivery: { version: 1, rootRunId } } }, scope)
  await run(); expect(llm.stream).not.toHaveBeenCalled(); expect(await count('collaboration_deliveries')).toBe(0)
})
it('refuses a WAL edit after final budgeting before the scripted provider is called', async () => {
  await seed(); const accepted = await mail(); let edited = false
  await run(null, ctx, llm, async frame => {
    if (!edited && frame.startsWith('\x00__usage__')) {
      edited = true
      const receipt = await runtime.sqliteDeliveryReceipt(producer, accepted.messageId)
      await observer.execute({ sql: 'UPDATE conversations SET content=? WHERE message_id=?', args: ['changed by independent writer', receipt!.historyMessageId] })
    }
  })
  expect(edited).toBe(true); expect(llm.stream).not.toHaveBeenCalled(); expect(await count('collaboration_deliveries')).toBe(1)
})
it('rejects mail that exceeds the final model window while preserving its queryable integration receipt', async () => {
  ctx.modelCaps = { contextWindow: 1_000 }; ctx.tokenBudget = 100_000
  const accepted = await mail('Large evidence '.repeat(1_600))
  await run(task)
  expect(llm.stream).not.toHaveBeenCalled(); expect(llm.complete).not.toHaveBeenCalled()
  expect((await runtime.sqliteDeliveryReceipt(producer, accepted.messageId))?.state).toBe('integrated')
  expect(outcomes.at(-1)).toMatchObject({ status: 'failed', stopReason: 'context_limit' })
})
it('consumes a bounded backlog over real ReAct iterations without duplicate history or receipts', async () => {
  for (let n = 0; n < 35; n++) await mail('Evidence ' + n, 'mail-' + n)
  let calls = 0
  llm.stream = vi.fn(async function* () {
    if (calls++ === 0) yield { done: true, content: 'Continue', toolCalls: [{ id: 'step', name: 'step', args: '{}', index: 0 }] }
    else yield { done: true, content: 'Final' }
  })
  await run(task)
  expect(llm.stream).toHaveBeenCalledTimes(2)
  const messages = vi.mocked(llm.stream).mock.calls.map(([value]) => value)
  expect(messages[0].filter(message => String(message.content).startsWith('[对等 Agent 消息]'))).toHaveLength(32)
  expect(messages[1].filter(message => String(message.content).startsWith('[对等 Agent 消息]'))).toHaveLength(35)
  expect(await count('collaboration_deliveries')).toBe(35)
  expect(Number((await observer.execute("SELECT count(*) AS n FROM conversations WHERE message_id LIKE 'peer:%'")).rows[0].n)).toBe(35)
})
it('keeps integrated distinct from provider failure and does not append the same mail on model retry', async () => {
  const accepted = await mail()
  llm.stream = vi.fn(async function* () { throw new Error('scripted provider failure'); yield { done: true } })
  await run(task); expect(llm.stream).toHaveBeenCalledTimes(1)
  expect((await runtime.sqliteDeliveryReceipt(producer, accepted.messageId))?.state).toBe('integrated')
  llm.stream = vi.fn(async function* () { yield { done: true, content: 'Retry result' } })
  await run(); expect(llm.stream).toHaveBeenCalledTimes(1)
  expect(await count('collaboration_deliveries')).toBe(1)
  expect(vi.mocked(llm.stream).mock.calls[0][0].filter(message => String(message.content).startsWith('[对等 Agent 消息]'))).toHaveLength(1)
})
it('guards the actual provider-attempt boundary and refuses a retry after an independent epoch change', async () => {
  const accepted = await mail(), wire = vi.fn(async () => { throw new Error('scripted wire failure') })
  const attempts: string[] = []; ctx.onRequestAttempt = event => { attempts.push(event.type) }
  llm.stream = vi.fn(async function* (_messages: Message[], options?: LLMAdapterOptions) {
    await expect(observeRequest(wire, options, 'test', 'scripted-only', () => undefined)).rejects.toThrow('scripted wire failure')
    await observer.batch(invalidateSQLiteDeliveryStatements(sqliteHistoryScope(scope.tenantId, scope.sessionId)), 'write')
    await observeRequest(wire, options, 'test', 'scripted-only', () => undefined)
    yield { done: true, content: 'Unreachable stale retry' }
  })
  await run(task)
  expect(llm.stream).toHaveBeenCalledTimes(1); expect(wire).toHaveBeenCalledTimes(1)
  expect(attempts).toEqual(['start', 'finish'])
  expect((await runtime.sqliteDeliveryReceipt(producer, accepted.messageId))?.state).toBe('suppressed')
  expect(await count('collaboration_deliveries')).toBe(1); expect(outcomes.at(-1)?.status).toBe('failed')
})
it('routes a private child producer into its actual child transcript and refuses root substitution or copied capabilities', async () => {
  const admitted = await child(), ticket = owners.reserveChild(owner), runId = admitted.mutation.header.runId
  expect(() => owners.attachChild(ticket, runId, producer)).toThrow('Child producer')
  expect(() => owners.attachChild(ticket, runId + '-other', admitted.producer)).toThrow('Child producer')
  const childOwner = owners.attachChild(ticket, runId, admitted.producer)
  expect(owners.producerForExecution(childOwner)).toBe(admitted.producer); expect(admitted.producer).not.toBe(producer)
  expect(() => owners.producer(childOwner)).toThrow('root capability')
  expect(await runtime.recoverChildProducer(producer, admitted.input)).toBe(admitted.producer)
  await expect(runtime.recoverChildProducer(producer, { ...admitted.input, task: 'Altered dispatch' })).rejects.toMatchObject({ code: 'conflict' })
  const target = context(createConversationHistory(), childOwner, admitted.mutation.header.childSessionId)
  delete target.userMessageId; target.runId = runId; target.sqliteDelivery = createSQLiteReActBoundary(target)
  const accepted = await runtime.send(producer, { recipientParticipantId: admitted.target, message: 'Parent evidence for exact child', requestKey: 'to-child' })
  await run('Exact delegated input', target)
  expect(llm.stream).toHaveBeenCalledTimes(1)
  expect(vi.mocked(llm.stream).mock.calls[0][0][0].content).toBe('Exact delegated input')
  expect((await runtime.sqliteDeliveryReceipt(admitted.producer, accepted.messageId))?.invocationRunId).toBe(runId)
  expect(Number((await observer.execute({ sql: "SELECT count(*) AS n FROM conversations WHERE tenant_id=? AND session_id=? AND message_id LIKE 'peer:%'", args: [scope.tenantId, scope.sessionId] })).rows[0].n)).toBe(0)
  expect(() => runtime.send({ ...admitted.producer } as CollaborationProducer, { recipientParticipantId: admitted.target, message: 'Forged', requestKey: 'copied' })).toThrow('live server producer')
  owners.completeChild(ticket, { runId, terminalSeq: 1, projection: 'appended' })
  expect(() => owners.producerForExecution(childOwner)).toThrow('active admitted producer')
})
it('reconciles lost delivery commit ACK without treating it as a provider dispatch or duplicating mail on retry', async () => {
  const accepted = await mail(), original = db.transaction.bind(db)
  let faults = 0
  const fault = vi.spyOn(db, 'transaction').mockImplementation(async mode => {
    const tx = await original(mode); let deliveryInserted = false
    return new Proxy(tx, { get(target, property) {
      if (property === 'execute') return async (...args: Parameters<Transaction['execute']>) => {
        const statement = args[0], sql = typeof statement === 'string' ? statement : statement.sql
        deliveryInserted ||= sql.includes('INSERT INTO collaboration_deliveries')
        return target.execute(...args)
      }
      if (property === 'commit') return async () => {
        await target.commit()
        if (deliveryInserted) { faults++; throw new Error('owned lost delivery ACK') }
      }
      const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value
    } })
  })
  await run(task); fault.mockRestore()
  expect(faults).toBe(1); expect(llm.stream).not.toHaveBeenCalled()
  expect((await runtime.sqliteDeliveryReceipt(producer, accepted.messageId))?.state).toBe('integrated')
  await run(); expect(llm.stream).toHaveBeenCalledTimes(1); expect(await count('collaboration_deliveries')).toBe(1)
})
it('the actual child runner retains the canonical producer across a lost admission ACK and starts the child exactly once', async () => {
  await seed()
  const input = { tenantId: scope.tenantId, rootSessionId: scope.sessionId, parentSessionId: scope.sessionId,
    parentConversationId: turnId, parentMessageId: 'runner-dispatch', parentToolCallId: 'runner-call',
    task: 'Runner delegated task', description: 'Runner child', modelId: 'scripted-only',
    continuation: { readOnly: true, systemPrompt: '', toolNames: [], workspacePaths: [] } }
  await raw.append({ id: input.parentMessageId, role: 'assistant', content: '', toolCall: { id: input.parentToolCallId, name: 'subagent', args: {} }, conversationId: turnId }, scope)
  const original = runtime.admitChild.bind(runtime); let admittedProducer: CollaborationProducer | undefined, faults = 0, executions = 0
  const fault = vi.spyOn(runtime, 'admitChild').mockImplementation(async (...args) => {
    const admitted = await original(...args); admittedProducer = admitted.producer
    faults++; throw new Error('owned lost child admission ACK')
  })
  const result = await new SubagentRunner(agents).run(input, ctx, async execution => {
    executions++
    expect(owners.producerForExecution(execution.executionOwner!)).toBe(admittedProducer)
    const target = context(createConversationHistory(), execution.executionOwner!, execution.snapshot.childSessionId)
    delete target.userMessageId; target.runId = execution.snapshot.runId; target.runObserver = execution.observer
    target.signal = execution.signal; target.sqliteDelivery = createSQLiteReActBoundary(target)
    await run(input.task, target)
  })
  fault.mockRestore()
  expect(result.status).toBe('succeeded'); expect(executions).toBe(1); expect(faults).toBe(1)
  expect(await count('subagent_runs')).toBe(1); expect(llm.stream).toHaveBeenCalledTimes(1)
  await expect(runtime.recoverChildProducer(producer, input)).rejects.toMatchObject({ code: 'closed' })
})
it('keeps default JSONL free of SQLite consumers and refuses copied private boundary objects', async () => {
  await seed(); const copied = { ...ctx.sqliteDelivery } as NonNullable<AgentContext['sqliteDelivery']>
  await expect(bindSQLiteReActBoundary(copied, ctx, userId)).rejects.toMatchObject({ code: 'forbidden' })
  vi.stubEnv('HISTORY_BACKEND', 'jsonl')
  const target = context(createConversationHistory()); delete target.sqliteDelivery
  expect(() => createSQLiteReActBoundary(target)).toThrow('actual SQLite history Client')
  await run(task, target); expect(llm.stream).toHaveBeenCalledTimes(1); expect(await count('collaboration_deliveries')).toBe(0)
})
