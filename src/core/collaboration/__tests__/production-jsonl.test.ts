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
import { bindJSONLReActBoundary } from '../jsonl-react-boundary.js'
import { installProductionCollaborationBoundary } from '../production-boundary.js'
import { jsonlHistoryIdentity, readAuthenticatedJSONLHistory } from '../../../storage/conversation/jsonl-origin.js'
import { invalidateSQLiteDeliveryStatements, sqliteHistoryScope } from '../delivery-schema.js'
import type { CollaborationProducer } from '../types.js'

vi.mock('../../../storage/todo/index.js', () => ({ TodoStore: class { async list() { return [] } } }))
let directory: string, db: LocalSqliteProcessClient, observer: LocalSqliteProcessClient
let agents: SubagentStore, runtime: CollaborationRuntime, owners: ExecutionOwners, owner: ExecutionOwner, producer: CollaborationProducer
let raw: JSONLConversationHistory, ctx: AgentContext, llm: LLMAdapter, outcomes: RunOutcome[]
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
  await bindJSONLReActBoundary(ctx.jsonlDelivery!, ctx, userId)
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
  directory = path.resolve('.e2e-tmp', 'production-jsonl-' + randomUUID()); fs.mkdirSync(directory, { recursive: true })
  vi.stubEnv('DATA_DIR', path.join(directory, 'fixture.db')); vi.stubEnv('HISTORY_BACKEND', '')
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
  raw = new JSONLConversationHistory()
  const history = admissionProjectingHistory(bindHistoryGeneration(serializeConversationHistory(raw), scope.tenantId, scope.sessionId),
    { rootRunId, turnId, userMessageId: userId, assistantAnchorId: admitted.receipt.assistantMessageId })
  outcomes = []; ctx = context(history); installProductionCollaborationBoundary(ctx)
  llm = { model: 'scripted-only', provider: 'test', complete: vi.fn(), countTokens: () => 0,
    stream: vi.fn(async function* (): AsyncGenerator<LLMStreamChunk> { yield { done: true, content: 'Final scripted response.' } }) }
})
afterEach(async () => {
  vi.restoreAllMocks(); await closeDb(); observer.close()
  await Promise.all([db.whenClosed(), observer.whenClosed()]); vi.unstubAllEnvs()
  if (path.dirname(directory) !== path.resolve('.e2e-tmp') || !path.basename(directory).startsWith('production-jsonl-')) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

const archive = () => path.join(directory, 'sessions', scope.tenantId, scope.sessionId + '.jsonl')
const physicalRows = () => fs.readFileSync(archive(), 'utf8').trim().split('\n').map(line => JSON.parse(line) as { uuid: string; payload?: Message; type: string })
const bindConsumer = () => runtime.bindJSONLDelivery(producer, { origin: jsonlHistoryIdentity(ctx.history)!, ...scope, anchorId: userId, anchorContent: task })

it('the real production creator selects default JSONL through generation/admission wrappers and real ReAct receives peers plus complete current tools', async () => {
  expect(ctx.sqliteDelivery).toBeUndefined(); expect(ctx.jsonlDelivery).toBeDefined()
  expect(jsonlHistoryIdentity(createConversationHistory())).toBeDefined()
  await raw.append({ id: 'old-task', role: 'user', content: 'Old task', conversationId: 'old-turn' }, scope)
  await seed()
  const first = await mail('First peer')
  const consumer = await bindConsumer(); await runtime.consumeJSONLDelivery(consumer)
  await raw.append({ id: 'actual-assistant', role: 'assistant', content: 'Working', toolCall: { id: 'call-one', name: 'step', args: { exact: 1 } }, conversationId: turnId }, scope)
  await raw.append({ id: 'actual-tool', role: 'tool', content: 'Complete real tool evidence', toolCallId: 'call-one', toolName: 'step', conversationId: turnId }, scope)
  const second = await mail('Second peer'); await run()
  expect(llm.stream).toHaveBeenCalledTimes(1)
  const messages = vi.mocked(llm.stream).mock.calls[0][0]
  const one = await runtime.jsonlDeliveryReceipt(producer, first.messageId), two = await runtime.jsonlDeliveryReceipt(producer, second.messageId)
  expect(messages.map(message => message.id)).toEqual([userId, one!.historyMessageId, 'actual-assistant', 'actual-tool', two!.historyMessageId])
  expect(messages[2].toolCall).toEqual({ id: 'call-one', name: 'step', args: { exact: 1 } })
  expect(messages[3]).toMatchObject({ content: 'Complete real tool evidence', toolCallId: 'call-one', toolName: 'step' })
  expect(physicalRows().filter(row => row.uuid === one!.historyMessageId)).toHaveLength(1)
  expect(outcomes.at(-1)?.status).toBe('succeeded')
})

it('losing reservation commit ACK keeps a pending receipt without a peer row and retries exactly once', async () => {
  await seed(); const accepted = await mail(), consumer = await bindConsumer(), native = db.transaction.bind(db)
  let lost = false
  vi.spyOn(db, 'transaction').mockImplementation(async mode => {
    const tx = await native(mode); let reservation = false
    return new Proxy(tx, { get(target, property) {
      if (property === 'execute') return async (statement: Parameters<Transaction['execute']>[0]) => {
        if ((typeof statement === 'string' ? statement : statement.sql).includes('INSERT INTO collaboration_jsonl_deliveries')) reservation = true
        return target.execute(statement)
      }
      if (property === 'commit') return async () => { await target.commit(); if (reservation && !lost) { lost = true; throw new Error('lost reservation ACK') } }
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value
    } })
  })
  await expect(runtime.consumeJSONLDelivery(consumer)).rejects.toThrow('lost reservation ACK')
  expect(await count('collaboration_jsonl_deliveries')).toBe(1); expect(physicalRows().filter(row => row.type === 'user')).toHaveLength(1)
  expect((await readAuthenticatedJSONLHistory(ctx.history, scope))!.map(message => message.id)).toEqual([userId])
  expect((await runtime.consumeJSONLDelivery(consumer)).receipts).toHaveLength(1)
  const receipt = await runtime.jsonlDeliveryReceipt(producer, accepted.messageId)
  expect(receipt?.state).toBe('integrated'); expect(physicalRows().filter(row => row.uuid === receipt!.historyMessageId)).toHaveLength(1)
})

it('losing finalized commit ACK preserves one synced row and one integration receipt without replay', async () => {
  await seed(); const accepted = await mail(), consumer = await bindConsumer(), native = db.transaction.bind(db)
  let lost = false
  vi.spyOn(db, 'transaction').mockImplementation(async mode => {
    const tx = await native(mode); let finalization = false
    return new Proxy(tx, { get(target, property) {
      if (property === 'execute') return async (statement: Parameters<Transaction['execute']>[0]) => {
        if ((typeof statement === 'string' ? statement : statement.sql).includes("SET state='integrated'")) finalization = true
        return target.execute(statement)
      }
      if (property === 'commit') return async () => { await target.commit(); if (finalization && !lost) { lost = true; throw new Error('lost finalized ACK') } }
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value
    } })
  })
  await expect(runtime.consumeJSONLDelivery(consumer)).rejects.toThrow('lost finalized ACK')
  const receipt = await runtime.jsonlDeliveryReceipt(producer, accepted.messageId)
  expect(receipt?.state).toBe('integrated'); expect((await runtime.consumeJSONLDelivery(consumer)).receipts).toHaveLength(0)
  expect(await count('collaboration_jsonl_deliveries')).toBe(1); expect(physicalRows().filter(row => row.uuid === receipt!.historyMessageId)).toHaveLength(1)
})

it.each(['partial-write', 'sync-ACK'] as const)('reconciles %s failure using exact reserved file bytes and sync before integration', async kind => {
  await seed(); const accepted = await mail('完整 UTF-8 对等消息'), consumer = await bindConsumer(), open = fs.promises.open.bind(fs.promises)
  let lost = false
  vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args)
    if (args[1] !== 'r+' || String(args[0]) !== archive()) return handle
    return new Proxy(handle, { get(target, property) {
      if (property === 'write' && kind === 'partial-write') return async (buffer: Uint8Array, offset: number, length: number, position: number) => {
        if (!lost) { lost = true; await target.write(buffer, offset, Math.max(1, Math.floor(length / 3)), position); throw new Error('lost partial suffix') }
        return target.write(buffer, offset, length, position)
      }
      if (property === 'sync' && kind === 'sync-ACK') return async () => { await target.sync(); if (!lost) { lost = true; throw new Error('lost sync ACK') } }
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value
    } })
  })
  await expect(runtime.consumeJSONLDelivery(consumer)).rejects.toThrow(kind === 'partial-write' ? 'lost partial suffix' : 'lost sync ACK')
  expect((await observer.execute('SELECT state FROM collaboration_jsonl_deliveries')).rows[0].state).toBe('pending')
  expect((await readAuthenticatedJSONLHistory(ctx.history, scope))!.map(message => message.id)).toEqual([userId])
  expect((await runtime.consumeJSONLDelivery(consumer)).receipts).toHaveLength(1)
  const receipt = await runtime.jsonlDeliveryReceipt(producer, accepted.messageId)
  expect(physicalRows().filter(row => row.uuid === receipt!.historyMessageId)).toHaveLength(1)
})

