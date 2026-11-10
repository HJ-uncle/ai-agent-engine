// Real canonical admission, runner, SQLite, transcript projection and ReAct.
// Only provider output is scripted; no production data, network model or app listener.
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext, Message } from '../../agent-context/types.js'
import type { LLMAdapter, LLMAdapterOptions, LLMStreamChunk } from '../../llm-adapter/types.js'
import { OpenAIAdapter } from '../../llm-adapter/openai.js'
import { AnthropicAdapter } from '../../llm-adapter/anthropic.js'
import { RetryingAdapter } from '../../llm-adapter/retry.js'
import * as modelResolver from '../../llm-adapter/resolve-model.js'
import { resolveCapabilities } from '../../model-capabilities/index.js'
import { ReActStrategy } from '../react.js'
import { ChildResultReview } from '../child-result-review.js'
import * as database from '../../../storage/sqlite/db.js'
import { LocalSqliteProcessClient } from '../../../storage/sqlite/local-process-client.js'
import { RootRunStore } from '../../../storage/root-runs/index.js'
import { createConversationHistory } from '../../../storage/conversation/factory.js'
import { admissionProjectingHistory, readAdmissionSeed } from '../../../storage/root-admission/projection.js'
import { ensureUserAdmissionSchema, prepareUserAdmission, readDatabaseNamespace, userAdmissionDigest } from '../../../storage/root-admission/index.js'
import { CollaborationRuntime } from '../../collaboration/runtime.js'
import { CollaborationStore } from '../../collaboration/store.js'
import { ExecutionOwners } from '../../collaboration/execution-owner.js'
import { installProductionCollaborationBoundary } from '../../collaboration/production-boundary.js'
import { bindJSONLReActBoundary } from '../../collaboration/jsonl-react-boundary.js'
import { bindSQLiteReActBoundary } from '../../collaboration/sqlite-react-boundary.js'
import { SubagentRunner, type SubagentExecution } from '../../subagent/runner.js'
import * as subagentRunners from '../../subagent/runner.js'
import { SubagentStore } from '../../subagent/store.js'
import { SubagentPool } from '../../subagent/pool.js'
import { projectOwnedSubagent } from '../../subagent/projection.js'
import { evaluateDependencyHooks, readHookSnapshot } from '../../subagent/dependency-hooks.js'
import { planTool } from '../../../tools/todo/todo-tool.js'
import { ToolRegistry } from '../../tool-registry/registry.js'
import { subagentStartTool } from '../../../tools/subagent/subagent-tool.js'
import { trustBuiltinTool } from '../../../security/tool-policy.js'
import { WorkspaceManager, workspaceManager } from '../../../workspace/index.js'

const scope = { tenantId: 'dependency-integration', sessionId: 'parent' }
const task = 'Integrate A from task 1, then B from tasks 2 and 3.'
const bodies = ['DEPENDENCY_RESULT_ONE_197', 'DEPENDENCY_RESULT_TWO_283', 'DEPENDENCY_RESULT_THREE_467']
let backend: 'jsonl' | 'sqlite' = 'jsonl', directory: string, db: LocalSqliteProcessClient
let ctx: AgentContext, runner: SubagentRunner, agents: SubagentStore, runtime: CollaborationRuntime, owners: ExecutionOwners
let controller: AbortController
const releases: Array<() => void> = [], joins: Promise<unknown>[] = []
function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  releases.push(release)
  return { promise, release }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
function claims(messages: Message[]): Array<{ id: string; revision: number; stepId: string; label: string; state: string; runIds: string[] }> {
  return messages.flatMap(message => {
    const value = message.metadata?.dependencyHooks
    return Array.isArray(value) ? value : value && typeof value === 'object' && 'claims' in value ? (value as { claims: any[] }).claims : []
  })
}
const labels = (messages: Message[]) => claims(messages).map(claim => claim.label).sort()
async function plan(steps: Array<{ step: string; ids: string[] }>) {
  const result = await planTool.execute({ plan: steps.map(step => ({ step: step.step, status: 'pending', wakeWhen: { allSucceeded: step.ids } })) }, ctx)
  expect(result.success, result.output).toBe(true)
}
async function held(index: number, status: 'succeeded' | 'failed' = 'succeeded') {
  const entered = gate(), finish = gate(); let execution!: SubagentExecution
  const body = bodies[index] ?? `DEPENDENCY_RESULT_EXTRA_${index}_1399`
  const key = `dispatch-${index}`
  await ctx.history.append({ id: key, role: 'assistant', content: '',
    toolCall: { id: key, name: 'subagent_start', args: {} }, ...{ conversationId: ctx.turnId } }, ctx)
  const start = await runner.start({ tenantId: scope.tenantId, rootSessionId: scope.sessionId, parentSessionId: scope.sessionId,
    parentConversationId: ctx.turnId!, parentMessageId: key, parentToolCallId: key, task: `Task ${index + 1}`,
    description: `Task ${index + 1}`, modelId: 'scripted-only',
    continuation: { readOnly: true, systemPrompt: '', toolNames: [], workspacePaths: [directory] },
  }, ctx, async current => {
    execution = current; entered.release(); await finish.promise
    await current.observer.onOutcome(status === 'succeeded' ? { status, output: body, finalOutput: body }
      : { status, partialOutput: body, error: { code: 'FIXTURE_CHILD_FAILED', message: 'Controlled child failure', retryable: false } })
  })
  await ctx.history.append({ id: 'admission:' + start.runId, role: 'tool', toolCallId: key, toolName: 'subagent_start',
    content: JSON.stringify({ state: 'admitted', runId: start.runId, childSessionId: start.childSessionId }),
    ...{ conversationId: ctx.turnId } }, ctx)
  joins.push(start.completion.catch(() => undefined)); await entered.promise
  return { start, finish, execution, body, complete: async () => { finish.release(); return start.completion } }
}
function model(stream: (messages: Message[], options?: LLMAdapterOptions) => AsyncIterable<LLMStreamChunk>): LLMAdapter {
  return { provider: 'fixture', model: 'scripted-only', countTokens: () => 0, complete: vi.fn(), stream }
}
function run(llm: LLMAdapter, frames?: string[]) {
  const execution = (async () => {
    for await (const frame of new ReActStrategy(llm, { maxIterations: 8, maxOutputTokens: 200 }).run('', ctx)) frames?.push(frame)
  })()
  joins.push(execution.catch(() => undefined))
  return execution
}
async function joinedCount(count: number) {
  await expect.poll(async () => Number((await db.execute('SELECT count(*) AS n FROM dependency_joined_results')).rows[0].n)).toBe(count)
}

