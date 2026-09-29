import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as database from '../../../../storage/sqlite/db.js'
import { rootRunStore, type RootRun } from '../../../../storage/root-runs/index.js'
import { createConversationHistory } from '../../../../storage/conversation/factory.js'
import { bindHistoryGeneration, withHistoryLock } from '../../../../storage/conversation/serialization.js'
import { conversationRoutes } from '../conversation.js'

const mocks = vi.hoisted(() => ({
  abort: vi.fn(),
  cancelChildren: vi.fn(),
  listChildren: vi.fn(),
  deleteChildren: vi.fn(),
  deleteAllChildren: vi.fn(),
}))

vi.mock('../chat.js', () => ({ abortActiveChat: mocks.abort }))
vi.mock('../subagent.js', () => ({ subagentRoutes: async () => {} }))
vi.mock('../../../../core/subagent/runner.js', () => ({
  getSubagentRunner: () => ({ cancelRunsForParent: mocks.cancelChildren }),
}))
vi.mock('../../../../core/subagent/store.js', () => ({
  getSubagentStore: () => ({
    listRunsForParent: mocks.listChildren,
    deleteRuns: mocks.deleteChildren,
    deleteRunsForParent: mocks.deleteAllChildren,
  }),
}))
vi.mock('../../../../core/subagent/projection.js', () => ({ projectPendingSubagents: async () => {} }))

const tenantId = 'destructive-tenant'
const sessionId = 'parent-session'
const ctx = { tenantId, sessionId }
const pending = {
  requestId: 'approval-1', toolCallId: 'approval-1', toolName: 'execute_cmd',
  kind: 'permission' as const, args: { command: 'node', args: ['--version'] },
}
let fixture: string
let db: Client
let app: FastifyInstance
let history: ReturnType<typeof createConversationHistory>

beforeEach(async () => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-destructive-routes-'))
  vi.stubEnv('DATA_DIR', path.join(fixture, 'agent.db'))
  vi.stubEnv('HISTORY_BACKEND', 'jsonl')
  db = createClient({ url: `file:${path.join(fixture, 'agent.db').replace(/\\/g, '/')}` })
  vi.spyOn(database, 'getDb').mockReturnValue(db)
  for (const mock of Object.values(mocks)) mock.mockReset()
  mocks.cancelChildren.mockResolvedValue(undefined)
  mocks.listChildren.mockResolvedValue([])
  mocks.deleteChildren.mockResolvedValue(undefined)
  mocks.deleteAllChildren.mockResolvedValue(undefined)
  history = createConversationHistory()
  app = Fastify()
  app.decorateRequest('authContext', null)
  app.addHook('onRequest', async request => {
    Object.assign(request, { authContext: { tenantId } })
  })
  await app.register(conversationRoutes)
})

afterEach(async () => {
  await app?.close()
  db?.close()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  if (path.dirname(fixture) !== path.resolve(os.tmpdir()) || !path.basename(fixture).startsWith('aether-destructive-routes-')) {
    throw new Error('Unsafe fixture cleanup path')
  }
  try { fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }) }
  catch (error) {
    if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error
  }
})

