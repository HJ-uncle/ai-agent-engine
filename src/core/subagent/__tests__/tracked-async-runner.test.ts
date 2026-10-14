/** Actual durable admission/executor/ticket/projection joins over both history backends; no model or listener. */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext } from '../../agent-context/types.js'
import * as database from '../../../storage/sqlite/db.js'
import { LocalSqliteProcessClient } from '../../../storage/sqlite/local-process-client.js'
import { RootRunStore, type RootRun } from '../../../storage/root-runs/index.js'
import { createConversationHistory } from '../../../storage/conversation/factory.js'
import { SubagentRunner, type SubagentExecution, type SubagentStart } from '../runner.js'
import { SubagentStore } from '../store.js'
import type { CreateSubagentRun } from '../types.js'
import { CollaborationRuntime } from '../../collaboration/runtime.js'
import { CollaborationStore } from '../../collaboration/store.js'
import { ExecutionOwners, initializeOwnedExecutionStartup, type ExecutionOwner } from '../../collaboration/execution-owner.js'
import { projectOwnedSubagent } from '../projection.js'
import { createToolRegistry } from '../../../tools/registry-factory.js'
import { createSubagentToolRegistry } from '../../../tools/subagent/subagent-tool.js'
import { ToolRegistry } from '../../tool-registry/index.js'

const tenant = 'async-owned', barrier = () => { let release!: () => void; const promise = new Promise<void>(yes => { release = yes }); return { promise, release } }
let backend = 'jsonl', directory: string, db: LocalSqliteProcessClient, roots: RootRunStore, root: RootRun
let agents: SubagentStore, runner: SubagentRunner, runtime: CollaborationRuntime, owners: ExecutionOwners, owner: ExecutionOwner, parent: AgentContext
const releases: (() => void)[] = [], joins: Promise<unknown>[] = []
const gate = () => { const value = barrier(); releases.push(value.release); return value }
async function input(key: string): Promise<CreateSubagentRun> {
  const value = { tenantId: tenant, rootSessionId: root.sessionId, parentSessionId: root.sessionId, parentConversationId: root.turnId,
    parentMessageId: 'dispatch:' + key, parentToolCallId: key, task: 'Exact async child ' + key, description: key, modelId: 'scripted-only',
    continuation: { readOnly: true, systemPrompt: '', toolNames: [], workspacePaths: [directory] } }
  await parent.history.append({ id: value.parentMessageId, role: 'assistant', content: '',
    toolCall: { id: value.parentToolCallId, name: 'subagent_start', args: {} }, ...{ conversationId: root.turnId } }, parent)
  return value
}
async function held(key: string) {
  const entered = gate(), finish = gate(); let execution!: SubagentExecution
  const start = await runner.start(await input(key), parent, async current => { execution = current; entered.release(); await finish.promise; await current.observer.onOutcome({ status: 'succeeded', output: 'Exact result ' + key }) })
  joins.push(start.completion.catch(() => undefined)); await entered.promise
  return { start, finish, execution }
}
// The exact-before control exercises the existing synchronous API when the new
// API is absent, so its leading failure proves the blocked return behavior.
async function startCompat(value: CreateSubagentRun, execute: (execution: SubagentExecution) => Promise<void>): Promise<SubagentStart> {
  if (typeof runner.start === 'function') return runner.start(value, parent, execute)
  const result = await runner.run(value, parent, execute)
  return { runId: result.runId, childSessionId: result.childSessionId, admittedSeq: result.lastSeq, completion: Promise.resolve(result) }
}
beforeEach(async () => {
  await database.closeDb()
  fs.mkdirSync('.e2e-tmp', { recursive: true }); directory = fs.mkdtempSync(path.resolve('.e2e-tmp/tracked-async-'))
  vi.stubEnv('DATA_DIR', path.join(directory, 'fixture.db')); vi.stubEnv('HISTORY_BACKEND', backend)
  db = new LocalSqliteProcessClient({ url: 'file:' + path.join(directory, 'fixture.db').replaceAll('\\', '/') })
  vi.spyOn(database, 'getDb').mockImplementation(() => db)
  await database.initDb()
  roots = new RootRunStore(() => db); root = await roots.create(tenant, 'parent', 'scripted-only', [directory], {})
  agents = new SubagentStore(db); runtime = new CollaborationRuntime(new CollaborationStore(db), agents); owners = new ExecutionOwners(db, runtime)
  owner = await owners.admitRoot({ tenantId: tenant, rootRunId: root.runId, rootAttemptId: (await roots.get(tenant, root.runId))!.attemptId, controller: new AbortController() })
  parent = { tenantId: tenant, sessionId: root.sessionId, rootRunId: root.runId, turnId: root.turnId, conversationId: root.turnId,
    executionOwner: owner, history: createConversationHistory(), logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as unknown as AgentContext
  runner = new SubagentRunner(agents)
})
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  await Promise.allSettled(joins.splice(0)); await database.closeDb(); expect((await db.closeWithReceipt()).healthy).toBe(true)
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (path.dirname(directory) !== path.resolve('.e2e-tmp') || !path.basename(directory).startsWith('tracked-async-')) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 })
})

