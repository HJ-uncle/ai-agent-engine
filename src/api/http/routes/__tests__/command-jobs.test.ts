import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { FastifyInstance, InjectOptions } from 'fastify'
import type { Client } from '@libsql/client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { CommandJobLaunch, CommandJobSnapshot } from '../../../../core/command-jobs/types.js'

let app: FastifyInstance
let fixture: string
let closeDb: () => void
let db: Client
let commandJobs: typeof import('../../../../core/command-jobs/index.js').commandJobs
let rootRunStore: typeof import('../../../../storage/root-runs/index.js').rootRunStore
let history: ReturnType<typeof import('../../../../storage/conversation/factory.js').createConversationHistory>
const tenantId = 'd7-http-tenant'
const token = 'd7-http-fixture-instance-token'
const headers = { 'X-Aether-Instance-Token': token, 'X-Aether-Tool-Profile': 'code', 'X-Test-Tenant': tenantId }

beforeAll(async () => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-d7-http-'))
  for (const [key, value] of Object.entries({
    DATA_DIR: path.join(fixture, 'agent.db'), WORKSPACE_ROOT: path.join(fixture, 'workspace'),
    AETHER_GLOBAL_DIR: path.join(fixture, 'global'), SKILLS_ROOT: path.join(fixture, 'skills'),
    PUBLIC_DIR: path.join(fixture, 'absent-public'), LOG_LEVEL: 'silent', QA_LOG_ENABLED: 'false',
    AUTH_ENABLED: 'false', AETHER_INSTANCE_TOKEN: token, ENABLE_LONG_TERM_MEMORY: 'false',
    HISTORY_BACKEND: 'jsonl', ENCRYPTION_KEY: '1'.repeat(64),
  })) vi.stubEnv(key, value)
  fs.mkdirSync(path.join(fixture, 'workspace'), { recursive: true })
  fs.mkdirSync(path.join(fixture, 'skills'), { recursive: true })
  const { SQLiteTaskQueue } = await import('../../../../storage/task-queue/sqlite-queue.js')
  vi.spyOn(SQLiteTaskQueue.prototype, 'start').mockImplementation(() => {})
  const { cronScheduler } = await import('../../../../scheduler/cron-scheduler.js')
  vi.spyOn(cronScheduler, 'start').mockImplementation(() => {})
  const database = await import('../../../../storage/sqlite/db.js')
  closeDb = database.closeDb
  await database.initDb()
  db = database.getDb()
  ;({ commandJobs } = await import('../../../../core/command-jobs/index.js'))
  ;({ rootRunStore } = await import('../../../../storage/root-runs/index.js'))
  history = (await import('../../../../storage/conversation/factory.js')).createConversationHistory()
  const { buildServer } = await import('../../server.js')
  app = await buildServer()
  // The owned-instance gate stays real. Only tenant identity is injected for cross-tenant requests.
  app.addHook('preHandler', async request => {
    Object.assign(request, { authContext: { tenantId: request.headers['x-test-tenant'] ?? tenantId } })
  })
  await app.ready()
}, 30_000)

afterAll(async () => {
  await app?.close()
  await commandJobs?.shutdown('HTTP fixture cleanup')
  closeDb?.()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  if (!fixture) return
  const resolved = path.resolve(fixture)
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('aether-d7-http-')) {
    throw new Error('Unsafe HTTP fixture cleanup path')
  }
  try { fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }) }
  catch (error) { if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error }
}, 20_000)

function request(options: InjectOptions) {
  return app.inject({ ...options, url: '/api/v1' + options.url, headers: { ...headers, ...options.headers } })
}

async function start(sessionId: string, script: string, overrides: Partial<CommandJobLaunch> = {}) {
  const scriptPath = path.join(fixture, `${sessionId}-${Math.random().toString(16).slice(2)}.cjs`)
  fs.writeFileSync(scriptPath, script)
  return commandJobs.start({ tenantId, sessionId, ownerSessionId: sessionId,
    command: process.execPath, args: [scriptPath], cwd: fixture, background: true,
    timeoutMs: 20_000, env: { ...process.env }, ...overrides })
}

