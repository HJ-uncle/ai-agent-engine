import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext, Message } from '../../agent-context/types.js'
import type { LLMAdapter, LLMAdapterOptions, LLMRequestAttemptEvent, LLMStreamChunk } from '../../llm-adapter/types.js'
import { observeStreamRequest } from '../../llm-adapter/request-attempt.js'
import { RetryingAdapter } from '../../llm-adapter/retry.js'
import { AnthropicAdapter } from '../../llm-adapter/anthropic.js'
import { APIConnectionError } from '@anthropic-ai/sdk'
import { RequestHistoryChangedError } from '../history-budget.js'
import type { RunInvocationUsage, RunOutcome } from '../../subagent/types.js'
import { ReActStrategy } from '../../agent-loop/react.js'
import { estimateRequestInput } from '../../agent-loop/finalization.js'
import { getDb, closeDb, initDb } from '../../../storage/sqlite/db.js'
import type { LocalSqliteProcessClient } from '../../../storage/sqlite/local-process-client.js'
import { RootRunStore } from '../../../storage/root-runs/index.js'
import { JSONLConversationHistory } from '../../../storage/conversation/jsonl-history.js'
import { SQLiteConversationHistory } from '../../../storage/conversation/history.js'
import { serializeConversationHistory, bindHistoryGeneration } from '../../../storage/conversation/serialization.js'
import { admissionProjectingHistory, readAdmissionSeed } from '../../../storage/root-admission/projection.js'
import { ensureUserAdmissionSchema, readDatabaseNamespace, prepareUserAdmission, userAdmissionDigest } from '../../../storage/root-admission/index.js'
import { SubagentStore } from '../../subagent/store.js'
import { SubagentRunner } from '../../subagent/runner.js'
import { CollaborationStore } from '../store.js'
import { CollaborationRuntime } from '../runtime.js'
import { ExecutionOwners } from '../execution-owner.js'
import { installProductionCollaborationBoundary } from '../production-boundary.js'
import { bindJSONLReActBoundary } from '../jsonl-react-boundary.js'
import { bindSQLiteReActBoundary } from '../sqlite-react-boundary.js'

vi.mock('../../../storage/todo/index.js', () => ({ TodoStore: class { async list() { return [] } } }))
let directory: string, db: LocalSqliteProcessClient, agents: SubagentStore
let raw: JSONLConversationHistory | SQLiteConversationHistory, ctx: AgentContext, controller: AbortController
let requests: Array<{ messages: Message[]; options: LLMAdapterOptions }>, outcomes: RunOutcome[], observedUsages: unknown[], llm: LLMAdapter
let backend: 'jsonl' | 'sqlite'
const scope = { tenantId: 'history-rebudget', sessionId: 'parent' }
const task = 'Review the child result and answer.'

