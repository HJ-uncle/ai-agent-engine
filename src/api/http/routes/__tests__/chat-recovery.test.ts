import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as database from '../../../../storage/sqlite/db.js'
import { up as createTodoTables } from '../../../../storage/sqlite/migrations/006_add_todos_cron.js'
import { rootRunStore, type RootRunStatus } from '../../../../storage/root-runs/index.js'
import { createConversationHistory } from '../../../../storage/conversation/factory.js'
import { TodoStore } from '../../../../storage/todo/index.js'
import { ChangeStore } from '../../../../storage/changes/index.js'
import { hashFileContent } from '../../../../shared/file-version.js'
import { StreamBus, activeStreams } from '../../../../core/stream-pipeline/stream-bus.js'
import { ReActStrategy } from '../../../../core/agent-loop/index.js'
import { chatRoutes, registerActiveChat, unregisterActiveChat, waitForPriorToolBatch } from '../chat.js'

const tenantId = 'd4-recovery-tenant'
const sessionId = 'd4-recovery-session'
const ctx = { tenantId, sessionId }
let fixture: string
let db: Client
let app: FastifyInstance
let baseUrl: string
let history: ReturnType<typeof createConversationHistory>
let todos: TodoStore
let changes: ChangeStore
let buses: StreamBus[]

beforeEach(async () => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-d4-recovery-'))
  vi.stubEnv('DATA_DIR', path.join(fixture, 'agent.db'))
  vi.stubEnv('HISTORY_BACKEND', 'jsonl')
  db = createClient({ url: 'file::memory:' })
  vi.spyOn(database, 'getDb').mockReturnValue(db)
  await createTodoTables(db)
  history = createConversationHistory()
  todos = new TodoStore()
  changes = new ChangeStore()
  buses = []
  app = Fastify()
  app.decorateRequest('authContext', null)
  app.addHook('onRequest', async request => {
    Object.assign(request, { authContext: { tenantId: request.headers['x-tenant'] ?? tenantId } })
  })
  await app.register(chatRoutes)
  baseUrl = await app.listen({ host: '127.0.0.1', port: 0 })
})

afterEach(async () => {
  for (const bus of buses) {
    if (bus.disconnectTimeout) clearTimeout(bus.disconnectTimeout)
    bus.abortController.abort()
    bus.end()
    unregisterActiveChat(tenantId, sessionId, bus.abortController)
  }
  activeStreams.delete(`${tenantId}:${sessionId}`)
  await app?.close()
  db?.close()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  if (path.dirname(fixture) !== path.resolve(os.tmpdir()) || !path.basename(fixture).startsWith('aether-d4-recovery-')) {
    throw new Error('Unsafe fixture cleanup path')
  }
  fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
})

async function seedTurn(status: RootRunStatus = 'succeeded', targetTenant = tenantId, targetSession = sessionId) {
  const run = await rootRunStore.create(targetTenant, targetSession, 'fixture-model', [fixture], {})
  const targetCtx = { tenantId: targetTenant, sessionId: targetSession }
  const userMessage = { id: run.userMessageId, role: 'user' as const, content: 'Inspect this attachment',
    conversationId: run.turnId, metadata: { attachments: [{ name: 'docs/设计.md', type: 'text/markdown' }] } }
  const assistantMessage = { id: run.assistantMessageId, role: 'assistant' as const, content: 'Saved final text',
    conversationId: run.turnId }
  await history.append(userMessage, targetCtx)
  await history.append(assistantMessage, targetCtx)
  return (await rootRunStore.update(targetTenant, run.runId, { status }))!
}

function attachBus(options: ConstructorParameters<typeof StreamBus>[1] = {}) {
  const bus = new StreamBus(new AbortController(), options)
  buses.push(bus)
  activeStreams.set(`${tenantId}:${sessionId}`, bus)
  return bus
}

async function snapshot(targetSession = sessionId, targetTenant = tenantId) {
  const response = await app.inject({ method: 'GET', url: `/chat/snapshot?sessionId=${targetSession}`, headers: { 'x-tenant': targetTenant } })
  expect(response.statusCode, response.body).toBe(200)
  expect(response.json().code).toBe(200)
  return response.json().data
}

async function replay(lastEventId: string, targetTenant = tenantId) {
  // Use a real socket because SSE ServerResponse.setTimeout is not supplied by LightMyRequest.
  const response = await fetch(`${baseUrl}/chat/stream?sessionId=${sessionId}&lastEventId=${encodeURIComponent(lastEventId)}`, {
    headers: { 'x-tenant': targetTenant }, signal: AbortSignal.timeout(5_000),
  })
  return { status: response.status, type: response.headers.get('content-type'), body: await response.text() }
}

