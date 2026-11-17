import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { LocalSqliteProcessClient } from '../../../../storage/sqlite/local-process-client.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as database from '../../../../storage/sqlite/db.js'
import { rootRunStore, type RootRun } from '../../../../storage/root-runs/index.js'
import { createConversationHistory } from '../../../../storage/conversation/factory.js'
import { bindHistoryGeneration, withHistoryLock } from '../../../../storage/conversation/serialization.js'
import { conversationRoutes } from '../conversation.js'
import type { Message } from '../../../../core/agent-context/types.js'
import { ChangeStore } from '../../../../storage/changes/index.js'
import { RollbackJournal } from '../../../../storage/changes/rollback-journal.js'
import { commitWriteChange, commitDeleteChange, readOldSnapshot } from '../../../../tools/file/change-recorder.js'
import type { AgentContext } from '../../../../core/agent-context/types.js'
import { withFileLocks } from '../../../../shared/file-version.js'
import { captureCreatedDirectories, missingParentDirectories } from '../../../../storage/changes/directories.js'

const mocks = vi.hoisted(() => ({
  abort: vi.fn(),
  stop: vi.fn(),
  cancelChildren: vi.fn(),
  listChildren: vi.fn(),
  listChildSessions: vi.fn(),
  deleteChildren: vi.fn(),
  deleteAllChildren: vi.fn(),
}))