it.each(['replace-file', 'edit-peer'] as const)('rejects external %s physical mutation before a provider attempt', async kind => {
  await seed(); await mail('Peer evidence'); await runtime.consumeJSONLDelivery(await bindConsumer())
  if (kind === 'replace-file') { const replacement = archive() + '.replacement'; fs.copyFileSync(archive(), replacement); fs.renameSync(replacement, archive()) }
  else fs.writeFileSync(archive(), fs.readFileSync(archive(), 'utf8').replace('Peer evidence', 'Peer evideNce'))
  await run(); expect(llm.stream).not.toHaveBeenCalled(); expect(outcomes.at(-1)?.status).toBe('failed')
})

it.each(['clear', 'edit', 'delete-anchor', 'truncate', 'delete-turn', 'micro-compact', 'compress'] as const)('durably invalidates %s and never promotes a suppressed peer ID to human', async kind => {
  await seed(); const accepted = await mail(), consumer = await bindConsumer(); await runtime.consumeJSONLDelivery(consumer)
  await raw.append({ id: 'large-tool', role: 'tool', content: 'Full tool evidence '.repeat(100), toolCallId: 'prior-call', conversationId: turnId }, scope)
  const before = await epoch()
  if (kind === 'clear') { await raw.clear(scope, { tombstone: false }); await raw.append({ id: userId, role: 'user', content: task, conversationId: turnId }, scope) }
  else if (kind === 'edit') await raw.updateMessageContent(userId, scope.tenantId, 'Edited current task', 5)
  else if (kind === 'delete-anchor') await raw.deleteMessage(userId, scope.tenantId)
  else if (kind === 'truncate') { const saved = await raw.getMessageById(userId, scope.tenantId); await raw.deleteMessagesAfterId(saved!.dbId, scope.sessionId, scope.tenantId) }
  else if (kind === 'delete-turn') await raw.deleteByConversationId(turnId, scope.tenantId)
  else if (kind === 'micro-compact') expect((await raw.microCompactToolResults(scope, { keepRecent: 0 })).cleared).toBe(1)
  else await raw.compress(scope, async () => 'Owned complete summary', 1)
  expect(await epoch()).toBeGreaterThan(before)
  expect(await runtime.jsonlDeliveryReceipt(producer, accepted.messageId)).toMatchObject({ state: 'suppressed', reason: 'history_changed' })
  await expect(runtime.consumeJSONLDelivery(consumer)).rejects.toMatchObject({ code: 'conflict' })
  await expect(bindJSONLReActBoundary(ctx.jsonlDelivery!, ctx, userId)).rejects.toMatchObject({ code: 'conflict' })
  const projection = await readAuthenticatedJSONLHistory(ctx.history, { ...scope, inheritContext: false })
  expect(projection!.some(message => String(message.content).startsWith('[对等 Agent 消息]'))).toBe(false)
  await run(); expect(llm.stream).not.toHaveBeenCalled()
})