async function seedTurn(targetSession = sessionId): Promise<RootRun> {
  const run = await rootRunStore.create(tenantId, targetSession, 'fixture-model', [], {})
  const message = { id: run.userMessageId, role: 'user' as const, content: 'original question', conversationId: run.turnId }
  await history.append(message, { tenantId, sessionId: targetSession })
  await rootRunStore.update(tenantId, run.runId, { status: 'succeeded' })
  return run
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

describe('destructive conversation routes', () => {
  it('deletes the pending root with its turn so the old approval can never be claimed', async () => {
    const run = await rootRunStore.create(tenantId, sessionId, 'fixture-model', [], {})
    const message = { id: run.userMessageId, role: 'user' as const, content: 'run command', conversationId: run.turnId }
    await history.append(message, ctx)
    await rootRunStore.pending(tenantId, run.runId, pending)
    const other = await seedTurn('other-session')

    const response = await app.inject({ method: 'DELETE', url: `/conversation/turns/${run.turnId}?sessionId=${sessionId}` })

    expect(response.json()).toMatchObject({ code: 200, data: { success: true } })
    expect(await history.getFullHistory(ctx)).toEqual([])
    expect(await rootRunStore.get(tenantId, run.runId)).toBeNull()
    await expect(rootRunStore.answer(tenantId, sessionId, run.runId, pending.requestId, pending.toolCallId, pending.toolName, 'approved'))
      .rejects.toMatchObject({ statusCode: 404 })
    expect(await rootRunStore.get(tenantId, other.runId)).toMatchObject({ status: 'succeeded' })
    expect((await history.getFullHistory({ tenantId, sessionId: 'other-session' })).map(message => message.id)).toEqual([other.userMessageId])
  })

  it.each(['turns', 'messages'] as const)('rejects deleting %s without sessionId before cancellation or mutation', async kind => {
    const run = await seedTurn()
    const writer = bindHistoryGeneration(createConversationHistory(), tenantId, sessionId)
    const id = kind === 'turns' ? run.turnId : run.userMessageId

    const response = await app.inject({ method: 'DELETE', url: `/conversation/${kind}/${id}` })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ code: 40001 })
    expect(mocks.abort).not.toHaveBeenCalled()
    expect(mocks.cancelChildren).not.toHaveBeenCalled()
    expect(await rootRunStore.get(tenantId, run.runId)).not.toBeNull()
    await writer.append({ id: 'still-authorized', role: 'assistant', content: 'continued' }, ctx)
    expect((await history.getFullHistory(ctx)).map(message => message.id)).toEqual([run.userMessageId, 'still-authorized'])
  })

  it.each([
    ['turn', false], ['message', false], ['truncate', false],
    ['turn', true], ['message', true], ['truncate', true],
  ] as const)('%s rejects an invalid target (mismatched session: %s) without invalidating either writer', async (kind, mismatched) => {
    const run = await seedTurn()
    const other = await seedTurn('other-session')
    const suppliedSession = mismatched ? 'other-session' : sessionId
    const target = mismatched ? (kind === 'turn' ? run.turnId : run.userMessageId) : 'missing-id'
    const writers = [sessionId, 'other-session'].map(id => bindHistoryGeneration(createConversationHistory(), tenantId, id))

    const response = await app.inject(kind === 'truncate'
      ? { method: 'POST', url: '/conversation/truncate', payload: { sessionId: suppliedSession, messageId: target } }
      : { method: 'DELETE', url: `/conversation/${kind === 'turn' ? 'turns' : 'messages'}/${target}?sessionId=${suppliedSession}` })

    // Some legacy not-found paths use HTTP 200 with the standard business error envelope.
    expect(response.json()).toMatchObject({ code: 40400 })
    expect(mocks.abort).not.toHaveBeenCalled()
    expect(mocks.cancelChildren).not.toHaveBeenCalled()
    expect(await rootRunStore.get(tenantId, run.runId)).not.toBeNull()
    expect(await rootRunStore.get(tenantId, other.runId)).not.toBeNull()
    for (const [index, id] of [sessionId, 'other-session'].entries()) {
      await writers[index].append({ id: `continued-${index}`, role: 'assistant', content: 'continued' }, { tenantId, sessionId: id })
    }
    expect((await history.getFullHistory(ctx)).map(message => message.id)).toEqual([run.userMessageId, 'continued-0'])
    expect((await history.getFullHistory({ tenantId, sessionId: 'other-session' })).map(message => message.id)).toEqual([other.userMessageId, 'continued-1'])
  })

  it.each(['clear', 'truncate'] as const)('%s blocks new claims during child cancellation and invalidates producers again at final deletion', async kind => {
    const run = await seedTurn()
    const oldWriter = bindHistoryGeneration(createConversationHistory(), tenantId, sessionId)
    const entered = deferred()
    const release = deferred()
    mocks.cancelChildren.mockImplementationOnce(async () => { entered.resolve(); await release.promise })
    const responsePromise = app.inject(kind === 'clear'
      ? { method: 'DELETE', url: `/conversation/history?sessionId=${sessionId}` }
      : { method: 'POST', url: '/conversation/truncate', payload: { sessionId, messageId: run.userMessageId } }).then(response => response)
    await Promise.race([entered.promise, responsePromise.then(response => {
      throw new Error(`Request completed before child cancellation: ${response.statusCode} ${response.body}`)
    })])

    let inFlight!: RootRun
    let lateWriter!: ReturnType<typeof bindHistoryGeneration>
    try {
      // The only preexisting root is terminal: a 409 here must come from the mutation lease.
      expect((await rootRunStore.list(tenantId, sessionId)).every(item => !['running', 'waiting'].includes(item.status))).toBe(true)
      await expect(rootRunStore.create(tenantId, sessionId, 'fixture-model', [], {})).rejects.toMatchObject({ statusCode: 409 })
      await expect(oldWriter.append({ id: 'old-write', role: 'assistant', content: 'too late' }, ctx)).rejects.toThrow('may no longer append')

      // Simulate a producer already admitted before the mutation began. Bypass only the
      // create guard to exercise the final fresh snapshot even if future startup regresses.
      inFlight = { ...run, runId: randomUUID(), turnId: randomUUID(), userMessageId: randomUUID(), assistantMessageId: randomUUID(), status: 'running', pending: [] }
      await withHistoryLock(tenantId, async () => {
        await db.execute({
          sql: 'INSERT INTO root_runs(tenant_id,session_id,run_id,turn_id,state) VALUES(?,?,?,?,?)',
          args: [tenantId, sessionId, inFlight.runId, inFlight.turnId, JSON.stringify({ ...inFlight, request: {}, attemptId: randomUUID() })],
        })
        lateWriter = bindHistoryGeneration(createConversationHistory(), tenantId, sessionId)
        const message = { id: inFlight.userMessageId, role: 'user' as const, content: 'admitted in-flight turn', conversationId: inFlight.turnId }
        await lateWriter.append(message, ctx)
      })
      expect((await history.getFullHistory(ctx)).map(message => message.id)).toContain(inFlight.userMessageId)
      mocks.abort.mockClear()
    } finally {
      release.resolve()
      await responsePromise
    }

    const response = await responsePromise
    expect(response.json()).toMatchObject({ code: 200, data: { success: true } })
    expect(mocks.abort).toHaveBeenCalledWith(tenantId, sessionId, expect.any(String))
    expect(await rootRunStore.get(tenantId, inFlight.runId)).toBeNull()
    expect(await rootRunStore.get(tenantId, run.runId)).toBeNull()
    await expect(lateWriter.append({ id: 'resurrected', role: 'assistant', content: 'must never return' }, ctx)).rejects.toThrow('may no longer append')
    expect(await history.getFullHistory(ctx)).toEqual([])
    // The lease ends with the request, so a fresh user turn is accepted afterwards.
    await expect(rootRunStore.create(tenantId, sessionId, 'fixture-model', [], {})).resolves.toMatchObject({ status: 'running' })
  })

  it('releases the mutation lease when child cancellation fails', async () => {
    await seedTurn()
    mocks.cancelChildren.mockRejectedValueOnce(new Error('child cancellation failed'))

    const response = await app.inject({ method: 'DELETE', url: `/conversation/history?sessionId=${sessionId}` })

    expect(response.statusCode).toBe(500)
    await expect(rootRunStore.create(tenantId, sessionId, 'fixture-model', [], {})).resolves.toMatchObject({ status: 'running' })
  })
})