describe('D4 chat snapshot and replay HTTP contract', () => {
  it('does not impose a 30 second answer wait on durable Code tool batches', async () => {
    vi.useFakeTimers()
    try {
      const bus = attachBus()
      const waiting = waitForPriorToolBatch(bus, 'code')
      await vi.advanceTimersByTimeAsync(30_001)

      let settled = false
      void waiting.then(() => { settled = true })
      await Promise.resolve()
      expect(settled).toBe(false)

      bus.end()
      await expect(waiting).resolves.toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the bounded answer wait for interactive profiles', async () => {
    vi.useFakeTimers()
    try {
      const bus = attachBus()
      const waiting = waitForPriorToolBatch(bus, 'chat')
      const rejected = expect(waiting).rejects.toMatchObject({ statusCode: 409 })
      await vi.advanceTimersByTimeAsync(30_001)
      await rejected
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns an explicit empty persisted snapshot without creating a run', async () => {
    expect(await snapshot()).toMatchObject({ schemaVersion: 1, source: 'persisted', sessionId,
      eventId: null, finished: true, projection: [], runs: [], history: [], todos: [], changes: [] })
    expect(await rootRunStore.list(tenantId, sessionId)).toEqual([])
    expect((await app.inject('/chat/snapshot')).statusCode).toBe(400)
  })

  it('reopens ended conversations with persisted turns, attachment references, todos and file changes', async () => {
    const first = await seedTurn()
    const latest = await seedTurn('failed')
    const todo = await todos.create(tenantId, { sessionId, title: 'Finish tests', status: 'in_progress' })
    const file = path.join(fixture, 'modified.txt')
    fs.writeFileSync(file, 'new contents')
    const change = await changes.record(tenantId, { sessionId, turnId: latest.turnId, runId: latest.runId,
      path: file, kind: 'write', oldContent: 'old contents', newContent: 'new contents',
      oldHash: hashFileContent('old contents'), newHash: hashFileContent('new contents') })

    const state = await snapshot()

    expect(state).toMatchObject({ source: 'persisted', eventId: null, finished: true, projection: [], run: latest })
    expect(state.runs.map((run: { runId: string }) => run.runId)).toEqual([first.runId, latest.runId])
    expect(state.history.map((message: { id: string }) => message.id)).toEqual([
      first.userMessageId, first.assistantMessageId, latest.userMessageId, latest.assistantMessageId,
    ])
    expect(state.history[2].metadata.attachments).toEqual([{ name: 'docs/设计.md', type: 'text/markdown' }])
    expect(state.todos).toEqual([todo])
    expect(state.changes).toEqual([change])
    expect(fs.readFileSync(file, 'utf8')).toBe('new contents')
    // A second read is observational; it neither starts a new turn nor duplicates history.
    expect(await snapshot()).toEqual(state)
  })

  it('recovers pending approval after the in-memory stream has gone without claiming its answer', async () => {
    const run = await seedTurn('running')
    const waiting = await rootRunStore.pending(tenantId, run.runId, {
      requestId: 'approval-request', toolCallId: 'command-tool', toolName: 'execute_cmd',
      kind: 'permission', args: { command: 'node', args: ['--version'] }, description: 'Confirm command',
    })
    const state = await snapshot()
    expect(state).toMatchObject({ source: 'persisted', eventId: null, finished: true,
      run: { status: 'waiting', pending: [{ requestId: 'approval-request', status: 'pending' }] } })
    expect(state.run).toEqual(waiting)
    expect((await rootRunStore.get(tenantId, run.runId))?.pending[0].status).toBe('pending')
  })

  it('preserves interrupted terminal outcomes after restart instead of presenting a resumable stream', async () => {
    const run = await seedTurn('running')
    await rootRunStore.update(tenantId, run.runId, { status: 'interrupted',
      stopReason: 'Engine restarted; execution was not resumed',
      error: { code: 'ENGINE_RESTARTED', message: 'Engine restarted', retryable: false } })
    expect(await snapshot()).toMatchObject({ source: 'persisted', eventId: null, finished: true,
      run: { runId: run.runId, status: 'interrupted', error: { code: 'ENGINE_RESTARTED', retryable: false } } })
    const response = await replay('retired-process:7')
    expect(response.status).toBe(409)
    expect(JSON.parse(response.body)).toMatchObject({ code: 40902, message: 'snapshot_required' })
  })

  it('scopes every persisted collection and live stream by tenant and session', async () => {
    const owned = await seedTurn()
    await seedTurn('succeeded', 'other-tenant')
    await seedTurn('succeeded', tenantId, 'other-session')
    await todos.create(tenantId, { sessionId: 'other-session', title: 'other session secret' })
    await todos.create('other-tenant', { sessionId, title: 'other tenant secret' })
    await changes.record('other-tenant', { sessionId, path: path.join(fixture, 'private.txt'), kind: 'write',
      oldContent: null, newContent: 'secret', oldHash: 'missing', newHash: hashFileContent('secret') })
    const bus = attachBus()
    bus.push('\x00__run__' + JSON.stringify(owned))
    bus.push('private live content')
    bus.end()

    const state = await snapshot()
    expect(state.runs).toEqual([owned])
    expect(state.history).toHaveLength(2)
    expect(state.todos).toEqual([])
    expect(state.changes).toEqual([])
    const unknown = await snapshot(sessionId, 'unknown-tenant')
    expect(unknown).toMatchObject({ source: 'persisted', runs: [], history: [], todos: [], changes: [], projection: [] })
    expect(JSON.stringify(unknown)).not.toContain('private')
    expect((await replay(bus.events.at(-1)!.id, 'unknown-tenant')).status).toBe(409)
  })

  it('pairs a live projection with its exact cursor and replays only later tool/result/terminal frames', async () => {
    const run = await seedTurn('running')
    const bus = attachBus()
    bus.push('\x00__run__' + JSON.stringify(run))
    bus.push('\x00__thinking__Inspecting the file')
    bus.push('\x00__tool_start__' + JSON.stringify({ toolCallId: 'read-1', name: 'read_file' }))
    bus.push('\x00__tool_args__' + JSON.stringify({ toolCallId: 'read-1', args: '{"path":"hello.txt"}' }))
    const boundary = bus.events.at(-1)!.id

    const state = await snapshot()
    expect(state).toMatchObject({ source: 'live', eventId: boundary, finished: false, run })
    expect(state.projection).toEqual(expect.arrayContaining([
      { run }, { thinking: 'Inspecting the file' },
      { toolStart: { toolCallId: 'read-1', name: 'read_file' } },
      { toolArgs: { toolCallId: 'read-1', args: '{"path":"hello.txt"}' } },
    ]))
    bus.push('\x00__tool_result__' + JSON.stringify({ toolCallId: 'read-1', name: 'read_file', output: 'hello' }))
    bus.push('Answer after recovery')
    const terminal = await rootRunStore.update(tenantId, run.runId, { status: 'succeeded' })
    bus.push('\x00__run__' + JSON.stringify(terminal))
    const expectedIds = bus.events.slice(bus.events.findIndex(event => event.id === boundary) + 1).map(event => event.id)
    bus.end()

    const response = await replay(state.eventId)
    expect(response.status, response.body).toBe(200)
    expect(response.type).toContain('text/event-stream')
    const replayedIds = [...response.body.matchAll(/^id: (.+)$/gm)].map(match => match[1])
    expect(replayedIds).toEqual(expectedIds)
    expect(response.body).toContain('"toolResult"')
    expect(response.body).toContain('Answer after recovery')
    expect(response.body).toContain('"status":"succeeded"')
    expect(response.body).toContain('event: done')
    expect(response.body).not.toContain('Inspecting the file')
    expect(response.body).not.toContain('"toolStart"')
  })

  it('rejects unknown cursors before SSE begins instead of silently replaying the entire turn', async () => {
    const run = await seedTurn()
    const bus = attachBus()
    bus.push('\x00__run__' + JSON.stringify(run))
    bus.push('Already consumed content')
    bus.end()
    const response = await replay('different-stream:1')
    expect(response.status).toBe(409)
    expect(response.type).toContain('application/json')
    expect(JSON.parse(response.body)).toMatchObject({ code: 40902, message: 'snapshot_required' })
    expect(response.body).not.toContain('Already consumed content')
  })

  it('requires a new snapshot when the consumed cursor has fallen outside bounded replay', async () => {
    const run = await seedTurn()
    const bus = attachBus({ maxReplayEvents: 2 })
    bus.push('\x00__run__' + JSON.stringify(run))
    bus.push('first ')
    const expiredCursor = bus.events.at(-1)!.id
    bus.push('second ')
    bus.push('third ')
    bus.push('fourth')
    bus.end()

    const stale = await replay(expiredCursor)
    expect(stale.status).toBe(409)
    expect(JSON.parse(stale.body)).toMatchObject({ code: 40902, message: 'snapshot_required' })
    const fresh = await snapshot()
    expect(fresh.projection).toContainEqual({ content: 'first second third fourth' })
    expect(fresh.eventId).toBe(bus.events.at(-1)!.id)
    const completed = await replay(fresh.eventId)
    expect(completed.status).toBe(200)
    expect(completed.body).toContain('event: done')
    expect(completed.body).not.toContain('first')
  })

  it('keeps live root state at the projection watermark when persistence has advanced ahead of delivery', async () => {
    const delivered = await seedTurn('running')
    const bus = attachBus()
    bus.push('\x00__run__' + JSON.stringify(delivered))
    const cursor = bus.events.at(-1)!.id
    const persisted = await rootRunStore.pending(tenantId, delivered.runId, {
      requestId: 'not-yet-delivered', toolCallId: 'ask-tool', toolName: 'ask_user', kind: 'ask', args: {},
      question: 'Continue?',
    })
    expect(persisted?.status).toBe('waiting')

    const state = await snapshot()
    expect(state.eventId).toBe(cursor)
    expect(state.run).toEqual(delivered)
    expect(state.runs).toEqual([delivered])
    expect(state.projection).toContainEqual({ run: delivered })
    expect(JSON.stringify(state.projection)).not.toContain('not-yet-delivered')
  })

  it('cancels server execution and exposes its outcome without invoking the agent or model again', async () => {
    const run = await seedTurn('running')
    const bus = attachBus()
    bus.push('\x00__run__' + JSON.stringify(run))
    registerActiveChat(tenantId, sessionId, bus.abortController)
    const execute = vi.spyOn(ReActStrategy.prototype, 'run')
    const cancel = await app.inject({ method: 'POST', url: '/chat/cancel', payload: { sessionId } })
    expect(cancel.json()).toMatchObject({ code: 200, data: { cancelled: true } })
    expect(bus.abortController.signal.aborted).toBe(true)
    expect((await rootRunStore.get(tenantId, run.runId))?.status).toBe('cancelled')
    const state = await snapshot()
    expect(state.run).toMatchObject({ runId: run.runId, status: 'cancelled' })
    expect(execute).not.toHaveBeenCalled()
    expect(await rootRunStore.list(tenantId, sessionId)).toHaveLength(1)
    expect(await history.getFullHistory(ctx)).toHaveLength(2)
  })

  it('cancels a waiting run after SSE finished and advances the snapshot to the persisted terminal outcome', async () => {
    const run = await seedTurn('running')
    const waiting = await rootRunStore.pending(tenantId, run.runId, {
      requestId: 'finished-wait', toolCallId: 'finished-ask', toolName: 'ask_user', kind: 'ask', args: {}, question: 'Continue?',
    })
    const bus = attachBus()
    bus.push('\x00__run__' + JSON.stringify(waiting))
    bus.push('\x00__ask_user__' + JSON.stringify({ toolCallId: 'finished-ask', requestId: 'finished-wait', question: 'Continue?' }))
    bus.end()
    const before = await snapshot()
    expect(before).toMatchObject({ finished: true, run: { status: 'waiting' } })

    const response = await app.inject({ method: 'POST', url: '/chat/cancel', payload: { sessionId } })

    expect(response.json()).toMatchObject({ code: 200, data: { cancelled: true } })
    expect((await rootRunStore.get(tenantId, run.runId))?.status).toBe('cancelled')
    const after = await snapshot()
    expect(after).toMatchObject({ finished: true, run: { runId: run.runId, status: 'cancelled' } })
    expect(after.eventId).not.toBe(before.eventId)
    expect(after.projection.some((payload: { ask_user?: unknown; permissionRequest?: unknown }) => payload.ask_user || payload.permissionRequest)).toBe(false)
    const status = await app.inject(`/chat/status?sessionId=${sessionId}`)
    expect(status.json()).toMatchObject({ code: 200, data: { running: false, finished: true, run: { status: 'cancelled' } } })
  })

  it('does not resurrect a deleted turn from a retained bus or replay its old frames', async () => {
    const run = await seedTurn()
    const bus = attachBus()
    bus.push('\x00__run__' + JSON.stringify(run))
    bus.push('deleted turn secret')
    const cursor = bus.events.at(-1)!.id
    bus.end()
    // Model the completed destructive history operation while its old cache has not yet expired.
    await rootRunStore.deleteTurns(tenantId, sessionId, [run.turnId])
    await history.clear(ctx, { tombstone: false })

    // Test stream admission before snapshot has a chance to evict the stale bus.
    const response = await replay(cursor)
    expect(response.status).toBe(409)
    expect(JSON.parse(response.body)).toMatchObject({ code: 40902, message: 'snapshot_required' })
    expect(response.body).not.toContain('deleted turn secret')
    // The snapshot must independently ignore the retained cache as well.
    activeStreams.set(`${tenantId}:${sessionId}`, bus)
    const state = await snapshot()

    expect(state).toMatchObject({ source: 'persisted', eventId: null, projection: [], runs: [], history: [] })
    expect(state.run).toBeUndefined()
    expect(JSON.stringify(state)).not.toContain('deleted turn secret')
  })
})
