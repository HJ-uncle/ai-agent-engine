/** Real SQLite/JSONL contracts: admission, executor join, receipts and revoked attempts. No model calls. */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { pino } from 'pino'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TransactionMode } from '@libsql/client'
import * as database from '../../../storage/sqlite/db.js'
import { LocalSqliteProcessClient } from '../../../storage/sqlite/local-process-client.js'
import { RootRunStore, type RootRun } from '../../../storage/root-runs/index.js'
import { JSONLConversationHistory } from '../../../storage/conversation/jsonl-history.js'
import { createAgentContext } from '../../agent-context/factory.js'
import type { AgentContext } from '../../agent-context/types.js'
import { ToolRegistry } from '../../tool-registry/index.js'
import { SubagentStore } from '../../subagent/store.js'
import { SubagentRunner } from '../../subagent/runner.js'
import type { CreateSubagentRun } from '../../subagent/types.js'
import { CollaborationRuntime } from '../runtime.js'
import { CollaborationStore, admissionFingerprint } from '../store.js'
import { ExecutionOwners, assertOwnedDispatch, type ExecutionOwner } from '../execution-owner.js'

let dir: string, db: LocalSqliteProcessClient, agents: SubagentStore, runtime: CollaborationRuntime, service: ExecutionOwners
let roots: RootRunStore, root: RootRun, owner: ExecutionOwner, controller: AbortController, parent: AgentContext, runner: SubagentRunner
let history: JSONLConversationHistory
const tenant = 'owned-fixture'
const barrier = () => { let release!: () => void; const promise = new Promise<void>(yes => { release = yes }); return { promise, release } }
const input = (dispatch: string, overrides: Partial<CreateSubagentRun> = {}): CreateSubagentRun => ({ tenantId: tenant,
  rootSessionId: root.sessionId, parentSessionId: root.sessionId, parentConversationId: root.turnId,
  parentMessageId: 'dispatch:' + dispatch, parentToolCallId: dispatch, task: 'Synthetic owned work', description: dispatch,
  modelId: 'synthetic-no-model', continuation: { readOnly: true, systemPrompt: 'frozen', toolNames: [], workspacePaths: [dir] }, ...overrides })
async function seed(value: CreateSubagentRun) {
  await parent.history.append({ id: value.parentMessageId, role: 'assistant', content: '',
    toolCall: { id: value.parentToolCallId, name: 'subagent', args: {} }, ...{ conversationId: value.parentConversationId } }, parent)
}
beforeEach(async () => {
  dir = path.resolve('.e2e-tmp', 'g3b1-' + randomUUID()); fs.mkdirSync(dir, { recursive: true })
  vi.stubEnv('DATA_DIR', path.join(dir, 'agent.db')); vi.stubEnv('HISTORY_BACKEND', 'jsonl')
  db = new LocalSqliteProcessClient({ url: 'file:' + path.join(dir, 'agent.db').replaceAll('\\', '/') })
  vi.spyOn(database, 'getDb').mockImplementation(() => db)
  roots = new RootRunStore(); await roots.initialize()
  root = await roots.create(tenant, 'parent', 'synthetic-no-model', [dir], { memoryScope: 'off' })
  agents = new SubagentStore(db); runtime = new CollaborationRuntime(new CollaborationStore(db), agents)
  service = new ExecutionOwners(db, runtime); controller = new AbortController()
  owner = await service.admitRoot({ tenantId: tenant, rootRunId: root.runId, rootAttemptId: (await roots.get(tenant, root.runId))!.attemptId, controller })
  history = new JSONLConversationHistory()
  parent = createAgentContext({ tenantId: tenant, sessionId: root.sessionId, scratchDir: path.join(dir, 'scratch'), projectRoot: dir,
    tools: new ToolRegistry(), history, logger: pino({ level: 'silent' }), executionOwner: owner,
    signal: controller.signal, rootRunId: root.runId, turnId: root.turnId, conversationId: root.turnId })
  runner = new SubagentRunner(agents)
})
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  const receipt = await db.closeWithReceipt(); expect(receipt.healthy, JSON.stringify(receipt)).toBe(true)
  if (!dir.startsWith(path.resolve('.e2e-tmp') + path.sep)) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 })
})

