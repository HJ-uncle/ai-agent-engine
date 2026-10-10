import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDb, getDb, initDb } from '../../../../storage/sqlite/db.js'
import type { LocalSqliteProcessClient } from '../../../../storage/sqlite/local-process-client.js'
import { closeMemoryDb } from '../../../../storage/memory/db.js'
import { ModelsStore } from '../../../../storage/sqlite/models.js'
import { createConversationHistory } from '../../../../storage/conversation/factory.js'
import { rootRunStore, type RootRun } from '../../../../storage/root-runs/index.js'
import { ReActStrategy } from '../../../../core/agent-loop/index.js'
import * as compactPrompt from '../../../../core/agent-loop/compact-prompt.js'
import { activeStreams } from '../../../../core/stream-pipeline/stream-bus.js'
import { SubagentStore } from '../../../../core/subagent/store.js'
import type { SubagentEvent } from '../../../../core/subagent/types.js'
import type { AgentContext, Message } from '../../../../core/agent-context/types.js'
import { chatRoutes, unregisterActiveChat } from '../chat.js'

vi.hoisted(() => { process.env.ENCRYPTION_KEY = 'd8'.repeat(32) })
const tenantId = 'compaction-progress-tenant', sessionId = 'compaction-progress-session'
const ctx = { tenantId, sessionId }
type StoredMessage = Message & { conversationId?: string }
type Frame = { id: string; payload: { run?: RootRun; content?: string; [key: string]: unknown } }
let fixture: string, base: string, app: FastifyInstance
let history: ReturnType<typeof createConversationHistory>
let release: ReturnType<typeof deferred>
let entered: ReturnType<typeof deferred>
let beforeCompression: Message[]
const model = 'compaction-fixture-model'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

beforeEach(async () => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-compaction-progress-'))
  for (const [key, value] of Object.entries({ DATA_DIR: path.join(fixture, 'agent.db'), MEMORY_DB_PATH: path.join(fixture, 'memory.db'),
    MCP_CONFIG_PATH: path.join(fixture, 'mcp.json'), AETHER_GLOBAL_DIR: path.join(fixture, 'global'), SKILLS_ROOT: path.join(fixture, 'skills'),
    WORKSPACE_ROOT: fixture, ENABLE_LONG_TERM_MEMORY: 'false', HISTORY_BACKEND: 'jsonl', LLM_PRIMARY_MODEL: model,
    OPENAI_API_KEY: '', LLM_SUMMARIZE_MODEL: '', LLM_FALLBACK_MODEL: '', QA_LOG_ENABLED: 'false', AUTO_COMPACT_THRESHOLD_RATIO: '0.92' })) vi.stubEnv(key, value)
  fs.mkdirSync(path.join(fixture, 'skills'))
  await initDb()
  await new ModelsStore().createModel({ tenantId, modelId: model, provider: 'custom', apiKey: 'synthetic-progress-key',
    baseUrl: 'https://progress.invalid/v1', isEnabled: true, capabilities: { contextWindow: 100_000 } })
  history = createConversationHistory()
  for (let index = 0; index < 8; index++) await history.append({ id: `original-${index}`, role: index % 2 ? 'assistant' : 'user',
    content: `Original requirement ${index}; keep the earlier verified constraint. `.repeat(24), modelId: model }, ctx)
  release = deferred()
  entered = deferred()
  beforeCompression = []
  app = Fastify()
  app.decorateRequest('authContext', null)
  app.addHook('onRequest', async request => { Object.assign(request, { authContext: { tenantId } }) })
  await app.register(chatRoutes)
  base = await app.listen({ host: '127.0.0.1', port: 0 })
})