vi.mock('../chat.js', () => ({ abortActiveChat: mocks.abort, stopOwnedSession: mocks.stop }))
vi.mock('../subagent.js', () => ({ subagentRoutes: async () => {} }))
vi.mock('../../../../core/subagent/runner.js', () => ({
  getSubagentRunner: () => ({ cancelRunsForParent: mocks.cancelChildren }),
}))
vi.mock('../../../../core/subagent/store.js', () => ({
  getSubagentStore: () => ({
    listRunsForParent: mocks.listChildren,
    listChildSessionIds: mocks.listChildSessions,
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
let db: LocalSqliteProcessClient
let app: FastifyInstance
let history: ReturnType<typeof createConversationHistory>

beforeEach(async () => {
  fs.mkdirSync('.e2e-tmp', { recursive: true })
  fixture = fs.mkdtempSync(path.resolve('.e2e-tmp/conversation-rollback-'))
  vi.stubEnv('DATA_DIR', path.join(fixture, 'agent.db'))
  vi.stubEnv('HISTORY_BACKEND', 'jsonl')
  db = new LocalSqliteProcessClient({ url: `file:${path.join(fixture, 'agent.db').replace(/\\/g, '/')}` })
  vi.spyOn(database, 'getDb').mockImplementation(() => db)
  for (const mock of Object.values(mocks)) mock.mockReset()
  // This fixture isolates destructive history semantics. Real owner joins and
  // held HTTP/preparation boundaries are covered by owned-stop-http.test.ts.
  mocks.stop.mockImplementation(async (tenant: string, session: string, reason: string) => {
    mocks.abort(tenant, session, reason)
    const roots = (await rootRunStore.list(tenant, session)).filter(run => ['running','waiting'].includes(run.status))
    for (const run of roots) await rootRunStore.update(tenant, run.runId, { status: 'cancelled', stopReason: reason })
    return roots.length > 0
  })
  mocks.cancelChildren.mockResolvedValue(undefined)
  mocks.listChildren.mockResolvedValue([])
  mocks.listChildSessions.mockResolvedValue([])
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
  if (db) expect((await db.closeWithReceipt()).healthy).toBe(true)
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  if (path.dirname(fixture) !== path.resolve('.e2e-tmp') || !path.basename(fixture).startsWith('conversation-rollback-')) {
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

type StoredMessage = Message & { conversationId?: string }
const appendTurn = (message: StoredMessage, context = ctx) => history.append(message, context)

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

describe('destructive conversation routes', () => {
  const rollbackKey = (messageId: string) => `rollback:${messageId}`
  const rollback = async (messageId: string, reviewedCommandChangeIds?: string[], requestKey = rollbackKey(messageId)) => {
    const response = await app.inject({ method: 'POST', url: '/conversation/rollback', payload: { sessionId, messageId, requestKey,
      ...(reviewedCommandChangeIds ? { reviewedCommandChangeIds } : {}) } })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json().code).toBe(200)
    return response.json().data
  }
  const write = async (run: RootRun, file: string, bytes: Buffer | string | null, child = false) => withFileLocks([file], async ([canonical]) => {
    const before = await readOldSnapshot(canonical)
    if (bytes === null) fs.unlinkSync(canonical)
    else { fs.mkdirSync(path.dirname(canonical), { recursive: true }); fs.writeFileSync(canonical, bytes) }
    const context = { ...ctx, sessionId: child ? 'worker-session' : sessionId, rootSessionId: sessionId,
      rootRunId: run.runId, turnId: run.turnId, conversationId: child ? 'child-turn' : run.turnId,
      ...(child ? { parentSessionId: sessionId, runId: 'child-run' } : {}), logger: { warn: vi.fn() } } as unknown as AgentContext
    return bytes === null ? commitDeleteChange(context, canonical, canonical, before) : commitWriteChange(context, canonical, canonical, before)
  })

  it('reverts five rounds to four, then to one after database reopen, preserving binary bytes and exact root ownership', async () => {
    const store = new ChangeStore(), main = path.join(fixture, 'workspace', 'main.txt')
    const binary = path.join(fixture, 'workspace', 'image.png'), extra = path.join(fixture, 'workspace', 'extra.txt')
    const baselineBytes = Buffer.from([0, 255, 1, 128]), fourthBytes = Buffer.from([0, 7, 9, 255])
    const userDir = path.join(fixture, 'user-empty'); fs.mkdirSync(userDir)
    const r1 = await seedTurn(); await write(r1, main, 'one\r\n'); await write(r1, binary, baselineBytes)
    const r2 = await seedTurn(); await write(r2, main, 'two\n'); await write(r2, extra, 'two'); await write(r2, binary, null)
    const ownDir = path.join(fixture, 'created-in-two'), probe = path.join(ownDir, '.probe'), missing = missingParentDirectories(probe)
    fs.mkdirSync(ownDir)
    await store.recordCreatedDirectories(tenantId, { sessionId, turnId: r2.turnId, runId: r2.runId }, captureCreatedDirectories(probe, missing))
    const r3 = await seedTurn(); await write(r3, main, null); await write(r3, binary, fourthBytes); await write(r3, extra, 'child-three', true)
    const r4 = await seedTurn(); await write(r4, main, 'four'); await write(r4, extra, 'four')
    const r5 = await seedTurn(); await write(r5, main, 'five'); await write(r5, binary, Buffer.from([0, 8, 8])); await write(r5, extra, null)
    const newest = path.join(fixture, 'only-five', 'nested', 'file.txt'); await write(r5, newest, 'five')
    const fifth = await rollback(r5.userMessageId)
    expect(fifth).toMatchObject({ historyTruncated: true, conflicts: 0, unavailable: 0, failed: 0 })
    expect(fs.readFileSync(main, 'utf8')).toBe('four'); expect(fs.readFileSync(extra, 'utf8')).toBe('four')
    expect(fs.readFileSync(binary)).toEqual(fourthBytes); expect(fs.existsSync(path.dirname(path.dirname(newest)))).toBe(false)
    expect((await rootRunStore.list(tenantId, sessionId)).map(run => run.turnId)).toEqual([r1, r2, r3, r4].map(run => run.turnId))
    expect((await db.closeWithReceipt()).healthy).toBe(true)
    db = new LocalSqliteProcessClient({ url: `file:${path.join(fixture, 'agent.db').replace(/\\/g, '/')}` })
    expect(await rollback(r5.userMessageId)).toEqual(fifth)
    const second = await rollback(r2.userMessageId)
    expect(second).toMatchObject({ historyTruncated: true, conflicts: 0, unavailable: 0, failed: 0 })
    expect(fs.readFileSync(main, 'utf8')).toBe('one\r\n'); expect(fs.readFileSync(binary)).toEqual(baselineBytes)
    expect(fs.existsSync(extra)).toBe(false); expect(fs.existsSync(ownDir)).toBe(false); expect(fs.existsSync(userDir)).toBe(true)
    expect((await history.getFullHistory(ctx)).map(message => message.id)).toEqual([r1.userMessageId])
    expect((await rootRunStore.list(tenantId, sessionId)).map(run => run.turnId)).toEqual([r1.turnId])
    const rows = await store.list(tenantId, sessionId)
    expect(rows.filter(row => row.turnId !== r1.turnId).every(row => row.status === 'reverted')).toBe(true)
    expect(rows.find(row => row.producerRunId === 'child-run')).toMatchObject({ sessionId, turnId: r3.turnId, runId: r3.runId, status: 'reverted' })
    const branch = await seedTurn(); await write(branch, main, 'new branch')
    mocks.stop.mockClear()
    expect(await rollback(r2.userMessageId)).toEqual(second)
    expect(mocks.stop).not.toHaveBeenCalled()
    expect(fs.readFileSync(main, 'utf8')).toBe('new branch')
    expect((await history.getFullHistory(ctx)).map(message => message.id)).toEqual([r1.userMessageId, branch.userMessageId])
  }, 30_000)

  it('keeps history on file conflicts and freezes the retry scope before another branch is appended', async () => {
    const first = await seedTurn(), file = path.join(fixture, 'conflict.txt'), other = path.join(fixture, 'independent.txt')
    await write(first, file, 'one'); const second = await seedTurn(); await write(second, file, 'two'); await write(second, other, 'two')
    fs.writeFileSync(file, 'manual')
    expect(await rollback(second.userMessageId)).toMatchObject({ historyTruncated: false, conflicts: 1, reverted: 1 })
    expect((await history.getFullHistory(ctx)).map(message => message.id)).toEqual([first.userMessageId, second.userMessageId])
    const branch = await seedTurn(), branchFile = path.join(fixture, 'branch.txt'); await write(branch, branchFile, 'keep')
    fs.writeFileSync(file, 'two')
    expect(await rollback(second.userMessageId)).toMatchObject({ historyTruncated: true, conflicts: 0 })
    expect(fs.readFileSync(file, 'utf8')).toBe('one'); expect(fs.readFileSync(branchFile, 'utf8')).toBe('keep')
    expect((await history.getFullHistory(ctx)).map(message => message.id)).toEqual([first.userMessageId, branch.userMessageId])
  }, 15_000)

  it('retries an unknown history-cleanup outcome without replaying files or deleting a later branch', async () => {
    const run = await seedTurn(), file = path.join(fixture, 'output.txt'); await write(run, file, 'old')
    const original = RollbackJournal.prototype.save
    const save = vi.spyOn(RollbackJournal.prototype, 'save').mockImplementation(async function(this: RollbackJournal, tenant, session, id, key, record) {
      if (record.state === 'succeeded') throw new Error('receipt write interrupted')
      return original.call(this, tenant, session, id, key, record)
    })
    const failed = await app.inject({ method: 'POST', url: '/conversation/rollback', payload: { sessionId, messageId: run.userMessageId, requestKey: rollbackKey(run.userMessageId) } })
    expect(failed.statusCode).toBe(500); expect(fs.existsSync(file)).toBe(false)
    expect((await new RollbackJournal().get(tenantId, sessionId, run.userMessageId, rollbackKey(run.userMessageId)))?.state).toBe('files_reverted')
    save.mockRestore()
    const branch = await seedTurn(); await write(branch, file, 'new branch')
    expect(await rollback(run.userMessageId)).toMatchObject({ historyTruncated: true })
    expect(fs.readFileSync(file, 'utf8')).toBe('new branch')
    expect((await history.getFullHistory(ctx)).map(message => message.id)).toEqual([branch.userMessageId])
  }, 15_000)

  it('does not turn frozen server-selected command IDs into implicit user approval', async () => {
    const run = await seedTurn(), file = path.join(fixture, 'observed.txt'); fs.writeFileSync(file, 'observed')
    const row = await new ChangeStore().record(tenantId, { sessionId, turnId: run.turnId, runId: run.runId, path: file,
      kind: 'write', oldContent: null, newContent: 'observed', source: 'command-observation', requiresExplicitRevert: true })
    expect(await rollback(run.userMessageId)).toMatchObject({ historyTruncated: false, unavailable: 1 })
    expect(fs.existsSync(file)).toBe(true)
    expect(await rollback(run.userMessageId, [row.id])).toMatchObject({ historyTruncated: true, unavailable: 0 })
    expect(fs.existsSync(file)).toBe(false)
  }, 15_000)

  it('holds admission while producers settle and includes their last file change before rollback', async () => {
    const run = await seedTurn(), file = path.join(fixture, 'settling.txt'); await write(run, file, 'before cancel')
    const entered = deferred(), release = deferred()
    mocks.cancelChildren.mockImplementationOnce(async () => { entered.resolve(); await release.promise })
    const pending = app.inject({ method: 'POST', url: '/conversation/rollback', payload: { sessionId, messageId: run.userMessageId, requestKey: rollbackKey(run.userMessageId) } }).then(value => value)
    await entered.promise
    try {
      await expect(rootRunStore.create(tenantId, sessionId, 'fixture-model', [], {})).rejects.toMatchObject({ statusCode: 409 })
      expect(fs.readFileSync(file, 'utf8')).toBe('before cancel')
      await write(run, file, 'last admitted producer bytes')
    } finally { release.resolve() }
    const response = await pending
    expect(response.json()).toMatchObject({ code: 200, data: { historyTruncated: true, total: 2, reverted: 2 } })
    expect(fs.existsSync(file)).toBe(false)
    expect(await history.getFullHistory(ctx)).toEqual([])
  }, 15_000)

  it('rejects non-root message anchors before cancelling or changing files', async () => {
    const run = await seedTurn(), file = path.join(fixture, 'keep.txt'); await write(run, file, 'keep')
    await appendTurn({ id: 'supplement', role: 'user', content: 'later supplement', conversationId: run.turnId })
    const response = await app.inject({ method: 'POST', url: '/conversation/rollback', payload: { sessionId, messageId: 'supplement', requestKey: 'invalid-anchor' } })
    expect(response.statusCode).toBe(400); expect(mocks.stop).not.toHaveBeenCalled()
    expect(fs.readFileSync(file, 'utf8')).toBe('keep')
    expect((await history.getFullHistory(ctx)).map(message => message.id)).toEqual([run.userMessageId, 'supplement'])
  }, 15_000)

  it('does not cancel an active new branch when an incomplete old rollback is retried', async () => {
    const run = await seedTurn(), file = path.join(fixture, 'conflicted.txt'); await write(run, file, 'recorded')
    fs.writeFileSync(file, 'manual')
    expect(await rollback(run.userMessageId)).toMatchObject({ historyTruncated: false, conflicts: 1 })
    const branch = await rootRunStore.create(tenantId, sessionId, 'fixture-model', [], {})
    mocks.stop.mockClear()
    const response = await app.inject({ method: 'POST', url: '/conversation/rollback', payload: { sessionId, messageId: run.userMessageId, requestKey: rollbackKey(run.userMessageId) } })
    expect(response.statusCode).toBe(409); expect(mocks.stop).not.toHaveBeenCalled()
    expect((await rootRunStore.get(tenantId, branch.runId))?.status).toBe('running')
    expect(fs.readFileSync(file, 'utf8')).toBe('manual')
  }, 15_000)

  it('requires review for a command observed during cancellation after the frontend preview', async () => {
    const run = await seedTurn(), file = path.join(fixture, 'known.txt'), late = path.join(fixture, 'late-command.txt')
    await write(run, file, 'known')
    const store = new ChangeStore(), preview = await store.previewRevert(tenantId, { sessionId, fromTurnId: run.turnId, scope: 'all' })
    let commandId!: string
    mocks.cancelChildren.mockImplementationOnce(async () => {
      fs.writeFileSync(late, 'late command')
      commandId = (await store.record(tenantId, { sessionId, turnId: run.turnId, runId: run.runId, path: late,
        kind: 'write', oldContent: null, newContent: 'late command', source: 'command-observation', requiresExplicitRevert: true })).id
    })
    const partial = await rollback(run.userMessageId, preview.changes.map(change => change.id))
    expect(partial).toMatchObject({ historyTruncated: false, total: 2, reverted: 1, unavailable: 1 })
    expect(partial.results.find((item: { id: string }) => item.id === commandId)?.status).toBe('unavailable')
    expect(fs.existsSync(late)).toBe(true)
    expect((await history.getFullHistory(ctx)).map(message => message.id)).toEqual([run.userMessageId])
    expect(await rollback(run.userMessageId, [commandId])).toMatchObject({ historyTruncated: true })
    expect(fs.existsSync(late)).toBe(false)
  }, 15_000)

  it.each(['pending', 'files_reverted'] as const)('rejects an old %s request after the same turn continues, while a new confirmation can select it', async phase => {
    const run = await seedTurn(), file = path.join(fixture, 'original.txt'), continued = path.join(fixture, 'continued.txt')
    await write(run, file, 'original')
    if (phase === 'pending') {
      fs.writeFileSync(file, 'manual')
      expect(await rollback(run.userMessageId)).toMatchObject({ historyTruncated: false })
    } else {
      const original = RollbackJournal.prototype.save
      const save = vi.spyOn(RollbackJournal.prototype, 'save').mockImplementation(async function(this: RollbackJournal, tenant, session, id, key, record) {
        await original.call(this, tenant, session, id, key, record)
        if (record.state === 'files_reverted') throw new Error('crash before history cleanup')
      })
      const response = await app.inject({ method: 'POST', url: '/conversation/rollback', payload: {
        sessionId, messageId: run.userMessageId, requestKey: rollbackKey(run.userMessageId),
      } })
      expect(response.statusCode).toBe(500); save.mockRestore()
    }
    // Continuation retains the logical root/turn and rotates its physical attempt.
    await db.execute({ sql: "UPDATE root_runs SET state=json_set(state,'$.attemptId',?) WHERE tenant_id=? AND run_id=?",
      args: [randomUUID(), tenantId, run.runId] })
    await appendTurn({ id: 'continued-output', role: 'assistant', content: 'new output', conversationId: run.turnId })
    await write(run, continued, 'new work')
    mocks.stop.mockClear()
    const old = await app.inject({ method: 'POST', url: '/conversation/rollback', payload: {
      sessionId, messageId: run.userMessageId, requestKey: rollbackKey(run.userMessageId),
    } })
    expect(old.statusCode).toBe(409); expect(mocks.stop).not.toHaveBeenCalled()
    expect(fs.readFileSync(continued, 'utf8')).toBe('new work')
    expect((await history.getFullHistory(ctx)).map(message => message.id)).toContain('continued-output')
    if (phase === 'pending') fs.writeFileSync(file, 'original')
    expect(await rollback(run.userMessageId, undefined, randomUUID())).toMatchObject({ historyTruncated: true })
    expect(fs.existsSync(continued)).toBe(false); expect(await history.getFullHistory(ctx)).toEqual([])
  }, 15_000)

  it('binds a request key to its original message instead of replaying it on another target', async () => {
    const one = await seedTurn(), two = await seedTurn()
    await rollback(two.userMessageId, undefined, 'same-key')
    mocks.stop.mockClear()
    const response = await app.inject({ method: 'POST', url: '/conversation/rollback', payload: {
      sessionId, messageId: one.userMessageId, requestKey: 'same-key',
    } })
    expect(response.statusCode).toBe(409); expect(mocks.stop).not.toHaveBeenCalled()
    expect((await history.getFullHistory(ctx)).map(message => message.id)).toEqual([one.userMessageId])
  })
  it('deletes compacted turn archives and child dispatches without touching another session with the same turn ID', async () => {
    const run = await seedTurn()
    await appendTurn({ id: 'archived-dispatch', role: 'assistant', content: '', conversationId: run.turnId,
      toolCall: { id: 'dispatch-tool', name: 'subagent', args: {} }, usage: { totalTokens: 640257 } }, ctx)
    await appendTurn({ id: 'dispatch-result', role: 'tool', content: 'accepted', conversationId: run.turnId, toolCallId: 'dispatch-tool' }, ctx)
    await appendTurn({ id: run.assistantMessageId, role: 'assistant', content: 'completed', conversationId: run.turnId }, ctx)
    const child = { runId: 'archived-child', parentMessageId: 'archived-dispatch', parentConversationId: run.turnId, childSessionId: 'archived-child-session' }
    mocks.listChildren.mockResolvedValue([child])
    await history.append({ id: 'child-answer', role: 'assistant', content: 'old child output' }, { tenantId, sessionId: child.childSessionId })
    const other = { tenantId, sessionId: 'other-session' }
    await appendTurn({ id: 'other-question', role: 'user', content: 'unrelated', conversationId: run.turnId }, other)
    await appendTurn({ id: 'other-answer', role: 'assistant', content: 'keep this', conversationId: run.turnId, usage: { totalTokens: 12 } }, other)
    await history.compress(ctx, async () => 'compacted evidence', 1)
    expect((await history.getFullHistory(ctx)).map(message => message.id)).not.toContain('archived-dispatch')
    expect(await history.getSessionUsage(ctx)).toMatchObject({ totalTokens: 640257 })

    const response = await app.inject({ method: 'DELETE', url: `/conversation/turns/${run.turnId}?sessionId=${sessionId}` })

    expect(response.json()).toMatchObject({ code: 200, data: { success: true, removed: 4 } })
    expect(mocks.deleteChildren).toHaveBeenCalledWith(tenantId, [child.runId])
    expect(await history.getFullHistory({ tenantId, sessionId: child.childSessionId })).toEqual([])
    expect((await history.getArchive!(ctx)).messages.filter(message => (message as StoredMessage).conversationId === run.turnId)).toEqual([])
    expect((await history.getDisplayHistory!(ctx, { limit: 2 })).turns).toEqual([])
    expect((await history.getSessionUsage(ctx)).totalTokens ?? 0).toBe(0)
    expect((await history.getFullHistory(other)).map(message => message.id)).toEqual(['other-question', 'other-answer'])
    expect(await history.getSessionUsage(other)).toMatchObject({ totalTokens: 12 })
  })

  it('truncation removes children by their deleted root turn even when no dispatch is in the projection', async () => {
    const retained = await seedTurn(), removed = await seedTurn()
    const children = [
      { runId: 'kept-child', parentMessageId: 'hidden-kept-dispatch', parentConversationId: retained.turnId, childSessionId: 'kept-child-session' },
      { runId: 'removed-child', parentMessageId: 'hidden-removed-dispatch', parentConversationId: removed.turnId, childSessionId: 'removed-child-session' },
    ]
    mocks.listChildren.mockResolvedValue(children)
    for (const child of children) await history.append({ id: child.runId + '-answer', role: 'assistant', content: 'child answer' }, { tenantId, sessionId: child.childSessionId })

    const response = await app.inject({ method: 'POST', url: '/conversation/truncate', payload: { sessionId, messageId: removed.userMessageId } })

    expect(response.json()).toMatchObject({ code: 200, data: { success: true } })
    expect(mocks.deleteChildren).toHaveBeenCalledWith(tenantId, ['removed-child'])
    expect(await history.getFullHistory({ tenantId, sessionId: 'removed-child-session' })).toEqual([])
    expect((await history.getFullHistory({ tenantId, sessionId: 'kept-child-session' })).map(message => message.id)).toEqual(['kept-child-answer'])
    expect((await history.getFullHistory(ctx)).map(message => message.id)).toEqual([retained.userMessageId])
  })

  it('truncating a supplement preserves earlier children in the same root turn', async () => {
    const run = await seedTurn()
    await appendTurn({ id: 'before-dispatch', role: 'assistant', content: '', conversationId: run.turnId }, ctx)
    await appendTurn({ id: 'supplement', role: 'user', content: 'revised request', conversationId: run.turnId }, ctx)
    await appendTurn({ id: 'after-dispatch', role: 'assistant', content: '', conversationId: run.turnId }, ctx)
    mocks.listChildren.mockResolvedValue([
      { runId: 'before-child', parentMessageId: 'before-dispatch', parentConversationId: run.turnId, childSessionId: 'before-child-session' },
      { runId: 'after-child', parentMessageId: 'after-dispatch', parentConversationId: run.turnId, childSessionId: 'after-child-session' },
    ])

    const response = await app.inject({ method: 'POST', url: '/conversation/truncate', payload: { sessionId, messageId: 'supplement' } })

    expect(response.json()).toMatchObject({ code: 200, data: { success: true } })
    expect(mocks.deleteChildren).toHaveBeenCalledWith(tenantId, ['after-child'])
    expect((await history.getFullHistory(ctx)).map(message => message.id)).toEqual([run.userMessageId, 'before-dispatch'])
  })

  it('keeps a reused child transcript when a surviving invocation still references it', async () => {
    const retained = await seedTurn(), removed = await seedTurn()
    const childSessionId = 'shared-child-session'
    mocks.listChildren.mockResolvedValue([
      { runId: 'prior-child', parentMessageId: 'prior-dispatch', parentConversationId: retained.turnId, childSessionId },
      { runId: 'resumed-child', parentMessageId: 'resumed-dispatch', parentConversationId: removed.turnId, childSessionId },
    ])
    mocks.listChildSessions.mockResolvedValue([childSessionId])
    await history.append({ id: 'reusable-context', role: 'assistant', content: 'prior invocation context' }, { tenantId, sessionId: childSessionId })

    const response = await app.inject({ method: 'POST', url: '/conversation/truncate', payload: { sessionId, messageId: removed.userMessageId } })

    expect(response.json()).toMatchObject({ code: 200, data: { success: true } })
    expect(mocks.deleteChildren).toHaveBeenCalledWith(tenantId, ['resumed-child'])
    expect((await history.getFullHistory({ tenantId, sessionId: childSessionId })).map(message => message.id)).toEqual(['reusable-context'])
  })

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