async function writingJob(sessionId: string, overrides: Partial<CommandJobLaunch> = {}) {
  const marker = path.join(fixture, `${sessionId}-${Math.random().toString(16).slice(2)}.writes`)
  const job = await start(sessionId, `
    const fs = require('node:fs');
    const marker = ${JSON.stringify(marker)};
    fs.appendFileSync(marker, 'started\\n');
    process.stdout.write('ready\\n');
    setInterval(() => fs.appendFileSync(marker, 'tick\\n'), 25);
  `, overrides)
  await expect.poll(() => fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '', { timeout: 5_000 }).toContain('tick')
  return { job, marker }
}

async function assertStopped(marker: string) {
  const atResponse = fs.readFileSync(marker, 'utf8')
  await new Promise(resolve => setTimeout(resolve, 150))
  expect(fs.readFileSync(marker, 'utf8')).toBe(atResponse)
}

async function assertStillWriting(marker: string) {
  const before = fs.statSync(marker).size
  await expect.poll(() => fs.statSync(marker).size, { timeout: 2_000 }).toBeGreaterThan(before)
}

async function getJob(job: CommandJobSnapshot, selectedTenant = tenantId, selectedSession = job.sessionId) {
  return request({ method: 'GET', url: `/command-jobs/${job.jobId}?sessionId=${selectedSession}`,
    headers: { 'X-Test-Tenant': selectedTenant } })
}