afterEach(async () => {
  release?.resolve()
  const bus = activeStreams.get(`${tenantId}:${sessionId}`)
  if (bus?.disconnectTimeout) clearTimeout(bus.disconnectTimeout)
  bus?.abortController.abort(); bus?.end()
  if (bus) unregisterActiveChat(tenantId, sessionId, bus.abortController)
  activeStreams.delete(`${tenantId}:${sessionId}`)
  await app?.close()
  const db = getDb() as LocalSqliteProcessClient
  closeDb()
  await Promise.all([closeMemoryDb(), db.whenClosed()])
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (path.dirname(fixture) !== path.resolve(os.tmpdir()) || !path.basename(fixture).startsWith('aether-compaction-progress-')) throw new Error('Unsafe compaction fixture cleanup')
  fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

function collectStream(response: Response) {
  const frames: Frame[] = [], changed = new EventEmitter(), decoder = new TextDecoder()
  let raw = '', finished = false
  const complete = (async () => {
    const reader = response.body!.getReader()
    let pending = ''
    while (true) {
      const result = await reader.read()
      if (result.done) break
      const text = decoder.decode(result.value, { stream: true })
      raw += text
      pending += text
      while (pending.includes('\n\n')) {
        const boundary = pending.indexOf('\n\n')
        const event = pending.slice(0, boundary)
        pending = pending.slice(boundary + 2)
        const data = event.split('\n').find(line => line.startsWith('data: '))?.slice(6)
        if (data?.startsWith('{')) frames.push({ id: event.split('\n').find(line => line.startsWith('id: '))?.slice(4) ?? '', payload: JSON.parse(data) })
        changed.emit('frame')
      }
    }
    finished = true
    changed.emit('frame')
    return raw
  })()
  // Observe rejection even when a failed assertion exits before awaiting completion.
  void complete.catch(() => {})
  const waitFor = (predicate: (frame: Frame) => boolean, timeout = 2_000): Promise<Frame> => {
    const existing = frames.find(predicate)
    if (existing) return Promise.resolve(existing)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error('Expected SSE frame was not delivered while compression remained pending')) }, timeout)
      const cleanup = () => { clearTimeout(timer); changed.off('frame', check) }
      const check = () => {
        const matching = frames.find(predicate)
        if (matching) { cleanup(); resolve(matching) }
        else if (finished) { cleanup(); reject(new Error('SSE finished before the expected compression progress')) }
      }
      changed.on('frame', check)
      check()
    })
  }
  return { frames, complete, waitFor, get finished() { return finished }, get raw() { return raw } }
}

async function startChat() {
  const response = await fetch(base + '/chat', { method: 'POST', headers: { 'content-type': 'application/json', 'x-aether-tool-profile': 'code' },
    body: JSON.stringify({ message: 'Continue the verified task.', model, sessionId, skills: [], mcpServers: [], knowledgeBases: [], memoryScope: 'off' }),
    signal: AbortSignal.timeout(15_000) })
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toContain('text/event-stream')
  return collectStream(response)
}

async function assertLiveRecovery(original: ReturnType<typeof collectStream>) {
  await entered.promise
  const running = await original.waitFor(frame => frame.payload.run?.compaction?.phase === 'running')
  expect(original.finished).toBe(false)
  const initialRun = original.frames.find(frame => frame.payload.run && !frame.payload.run.compaction)!
  const response = await fetch(`${base}/chat/snapshot?sessionId=${sessionId}`, { signal: AbortSignal.timeout(2_000) })
  const snapshot = (await response.json()).data
  expect(snapshot).toMatchObject({ source: 'live', finished: false, run: { runId: running.payload.run!.runId, compaction: { phase: 'running' } } })
  expect(snapshot.projection).toEqual(expect.arrayContaining([expect.objectContaining({ run: expect.objectContaining({ compaction: expect.objectContaining({ phase: 'running' }) }) })]))
  expect(snapshot.history.some((message: Message) => message.id === 'original-0')).toBe(true)
  // Replay from before the running notification; reconnect must not wait for history.compress's tenant lock.
  const reconnectAbort = new AbortController()
  const reconnectTimer = setTimeout(() => reconnectAbort.abort(new Error('Reconnect waited for compression instead of returning its running state')), 2_000)
  let resumed: Response
  try {
    resumed = await fetch(`${base}/chat/stream?sessionId=${sessionId}&lastEventId=${encodeURIComponent(initialRun.id)}`,
      { signal: AbortSignal.any([reconnectAbort.signal, AbortSignal.timeout(15_000)]) })
  } finally { clearTimeout(reconnectTimer) }
  expect(resumed.status).toBe(200)
  const replay = collectStream(resumed)
  await replay.waitFor(frame => frame.payload.run?.compaction?.phase === 'running')
  expect(replay.finished).toBe(false)
  return { running, snapshot, replay }
}