beforeEach(async () => {
  await database.closeDb()
  fs.mkdirSync('.e2e-tmp', { recursive: true })
  directory = fs.mkdtempSync(path.resolve('.e2e-tmp/dependency-integration-'))
  vi.stubEnv('DATA_DIR', path.join(directory, 'fixture.db')); vi.stubEnv('HISTORY_BACKEND', backend)
  vi.stubEnv('WORKSPACE_ROOT', path.join(directory, 'workspace'))
  vi.stubEnv('AETHER_WORKSPACE_BINDINGS_FILE', path.join(directory, 'bindings.json'))
  vi.stubEnv('AETHER_ALLOWED_WORKSPACE_ROOTS', directory)
  vi.stubEnv('AUTH_ENABLED', 'false'); vi.stubEnv('OSM_MODE', 'balanced'); vi.stubEnv('ENABLE_LONG_TERM_MEMORY', 'false')
  db = database.getDb() as LocalSqliteProcessClient
  await database.initDb(); await ensureUserAdmissionSchema(db)
  const roots = new RootRunStore(() => db)
  const selector = { protocolVersion: 1 as const, namespace: await readDatabaseNamespace(db), owner: 'code' as const, predecessor: null }
  const transport = { toolProfile: 'general', runLifetime: 'durable', subagentProtocol: 2 as const }
  const body: Record<string, unknown> = { sessionId: scope.sessionId, message: task, model: 'scripted-only' }
  body.admission = { ...selector, requestKey: 'root', bodyDigest: userAdmissionDigest(body, transport, selector) }
  const accepted = await roots.createUserAdmission(scope.tenantId, 'scripted-only', [directory], body, prepareUserAdmission(body, transport)!)
  agents = new SubagentStore(db); runtime = new CollaborationRuntime(new CollaborationStore(db), agents); owners = new ExecutionOwners(db, runtime)
  controller = new AbortController()
  const owner = await owners.admitRoot({ tenantId: scope.tenantId, rootRunId: accepted.run.runId,
    rootAttemptId: accepted.receipt.attemptId, controller })
  const seed = await readAdmissionSeed(db, scope, accepted.run.runId)
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }
  logger.child.mockReturnValue(logger)
  ctx = { ...scope, rootRunId: accepted.run.runId, turnId: accepted.run.turnId, userMessageId: accepted.run.userMessageId,
    conversationId: accepted.run.turnId, executionOwner: owner, signal: controller.signal,
    history: admissionProjectingHistory(createConversationHistory(), seed.anchor), tools: new ToolRegistry(),
    workspaceDir: directory, workspacePaths: [directory], projectRoot: directory, cwd: directory,
    memoryScopes: [], toolProfile: 'general', tokenBudget: 100_000, modelCaps: { contextWindow: 100_000 },
    logger,
    runObserver: { onOutcome: vi.fn() },
  } as unknown as AgentContext
  installProductionCollaborationBoundary(ctx)
  await ctx.history.append(seed.message, scope)
  if (ctx.jsonlDelivery) await bindJSONLReActBoundary(ctx.jsonlDelivery, ctx, ctx.userMessageId)
  else await bindSQLiteReActBoundary(ctx.sqliteDelivery!, ctx, ctx.userMessageId)
  runner = new SubagentRunner(agents, new SubagentPool(4))
  vi.spyOn(subagentRunners, 'getSubagentRunner').mockReturnValue(runner)
})
afterEach(async () => {
  controller?.abort(new Error('Fixture cleanup'))
  for (const release of releases.splice(0)) release()
  await Promise.allSettled(joins.splice(0))
  await database.closeDb(); await db.whenClosed()
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals()
  if (path.dirname(directory) !== path.resolve('.e2e-tmp') || !path.basename(directory).startsWith('dependency-integration-')) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 })
})