it('integration remains distinct from final model budget refusal', async () => {
  ctx.tokenBudget = 100_000; ctx.modelCaps = { contextWindow: 1_000 }
  const accepted = await mail('Large evidence '.repeat(1_600))
  await run(task); expect(llm.stream).not.toHaveBeenCalled()
  expect(await runtime.jsonlDeliveryReceipt(producer, accepted.messageId)).toMatchObject({ state: 'integrated' })
  expect(outcomes.at(-1)?.status).toBe('failed')
})

it('whole row and byte budgets process a backlog without duplicate file rows', async () => {
  await seed(); await mail('One'); await mail('Two'); await mail('Three'); const consumer = await bindConsumer()
  const first = await runtime.consumeJSONLDelivery(consumer, { maxRows: 2, maxBytes: 4000 })
  expect(first.receipts).toHaveLength(2); expect(first.hasMore).toBe(true); expect(first.bytes).toBeLessThanOrEqual(4000)
  expect((await runtime.consumeJSONLDelivery(consumer, { maxRows: 2, maxBytes: 4000 })).receipts).toHaveLength(1)
  expect((await runtime.consumeJSONLDelivery(consumer)).receipts).toHaveLength(0)
  expect(physicalRows().filter(row => row.type === 'user')).toHaveLength(4); expect(await count('collaboration_jsonl_deliveries')).toBe(3)
})