async function persistAnswer(agentCtx: AgentContext) {
  await agentCtx.history.append({ id: agentCtx.assistantMessageId, role: 'assistant', content: 'Verified task completed.',
    conversationId: agentCtx.turnId } as StoredMessage, agentCtx)
  await agentCtx.runObserver?.onOutcome?.({ status: 'succeeded', stopReason: 'completed' })
}

async function assertTerminal(original: ReturnType<typeof collectStream>, replay: ReturnType<typeof collectStream>, phase: 'succeeded' | 'failed') {
  const body = await original.complete
  const replayed = await replay.complete
  expect(body).toContain('event: done')
  expect(replayed).toContain('event: done')
  expect(body).not.toContain('[System Error:')
  const state = (await rootRunStore.list(tenantId, sessionId)).at(-1)!
  expect(state).toMatchObject({ status: 'succeeded', compaction: { phase, startedAt: expect.any(Number), finishedAt: expect.any(Number) } })
  expect(state.error).toBeUndefined()
  activeStreams.delete(`${tenantId}:${sessionId}`)
  const snapshot = (await (await fetch(`${base}/chat/snapshot?sessionId=${sessionId}`, { signal: AbortSignal.timeout(2_000) })).json()).data
  expect(snapshot).toMatchObject({ source: 'persisted', run: { runId: state.runId, status: 'succeeded', compaction: { phase } } })
  if (phase === 'failed') {
    expect(state.compaction?.error).toContain('Synthetic provider rejected compression')
    const actual = await history.getFullHistory(ctx)
    expect(actual.filter(message => message.id?.startsWith('original-'))).toEqual(beforeCompression.filter(message => message.id?.startsWith('original-')))
    expect(actual.some(message => message.metadata?.isCompactSummary)).toBe(false)
    const archived = (await history.getArchive!(ctx)).messages
    expect(archived.filter(message => message.id?.startsWith('original-'))).toEqual(beforeCompression.filter(message => message.id?.startsWith('original-')))
  }
}