describe.each(['jsonl', 'sqlite'])('%s tracked async runner', selected => {
  beforeAll(() => { backend = selected })
  it('reopen startup marks admitted async work interrupted once, projects an independent notification, and never grants old join or sender authority', async () => {
    const value = { ...await input('restart'), parentToolName: 'subagent_start' as const }
    const producer = owners.producerForExecution(owner), admitted = await runtime.admitChild(producer, value)
    await agents.appendHeader(tenant, admitted.mutation.header.runId, 'started', { status: 'running', startedAt: Date.now() }, { allowedStatuses: ['queued'] })
    await parent.history.append({ id: 'restart-admission', role: 'tool', content: JSON.stringify({ state: 'admitted', runId: admitted.mutation.header.runId }), toolCallId: value.parentToolCallId, toolName: 'subagent_start', ...{ conversationId: root.turnId } }, parent)
    expect((await db.closeWithReceipt()).healthy).toBe(true)
    db = new LocalSqliteProcessClient({ url: 'file:' + path.join(directory, 'fixture.db').replaceAll('\\', '/') })
    await database.initDb(); await initializeOwnedExecutionStartup(); await initializeOwnedExecutionStartup()
    agents = new SubagentStore(db); runner = new SubagentRunner(agents)
    const interrupted = (await agents.getRunView(tenant, admitted.mutation.header.runId))!
    expect(interrupted).toMatchObject({ status: 'interrupted', stopReason: 'engine_restarted', error: { code: 'ENGINE_RESTARTED', retryable: false } })
    const rows = await createConversationHistory().getFullHistory(parent)
    expect(rows.filter(row => row.role === 'tool' && row.toolCallId === value.parentToolCallId)).toHaveLength(1)
    expect(rows.filter(row => row.id === 'subagent-result:' + interrupted.runId)).toHaveLength(1)
    expect(rows.find(row => row.id === 'subagent-result:' + interrupted.runId)).toMatchObject({ role: 'assistant', metadata: { subagentNotification: { runId: interrupted.runId } } })
    await expect(runtime.send(producer, { recipientParticipantId: 'root:' + root.runId, message: 'Stale sender', requestKey: 'stale' })).rejects.toThrow()
    roots = new RootRunStore(() => db); root = await roots.create(tenant, 'parent', 'scripted-only', [directory], {})
    runtime = new CollaborationRuntime(new CollaborationStore(db), agents); owners = new ExecutionOwners(db, runtime)
    owner = await owners.admitRoot({ tenantId: tenant, rootRunId: root.runId, rootAttemptId: (await roots.get(tenant, root.runId))!.attemptId, controller: new AbortController() })
    parent = { ...parent, executionOwner: owner, rootRunId: root.runId, turnId: root.turnId, conversationId: root.turnId, history: createConversationHistory() }
    await expect(runner.waitOwned(parent, interrupted.runId)).rejects.toThrow('JOIN_UNKNOWN')
    const execute = vi.fn(async () => undefined)
    await expect(runner.start(value, parent, execute)).rejects.toThrow()
    expect(execute).not.toHaveBeenCalled(); expect((await db.execute('SELECT count(*) AS n FROM subagent_runs')).rows[0].n).toBe(1)
  })
  it('async terminal notification survives lost history ACK without duplicate tool results and respects deletion of its original dispatch', async () => {
    const first = await held('notification-ack'), history = parent.history as AgentContext['history'] & Required<Pick<AgentContext['history'], 'appendIfActiveToolCallAnchor'>>
    await history.append({ id: 'actual-start-result', role: 'tool', toolCallId: 'notification-ack', toolName: 'subagent_start', content: 'Admission only', ...{ conversationId: root.turnId } }, parent)
    const append = history.appendIfActiveToolCallAnchor.bind(history); let faults = 0
    vi.spyOn(history, 'appendIfActiveToolCallAnchor').mockImplementation(async (...args) => { const result = await append(...args); if (!faults++) throw new Error('LOST_NOTIFICATION_HISTORY_ACK'); return result })
    first.finish.release(); await expect(first.start.completion).rejects.toThrow('LOST_NOTIFICATION_HISTORY_ACK')
    const result = (await agents.getRunView(tenant, first.start.runId))!
    expect(await projectOwnedSubagent(history, agents, tenant, result.runId, result.lastSeq)).toBe('duplicate')
    const rows = await history.getFullHistory(parent)
    expect(rows.filter(row => row.role === 'tool' && row.toolCallId === 'notification-ack')).toHaveLength(1)
    expect(rows.filter(row => row.id === 'subagent-result:' + result.runId)).toHaveLength(1)
    const second = await held('notification-deleted')
    await history.deleteMessage('dispatch:notification-deleted', tenant)
    second.finish.release(); const deleted = await second.start.completion
    expect(await agents.ownedParentProjection(tenant, deleted.runId, deleted.lastSeq)).toMatchObject({ acknowledged: true, disposition: 'suppressed' })
    expect((await history.getFullHistory(parent)).some(row => row.id === 'subagent-result:' + deleted.runId)).toBe(false)
  })
  it('registers each actual async tool independently and removes all recursive launch names from child snapshots', async () => {
    const names = ['subagent_start', 'subagent_send', 'subagent_wait', 'subagent_cancel', 'subagent_participants', 'subagent_inbox']
    for (const name of names) {
      const { registry } = await createToolRegistry({ toolProfile: 'code', allowedTools: [name], allowedMcpServers: [], allowedSkills: [], strictSkillBindings: true })
      expect(registry.list().map(tool => tool.name).sort()).toEqual([name, 'plan_update'].sort())
      expect(registry.executionMode(name, {})).toBe(['subagent_wait', 'subagent_participants', 'subagent_inbox'].includes(name) ? 'readonly' : 'serial')
    }
    const { registry } = await createToolRegistry({ toolProfile: 'code', allowedTools: ['subagent', ...names], allowedMcpServers: [], allowedSkills: [], strictSkillBindings: true })
    const aliases = new ToolRegistry()
    for (const name of ['subagent', 'subagent_start', 'spawn_agent', 'start_agent']) aliases.register({ name, description: '', parameters: {}, execute: vi.fn(async () => ({ success: true, output: 'UNEXPECTED' })) })
    for (const source of [registry, aliases]) for (const readOnly of [true, false]) {
      const child = createSubagentToolRegistry(source, readOnly)
      for (const name of ['subagent', 'subagent_start', 'spawn_agent', 'start_agent']) {
        expect(child.has(name)).toBe(false); expect((await child.execute(name, {}, parent)).success).toBe(false)
      }
    }
  })
  it('actual send tool derives root and child sender, reconciles exact lost ACK, and rejects impersonation or key conflicts', async () => {
    const child = await held('tool-sender'), { registry } = await createToolRegistry({ toolProfile: 'code', allowedTools: ['subagent_send'], allowedMcpServers: [] })
    const send = runtime.send.bind(runtime); let faults = 0
    vi.spyOn(runtime, 'send').mockImplementation(async (...args) => { const receipt = await send(...args); if (!faults++) throw new Error('LOST_SEND_ACK'); return receipt })
    const args = { recipientParticipantId: 'child:' + child.start.childSessionId, message: 'Exact root message', requestKey: 'same-key' }
    const first = await registry.execute('subagent_send', args, parent)
    expect(first.success).toBe(true); expect(JSON.parse(first.output)).toMatchObject({ senderParticipantId: 'root:' + root.runId, state: 'queued' })
    expect((await registry.execute('subagent_send', args, parent)).output).toBe(first.output)
    expect((await registry.execute('subagent_send', { ...args, message: 'Changed body' }, parent)).success).toBe(false)
    expect((await registry.execute('subagent_send', { ...args, senderParticipantId: 'root:forged' }, parent)).success).toBe(false)
    expect((await registry.execute('subagent_send', { ...args, recipientParticipantId: 'root:foreign', requestKey: 'foreign' }, parent)).success).toBe(false)
    const childContext = { ...parent, sessionId: child.start.childSessionId, rootSessionId: root.sessionId, runId: child.start.runId, executionOwner: child.execution.executionOwner }
    const reply = await registry.execute('subagent_send', { recipientParticipantId: 'root:' + root.runId, message: 'Exact child reply', requestKey: 'reply' }, childContext)
    expect(reply.success).toBe(true); expect(JSON.parse(reply.output)).toMatchObject({ senderParticipantId: 'child:' + child.start.childSessionId, senderInvocationRunId: child.start.runId })
    expect((await db.execute('SELECT count(*) AS n FROM collaboration_messages')).rows[0].n).toBe(2)
    child.finish.release(); await child.start.completion
  })
  it('actual bounded participants/inbox tools use canonical scope and own recipient without loading message bodies', async () => {
    const first = await held('pages-one'), { registry } = await createToolRegistry({ toolProfile: 'code', allowedTools: ['subagent_participants', 'subagent_inbox', 'subagent_send'], allowedMcpServers: [] })
    const participants = JSON.parse((await registry.execute('subagent_participants', { limit: 1 }, parent)).output)
    expect(participants.entries).toHaveLength(1); expect(participants.hasMore).toBe(true)
    const second = await held('pages-two')
    const rest = JSON.parse((await registry.execute('subagent_participants', { cursor: participants.nextCursor }, parent)).output)
    expect(rest.entries.map((entry: { invocationRunId: string }) => entry.invocationRunId)).toEqual([first.start.runId]); expect(rest.revision).toBe(participants.revision)
    for (const key of ['inbox-one', 'inbox-two']) expect((await registry.execute('subagent_send', { recipientParticipantId: 'root:' + root.runId, message: 'Secret body ' + key, requestKey: key }, parent)).success).toBe(true)
    const inbox = JSON.parse((await registry.execute('subagent_inbox', { limit: 1 }, parent)).output)
    expect(inbox.entries).toHaveLength(1); expect(inbox.hasMore).toBe(true); expect(JSON.stringify(inbox)).not.toContain('Secret body')
    const childContext = { ...parent, sessionId: first.start.childSessionId, rootSessionId: root.sessionId, runId: first.start.runId, executionOwner: first.execution.executionOwner }
    expect((await registry.execute('subagent_inbox', { cursor: inbox.nextCursor }, childContext)).success).toBe(false)
    expect((await registry.execute('subagent_inbox', { participantId: 'root:' + root.runId }, childContext)).success).toBe(false)
    for (const limit of [0, 65, 1.5]) expect((await registry.execute('subagent_participants', { limit }, parent)).success).toBe(false)
    expect((await registry.execute('subagent_participants', {}, { ...parent, executionOwner: undefined })).success).toBe(false)
    first.finish.release(); second.finish.release(); await Promise.all([first.start.completion, second.start.completion])
  })
  it('returns exact durable admission while a real child is held, and root finish waits for its executor and projection', async () => {
    const value = await input('nonblocking'), entered = gate(), finish = gate()
    const pending = startCompat(value, async execution => { entered.release(); await finish.promise; await execution.observer.onOutcome({ status: 'succeeded', output: 'Exact nonblocking result' }) })
    let timer: ReturnType<typeof setTimeout> | undefined
    joins.push(pending.then(start => start.completion).catch(() => undefined))
    try {
      await entered.promise
      const admitted = await Promise.race([pending, new Promise<'blocked'>(resolve => { timer = setTimeout(() => resolve('blocked'), 250) })])
      expect(admitted).not.toBe('blocked'); if (admitted === 'blocked') return
      expect(Object.isFrozen(admitted)).toBe(true)
      expect((await agents.getRunHeader(tenant, admitted.runId))!.childSessionId).toBe(admitted.childSessionId)
      let settled = false
      const finishing = roots.finishOwned(owner, { status: 'succeeded' }).then(value => { settled = true; return value }); joins.push(finishing.catch(() => undefined))
      await expect.poll(async () => (await db.execute('SELECT phase FROM collaboration_roots')).rows[0].phase).toBe('draining')
      expect(settled).toBe(false); finish.release()
      const result = await admitted.completion
      expect(result.status).toBe('succeeded'); expect((await finishing).status).toBe('succeeded')
      const receipt = await agents.ownedParentProjection(tenant, result.runId, result.lastSeq)
      expect(receipt).toMatchObject({ acknowledged: true, disposition: 'appended' })
      expect((await parent.history.getFullHistory(parent)).find(message => message.id === 'subagent-result:' + result.runId)?.content).toContain('Exact nonblocking result')
    } finally { if (timer) clearTimeout(timer); finish.release() }
  })
  it('a terminal DB row remains pending until exact durable parent projection and canonical ticket settle', async () => {
    const history = parent.history as AgentContext['history'] & Required<Pick<AgentContext['history'], 'appendIfActiveToolCallAnchor'>>
    const entered = gate(), projection = gate(), append = history.appendIfActiveToolCallAnchor.bind(history)
    vi.spyOn(history, 'appendIfActiveToolCallAnchor').mockImplementation(async (...args) => { entered.release(); await projection.promise; return append(...args) })
    const start = await runner.start(await input('projection'), parent, async execution => { await execution.observer.onOutcome({ status: 'succeeded', output: 'Projection-gated result' }) }); joins.push(start.completion.catch(() => undefined))
    await entered.promise
    expect((await agents.getRunHeader(tenant, start.runId))!.status).toBe('succeeded')
    expect(await runner.waitOwned(parent, start.runId, { timeoutMs: 0 })).toEqual({ state: 'pending', runId: start.runId })
    let finished = false
    const finishing = roots.finishOwned(owner, { status: 'succeeded' }).then(value => { finished = true; return value }); joins.push(finishing.catch(() => undefined))
    await expect.poll(async () => (await db.execute('SELECT phase FROM collaboration_roots')).rows[0].phase).toBe('draining')
    expect(finished).toBe(false); projection.release(); await start.completion; expect((await finishing).status).toBe('succeeded')
  })
  it('timeout and one observer abort remove their listeners/timer without cancelling the child or another waiter', async () => {
    const child = await held('observer'), aborter = new AbortController(), add = vi.spyOn(aborter.signal, 'addEventListener'), remove = vi.spyOn(aborter.signal, 'removeEventListener')
    const timers = vi.spyOn(globalThis, 'setTimeout'), cleared = vi.spyOn(globalThis, 'clearTimeout')
    expect(await runner.waitOwned(parent, child.start.runId, { timeoutMs: 0 })).toEqual({ state: 'pending', runId: child.start.runId })
    const aborted = runner.waitOwned(parent, child.start.runId, { signal: aborter.signal, timeoutMs: 60_000 }); void aborted.catch(() => undefined)
    const other = runner.waitOwned(parent, child.start.runId, { timeoutMs: 30_000 }); joins.push(other.catch(() => undefined))
    await expect.poll(() => add.mock.calls.length).toBe(1)
    const timer = timers.mock.results[timers.mock.calls.findIndex(call => call[1] === 60_000)]?.value
    aborter.abort(new Error('Only this observer'))
    await expect(aborted).rejects.toThrow('Only this observer')
    expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0][1]); expect(cleared).toHaveBeenCalledWith(timer)
    expect(child.execution.signal.aborted).toBe(false)
    child.finish.release(); expect((await other).state).toBe('completed')
    expect((await new SubagentRunner(agents).waitOwned(parent, child.start.runId)).state).toBe('completed')
  })
  it('cancel ACK stays pending while the aborted real executor is held, then joins exact cancelled terminal projection', async () => {
    const child = await held('cancel')
    expect(await runner.cancelOwned(parent, child.start.runId, { timeoutMs: 0 })).toEqual({ state: 'pending', runId: child.start.runId })
    expect(child.execution.signal.aborted).toBe(true); expect((await agents.getRunHeader(tenant, child.start.runId))!.status).toBe('cancelling')
    expect((await runner.waitOwned(parent, child.start.runId, { timeoutMs: 0 })).state).toBe('pending')
    child.finish.release()
    const joined = await runner.cancelOwned(parent, child.start.runId)
    expect(joined.state).toBe('completed'); if (joined.state !== 'completed') return
    expect(joined.run.status).toBe('cancelled')
    expect(await agents.ownedParentProjection(tenant, joined.run.runId, joined.run.lastSeq)).toMatchObject({ acknowledged: true, disposition: 'appended' })
    expect((await roots.finishOwned(owner, { status: 'succeeded' })).status).toBe('succeeded')
  })
  it('cancels only the exact owned child and a pre-aborted caller cannot mutate its sibling', async () => {
    const first = await held('one'), second = await held('two'), aborter = new AbortController()
    aborter.abort(new Error('Caller already ended'))
    await expect(runner.cancelOwned(parent, second.start.runId, { signal: aborter.signal })).rejects.toThrow('Caller already ended')
    await new SubagentRunner(agents).cancelOwned(parent, first.start.runId, { timeoutMs: 0 })
    expect(first.execution.signal.aborted).toBe(true); expect(second.execution.signal.aborted).toBe(false)
    first.finish.release(); second.finish.release()
    expect((await first.start.completion).status).toBe('cancelled'); expect((await second.start.completion).status).toBe('succeeded')
  })
  it('reconciles lost admission ACK and a second runner joins the same actual executor exactly once', async () => {
    const admit = runtime.admitChild.bind(runtime); let faults = 0, calls = 0
    vi.spyOn(runtime, 'admitChild').mockImplementation(async (...args) => { const result = await admit(...args); if (!faults++) throw new Error('LOST_CHILD_ADMISSION_ACK'); return result })
    const value = await input('retry'), entered = gate(), finish = gate()
    const execute = async (execution: SubagentExecution) => { calls++; entered.release(); await finish.promise; await execution.observer.onOutcome({ status: 'succeeded', output: 'One exact retry result' }) }
    const first = await runner.start(value, parent, execute); joins.push(first.completion.catch(() => undefined)); await entered.promise
    const second = await new SubagentRunner(agents).start(value, parent, execute); joins.push(second.completion.catch(() => undefined))
    expect(first.runId).toBe(second.runId); expect(calls).toBe(1)
    expect((await db.execute('SELECT count(*) AS n FROM subagent_runs')).rows[0].n).toBe(1)
    finish.release(); const result = await first.completion; await second.completion
    expect((await parent.history.getFullHistory(parent)).filter(message => message.id === 'subagent-result:' + result.runId)).toHaveLength(1)
    expect((await roots.finishOwned(owner, { status: 'succeeded' })).status).toBe('succeeded')
  })
  it('rejects copied/foreign/child owners, changed contexts and readable unknown IDs before mutation', async () => {
    const child = await held('authority')
    await expect(runner.start(await input('ownerless'), { ...parent, executionOwner: undefined }, async () => undefined)).rejects.toThrow('CANONICAL_OWNER')
    await expect(runner.waitOwned({ ...parent, executionOwner: Object.freeze({}) as ExecutionOwner }, child.start.runId)).rejects.toThrow('Forged')
    await expect(runner.cancelOwned({ ...parent, tenantId: 'foreign' }, child.start.runId)).rejects.toThrow('AUTHORITY_MISMATCH')
    await expect(runner.waitOwned(parent, randomUUID())).rejects.toThrow('JOIN_UNKNOWN')
    const childContext = { ...parent, sessionId: child.start.childSessionId, executionOwner: child.execution.executionOwner }
    await expect(runner.cancelOwned(childContext, child.start.runId)).rejects.toThrow('AUTHORITY_MISMATCH')
    expect(child.execution.signal.aborted).toBe(false); expect((await agents.getRunHeader(tenant, child.start.runId))!.status).toBe('running')
    child.finish.release(); await child.start.completion
  })
  it('reports a detached projection failure to wait and root drain without an unhandled rejection', async () => {
    const failures: unknown[] = [], listener = (error: unknown) => failures.push(error); process.on('unhandledRejection', listener)
    try {
      const history = parent.history as AgentContext['history'] & Required<Pick<AgentContext['history'], 'appendIfActiveToolCallAnchor'>>
      vi.spyOn(history, 'appendIfActiveToolCallAnchor').mockRejectedValue(new Error('EXACT_PROJECTION_FAILED'))
      const start = await runner.start(await input('failure'), parent, async execution => { await execution.observer.onOutcome({ status: 'succeeded', output: 'Executor ended' }) })
      await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve))
      await expect(start.completion).rejects.toThrow('EXACT_PROJECTION_FAILED')
      await expect(runner.waitOwned(parent, start.runId)).rejects.toThrow('EXACT_PROJECTION_FAILED')
      await expect(roots.finishOwned(owner, { status: 'succeeded' })).rejects.toThrow('CHILD_CLEANUP_UNKNOWN')
      expect(failures).toEqual([])
    } finally { process.off('unhandledRejection', listener) }
  })
  it('rechecks the durable attempt after an awaited target read and refuses stale wait/cancel authority', async () => {
    const child = await held('replacement'), read = agents.getRunHeader.bind(agents), entered = gate(), release = gate(); let intercept = true
    vi.spyOn(agents, 'getRunHeader').mockImplementation(async (...args) => { const result = await read(...args); if (intercept && args[1] === child.start.runId) { intercept = false; entered.release(); await release.promise } return result })
    const waiting = runner.waitOwned(parent, child.start.runId); void waiting.catch(() => undefined)
    await entered.promise
    const stored = (await roots.get(tenant, root.runId))!
    await db.execute({ sql: 'UPDATE root_runs SET state=? WHERE run_id=?', args: [JSON.stringify({ ...stored, attemptId: randomUUID() }), root.runId] })
    release.release(); await expect(waiting).rejects.toThrow('stale or inactive')
    await expect(runner.cancelOwned(parent, child.start.runId)).rejects.toThrow('stale or inactive')
    expect(child.execution.signal.aborted).toBe(false); child.finish.release(); await child.start.completion
  })
  it('refuses a closed actual datasource and validates bounds before cancellation', async () => {
    const child = await held('bounds')
    for (const timeoutMs of [-1, 60_001, NaN, 0.5]) await expect(runner.cancelOwned(parent, child.start.runId, { timeoutMs })).rejects.toThrow('Invalid subagent wait timeout')
    expect(child.execution.signal.aborted).toBe(false); child.finish.release(); await child.start.completion
    expect((await db.closeWithReceipt()).healthy).toBe(true)
    await expect(runner.waitOwned(parent, child.start.runId)).rejects.toThrow('Datasource')
  })
})