describe('owned execution lifecycle', () => {
  it('reconciles a lost root terminal commit ACK without rewriting its outcome or reopening dispatch', async () => {
    const native = db.transaction.bind(db); let lost = false, terminalWrites = 0
    vi.spyOn(db, 'transaction').mockImplementation(async mode => {
      const tx = await native(mode); let terminal = false
      return new Proxy(tx, { get(target, property) {
        if (property === 'execute') return async (statement: Parameters<typeof tx.execute>[0]) => {
          if (typeof statement !== 'string' && statement.sql.startsWith('UPDATE root_runs SET state=') && Array.isArray(statement.args)
            && String(statement.args[0]).includes('"status":"succeeded"')) { terminal = true; terminalWrites++ }
          return target.execute(statement)
        }
        if (property === 'commit') return async () => {
          await target.commit()
          if (terminal && !lost) { lost = true; throw new Error('Synthetic root terminal ACK lost') }
        }
        const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value
      } })
    })
    const result = await roots.finishOwned(owner, { status: 'succeeded', stopReason: 'completed' })
    expect(result.status).toBe('succeeded'); expect(terminalWrites).toBe(1)
    expect((await roots.get(tenant, root.runId))?.version).toBe(result.version)
    expect(() => service.reserveChild(owner)).toThrow('revoked')
    expect((await db.execute('SELECT phase FROM collaboration_roots')).rows[0].phase).toBe('closed')
  })
  it('a second physical SQLite client cannot admit a child through the root terminal transaction', async () => {
    const other = new LocalSqliteProcessClient({ url: 'file:' + path.join(dir, 'agent.db').replaceAll('\\', '/') })
    try {
      const otherStore = new CollaborationStore(other), otherAgents = new SubagentStore(other)
      await otherAgents.initialize(); await otherStore.prepare()
      const binding = service.record(owner).binding
      const entered = barrier(), close = barrier(), original = runtime.store.closeSettledRoot.bind(runtime.store)
      vi.spyOn(runtime.store, 'closeSettledRoot').mockImplementationOnce(async (tx, scope) => {
        await original(tx, scope); entered.release(); await close.promise
      })
      const finishing = roots.finishOwned(owner, { status: 'succeeded' }); await entered.promise
      // Exercise the trusted in-transaction writer through a genuinely second
      // connection; copying a runtime cap would be rejected before SQLite.
      const value = input('cross-client-race')
      const admission = otherAgents.createRunDelta(value, (tx, header, receipt) => otherStore.admitChild(tx, binding, header, receipt, admissionFingerprint(value)).then(() => undefined))
      void admission.catch(() => undefined)
      close.release(); expect((await finishing).status).toBe('succeeded')
      await expect(admission).rejects.toMatchObject({ code: 'closed' })
      expect(Number((await db.execute('SELECT count(*) AS n FROM subagent_runs')).rows[0].n)).toBe(0)
      expect((await roots.get(tenant, root.runId))?.status).toBe('succeeded')
      expect((await db.execute('SELECT phase FROM collaboration_roots')).rows[0].phase).toBe('closed')
    } finally { expect((await other.closeWithReceipt()).healthy).toBe(true) }
  })
  it('closes a committed waiting attempt when cancellation wins before the park ACK returns', async () => {
    const entered = barrier(), ack = barrier(), native = db.transaction.bind(db)
    vi.spyOn(db, 'transaction').mockImplementation(async mode => {
      const tx = await native(mode); let parked = false
      return new Proxy(tx, { get(target, property) {
        if (property === 'execute') return async (statement: Parameters<typeof tx.execute>[0]) => {
          if (typeof statement !== 'string' && statement.sql.startsWith('UPDATE root_runs SET state=') && Array.isArray(statement.args) && String(statement.args[0]).includes('"status":"waiting"')) parked = true
          return target.execute(statement)
        }
        if (property === 'commit') return async () => {
          await target.commit()
          if (parked) { entered.release(); await ack.promise }
        }
        const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value
      } })
    })
    const pending = { kind: 'ask' as const, requestId: 'held-park', toolCallId: 'held-park', toolName: 'ask_user', args: {} }
    const parking = roots.finishOwned(owner, { status: 'waiting' }, pending)
    await entered.promise
    expect((await roots.get(tenant, root.runId))?.status).toBe('waiting')
    service.fence(owner, 'cancel', 'User cancelled while park ACK was held')
    let stopped = false
    const stopping = roots.finishOwned(owner, { status: 'cancelled' }).then(result => { stopped = true; return result })
    expect(stopped).toBe(false)
    ack.release()
    expect((await parking).status).toBe('cancelled')
    expect((await stopping).status).toBe('cancelled')
    expect((await roots.get(tenant, root.runId))?.status).toBe('cancelled')
    await expect(roots.answer(tenant, root.sessionId, root.runId, pending.requestId, pending.toolCallId, pending.toolName, 'A')).rejects.toThrow('no longer waiting')
    expect(service.record(owner).phase).toBe('closed')
  })
  it('joins a held root admission/open ACK during shutdown and never issues a dispatchable late owner', async () => {
    const second = await roots.create(tenant, 'late-root', 'synthetic-no-model', [], {})
    const entered = barrier(), commit = barrier(), lateController = new AbortController()
    const open = runtime.store.openRoot.bind(runtime.store)
    vi.spyOn(runtime.store, 'openRoot').mockImplementationOnce(async binding => {
      entered.release(); await commit.promise; await open(binding); throw new Error('Synthetic root open ACK lost')
    })
    const admission = service.admitRoot({ tenantId: tenant, rootRunId: second.runId, rootAttemptId: (await roots.get(tenant, second.runId))!.attemptId, controller: lateController })
    await entered.promise; service.stopAdmission()
    expect(lateController.signal.aborted).toBe(true)
    expect(() => service.reservePreparation(new AbortController())).toThrow('not accepting')
    let joined = false
    const preparationJoin = service.joinPreparations().then(() => { joined = true })
    expect(joined).toBe(false); commit.release()
    const lateOwner = await admission; await preparationJoin
    expect(() => assertOwnedDispatch(lateOwner)).toThrow('revoked')
    service.registerCompletion(lateOwner, Promise.resolve())
    expect((await roots.finishOwned(lateOwner, { status: 'cancelled' })).status).toBe('cancelled')
    expect((await roots.finishOwned(owner, { status: 'cancelled' })).status).toBe('cancelled')
    expect(Number((await db.execute('SELECT count(*) AS n FROM collaboration_roots')).rows[0].n)).toBe(2)
  })
  it('holds root preparation through a lost creation ACK and cancels the exact unstarted root before release', async () => {
    const prepareController = new AbortController(), preparation = service.reservePreparation(prepareController)
    const entered = barrier(), commit = barrier(); let preparedId = ''
    const native = db.transaction.bind(db); let dropped = false
    vi.spyOn(db, 'transaction').mockImplementation(async mode => {
      const tx = await native(mode)
      return new Proxy(tx, { get(target, property) {
        if (property === 'commit') return async () => {
          await target.commit()
          if (mode === 'write' && !dropped) { dropped = true; entered.release(); await commit.promise; throw new Error('Synthetic create ACK lost') }
        }
        const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value
      } })
    })
    const creation = roots.create(tenant, 'held-create', 'synthetic-no-model', [], {}, undefined, prepareController.signal, id => { preparedId = id })
    await entered.promise; expect(preparedId).not.toBe(''); service.stopAdmission()
    expect(prepareController.signal.aborted).toBe(true)
    let joined = false; const closing = service.joinPreparations().then(() => { joined = true })
    expect(joined).toBe(false); commit.release()
    const admitted = await creation; expect(admitted.runId).toBe(preparedId)
    await expect(service.admitRoot({ tenantId: tenant, rootRunId: admitted.runId, rootAttemptId: (await roots.get(tenant, admitted.runId))!.attemptId, controller: prepareController })).rejects.toThrow('stopping')
    expect((await roots.update(tenant, admitted.runId, { status: 'cancelled' }))?.status).toBe('cancelled')
    service.finishPreparation(preparation); await closing
    expect(Number((await db.execute("SELECT count(*) AS n FROM root_runs WHERE session_id='held-create'")).rows[0].n)).toBe(1)
  })
  it('holds root success until the real child executor and exact JSONL result receipt settle', async () => {
    const value = input('slow'); await seed(value)
    const entered = barrier(), finish = barrier()
    const child = runner.run(value, parent, async ({ observer, executionOwner }) => {
      assertOwnedDispatch(executionOwner); entered.release(); await finish.promise
      await observer.onOutcome({ status: 'succeeded', output: 'Synthetic result' })
    })
    await entered.promise
    let settled = false
    const closing = roots.finishOwned(owner, { status: 'succeeded' }).then(result => { settled = true; return result })
    expect(() => service.reserveChild(owner)).toThrow('revoked')
    expect((await roots.get(tenant, root.runId))?.status).toBe('running'); expect(settled).toBe(false)
    finish.release(); const result = await child; expect((await closing).status).toBe('succeeded')
    const receipt = await agents.ownedParentProjection(tenant, result.runId, result.lastSeq)
    expect(receipt).toMatchObject({ acknowledged: true, disposition: 'appended' })
    expect((await parent.history.getFullHistory(parent)).filter(message => message.id === 'subagent-result:' + result.runId)).toHaveLength(1)
    expect((await db.execute('SELECT phase FROM collaboration_roots')).rows[0].phase).toBe('closed')
  })
  it('includes a held admission commit and recovers lost ACK after drain without redispatch', async () => {
    const value = input('lost-admission'); await seed(value)
    const entered = barrier(), commit = barrier(); let executes = 0
    const original = agents.createRunDelta.bind(agents)
    vi.spyOn(agents, 'createRunDelta').mockImplementationOnce(async (...args) => {
      entered.release(); await commit.promise; await original(...args); throw new Error('Synthetic admission ACK lost')
    })
    const child = runner.run(value, parent, async ({ observer }) => { executes++; await observer.onOutcome({ status: 'succeeded', output: 'once' }) })
    await entered.promise
    const closing = roots.finishOwned(owner, { status: 'succeeded' })
    expect((await roots.get(tenant, root.runId))?.status).toBe('running')
    commit.release(); await child; expect((await closing).status).toBe('succeeded')
    expect(executes).toBe(1)
    expect(Number((await db.execute('SELECT count(*) AS n FROM subagent_runs')).rows[0].n)).toBe(1)
  })
  it('rejects changed task and frozen profile under the same dispatch key', async () => {
    const value = input('immutable'); const producer = service.producer(owner)
    await runtime.admitChild(producer, value)
    await expect(runtime.admitChild(producer, { ...value, task: 'different' })).rejects.toMatchObject({ code: 'conflict' })
    await expect(runtime.lookupChildAdmissionReceipt(producer, { ...value, continuation: { ...value.continuation!, readOnly: false } })).rejects.toMatchObject({ code: 'conflict' })
    await runtime.beginDrain(producer)
    expect(await runtime.lookupChildAdmissionReceipt(producer, value)).not.toBeNull()
    expect(Number((await db.execute('SELECT count(*) AS n FROM subagent_runs')).rows[0].n)).toBe(1)
  })
  it('cancellation aborts before persistence and joins a provider that reports late success', async () => {
    const value = input('cancel-late'); await seed(value)
    const entered = barrier(), finish = barrier(); let signal: AbortSignal | undefined
    const child = runner.run(value, parent, async execution => {
      signal = execution.signal; entered.release(); await finish.promise
      await execution.observer.onUsage({ invocationId: 'late-usage', promptTokens: 3, completionTokens: 2 })
      await execution.observer.onOutcome({ status: 'succeeded', output: 'late success' })
    })
    await entered.promise
    service.fence(owner, 'cancel', 'Synthetic user stop')
    expect(signal?.aborted).toBe(true)
    const closing = roots.finishOwned(owner, { status: 'succeeded' })
    expect((await roots.get(tenant, root.runId))?.status).toBe('running')
    finish.release(); expect((await child).status).toBe('cancelled'); expect((await closing).status).toBe('cancelled')
    expect((await agents.listRunViewsForParent(tenant, root.sessionId))[0].usage.totalTokens).toBe(5)
  })
  it('does not translate cleanup abort for a failed root into user cancellation', async () => {
    expect((await roots.finishOwned(owner, { status: 'failed', error: { code: 'SYNTHETIC_FAILURE', message: 'fixture', retryable: false } })).status).toBe('failed')
  })
  it('park revokes real dispatch, closes children, and a resumed attempt gets distinct authority', async () => {
    const value = input('parked-child'); await seed(value)
    const entered = barrier(), finish = barrier(); let childOwner: ExecutionOwner | undefined
    const child = runner.run(value, parent, async execution => { childOwner = execution.executionOwner; entered.release(); await finish.promise; await execution.observer.onOutcome({ status: 'succeeded' }) })
    await entered.promise
    const pending = { kind: 'ask' as const, requestId: 'answer', toolCallId: 'answer', toolName: 'ask_user', args: {}, question: 'Synthetic question' }
    const parking = roots.finishOwned(owner, { status: 'waiting' }, pending)
    expect(controller.signal.aborted).toBe(true)
    expect(() => assertOwnedDispatch(childOwner)).toThrow('revoked')
    await expect(roots.answer(tenant, root.sessionId, root.runId, pending.requestId, pending.toolCallId, pending.toolName, 'yes')).rejects.toThrow('not found')
    finish.release(); expect((await child).status).toBe('cancelled'); expect((await parking).status).toBe('waiting')
    const accepted = await roots.answer(tenant, root.sessionId, root.runId, pending.requestId, pending.toolCallId, pending.toolName, 'yes')
    const second = await service.admitRoot({ tenantId: tenant, rootRunId: accepted.run.runId, rootAttemptId: (await roots.get(tenant, root.runId))!.attemptId, controller: new AbortController() })
    expect(second).not.toBe(owner); expect(() => service.reserveChild(owner)).toThrow('revoked'); assertOwnedDispatch(second)
    expect((await roots.finishOwned(second, { status: 'succeeded' })).status).toBe('succeeded')
  })
  it('cannot bypass owner drain via the old root update or pending methods', async () => {
    await expect(roots.update(tenant, root.runId, { status: 'succeeded' })).rejects.toThrow('REQUIRES_OWNED_DRAIN')
    await expect(roots.pending(tenant, root.runId, { kind: 'ask', requestId: 'x', toolCallId: 'x', toolName: 'ask_user', args: {} })).rejects.toThrow('REQUIRES_OWNED_DRAIN')
    expect((await roots.get(tenant, root.runId))?.status).toBe('running')
  })
  it('requires actual same Client and opaque evidence; copied caps do not dispatch', async () => {
    expect(() => assertOwnedDispatch({ ...owner } as ExecutionOwner)).toThrow('Forged')
    const proof = await service.drain(owner, 'finish')
    const other = new LocalSqliteProcessClient({ url: 'file:' + path.join(dir, 'other.db').replaceAll('\\', '/') })
    try { expect(() => service.assertSettlement(owner, proof, other)).toThrow('physical transaction') }
    finally { expect((await other.closeWithReceipt()).healthy).toBe(true) }
  })
  it('invalidates old owner and drain evidence on a same-object datasource reconnect', async () => {
    const proof = await service.drain(owner, 'finish')
    await db.reconnect()
    await db.execute('SELECT 1')
    expect(() => service.assertSettlement(owner, proof, db)).toThrow('Datasource')
  })
  it('retains unknown projection failures and never marks the root successful', async () => {
    const value = input('projection-fault'); await seed(value)
    vi.spyOn(history, 'appendIfActiveToolCallAnchor').mockRejectedValueOnce(new Error('Synthetic projection storage fault'))
    await expect(runner.run(value, parent, async ({ observer }) => { await observer.onOutcome({ status: 'succeeded' }) })).rejects.toThrow('projection storage fault')
    await expect(roots.finishOwned(owner, { status: 'succeeded' })).rejects.toThrow('CHILD_CLEANUP_UNKNOWN')
    expect((await roots.get(tenant, root.runId))?.status).toBe('running')
    expect((await db.execute('SELECT acknowledged FROM subagent_outbox')).rows[0].acknowledged).toBe(0)
  })
  it('waits for every sibling even when another ticket fails, while another root remains usable', async () => {
    const a = input('failure'), b = input('held'); await seed(a); await seed(b)
    const entered = barrier(), finish = barrier()
    const held = runner.run(b, parent, async ({ observer }) => { entered.release(); await finish.promise; await observer.onOutcome({ status: 'succeeded' }) })
    await entered.promise
    const failed = runner.run(a, parent, async ({ observer }) => { await observer.onOutcome({ status: 'succeeded' }) })
    const append = history.appendIfActiveToolCallAnchor.bind(history)
    vi.spyOn(history, 'appendIfActiveToolCallAnchor').mockImplementation((message, ctx, anchor) => message.toolCallId === a.parentToolCallId ? Promise.reject(new Error('one sibling projection unknown')) : append(message, ctx, anchor))
    await expect(failed).rejects.toThrow('projection unknown')
    const other = await roots.create(tenant, 'independent', 'synthetic-no-model', [], {})
    const otherOwner = await service.admitRoot({ tenantId: tenant, rootRunId: other.runId, rootAttemptId: (await roots.get(tenant, other.runId))!.attemptId, controller: new AbortController() })
    let settled = false
    const closing = roots.finishOwned(owner, { status: 'failed' }).finally(() => { settled = true })
    void closing.catch(() => undefined)
    expect(settled).toBe(false); assertOwnedDispatch(otherOwner)
    expect((await roots.finishOwned(otherOwner, { status: 'succeeded' })).status).toBe('succeeded')
    expect(settled).toBe(false); finish.release(); await held
    await expect(closing).rejects.toThrow('CHILD_CLEANUP_UNKNOWN')
    expect((await roots.get(tenant, other.runId))?.status).toBe('succeeded')
  })
  it('recovers a terminal commit ACK through its stable finish receipt without another external call', async () => {
    const value = input('finish-ack'); await seed(value); let executes = 0
    const native = db.transaction.bind(db); let dropped = false
    vi.spyOn(db, 'transaction').mockImplementation(async (mode?: TransactionMode) => {
      const tx = await native(mode)
      return new Proxy(tx, { get(target, property) {
        if (property === 'commit') return async () => {
          const finish = mode === 'write' ? await target.execute('SELECT count(*) AS n FROM subagent_execution_receipts') : undefined
          await target.commit()
          if (!dropped && Number(finish?.rows[0]?.n) > 0) { dropped = true; throw new Error('Synthetic finished ACK lost') }
        }
        const v = Reflect.get(target, property); return typeof v === 'function' ? v.bind(target) : v
      } })
    })
    const result = await runner.run(value, parent, async ({ observer }) => { executes++; await observer.onOutcome({ status: 'succeeded', output: 'once' }) })
    expect(dropped).toBe(true); expect(executes).toBe(1); expect(result.status).toBe('succeeded')
    expect((await roots.finishOwned(owner, { status: 'succeeded' })).status).toBe('succeeded')
  })
})