describe.each(['jsonl', 'sqlite'] as const)('%s dependency hook execution boundaries', selected => {
  beforeAll(() => { backend = selected })

  it('waits for each complete dependency set and never overlaps parent requests or leaks a half-ready result', async () => {
    const children = await Promise.all([held(0), held(1), held(2)])
    await plan([{ step: 'A', ids: [children[0].start.runId] }, { step: 'B', ids: [children[1].start.runId, children[2].start.runId] }])
    const requests: Message[][] = [], first = gate(), handlingA = gate(), finishA = gate()
    let active = 0, maxActive = 0
    const execution = run(model(async function* (messages) {
      active++; maxActive = Math.max(maxActive, active); requests.push(structuredClone(messages))
      try {
        if (requests.length === 1) first.release()
        if (requests.length === 2) { handlingA.release(); await finishA.promise }
        yield { done: true, content: 'Integrate the currently ready work.', promptTokens: 100, completionTokens: 10 }
      } finally { active-- }
    }))
    await first.promise
    await children[1].complete(); await joinedCount(1)
    expect(requests).toHaveLength(1)
    expect((await readHookSnapshot(ctx)).hooks.map(hook => hook.state)).toEqual(['armed', 'armed'])
    await children[0].complete(); await handlingA.promise
    expect(requests).toHaveLength(2); expect(labels(requests[1])).toEqual(['A'])
    expect(JSON.stringify(requests[1])).toContain(bodies[0]); expect(JSON.stringify(requests[1])).not.toContain(bodies[1])
    await children[2].complete(); await tick()
    expect(requests).toHaveLength(2); expect(maxActive).toBe(1)
    finishA.release(); await execution
    expect(requests).toHaveLength(3); expect(labels(requests[2])).toEqual(['B']); expect(maxActive).toBe(1)
    for (const body of bodies.slice(1)) expect(JSON.stringify(requests[2].map(message => message.content)).split(body)).toHaveLength(2)
    expect((await readHookSnapshot(ctx)).hooks.every(hook => hook.state === 'consumed')).toBe(true)
    expect(ctx.runObserver?.onOutcome).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'succeeded' }))
  })

  it('merges simultaneous ready hooks in one request and ignores duplicate terminal projections', async () => {
    const children = await Promise.all([held(0), held(1), held(2)])
    await plan([{ step: 'A', ids: [children[0].start.runId] }, { step: 'B', ids: [children[1].start.runId, children[2].start.runId] }])
    const completed = await Promise.all(children.map(child => child.complete()))
    for (const child of completed) expect(await projectOwnedSubagent(ctx.history, agents, scope.tenantId, child.runId, child.lastSeq)).toBe('appended')
    await evaluateDependencyHooks(ctx, completed); await evaluateDependencyHooks(ctx, completed)
    const requests: Message[][] = []
    await run(model(async function* (messages) {
      requests.push(structuredClone(messages))
      yield { done: true, content: 'Integrated both ready groups.', promptTokens: 100, completionTokens: 10 }
    }))
    expect(requests).toHaveLength(1); expect(labels(requests[0])).toEqual(['A', 'B'])
    const hooks = (await readHookSnapshot(ctx)).hooks
    expect(hooks).toHaveLength(2); expect(new Set(hooks.map(hook => hook.consumedRequestId)).size).toBe(1)
    expect(hooks.every(hook => hook.state === 'consumed')).toBe(true)
    expect((await ctx.history.getFullHistory(ctx)).filter(message => message.id?.startsWith('subagent-result:'))).toHaveLength(3)
  })

  it('real ReAct compaction hides half-ready results from its summary model and restores the full group when ready', async () => {
    const second = await held(1), third = await held(2)
    await plan([{ step: 'B', ids: [second.start.runId, third.start.runId] }]); await second.complete()
    await ctx.history.append({ id: 'long-work-before-dependency-join', role: 'assistant',
      content: 'Existing parent work before joining dependencies. '.repeat(1800), ...{ conversationId: ctx.turnId } }, ctx)
    expect(JSON.stringify(await ctx.history.getFullHistory(ctx))).toContain(bodies[1])
    ctx.modelCaps = { contextWindow: 12_000 }; ctx.tokenBudget = 12_000
    const requests: Message[][] = [], firstRequest = gate()
    const llm = model(async function* (messages) {
      requests.push(structuredClone(messages)); if (requests.length === 1) firstRequest.release()
      yield { done: true, content: 'Integrated the available complete dependency group.', promptTokens: 100, completionTokens: 10 }
    })
    const summaries: Message[][] = []
    llm.complete = vi.fn(async messages => {
      summaries.push(structuredClone(messages))
      return { content: '<summary>Parent work remains available; dependency group B is still waiting.</summary>',
        promptTokens: 100, completionTokens: 10, finishReason: 'stop' as const }
    })
    const execution = run(llm)
    await Promise.race([firstRequest.promise, execution.then(() => {
      throw new Error('Parent ended before its first dispatch: ' + JSON.stringify({
        outcomes: vi.mocked(ctx.runObserver!.onOutcome!).mock.calls, errors: vi.mocked(ctx.logger.error).mock.calls }))
    })]); await joinedCount(1)
    expect(summaries.length).toBeGreaterThan(0)
    expect(JSON.stringify(summaries)).not.toContain(bodies[1])
    expect(JSON.stringify(summaries)).not.toContain(bodies[2])
    expect(requests).toHaveLength(1); expect(labels(requests[0])).toEqual([])
    expect(JSON.stringify(requests[0])).not.toContain(bodies[1])
    expect((await readHookSnapshot(ctx)).hooks[0].state).toBe('armed')
    // Confirm the test actually retired the original row, so the next request
    // must restore the joined body rather than accidentally finding it retained.
    const compacted = await ctx.history.getFullHistory(ctx)
    expect(JSON.stringify(compacted)).not.toContain(bodies[1])
    expect(compacted.some(message => message.id === 'dispatch-2')).toBe(true)
    expect(compacted.some(message => message.id === 'admission:' + third.start.runId)).toBe(true)
    const completed = await third.complete()
    expect(await agents.ownedParentProjection(scope.tenantId, completed.runId, completed.lastSeq))
      .toMatchObject({ acknowledged: true, disposition: 'appended' })
    await execution
    expect(requests).toHaveLength(2); expect(labels(requests[1])).toEqual(['B'])
    expect(claims(requests[1])).toEqual([expect.objectContaining({ label: 'B', state: 'ready' })])
    for (const body of bodies.slice(1)) expect(JSON.stringify(requests[1].map(message => message.content)).split(body),
      `${body}: ${JSON.stringify(requests[1].filter(message => message.id?.startsWith('subagent-result:')))}`).toHaveLength(2)
    expect((await readHookSnapshot(ctx)).hooks[0].state).toBe('consumed')
    expect(ctx.runObserver?.onOutcome).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'succeeded' }))
  })

  it('delivers a failed dependency as one blocked hook without claiming the group succeeded', async () => {
    const failed = await held(0, 'failed'), pending = await held(1)
    await plan([{ step: 'B', ids: [failed.start.runId, pending.start.runId] }])
    const review = new ChildResultReview(), waiting = review.beforeFinal(ctx)
    joins.push(waiting.catch(() => undefined)); await failed.complete()
    expect(await waiting).toBe(true)
    const messages = await review.prepare(ctx, await ctx.history.getFullHistory(ctx))
    expect(claims(messages)).toEqual([expect.objectContaining({ label: 'B', state: 'blocked' })])
    expect(JSON.stringify(messages)).not.toContain(bodies[1])
    review.recordRequest(messages); await review.commitResponse(ctx, 'accepted-failure-review')
    await evaluateDependencyHooks(ctx, [await failed.start.completion])
    const replay = await new ChildResultReview().prepare(ctx, await ctx.history.getFullHistory(ctx))
    expect(claims(replay)).toHaveLength(0)
    expect((await readHookSnapshot(ctx)).hooks[0]).toMatchObject({ state: 'consumed', conditionOutcome: 'blocked' })
    let settled = false
    const lateReview = review.beforeFinal(ctx).then(value => { settled = true; return value })
    joins.push(lateReview.catch(() => undefined)); await tick()
    expect(settled).toBe(false)
    await pending.complete(); expect(await lateReview).toBe(true)
    const late = await review.prepare(ctx, await ctx.history.getFullHistory(ctx))
    expect(claims(late)).toHaveLength(0)
    expect(late.some(message => message.id === 'subagent-result:' + pending.start.runId && String(message.content).includes(bodies[1]))).toBe(true)
  })

  it('wakes for accepted mail without exposing a half-ready group and later resumes its complete hook', async () => {
    const second = await held(1), third = await held(2)
    await plan([{ step: 'B', ids: [second.start.runId, third.start.runId] }])
    const requests: Message[][] = [], first = gate(), mailSeen = gate(), finishMail = gate()
    const execution = run(model(async function* (messages) {
      requests.push(structuredClone(messages))
      if (requests.length === 1) first.release()
      if (requests.length === 2) { mailSeen.release(); await finishMail.promise }
      yield { done: true, content: 'Processed available input.', promptTokens: 100, completionTokens: 10 }
    }))
    await first.promise; await second.complete(); await joinedCount(1)
    await runtime.send(owners.producerForExecution(third.execution.executionOwner!), {
      recipientParticipantId: 'root:' + ctx.rootRunId, message: 'UNIQUE_INCOMING_REQUIREMENT_619', requestKey: 'steer-parent',
    })
    await mailSeen.promise
    expect(requests).toHaveLength(2); expect(labels(requests[1])).toEqual([])
    expect(JSON.stringify(requests[1])).toContain('UNIQUE_INCOMING_REQUIREMENT_619')
    expect(JSON.stringify(requests[1])).not.toContain(bodies[1])
    await third.complete(); finishMail.release(); await execution
    expect(requests).toHaveLength(3); expect(labels(requests[2])).toEqual(['B'])
  })

  it('cancels an idle parent without consuming armed hooks or sending a polling request', async () => {
    const child = await held(0)
    await plan([{ step: 'A', ids: [child.start.runId] }])
    const waiting = gate(), actualWait = runtime.waitForInput.bind(runtime)
    vi.spyOn(runtime, 'waitForInput').mockImplementation((...args) => { waiting.release(); return actualWait(...args) })
    let requests = 0
    const execution = run(model(async function* () {
      requests++; yield { done: true, content: 'Waiting for A.', promptTokens: 100, completionTokens: 10 }
    }))
    await waiting.promise; controller.abort(new Error('User cancelled the parent')); child.finish.release(); await execution
    expect(requests).toBe(1)
    expect((await db.execute('SELECT state,consumed_request_id FROM dependency_hooks')).rows[0]).toMatchObject({ state: 'armed', consumed_request_id: null })
    expect(ctx.runObserver?.onOutcome).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'cancelled' }))
  })

  it('keeps hook claims through a provider failure and retry, consuming only after the valid response', async () => {
    const child = await held(0)
    await plan([{ step: 'A', ids: [child.start.runId] }]); await child.complete()
    const requests: Message[][] = []
    const inner = model(async function* (messages, options) {
      requests.push(structuredClone(messages))
      await options?.onRequestAttempt?.({ type: 'start', requestAttemptId: 'provider-attempt-' + requests.length, provider: 'fixture', model: 'scripted-only' })
      expect((await readHookSnapshot(ctx)).hooks[0].state).toBe('ready')
      if (requests.length === 1) throw Object.assign(new Error('Controlled provider overload'), { status: 503 })
      yield { done: true, content: 'Integrated A after retry.', promptTokens: 100, completionTokens: 10 }
    })
    await run(new RetryingAdapter(inner, { maxRetries: 1, baseDelayMs: 0, maxDelayMs: 0 }))
    expect(requests).toHaveLength(2)
    expect(labels(requests[0])).toEqual(['A']); expect(claims(requests[1])).toEqual(claims(requests[0]))
    expect((await readHookSnapshot(ctx)).hooks[0]).toMatchObject({ state: 'consumed' })
    expect((await ctx.history.getFullHistory(ctx)).filter(message => message.usage)).toHaveLength(1)
  })

  it('preserves a ready hook when the provider rejects every attempt without a valid response', async () => {
    const child = await held(0)
    await plan([{ step: 'A', ids: [child.start.runId] }]); await child.complete()
    let requests = 0
    await run(model(async function* (_messages, options) {
      requests++
      await options?.onRequestAttempt?.({ type: 'start', requestAttemptId: 'rejected-provider', provider: 'fixture', model: 'scripted-only' })
      throw Object.assign(new Error('Controlled provider refusal'), { status: 400 })
    }))
    expect(requests).toBe(1)
    expect((await readHookSnapshot(ctx)).hooks[0]).toMatchObject({ state: 'ready' })
    expect((await readHookSnapshot(ctx)).hooks[0].consumedRequestId).toBeUndefined()
    expect(ctx.runObserver?.onOutcome).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'failed', stopReason: 'provider_error' }))
    const retry = await new ChildResultReview().prepare(ctx, await ctx.history.getFullHistory(ctx))
    expect(labels(retry)).toEqual(['A'])
  })

  it('does not resurrect a suppressed child body after its dispatch anchor was deleted', async () => {
    const child = await held(0)
    await plan([{ step: 'A', ids: [child.start.runId] }])
    await ctx.history.deleteMessage('dispatch-0', scope.tenantId)
    const completed = await child.complete()
    expect(await agents.ownedParentProjection(scope.tenantId, completed.runId, completed.lastSeq)).toMatchObject({ acknowledged: true, disposition: 'suppressed' })
    const review = new ChildResultReview()
    const messages = await review.prepare(ctx, await ctx.history.getFullHistory(ctx))
    expect(claims(messages)).toEqual([expect.objectContaining({ label: 'A', state: 'blocked' })])
    expect(JSON.stringify(messages)).not.toContain(bodies[0])
    expect(messages.some(message => message.id === 'subagent-result:' + completed.runId)).toBe(false)
    expect((await ctx.history.getFullHistory(ctx)).some(message => message.id === 'subagent-result:' + completed.runId)).toBe(false)
    review.recordRequest(messages); await review.commitResponse(ctx, 'suppressed-notice-consumed')
    expect(await review.beforeFinal(ctx)).toBe(false)
    // A stale request cache must not reintroduce an unavailable body after the
    // exception notice is consumed and the legacy result-review path runs.
    const replay = await review.prepare(ctx, [...await ctx.history.getFullHistory(ctx),
      { id: 'subagent-result:' + completed.runId, role: 'assistant', content: bodies[0] }])
    expect(claims(replay)).toHaveLength(0)
    expect(JSON.stringify(replay)).not.toContain(bodies[0])
    expect(replay.some(message => message.id === 'subagent-result:' + completed.runId)).toBe(false)
    expect(await review.beforeFinal(ctx)).toBe(false)
  })

  it('excludes a consumed suppressed result while still reviewing its late successful sibling', async () => {
    const suppressed = await held(0), sibling = await held(1)
    await plan([{ step: 'B', ids: [suppressed.start.runId, sibling.start.runId] }])
    await ctx.history.deleteMessage('dispatch-0', scope.tenantId)
    const completed = await suppressed.complete()
    expect(await agents.ownedParentProjection(scope.tenantId, completed.runId, completed.lastSeq)).toMatchObject({ acknowledged: true, disposition: 'suppressed' })
    const review = new ChildResultReview()
    const blocked = await review.prepare(ctx, await ctx.history.getFullHistory(ctx))
    expect(claims(blocked)).toEqual([expect.objectContaining({ label: 'B', state: 'blocked' })])
    expect(JSON.stringify(blocked)).not.toContain(bodies[0])
    review.recordRequest(blocked); await review.commitResponse(ctx, 'suppressed-group-notice-consumed')
    const subscribed = gate(), actualWait = runtime.waitForInput.bind(runtime)
    vi.spyOn(runtime, 'waitForInput').mockImplementation((...args) => { subscribed.release(); return actualWait(...args) })
    const waits = vi.spyOn(runner, 'waitOwned')
    let settled = false
    const pending = review.beforeFinal(ctx).then(value => { settled = true; return value })
    joins.push(pending.catch(() => undefined)); await subscribed.promise; await tick()
    expect(settled).toBe(false)
    expect(waits.mock.calls.map(call => call[1])).toEqual([sibling.start.runId])
    await sibling.complete(); expect(await pending).toBe(true)
    const messages = await review.prepare(ctx, await ctx.history.getFullHistory(ctx))
    expect(claims(messages)).toHaveLength(0)
    expect(JSON.stringify(messages)).not.toContain(bodies[0])
    expect(messages.filter(message => message.id === 'subagent-result:' + sibling.start.runId)).toHaveLength(1)
    expect(messages.some(message => message.id === 'subagent-result:' + sibling.start.runId && String(message.content).includes(bodies[1]))).toBe(true)
    review.recordRequest(messages); await review.commitResponse(ctx, 'late-sibling-reviewed')
    expect(await review.beforeFinal(ctx)).toBe(false)
    expect((await readHookSnapshot(ctx)).hooks[0]).toMatchObject({ state: 'consumed', conditionOutcome: 'blocked',
      issue: { runId: completed.runId, code: 'DEPENDENCY_RESULT_SUPPRESSED' } })
  })

  it.each(['failed', 'succeeded'] as const)('keeps all later suppressed siblings unavailable after the first %s exception while reviewing a late normal sibling', async firstStatus => {
    const first = await held(0, firstStatus), later = [await held(1), await held(2)], normal = await held(3)
    await plan([{ step: 'B', ids: [first.start.runId, ...later.map(child => child.start.runId), normal.start.runId] }])
    if (firstStatus === 'succeeded') await ctx.history.deleteMessage('dispatch-0', scope.tenantId)
    await ctx.history.deleteMessage('dispatch-1', scope.tenantId)
    await ctx.history.deleteMessage('dispatch-2', scope.tenantId)
    await first.complete()
    const review = new ChildResultReview()
    const blocked = await review.prepare(ctx, await ctx.history.getFullHistory(ctx))
    expect(claims(blocked)).toEqual([expect.objectContaining({ label: 'B', state: 'blocked' })])
    review.recordRequest(blocked); await review.commitResponse(ctx, 'first-exception-consumed')
    const completed = await Promise.all(later.map(child => child.complete()))
    for (const child of completed) expect(await agents.ownedParentProjection(scope.tenantId, child.runId, child.lastSeq))
      .toMatchObject({ acknowledged: true, disposition: 'suppressed' })
    const replay = await review.prepare(ctx, [...await ctx.history.getFullHistory(ctx),
      ...later.map(child => ({ id: 'subagent-result:' + child.start.runId, role: 'assistant' as const, content: child.body }))])
    expect(claims(replay)).toHaveLength(0)
    for (const child of later) {
      expect(JSON.stringify(replay)).not.toContain(child.body)
      expect(replay.some(message => message.id === 'subagent-result:' + child.start.runId)).toBe(false)
    }
    expect((await readHookSnapshot(ctx)).suppressedRunIds).toEqual(expect.arrayContaining(later.map(child => child.start.runId)))
    const subscribed = gate(), actualWait = runtime.waitForInput.bind(runtime)
    vi.spyOn(runtime, 'waitForInput').mockImplementation((...args) => { subscribed.release(); return actualWait(...args) })
    const waits = vi.spyOn(runner, 'waitOwned')
    const pending = review.beforeFinal(ctx); joins.push(pending.catch(() => undefined)); await subscribed.promise
    expect(waits.mock.calls.map(call => call[1])).toEqual([normal.start.runId])
    await normal.complete(); expect(await pending).toBe(true)
    const accepted = await review.prepare(ctx, await ctx.history.getFullHistory(ctx))
    expect(claims(accepted)).toHaveLength(0)
    for (const child of later) expect(JSON.stringify(accepted)).not.toContain(child.body)
    expect(accepted.filter(message => message.id === 'subagent-result:' + normal.start.runId)).toHaveLength(1)
    expect(JSON.stringify(accepted)).toContain(normal.body)
    review.recordRequest(accepted); await review.commitResponse(ctx, 'normal-late-sibling-consumed')
    expect(await review.beforeFinal(ctx)).toBe(false)
  })

  it('withholds a premature final while dependencies are armed and keeps it only as model context', async () => {
    const child = await held(0)
    await plan([{ step: 'A', ids: [child.start.runId] }])
    const frames: string[] = [], waiting = gate(), actualWait = runtime.waitForInput.bind(runtime)
    vi.spyOn(runtime, 'waitForInput').mockImplementation((...args) => { waiting.release(); return actualWait(...args) })
    let requests = 0
    const execution = run(model(async function* () {
      requests++
      if (requests === 1) {
        yield { done: false, content: 'PREMATURE_FINAL_MARKER_581' }
        yield { done: true, content: ' unverified delivery claim.', promptTokens: 100, completionTokens: 10 }
      } else yield { done: true, content: 'VERIFIED_FINAL_MARKER_683', promptTokens: 100, completionTokens: 10 }
    }), frames)
    await waiting.promise
    expect(frames.filter(frame => !frame.startsWith('\x00')).join('')).not.toContain('PREMATURE_FINAL_MARKER_581')
    await child.complete(); await execution
    const visible = frames.filter(frame => !frame.startsWith('\x00')).join('')
    expect(visible).not.toContain('PREMATURE_FINAL_MARKER_581'); expect(visible).toContain('VERIFIED_FINAL_MARKER_683')
    const history = await ctx.history.getFullHistory(ctx)
    expect(history.some(message => String(message.content).includes('PREMATURE_FINAL_MARKER_581'))).toBe(false)
    expect(history.some(message => String(message.modelInputContent).includes('PREMATURE_FINAL_MARKER_581'))).toBe(true)
  })

  it('keeps length continuation drafts private while armed and discards their prefix before the reviewed final', async () => {
    const child = await held(0)
    await plan([{ step: 'A', ids: [child.start.runId] }])
    const frames: string[] = [], waiting = gate(), actualWait = runtime.waitForInput.bind(runtime)
    vi.spyOn(runtime, 'waitForInput').mockImplementation((...args) => { waiting.release(); return actualWait(...args) })
    let requests = 0
    const execution = run(model(async function* () {
      requests++
      if (requests === 1) yield { done: true, finishReason: 'length', content: 'ARMED_LENGTH_DRAFT_727', promptTokens: 100, completionTokens: 10 }
      else if (requests === 2) yield { done: true, finishReason: 'stop', content: 'ARMED_STOP_DRAFT_823', promptTokens: 100, completionTokens: 10 }
      else yield { done: true, finishReason: 'stop', content: 'REVIEWED_FINAL_AFTER_LENGTH_947', promptTokens: 100, completionTokens: 10 }
    }), frames)
    await waiting.promise
    expect(requests).toBe(2)
    expect(frames.filter(frame => !frame.startsWith('\x00')).join('')).not.toMatch(/ARMED_LENGTH_DRAFT_727|ARMED_STOP_DRAFT_823/)
    await child.complete(); await execution
    const visible = frames.filter(frame => !frame.startsWith('\x00')).join('')
    expect(requests).toBe(3); expect(visible).toBe('REVIEWED_FINAL_AFTER_LENGTH_947')
    const history = await ctx.history.getFullHistory(ctx)
    expect(history.map(message => message.content).join('')).not.toMatch(/ARMED_LENGTH_DRAFT_727|ARMED_STOP_DRAFT_823/)
    expect(history.map(message => message.modelInputContent).join('')).toContain('ARMED_LENGTH_DRAFT_727')
    expect(history.map(message => message.modelInputContent).join('')).toContain('ARMED_STOP_DRAFT_823')
    expect(ctx.runObserver?.onOutcome).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'succeeded', finalOutput: visible }))
  })

  it('releases a deferred length prefix once when dependencies become ready before the stop response', async () => {
    const child = await held(0)
    await plan([{ step: 'A', ids: [child.start.runId] }])
    const frames: string[] = [], requests: Message[][] = []
    const prefix = 'DEFERRED_FINAL_PREFIX_1021 ', suffix = 'VERIFIED_FINAL_SUFFIX_1153'
    await run(model(async function* (messages) {
      requests.push(structuredClone(messages))
      if (requests.length === 1) {
        yield { done: true, finishReason: 'length', content: prefix, promptTokens: 100, completionTokens: 10 }
        expect(frames.filter(frame => !frame.startsWith('\x00')).join('')).not.toContain(prefix)
        // The first response still owns its original armed snapshot; the next
        // response sees ready, while it must preserve the buffered prefix.
        await child.complete()
      } else yield { done: true, finishReason: 'stop', content: suffix, promptTokens: 100, completionTokens: 10 }
    }), frames)
    expect(requests).toHaveLength(2); expect(labels(requests[1])).toEqual(['A'])
    const visible = frames.filter(frame => !frame.startsWith('\x00')).join('')
    expect(visible).toBe(prefix + suffix)
    const history = await ctx.history.getFullHistory(ctx)
    const publicHistory = history.filter(message => message.role === 'assistant' && message.usage)
      .map(message => String(message.content)).join('')
    expect(publicHistory).toBe(prefix + suffix)
    const modelHistory = history.map(message => String(message.modelInputContent ?? message.content)).join('')
    expect(modelHistory.split(prefix)).toHaveLength(2)
    expect(ctx.runObserver?.onOutcome).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'succeeded', finalOutput: prefix + suffix }))
  })

  it('runs actual plan/start/taskKey tools in one batch and sleeps after awaitDependencies without an extra parent request', async () => {
    const manager = new WorkspaceManager(path.join(directory, 'workspace'))
    manager.bind(scope, directory)
    vi.spyOn(workspaceManager, 'getPaths').mockImplementation(target => manager.getPaths(target))
    vi.spyOn(workspaceManager, 'getWorkingDirectory').mockImplementation(target => manager.getWorkingDirectory(target))
    vi.spyOn(workspaceManager, 'getBindingSnapshot').mockImplementation(target => manager.getBindingSnapshot(target))
    vi.spyOn(workspaceManager, 'bindingReadGuard').mockImplementation((target, expected) => manager.bindingReadGuard(target, expected))
    vi.spyOn(workspaceManager, 'inheritChildWorkspace').mockImplementation((...args) => manager.inheritChildWorkspace(...args))
    const childStarted = [gate(), gate(), gate()], childFinish = [gate(), gate(), gate()]
    const childCalls = [0, 0, 0], keys = ['a', 'b', 'c']
    vi.spyOn(modelResolver, 'resolveModelConfig').mockImplementation(async ({ model }) => ({ model: model!, provider: 'fixture',
      capabilities: resolveCapabilities({ model: 'gpt-4o', provider: 'openai' }), thinkingEnabled: false }))
    vi.spyOn(modelResolver, 'createAdapterFromResolved').mockImplementation(config => {
      const index = keys.findIndex(key => config.model === 'child-' + key)
      if (index < 0) throw new Error('Unexpected real-model resolution')
      return model(async function* () {
        childCalls[index]++; childStarted[index].release(); await childFinish[index].promise
        yield { done: true, content: bodies[index], promptTokens: 100, completionTokens: 10 }
      })
    })
    const registry = ctx.tools as ToolRegistry
    registry.register(trustBuiltinTool(planTool, 'serial'))
    registry.register(trustBuiltinTool(subagentStartTool, 'serial'))
    const planInput = { plan: [
      { step: 'A', status: 'pending', wakeWhen: { allSucceeded: ['task:a'] } },
      { step: 'B', status: 'pending', wakeWhen: { allSucceeded: ['task:b', 'task:c'] } },
    ] }
    const startArgs = keys.map(key => ({ task: 'Complete fixture task ' + key, description: 'Task ' + key,
      model: 'child-' + key, taskKey: key, builtinRole: 'research' }))
    const requests: Message[][] = [], handlingA = gate(), finishA = gate(), waiting = gate()
    const actualWait = runtime.waitForInput.bind(runtime)
    vi.spyOn(runtime, 'waitForInput').mockImplementation((...args) => { waiting.release(); return actualWait(...args) })
    const execution = run(model(async function* (messages) {
      requests.push(structuredClone(messages))
      if (requests.length === 1) {
        yield { done: true, promptTokens: 100, completionTokens: 10, toolCalls: [
          { index: 0, id: 'register-plan', name: 'plan_update', args: JSON.stringify(planInput) },
          ...startArgs.map((args, index) => ({ index: index + 1, id: 'start-' + keys[index], name: 'subagent_start', args: JSON.stringify(args) })),
          { index: 4, id: 'await-plan', name: 'plan_update', args: JSON.stringify({ ...planInput, awaitDependencies: true }) },
        ] }
      } else {
        if (requests.length === 2) { handlingA.release(); await finishA.promise }
        yield { done: true, content: 'Integrated the ready dependency group.', promptTokens: 100, completionTokens: 10 }
      }
    }))
    await Promise.all(childStarted.map(item => item.promise)); await waiting.promise
    expect(requests).toHaveLength(1)
    const bindingRows = (await db.execute('SELECT task_key,run_id FROM dependency_task_bindings ORDER BY task_key')).rows
    expect(bindingRows.map(row => row.task_key)).toEqual(keys)
    expect(new Set(bindingRows.map(row => row.run_id)).size).toBe(3)
    const dispatch = (await ctx.history.getFullHistory(ctx)).find(message => message.toolCall?.id === 'start-a')!
    const repeat = await subagentStartTool.execute(startArgs[0], { ...ctx, currentMessageId: dispatch.id, currentToolCallId: 'start-a' })
    expect(repeat.success, repeat.output).toBe(true)
    expect(JSON.parse(repeat.output)).toMatchObject({ reused: true, runId: bindingRows[0].run_id })
    await expect(subagentStartTool.execute(startArgs[0], { ...ctx, currentMessageId: dispatch.id, currentToolCallId: 'another-tool-id' })).rejects.toThrow('ALREADY_RESERVED')
    expect(Number((await db.execute('SELECT count(*) AS n FROM subagent_runs')).rows[0].n)).toBe(3)
    expect(childCalls).toEqual([1, 1, 1])
    childFinish[1].release(); await joinedCount(1)
    expect(requests).toHaveLength(1)
    childFinish[0].release(); await handlingA.promise
    expect(requests).toHaveLength(2); expect(labels(requests[1])).toEqual(['A'])
    expect(JSON.stringify(requests[1])).not.toContain(bodies[1])
    childFinish[2].release(); finishA.release(); await execution
    expect(requests).toHaveLength(3); expect(labels(requests[2])).toEqual(['B'])
    expect((await readHookSnapshot(ctx)).hooks.every(hook => hook.state === 'consumed')).toBe(true)
    expect(childCalls).toEqual([1, 1, 1])
  })

  it.each(['openai', 'anthropic'] as const)('%s wire excludes partial results and sends the ready group bodies exactly once', async provider => {
    const second = await held(1), third = await held(2)
    await plan([{ step: 'B', ids: [second.start.runId, third.start.runId] }]); await second.complete()
    const wire: any[] = [], first = gate()
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      wire.push(JSON.parse(String(init?.body)))
      return Response.json(provider === 'openai'
        ? { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10 } }
        : { id: 'fixture', type: 'message', role: 'assistant', model: 'fixture', content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 10 } })
    }))
    const serializer = provider === 'openai' ? new OpenAIAdapter('fixture', 'fixture-key', 'http://model.invalid', true)
      : new AnthropicAdapter('fixture', 'fixture-key', 'http://model.invalid')
    const execution = run(model(async function* (messages, options) {
      await serializer.complete(messages, options)
      if (wire.length === 1) first.release()
      yield { done: true, content: 'Reviewed the ready group.', promptTokens: 100, completionTokens: 10 }
    }))
    await first.promise; await joinedCount(1)
    expect(wire).toHaveLength(1); expect(JSON.stringify(wire[0])).not.toContain(bodies[1])
    await third.complete(); await execution
    expect(wire).toHaveLength(2)
    for (const body of bodies.slice(1)) expect(JSON.stringify(wire[1]).split(body)).toHaveLength(2)
    expect((await readHookSnapshot(ctx)).hooks[0].state).toBe('consumed')
  })
})