it.each(['integrated', 'suppressed'] as const)('reclaims the real 1024-message backlog after JSONL %s without treating pending reservation as delivery', async terminal => {
  await seed()
  const sender = await child('backlog-child'), recipientParticipantId = 'root:' + rootRunId
  const send = (requestKey: string) => runtime.send(sender.producer, { recipientParticipantId, message: 'Owned backlog ' + requestKey, requestKey })
  for (let index = 0; index < 1024; index++) await send('backlog-' + index)
  await expect(send('still-full')).rejects.toMatchObject({ code: 'full' })
  const consumer = await bindConsumer(), open = fs.promises.open.bind(fs.promises)
  let failedSync = false
  const fault = vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args)
    if (args[1] !== 'r+' || String(args[0]) !== archive()) return handle
    return new Proxy(handle, { get(target, property) {
      if (property === 'sync') return async () => { await target.sync(); if (!failedSync) { failedSync = true; throw new Error('backlog pending sync ACK lost') } }
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value
    } })
  })
  await expect(runtime.consumeJSONLDelivery(consumer, { maxRows: 1 })).rejects.toThrow('backlog pending sync ACK lost')
  fault.mockRestore()
  expect((await observer.execute('SELECT state FROM collaboration_jsonl_deliveries')).rows).toMatchObject([{ state: 'pending' }])
  await expect(send('pending-still-full')).rejects.toMatchObject({ code: 'full' })
  let integrated = 0
  while (integrated < 1024) {
    const batch = await runtime.consumeJSONLDelivery(consumer, { maxRows: 32, maxBytes: 128 * 1024 })
    expect(batch.receipts.length).toBeGreaterThan(0)
    integrated += batch.receipts.length
  }
  expect(integrated).toBe(1024)
  expect(physicalRows().filter(row => row.type === 'user')).toHaveLength(1025)
  if (terminal === 'suppressed') await raw.clear(scope, { tombstone: false })
  const deliveryStates = await observer.execute('SELECT state, count(*) AS n FROM collaboration_jsonl_deliveries GROUP BY state')
  expect(deliveryStates.rows).toMatchObject([{ state: terminal, n: 1024 }])
  const accepted = await send('after-real-jsonl-' + terminal)
  expect(accepted).toMatchObject({ state: 'queued', requestKey: 'after-real-jsonl-' + terminal })
  expect(await count('collaboration_messages')).toBe(1025)
}, 120_000)