describe('D7 command job HTTP and history lifecycle', () => {
  it('requires the owned-instance token on every new command route and exposes no launch route', async () => {
    for (const [method, url, payload] of [
      ['GET', '/command-jobs?sessionId=auth', undefined],
      ['GET', '/command-jobs/missing?sessionId=auth', undefined],
      ['GET', '/command-jobs/missing/output?sessionId=auth', undefined],
      ['POST', '/command-jobs/missing/cancel', { sessionId: 'auth' }],
    ] as const) {
      for (const supplied of ['', 'wrong-fixture-token']) {
        const result = await request({ method, url, payload, headers: { 'X-Aether-Instance-Token': supplied } })
        expect(result.statusCode, result.body).toBe(401)
        expect(result.json().code).toBe(40100)
        expect(result.body).not.toContain(token)
      }
    }
    expect((await request({ method: 'POST', url: '/command-jobs', payload: { command: process.execPath } })).statusCode).toBe(404)
  })

  it('rejects missing sessions and invalid output cursors before returning command data', async () => {
    const job = await start('cursor-validation', "process.stdout.write('one');")
    await commandJobs.wait({ tenantId, sessionId: job.sessionId }, job.jobId)
    for (const url of ['/command-jobs', `/command-jobs/${job.jobId}`, `/command-jobs/${job.jobId}/output`]) {
      expect((await request({ method: 'GET', url })).statusCode).toBe(400)
    }
    expect((await request({ method: 'POST', url: `/command-jobs/${job.jobId}/cancel`, payload: {} })).statusCode).toBe(400)
    for (const query of ['cursor=-1', 'cursor=0.5', 'cursor=nope', 'cursor=9007199254740992', 'cursor=999999',
      'maxBytes=0', 'maxBytes=-1', 'maxBytes=0.5', 'maxBytes=nope', 'maxBytes=1', 'maxBytes=3', 'maxBytes=65537']) {
      const result = await request({ method: 'GET', url: `/command-jobs/${job.jobId}/output?sessionId=${job.sessionId}&${query}` })
      expect(result.statusCode, `${query}: ${result.body}`).toBe(400)
      expect(result.json().data).toBeNull()
    }
  })

  it('conceals other tenants and sessions across list, status, output, and cancellation without stopping their process', async () => {
    const { job, marker } = await writingJob('scope-owner')
    for (const [selectedTenant, selectedSession] of [['foreign-tenant', job.sessionId], [tenantId, 'foreign-session']]) {
      const tenantHeaders = { 'X-Test-Tenant': selectedTenant }
      const listed = await request({ method: 'GET', url: `/command-jobs?sessionId=${selectedSession}`, headers: tenantHeaders })
      expect(listed.json().data.jobs).toEqual([])
      const requests = [
        await getJob(job, selectedTenant, selectedSession),
        await request({ method: 'GET', url: `/command-jobs/${job.jobId}/output?sessionId=${selectedSession}`, headers: tenantHeaders }),
        await request({ method: 'POST', url: `/command-jobs/${job.jobId}/cancel`, payload: { sessionId: selectedSession }, headers: tenantHeaders }),
      ]
      for (const result of requests) {
        expect(result.statusCode, result.body).toBe(404)
        expect(result.json()).toMatchObject({ code: 40400, data: null })
        expect(result.body).not.toContain(marker)
      }
    }
    await assertStillWriting(marker)
    expect((await getJob(job)).json().data.status).toBe('running')
    await commandJobs.cancel({ tenantId, sessionId: job.sessionId }, job.jobId, 'fixture completed')
  })

  it('returns actual failed exits and incremental output, while refresh and snapshots never re-execute commands', async () => {
    const sessionId = 'read-without-replay'
    const started = path.join(fixture, 'refresh-start-count.txt')
    const run = await rootRunStore.create(tenantId, sessionId, 'fixture-model', [fixture], {})
    await rootRunStore.update(tenantId, run.runId, { status: 'succeeded' })
    const job = await start(sessionId, `
      require('node:fs').appendFileSync(${JSON.stringify(started)}, 'start\\n');
      process.stdout.write('first-output\\n');
      setTimeout(() => { process.stderr.write('actual-error\\n'); process.exitCode = 7; }, 30);
    `, { runId: run.runId, ownerRunId: run.runId, turnId: run.turnId, toolCallId: 'background-tool' })
    await commandJobs.wait({ tenantId, sessionId }, job.jobId)
    const launchSpy = vi.spyOn(commandJobs, 'start')
    try {
      const first = await request({ method: 'GET', url: `/command-jobs/${job.jobId}/output?sessionId=${sessionId}&cursor=0` })
      expect(first.statusCode, first.body).toBe(200)
      expect(first.json().data.job).toMatchObject({ jobId: job.jobId, status: 'failed', exitCode: 7 })
      const entries = first.json().data.entries as Array<{ seq: number; stream: string; text: string }>
      expect(entries.filter(entry => entry.stream === 'stdout').map(entry => entry.text).join('')).toBe('first-output\n')
      expect(entries.filter(entry => entry.stream === 'stderr').map(entry => entry.text).join('')).toBe('actual-error\n')
      expect(new Set(entries.map(entry => entry.seq)).size).toBe(entries.length)
      const next = await request({ method: 'GET', url: `/command-jobs/${job.jobId}/output?sessionId=${sessionId}&cursor=${first.json().data.nextCursor}` })
      expect(next.json().data).toMatchObject({ entries: [], hasMore: false, truncated: false })
      for (let refresh = 0; refresh < 3; refresh++) {
        const snapshot = await request({ method: 'GET', url: `/chat/snapshot?sessionId=${sessionId}` })
        expect(snapshot.statusCode, snapshot.body).toBe(200)
        expect(snapshot.json().data.commandJobs).toEqual([expect.objectContaining({ jobId: job.jobId, status: 'failed', exitCode: 7 })])
        const listed = await request({ method: 'GET', url: `/command-jobs?sessionId=${sessionId}` })
        expect(listed.json().data.jobs).toHaveLength(1)
        expect((await getJob(job)).json().data.status).toBe('failed')
      }
      expect(fs.readFileSync(started, 'utf8')).toBe('start\n')
      expect(launchSpy).not.toHaveBeenCalled()
    } finally { launchSpy.mockRestore() }
  })

  it('awaits real process cancellation and returns the same terminal result on duplicate stop', async () => {
    const { job, marker } = await writingJob('cancel-handle')
    const first = await request({ method: 'POST', url: `/command-jobs/${job.jobId}/cancel`, payload: { sessionId: job.sessionId } })
    expect(first.statusCode, first.body).toBe(200)
    expect(first.json().data).toMatchObject({ jobId: job.jobId, status: 'cancelled' })
    await assertStopped(marker)
    const again = await request({ method: 'POST', url: `/command-jobs/${job.jobId}/cancel`, payload: { sessionId: job.sessionId } })
    expect(again.json().data).toEqual(first.json().data)
  })

  it('chat stop reaches root and child-owned jobs after the model ended, without stopping another session', async () => {
    const sessionId = 'chat-stop-background'
    const root = await writingJob(sessionId)
    const child = await writingJob(sessionId, { ownerSessionId: 'child-owned-session', ownerRunId: 'child-run' })
    const other = await writingJob('unrelated-chat')
    const result = await request({ method: 'POST', url: '/chat/cancel', payload: { sessionId } })
    expect(result.statusCode, result.body).toBe(200)
    expect(result.json().data).toMatchObject({ sessionId, cancelled: true })
    for (const item of [root, child]) {
      expect((await getJob(item.job)).json().data.status).toBe('cancelled')
      await assertStopped(item.marker)
    }
    await assertStillWriting(other.marker)
    await commandJobs.cancel({ tenantId, sessionId: other.job.sessionId }, other.job.jobId, 'fixture completed')
  // Windows queries each real process tree through PowerShell before stopping it.
  }, 15_000)

  it('stops owned processes even when persisting chat cancellation fails, then reconciles on retry', async () => {
    const sessionId = 'chat-stop-write-failure'
    const run = await rootRunStore.create(tenantId, sessionId, 'fixture-model', [fixture], {})
    const child = await writingJob(sessionId, { ownerSessionId: 'failed-stop-child', ownerRunId: 'failed-stop-child-run' })
    const { registerActiveChat, unregisterActiveChat } = await import('../chat.js')
    const controller = new AbortController()
    registerActiveChat(tenantId, sessionId, controller)
    const update = vi.spyOn(rootRunStore, 'update').mockRejectedValueOnce(
      Object.assign(new Error('SQLITE_BUSY: database is locked'), { code: 'SQLITE_BUSY' }),
    )
    try {
      const failed = await request({ method: 'POST', url: '/chat/cancel', payload: { sessionId } })
      expect(failed.json()).toMatchObject({ code: 50000, message: 'SQLITE_BUSY: database is locked' })
      expect(controller.signal.aborted).toBe(true)
      expect((await getJob(child.job)).json().data.status).toBe('cancelled')
      await assertStopped(child.marker)
      expect((await rootRunStore.get(tenantId, run.runId))?.status).toBe('running')

      const retried = await request({ method: 'POST', url: '/chat/cancel', payload: { sessionId } })
      expect(retried.json()).toMatchObject({ code: 200, data: { cancelled: true } })
      expect((await rootRunStore.get(tenantId, run.runId))?.status).toBe('cancelled')
      await assertStopped(child.marker)
    } finally {
      update.mockRestore()
      unregisterActiveChat(tenantId, sessionId, controller)
    }
  }, 15_000)

  it.each(['clear', 'turn', 'message', 'truncate', 'session'] as const)(
    'history mutation %s settles background processes before deleting history', async operation => {
      const sessionId = `delete-${operation}`
      const run = await rootRunStore.create(tenantId, sessionId, 'fixture-model', [fixture], {})
      const message = { id: run.userMessageId, role: 'user' as const, content: 'Start the fixture', conversationId: run.turnId }
      await history.append(message, { tenantId, sessionId })
      await rootRunStore.update(tenantId, run.runId, { status: 'succeeded' })
      const { job, marker } = await writingJob(sessionId, { runId: run.runId, turnId: run.turnId,
        ownerSessionId: `${sessionId}-child`, ownerRunId: 'child-run' })
      const routes: Record<typeof operation, InjectOptions> = {
        clear: { method: 'DELETE', url: `/conversation/history?sessionId=${sessionId}` },
        turn: { method: 'DELETE', url: `/conversation/turns/${run.turnId}?sessionId=${sessionId}` },
        message: { method: 'DELETE', url: `/conversation/messages/${run.userMessageId}?sessionId=${sessionId}` },
        truncate: { method: 'POST', url: '/conversation/truncate', payload: { sessionId, messageId: run.userMessageId } },
        session: { method: 'DELETE', url: `/sessions/${sessionId}?keepWorkspace=true` },
      }
      const result = await request(routes[operation])
      expect(result.statusCode, result.body).toBe(200)
      expect(result.json().code).toBe(200)
      expect((await commandJobs.get({ tenantId, sessionId }, job.jobId))?.status).toBe('cancelled')
      await assertStopped(marker)
      expect(await history.getFullHistory({ tenantId, sessionId })).toEqual([])
      expect(await rootRunStore.list(tenantId, sessionId)).toEqual([])
    }, 10_000)

  it('a foreign turn deletion does not stop the real owner job or mutate its history', async () => {
    const sessionId = 'delete-wrong-scope'
    const run = await rootRunStore.create(tenantId, sessionId, 'fixture-model', [fixture], {})
    const message = { id: run.userMessageId, role: 'user' as const, content: 'Keep my process', conversationId: run.turnId }
    await history.append(message, { tenantId, sessionId })
    const { job, marker } = await writingJob(sessionId, { runId: run.runId, turnId: run.turnId })
    const result = await request({ method: 'DELETE', url: `/conversation/turns/${run.turnId}?sessionId=wrong-session` })
    expect(result.json().code).toBe(40400)
    await assertStillWriting(marker)
    expect(await history.getFullHistory({ tenantId, sessionId })).toHaveLength(1)
    await commandJobs.cancel({ tenantId, sessionId }, job.jobId, 'fixture completed')
  })

  it('chat cancellation during initial job persistence prevents a late command spawn', async () => {
    const sessionId = 'cancel-start-admission'
    const marker = path.join(fixture, 'must-not-spawn-after-cancel.txt')
    const run = await rootRunStore.create(tenantId, sessionId, 'fixture-model', [fixture], {})
    let release!: () => void
    let entered!: () => void
    let stopping!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const persisting = new Promise<void>(resolve => { entered = resolve })
    const cancelling = new Promise<void>(resolve => { stopping = resolve })
    const originalBatch = db.batch.bind(db)
    let held = false
    const dbSpy = vi.spyOn(db, 'batch').mockImplementation(async (statements, mode) => {
      const statement = (statements as unknown[]).find(item => {
        if (!item || typeof item !== 'object') return false
        const sql = (item as { sql?: unknown }).sql
        return typeof sql === 'string' && sql.includes('INSERT INTO command_jobs')
      }) as { sql: string; args?: unknown[] } | undefined
      if (!held && statement && Array.isArray(statement.args) && statement.args[1] === sessionId) {
          held = true
          entered()
          await gate
      }
      return originalBatch(statements, mode)
    })
    const originalCancel = commandJobs.cancelScope.bind(commandJobs)
    const cancelSpy = vi.spyOn(commandJobs, 'cancelScope').mockImplementation(async (...args) => {
      const result = originalCancel(...args)
      if (args[0].sessionId === sessionId) stopping()
      return result
    })
    try {
      const starting = start(sessionId,
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'late side effect')`,
        { runId: run.runId, turnId: run.turnId }).catch(error => error as Error)
      await persisting
      const response = request({ method: 'POST', url: '/chat/cancel', payload: { sessionId } })
      await cancelling
      release()
      const result = await response
      expect(result.statusCode, result.body).toBe(200)
      expect(result.json().data.cancelled).toBe(true)
      const admitted = await starting
      if (!(admitted instanceof Error)) {
        const settled = await commandJobs.wait({ tenantId, sessionId }, admitted.jobId)
        expect(settled?.status).toBe('cancelled')
      }
      expect((await rootRunStore.get(tenantId, run.runId))?.status).toBe('cancelled')
      expect(fs.existsSync(marker)).toBe(false)
    } finally { release(); dbSpy.mockRestore(); cancelSpy.mockRestore() }
  }, 10_000)

  it('cancels five sessions while subagent transactions and ordinary writes compete for SQLite', async () => {
    const { SubagentStore } = await import('../../../../core/subagent/store.js')
    const store = new SubagentStore(db)
    const roots = await Promise.all(Array.from({ length: 5 }, (_, index) =>
      rootRunStore.create(tenantId, `sqlite-overlap-${index}`, 'fixture-model', [fixture], {})))
    const children = await Promise.all(roots.flatMap(root => Array.from({ length: 3 }, (_, index) =>
      store.createRun({ tenantId, rootSessionId: root.sessionId, parentSessionId: root.sessionId,
        parentConversationId: root.turnId, parentMessageId: root.assistantMessageId,
        parentToolCallId: `${root.runId}-review-${index}`, task: 'Concurrent persistence regression',
        description: `Reviewer ${index}`, modelId: 'fixture-model' }))))

    // Hold a real write transaction while HTTP cancellation and child snapshots
    // arrive. Ordinary writes must wait rather than racing a detached connection.
    const tx = await db.transaction('write')
    let responses: Awaited<ReturnType<typeof request>>[]
    let updated: Awaited<ReturnType<typeof store.appendSnapshot>>[]
    try {
      await tx.execute({ sql: 'UPDATE root_runs SET state=state WHERE tenant_id=?', args: [tenantId] })
      const cancellation = Promise.all(roots.map(root =>
        request({ method: 'POST', url: '/chat/cancel', payload: { sessionId: root.sessionId } })))
      const snapshots = Promise.all(children.map(async ({ runId }) => {
        await store.appendSnapshot(tenantId, runId, 'started', { status: 'running', startedAt: Date.now() })
        return store.appendSnapshot(tenantId, runId, 'finished', {
          status: 'succeeded', resultSummary: 'Persisted concurrent review', finishedAt: Date.now(),
        })
      }))
      // Attach rejection handlers before releasing the transaction.
      const combined = Promise.all([cancellation, snapshots])
      void combined.catch(() => {})
      const health = await app.inject({ method: 'GET', url: '/health', headers })
      expect(health.json()).toMatchObject({ code: 200, data: { status: 'ok' } })
      await new Promise(resolve => setTimeout(resolve, 30))
      await tx.commit()
      ;[responses, updated] = await combined
    } finally { tx.close() }

    for (const response of responses) {
      expect(response.statusCode, response.body).toBe(200)
      expect(response.json(), response.body).toMatchObject({ code: 200, data: { cancelled: true } })
    }
    expect(updated).toHaveLength(15)
    for (const root of roots) expect((await rootRunStore.get(tenantId, root.runId))?.status).toBe('cancelled')
    const outbox = await store.listPendingParentProjections(tenantId)
    for (const { runId } of children) {
      expect((await store.getRun(tenantId, runId))?.status).toBe('succeeded')
      expect((await store.listEvents(tenantId, runId)).map(event => event.seq)).toEqual([1, 2, 3])
      expect(outbox.filter(item => item.event.runId === runId).map(item => item.event.seq)).toEqual([1, 2, 3])
    }
  }, 15_000)

  it('closing the real HTTP server waits for owned background processes to stop', async () => {
    const { job, marker } = await writingJob('server-shutdown')
    await app.close()
    expect((await commandJobs.get({ tenantId, sessionId: job.sessionId }, job.jobId))?.status).toBe('cancelled')
    await assertStopped(marker)
  }, 10_000)
})