beforeEach(async () => {
  await closeDb()
  directory = path.resolve('.e2e-tmp', 'history-rebudget-' + randomUUID())
  fs.mkdirSync(directory, { recursive: true })
  vi.stubEnv('DATA_DIR', path.join(directory, 'fixture.db'))
  vi.stubEnv('HISTORY_BACKEND', backend)
  vi.stubEnv('ENABLE_LONG_TERM_MEMORY', 'false')
  db = getDb() as LocalSqliteProcessClient
  await initDb(); await ensureUserAdmissionSchema(db)
  const roots = new RootRunStore(() => db), namespace = await readDatabaseNamespace(db)
  const selector = { protocolVersion: 1 as const, namespace, owner: 'code' as const, predecessor: null }
  const transport = { toolProfile: 'general', runLifetime: 'durable', subagentProtocol: 2 as const }
  const body: Record<string, unknown> = { sessionId: scope.sessionId, message: task, model: 'scripted-only' }
  body.admission = { ...selector, requestKey: 'root', bodyDigest: userAdmissionDigest(body, transport, selector) }
  const admitted = await roots.createUserAdmission(scope.tenantId, 'scripted-only', [], body, prepareUserAdmission(body, transport)!)
  agents = new SubagentStore(db)
  const runtime = new CollaborationRuntime(new CollaborationStore(db), agents), owners = new ExecutionOwners(db, runtime)
  controller = new AbortController()
  const owner = await owners.admitRoot({ tenantId: scope.tenantId, rootRunId: admitted.run.runId,
    rootAttemptId: admitted.receipt.attemptId, controller })
  raw = backend === 'jsonl' ? new JSONLConversationHistory() : new SQLiteConversationHistory()
  const history = admissionProjectingHistory(bindHistoryGeneration(serializeConversationHistory(raw), scope.tenantId, scope.sessionId),
    { rootRunId: admitted.run.runId, turnId: admitted.run.turnId, userMessageId: admitted.run.userMessageId,
      assistantAnchorId: admitted.receipt.assistantMessageId })
  requests = []; outcomes = []; observedUsages = []
  ctx = { ...scope, rootRunId: admitted.run.runId, turnId: admitted.run.turnId, userMessageId: admitted.run.userMessageId,
    executionOwner: owner, inheritContext: false, signal: controller.signal, history,
    modelCaps: { contextWindow: 100_000 }, tokenBudget: 100_000,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    tools: { list: () => [], has: () => false, execute: vi.fn() },
    runObserver: { onOutcome: async (value: RunOutcome) => { outcomes.push(value) }, onUsage: async (value: RunInvocationUsage) => { observedUsages.push(value) } },
  } as unknown as AgentContext
  installProductionCollaborationBoundary(ctx)
  const seed = await readAdmissionSeed(db, scope, ctx.rootRunId!)
  await history.append(seed.message, scope)
  if (ctx.jsonlDelivery) await bindJSONLReActBoundary(ctx.jsonlDelivery, ctx, ctx.userMessageId)
  else await bindSQLiteReActBoundary(ctx.sqliteDelivery!, ctx, ctx.userMessageId)
  llm = { model: 'scripted-only', provider: 'test', complete: vi.fn(), countTokens: () => 0,
    stream: vi.fn(async function* (messages, options) {
      requests.push({ messages, options: options! })
      yield { done: true, content: 'Reviewed the actual child result.', promptTokens: 100, completionTokens: 10 }
    }) }
})
afterEach(async () => {
  vi.restoreAllMocks(); await closeDb(); await db.whenClosed(); vi.unstubAllEnvs(); vi.unstubAllGlobals()
  if (path.dirname(directory) !== path.resolve('.e2e-tmp') || !path.basename(directory).startsWith('history-rebudget-')) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

async function run(onBudget: () => Promise<void>) {
  const frames: string[] = []
  for await (const frame of new ReActStrategy(llm, { maxIterations: 1, maxOutputTokens: 100 }).run(null, ctx)) {
    frames.push(frame)
    if (frame.startsWith('\x00__usage__') && JSON.parse(frame.slice('\x00__usage__'.length)).contextUsageEstimated === true) await onBudget()
  }
  return frames
}

function instrumentedAdapter(beforeAttempt: () => Promise<void>, failRequest = false): LLMAdapter {
  return { ...llm, stream: async function* (messages, options) {
    await beforeAttempt()
    const stream = await observeStreamRequest<LLMStreamChunk>(async () => {
      requests.push({ messages, options: options! })
      if (failRequest) throw Object.assign(new Error('Temporary provider connection failure'), { retryable: true })
      return (async function* () { yield { done: true, content: 'Reviewed the refreshed evidence.', promptTokens: 100, completionTokens: 10 } })()
    }, options, 'test', 'scripted-only', () => ({ promptTokens: 100, completionTokens: 10 }), chunk => chunk.done)
    yield* stream
  } }
}

function successfulAnthropicResponse() {
  const frame = (type: string, value: unknown) => `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`
  return new Response(frame('message_start', { type: 'message_start', message: {
    id: 'fixture-response', type: 'message', role: 'assistant', model: 'fixture-anthropic', content: [],
    stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 },
  } }) + frame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Reviewed.' } })
    + frame('content_block_stop', { type: 'content_block_stop', index: 0 })
    + frame('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } })
    + frame('message_stop', { type: 'message_stop' }), { headers: { 'content-type': 'text/event-stream' } })
}

describe.each(['jsonl', 'sqlite'] as const)('%s authenticated pre-dispatch history refresh', selected => {
  beforeAll(() => { backend = selected })

  it('re-budgets a real joined child result, without another provider attempt or model iteration', async () => {
    await raw.append({ id: 'child-dispatch', role: 'assistant', content: '', conversationId: ctx.turnId,
      toolCall: { id: 'child-call', name: 'subagent_start', args: { task: 'Compute the requested value.' } } } as Message, scope)
    let finish!: () => void
    const gate = new Promise<void>(resolve => { finish = resolve })
    const runner = new SubagentRunner(agents)
    const child = await runner.start({ tenantId: scope.tenantId, rootSessionId: scope.sessionId, parentSessionId: scope.sessionId,
      parentConversationId: ctx.turnId!, parentMessageId: 'child-dispatch', parentToolCallId: 'child-call', parentToolName: 'subagent_start',
      task: 'Compute the requested value.', description: 'Child result arrives during parent budgeting', modelId: 'scripted-only',
      continuation: { readOnly: true, systemPrompt: '', toolNames: [], workspacePaths: [] } }, ctx,
      async execution => { await gate; await execution.observer.onOutcome({ status: 'succeeded', output: 'CHILD_VALUE_667 ' + 'verified evidence '.repeat(80) }) })
    await raw.append({ id: 'child-admission', role: 'tool', toolCallId: 'child-call', toolName: 'subagent_start',
      content: JSON.stringify({ state: 'admitted', runId: child.runId }), metadata: { status: 'succeeded', success: true } }, scope)
    let snapshots = 0
    await run(async () => { if (++snapshots === 1) { finish(); await child.completion } })
    expect(snapshots).toBeGreaterThanOrEqual(2)
    expect(requests).toHaveLength(1)
    expect(requests[0].messages.some(message => String(message.content).includes('CHILD_VALUE_667'))).toBe(true)
    expect(requests[0].options.requestInputTokenEstimate).toBe(estimateRequestInput(requests[0].messages,
      requests[0].options.systemPrompt, requests[0].options.tools ?? [], requests[0].options.requestContext))
    expect(observedUsages).toHaveLength(1)
    expect(outcomes.at(-1)?.status, JSON.stringify(outcomes.at(-1))).toBe('succeeded')
    expect((await ctx.history.getFullHistory(ctx)).filter(message => message.usage)).toHaveLength(1)
  })

  it('bounds repeated valid changes without sending a request or inventing usage', async () => {
    let updates = 0
    await run(async () => { await raw.append({ id: `background-${++updates}`, role: 'assistant', content: `new evidence ${updates}` }, scope) })
    expect(updates).toBe(9)
    expect(requests).toHaveLength(0)
    expect(observedUsages).toHaveLength(0)
    expect((await ctx.history.getFullHistory(ctx)).some(message => message.usage)).toBe(false)
    expect(outcomes.at(-1)?.status).toBe('failed')
    expect(outcomes.at(-1)?.error?.message).toContain('changed after request budgeting')
  })

  it('re-budgets when history changes inside the adapter before its first physical attempt', async () => {
    let preparations = 0
    const attempts: LLMRequestAttemptEvent[] = []
    ctx.onRequestAttempt = event => { attempts.push(event) }
    llm = instrumentedAdapter(async () => {
      if (++preparations === 1) await raw.append({ id: 'adapter-evidence', role: 'assistant', content: 'ADAPTER_EVIDENCE_318' }, scope)
    })
    await run(async () => {})
    expect(preparations).toBe(2)
    expect(requests).toHaveLength(1)
    expect(requests[0].messages.some(message => message.content === 'ADAPTER_EVIDENCE_318')).toBe(true)
    expect(attempts.map(event => event.type)).toEqual(['start', 'finish'])
    expect(observedUsages).toHaveLength(1)
    expect(outcomes.at(-1)?.status).toBe('succeeded')
  })

  it('bounds repeated adapter-side changes before any physical attempt', async () => {
    let preparations = 0
    const attempts: LLMRequestAttemptEvent[] = []
    ctx.onRequestAttempt = event => { attempts.push(event) }
    llm = instrumentedAdapter(async () => {
      await raw.append({ id: `adapter-evidence-${++preparations}`, role: 'assistant', content: `new evidence ${preparations}` }, scope)
    })
    await run(async () => {})
    expect(preparations).toBe(9)
    expect(requests).toHaveLength(0)
    expect(attempts).toHaveLength(0)
    expect(observedUsages).toHaveLength(0)
    expect(outcomes.at(-1)?.status).toBe('failed')
  })

  it('does not re-budget a failed physical request that the adapter was about to retry', async () => {
    let preparations = 0
    const attempts: LLMRequestAttemptEvent[] = []
    ctx.onRequestAttempt = event => { attempts.push(event) }
    llm = new RetryingAdapter(instrumentedAdapter(async () => {
      if (++preparations === 2) await raw.append({ id: 'late-evidence', role: 'assistant', content: 'Changed after the first physical request' }, scope)
    }, true), { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1 })
    await run(async () => {})
    expect(preparations).toBe(2)
    expect(requests).toHaveLength(1)
    expect(attempts.map(event => event.type)).toEqual(['start', 'finish'])
    expect(outcomes.at(-1)?.status).toBe('failed')
    expect(outcomes.at(-1)?.error?.message).toContain('changed after request budgeting')
  })

  it('preserves the first-attempt history error through the real Anthropic adapter, then dispatches the refreshed wire once', async () => {
    const attempts: LLMRequestAttemptEvent[] = [], bodies: unknown[] = [], errors: unknown[] = []
    ctx.onRequestAttempt = event => { attempts.push(event) }
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return successfulAnthropicResponse()
    }))
    const adapter = new AnthropicAdapter('fixture-anthropic', 'fixture-key', 'http://fixture.invalid/anthropic')
    let preparations = 0
    llm = { ...llm, stream: async function* (messages, options) {
      if (++preparations === 1) await raw.append({ id: 'sdk-evidence', role: 'assistant', content: 'SDK_EVIDENCE_812' }, scope)
      try { yield* adapter.stream(messages, options) } catch (error) { errors.push(error); throw error }
    } }
    await run(async () => {})
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(RequestHistoryChangedError)
    expect(preparations).toBe(2)
    expect(bodies).toHaveLength(1)
    expect(JSON.stringify(bodies[0])).toContain('SDK_EVIDENCE_812')
    expect(attempts.map(event => event.type)).toEqual(['start', 'finish'])
    expect(observedUsages).toHaveLength(1)
    expect(outcomes.at(-1)?.status, JSON.stringify(outcomes.at(-1))).toBe('succeeded')
  })

  it('reproduces a real Anthropic fetch rejection followed by changed history before retry without replaying that request', async () => {
    const attempts: LLMRequestAttemptEvent[] = [], errors: unknown[] = []
    ctx.onRequestAttempt = event => { attempts.push(event) }
    const fetchMock = vi.fn(async () => {
      await raw.append({ id: 'evidence-during-failed-fetch', role: 'assistant', content: 'New child terminal evidence' }, scope)
      throw new Error('EVAL_CUMULATIVE_INPUT_LIMIT')
    })
    vi.stubGlobal('fetch', fetchMock)
    const adapter = new AnthropicAdapter('fixture-anthropic', 'fixture-key', 'http://fixture.invalid/anthropic')
    llm = new RetryingAdapter({ ...llm, stream: async function* (messages, options) {
      try { yield* adapter.stream(messages, options) } catch (error) { errors.push(error); throw error }
    } }, { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1 })
    await run(async () => {})
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(errors).toHaveLength(2)
    expect(errors[0]).toBeInstanceOf(APIConnectionError)
    expect((errors[0] as Error).cause).toMatchObject({ message: 'EVAL_CUMULATIVE_INPUT_LIMIT' })
    expect(errors[1]).toBeInstanceOf(RequestHistoryChangedError)
    expect(attempts.map(event => event.type)).toEqual(['start', 'finish'])
    expect(attempts[1]).toMatchObject({ outcome: 'failed' })
    expect(outcomes.at(-1)?.status).toBe('failed')
    expect(outcomes.at(-1)?.error?.message).toContain('changed after request budgeting')
  })

  it('does not refresh or dispatch after cancellation', async () => {
    let snapshots = 0
    await run(async () => { snapshots++; controller.abort(new Error('cancel during budgeting')) })
    expect(snapshots).toBe(1)
    expect(requests).toHaveLength(0)
    expect(observedUsages).toHaveLength(0)
    expect(outcomes.at(-1)?.status).toBe('cancelled')
  })

  it('does not treat a replaced admitted input as a recoverable history update', async () => {
    let snapshots = 0
    await run(async () => { snapshots++; await raw.updateMessageContent(ctx.userMessageId!, scope.tenantId, 'Unauthorized replacement', 1) })
    expect(snapshots).toBe(1)
    expect(requests).toHaveLength(0)
    expect(observedUsages).toHaveLength(0)
    expect(outcomes.at(-1)?.status).toBe('failed')
    expect(outcomes.at(-1)?.error?.message).not.toContain('changed after request budgeting')
  })
})
