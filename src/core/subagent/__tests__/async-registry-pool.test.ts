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


import { getGlobalToolPool, setGlobalToolPoolLimit } from '../../utils/concurrency-pool.js'
import { trustBuiltinTool } from '../../../security/tool-policy.js'

describe.each(['jsonl', 'sqlite'])('%s actual async registry with one ordinary tool slot', selected => {
  beforeAll(() => { backend = selected })
  it('keeps readonly wait outside the pool needed by its own child', async () => {
    const pool = getGlobalToolPool(), original = pool.size, begin = gate(), entered = gate(), observing = gate()
    const realWait = SubagentRunner.prototype.waitOwned
    vi.spyOn(SubagentRunner.prototype, 'waitOwned').mockImplementation(function (this: SubagentRunner, ...args) { observing.release(); return realWait.apply(this, args) })
    let start: SubagentStart | undefined
    setGlobalToolPoolLimit(1)
    try {
      const { registry } = await createToolRegistry({ toolProfile: 'code', allowedTools: ['subagent_wait'], allowedMcpServers: [], allowedSkills: [], strictSkillBindings: true })
      const { registry: ordinary } = await createToolRegistry({ toolProfile: 'general', allowedTools: ['get_time'], allowedMcpServers: [], allowedSkills: [], strictSkillBindings: true })
      expect(ordinary.has('get_time')).toBe(true); expect(registry.executionMode('subagent_wait', {})).toBe('readonly')
      start = await runner.start(await input('pool-wait'), parent, async execution => {
        entered.release(); await begin.promise
        const result = await ordinary.execute('get_time', {}, { ...parent, sessionId: execution.snapshot.childSessionId,
          rootSessionId: root.sessionId, runId: execution.snapshot.runId, executionOwner: execution.executionOwner })
        expect(result.success).toBe(true)
        await execution.observer.onOutcome({ status: 'succeeded', output: 'Child ordinary tool completed' })
      })
      joins.push(start.completion.catch(() => undefined)); await entered.promise
      const waiting = registry.execute('subagent_wait', { runId: start.runId, timeoutMs: 1000 }, parent)
      await observing.promise; begin.release()
      const observed = await waiting
      expect(observed.success).toBe(true)
      expect(observed.metadata?.subagentObservation).toMatchObject({ state: 'completed', run: { status: 'succeeded' } })
    } finally { begin.release(); if (start) await start.completion; setGlobalToolPoolLimit(original) }
  })
  it('starts cancellation while the child operation occupies the only ordinary slot and joins actual abort cleanup', async () => {
    const pool = getGlobalToolPool(), original = pool.size, entered = gate(), finish = gate()
    let start: SubagentStart | undefined, cancelling: Promise<unknown> | undefined, deadline: ReturnType<typeof setTimeout> | undefined
    setGlobalToolPoolLimit(1)
    try {
      const { registry } = await createToolRegistry({ toolProfile: 'code', allowedTools: ['subagent_cancel'], allowedMcpServers: [], allowedSkills: [], strictSkillBindings: true })
      expect(registry.executionMode('subagent_cancel', {})).toBe('serial')
      const childTools = new ToolRegistry()
      childTools.register(trustBuiltinTool({ name: 'held_child_operation', description: 'Controlled ordinary operation', parameters: {},
        execute: async (_args, ctx) => {
          const onAbort = () => finish.release()
          ctx.signal?.addEventListener('abort', onAbort, { once: true }); if (ctx.signal?.aborted) onAbort()
          entered.release()
          try { await finish.promise; return { success: true, output: 'Ordinary operation cleanup finished' } }
          finally { ctx.signal?.removeEventListener('abort', onAbort) }
        } }))
      start = await runner.start(await input('pool-cancel'), parent, async execution => {
        const result = await childTools.execute('held_child_operation', {}, { ...parent, signal: execution.signal })
        expect(result.success).toBe(true)
        await execution.observer.onOutcome({ status: 'succeeded', output: 'Ordinary operation returned after cleanup' })
      })
      joins.push(start.completion.catch(() => undefined)); await entered.promise; expect(pool.active).toBe(1)
      cancelling = registry.execute('subagent_cancel', { runId: start.runId, timeoutMs: 1000 }, parent)
      const result = await Promise.race([cancelling, new Promise<'blocked-before-cancel-entry'>(resolve => { deadline = setTimeout(() => resolve('blocked-before-cancel-entry'), 1500) })])
      expect(result).not.toBe('blocked-before-cancel-entry')
      expect(result).toMatchObject({ success: true, metadata: { subagentObservation: { state: 'completed', run: { status: 'cancelled' } } } })
      expect((await start.completion).status).toBe('cancelled')
    } finally {
      if (deadline) clearTimeout(deadline); finish.release()
      if (start) await start.completion; if (cancelling) await cancelling
      setGlobalToolPoolLimit(original)
    }
  })
})