describe('HTTP automatic compaction progress while the summarizer is pending', () => {
  it('keeps running compaction recoverable when the next chat admission is already waiting for its history lock', async () => {
    const nextAdmission = deferred()
    const createRun = rootRunStore.create.bind(rootRunStore)
    let admissionCount = 0, invocationCount = 0, nextResponseReturned = false
    vi.spyOn(rootRunStore, 'create').mockImplementation(async (...args) => {
      if (++admissionCount === 2) nextAdmission.resolve()
      return createRun(...args)
    })
    vi.spyOn(compactPrompt, 'buildCompactSummarizeFn').mockImplementation(() => async () => {
      entered.resolve()
      await release.promise
      return 'Earlier verified requirements are retained.'
    })
    vi.spyOn(ReActStrategy.prototype, 'run').mockImplementation(async function* (_prompt, agentCtx) {
      const invocation = ++invocationCount
      await agentCtx.history.append({ id: agentCtx.userMessageId, role: 'user', content: `Verified task round ${invocation}.`,
        conversationId: agentCtx.turnId } as StoredMessage, agentCtx)
      await persistAnswer(agentCtx)
      yield '\x00__usage__' + JSON.stringify({ currentPromptTokens: invocation === 1 ? 95_000 : 1_000, contextWindow: 100_000, modelId: model })
      yield `Verified task completed round ${invocation}.`
    })
    const original = await startChat()
    await entered.promise
    await original.waitFor(frame => frame.payload.run?.compaction?.phase === 'running')
    const queued = startChat().then(stream => { nextResponseReturned = true; return stream })
    await nextAdmission.promise
    expect(nextResponseReturned).toBe(false)
    expect(invocationCount).toBe(1)
    const { running, replay } = await assertLiveRecovery(original)
    expect(running.payload.run?.status).toBe('succeeded')
    expect(nextResponseReturned).toBe(false)
    release.resolve()
    expect(await original.complete).toContain('event: done')
    expect(await replay.complete).toContain('event: done')
    const next = await queued
    expect(await next.complete).toContain('Verified task completed round 2.')
    const runs = await rootRunStore.list(tenantId, sessionId)
    expect(runs).toHaveLength(2)
    expect(runs[0]).toMatchObject({ status: 'succeeded', compaction: { phase: 'succeeded' } })
    expect(runs[1]).toMatchObject({ status: 'succeeded' })
    expect(runs[1].compaction).toBeUndefined()
    expect(invocationCount).toBe(2)
  }, 20_000)

  it('recovers an evicted child at its published watermark while compression is pending without exposing future state or billing', async () => {
    const children = new SubagentStore()
    let published!: SubagentEvent
    let future!: SubagentEvent
    vi.spyOn(ReActStrategy.prototype, 'run').mockImplementation(async function* (_prompt, agentCtx) {
      await agentCtx.history.append({ id: agentCtx.userMessageId, role: 'user', content: 'Continue the verified task.', conversationId: agentCtx.turnId } as StoredMessage, agentCtx)
      const created = await children.createRun({ tenantId, rootSessionId: sessionId, parentSessionId: sessionId,
        parentConversationId: agentCtx.turnId!, parentMessageId: agentCtx.assistantMessageId!, parentToolCallId: 'watermark-child',
        task: 'Review the ongoing development task.', description: 'Published reviewer state', modelId: model })
      await children.appendSnapshot(tenantId, created.runId, 'started', { status: 'running', startedAt: Date.now() })
      published = (await children.recordUsage(tenantId, created.runId, { invocationId: 'delivered-call', promptTokens: 10, completionTokens: 2 }))!
      yield '\x00__subagent_event__' + JSON.stringify(published)
      // Durable child progress is deliberately ahead of what the parent delivered.
      await children.recordUsage(tenantId, created.runId, { invocationId: 'undelivered-call', promptTokens: 2_000, completionTokens: 500 })
      future = (await children.appendSnapshot(tenantId, created.runId, 'finished', { status: 'succeeded', finishedAt: Date.now(),
        resultSummary: 'Future child result must not leak before its event is published.' }))!
      // A heavy developer session evicts the child transcript slot, but keeps its sequence watermark.
      for (let index = 0; index < 4_200; index++) {
        yield '\x00__file_change__' + JSON.stringify({ id: `heavy-session-change-${index}` })
        // A real long task yields to socket delivery; flooding one microtask would test subscriber overflow instead of transcript eviction.
        if (index % 100 === 0) await new Promise<void>(resolve => setImmediate(resolve))
      }
      const startedAt = Date.now()
      await agentCtx.runObserver?.onCompaction?.({ phase: 'running', startedAt, beforeTokens: 4_000 })
      const stats = await agentCtx.history.compress(agentCtx, async () => {
        entered.resolve()
        await release.promise
        return 'Earlier verified requirements are retained.'
      }, 6)
      await agentCtx.runObserver?.onCompaction?.({ phase: 'succeeded', startedAt, finishedAt: Date.now(), beforeTokens: stats.preTokens, afterTokens: stats.postTokens })
      await persistAnswer(agentCtx)
      yield 'Verified task completed.'
    })
    const original = await startChat()
    await entered.promise
    await original.waitFor(frame => frame.payload.run?.compaction?.phase === 'running')
    expect(original.finished).toBe(false)
    const response = await fetch(`${base}/chat/snapshot?sessionId=${sessionId}`, { signal: AbortSignal.timeout(2_000) })
    const snapshot = (await response.json()).data
    expect(snapshot).toMatchObject({ source: 'live', finished: false, projectionTruncated: true, run: { compaction: { phase: 'running' } } })
    expect(snapshot.projection.some((frame: { subagentEvent?: SubagentEvent }) => frame.subagentEvent?.runId === published.runId)).toBe(false)
    expect(snapshot.subagentWatermarks).toContainEqual({ runId: published.runId, seq: published.seq })
    expect(snapshot.subagentRuns).toEqual([published.snapshot])
    expect(snapshot.sessionSubagentUsage).toEqual({ totalTokens: 12, count: 1, unknown: 0 })
    expect(future.seq).toBeGreaterThan(published.seq)
    expect(future.snapshot).toMatchObject({ status: 'succeeded', usage: { totalTokens: 2_512 } })
    expect(JSON.stringify(snapshot)).not.toContain('Future child result must not leak')
    expect(snapshot.subagentRuns[0].status).toBe('running')
    release.resolve()
    expect(await original.complete).toContain('event: done')
    expect((await rootRunStore.list(tenantId, sessionId)).at(-1)).toMatchObject({ status: 'succeeded', compaction: { phase: 'succeeded' } })
  }, 20_000)

  it.each(['succeeded', 'failed'] as const)('publishes in-loop progress before model output and restores live and persisted %s state', async phase => {
    vi.spyOn(ReActStrategy.prototype, 'run').mockImplementation(async function* (_prompt, agentCtx) {
      await agentCtx.history.append({ id: agentCtx.userMessageId, role: 'user', content: 'Continue the verified task.', conversationId: agentCtx.turnId } as StoredMessage, agentCtx)
      beforeCompression = await agentCtx.history.getFullHistory(agentCtx)
      const startedAt = Date.now()
      await agentCtx.runObserver?.onCompaction?.({ phase: 'running', startedAt, beforeTokens: 4_000 })
      try {
        const stats = await agentCtx.history.compress(agentCtx, async () => {
          entered.resolve()
          await release.promise
          if (phase === 'failed') throw new Error('Synthetic provider rejected compression')
          return 'Earlier verified requirements are retained.'
        }, 6)
        await agentCtx.runObserver?.onCompaction?.({ phase: 'succeeded', startedAt, finishedAt: Date.now(), beforeTokens: stats.preTokens, afterTokens: stats.postTokens })
      } catch (error) {
        await agentCtx.runObserver?.onCompaction?.({ phase: 'failed', startedAt, finishedAt: Date.now(), error: (error as Error).message })
      }
      await persistAnswer(agentCtx)
      yield '\x00__usage__' + JSON.stringify({ currentPromptTokens: 1_000, contextWindow: 100_000, modelId: model })
      yield 'Verified task completed.'
    })
    const original = await startChat()
    const { replay } = await assertLiveRecovery(original)
    expect(original.raw).not.toContain('Verified task completed.')
    release.resolve()
    await assertTerminal(original, replay, phase)
  }, 20_000)

  it.each(['succeeded', 'failed'] as const)('keeps post-turn maintenance visible and preserves the completed task after %s compression', async phase => {
    vi.spyOn(compactPrompt, 'buildCompactSummarizeFn').mockImplementation(() => async () => {
      entered.resolve()
      await release.promise
      if (phase === 'failed') throw new Error('Synthetic provider rejected compression')
      return 'Earlier verified requirements are retained.'
    })
    vi.spyOn(ReActStrategy.prototype, 'run').mockImplementation(async function* (_prompt, agentCtx) {
      await agentCtx.history.append({ id: agentCtx.userMessageId, role: 'user', content: 'Continue the verified task.', conversationId: agentCtx.turnId } as StoredMessage, agentCtx)
      await persistAnswer(agentCtx)
      beforeCompression = await agentCtx.history.getFullHistory(agentCtx)
      yield '\x00__usage__' + JSON.stringify({ currentPromptTokens: 95_000, contextWindow: 100_000, modelId: model })
      yield 'Verified task completed.'
    })
    const original = await startChat()
    const { running, replay } = await assertLiveRecovery(original)
    expect(running.payload.run?.status).toBe('succeeded')
    expect(original.raw).toContain('Verified task completed.')
    release.resolve()
    await assertTerminal(original, replay, phase)
    if (phase === 'failed') expect(await history.getFullHistory(ctx)).toEqual(beforeCompression)
  }, 20_000)
})
