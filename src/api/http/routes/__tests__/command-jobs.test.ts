import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { FastifyInstance, InjectOptions } from 'fastify'
import type { Client, TransactionMode } from '@libsql/client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { CommandJobLaunch, CommandJobSnapshot } from '../../../../core/command-jobs/types.js'

let app: FastifyInstance
let fixture: string
const fixtureRoot = path.resolve('.e2e-tmp/command-receipts')
let closeDb: () => void
let db: Client
let commandJobs: typeof import('../../../../core/command-jobs/index.js').commandJobs
let rootRunStore: typeof import('../../../../storage/root-runs/index.js').rootRunStore
let history: ReturnType<typeof import('../../../../storage/conversation/factory.js').createConversationHistory>
const tenantId = 'd7-http-tenant'
const token = 'd7-http-fixture-instance-token'
const headers = { 'X-Aether-Instance-Token': token, 'X-Aether-Tool-Profile': 'code', 'X-Test-Tenant': tenantId }

beforeAll(async () => {
  fs.mkdirSync(fixtureRoot, { recursive: true })
  fixture = fs.mkdtempSync(path.join(fixtureRoot, 'http-'))
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
  if (path.dirname(resolved) !== fixtureRoot || !path.basename(resolved).startsWith('http-')) {
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
      ['POST', '/command-jobs/missing/restart', { sessionId: 'auth' }],
      ['DELETE', '/command-jobs/missing?sessionId=auth', undefined],
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
      'cursorOffset=-1', 'cursorOffset=0.5', 'cursorOffset=nope', 'cursorOffset=9007199254740992',
      'tail=1', 'tail=', 'tail=TRUE', 'tail=true&cursor=0', 'tail=true&cursorOffset=0',
      'maxBytes=0', 'maxBytes=-1', 'maxBytes=0.5', 'maxBytes=nope', 'maxBytes=1', 'maxBytes=3', 'maxBytes=65537']) {
      const result = await request({ method: 'GET', url: `/command-jobs/${job.jobId}/output?sessionId=${job.sessionId}&${query}` })
      expect(result.statusCode, `${query}: ${result.body}`).toBe(400)
      expect(result.json().data).toBeNull()
    }
  })

  it('continues a partial Unicode entry through HTTP without losing or repeating text', async () => {
    const text = '😀中文\\\"\n'.repeat(15)
    const job = await start('partial-unicode-http', `process.stdout.write(${JSON.stringify(text)});`)
    await commandJobs.wait({ tenantId, sessionId: job.sessionId }, job.jobId)
    let cursor = 0, offset = 0, joined = '', pages = 0
    do {
      const response = await request({ method: 'GET', url: `/command-jobs/${job.jobId}/output?sessionId=${job.sessionId}&cursor=${cursor}&cursorOffset=${offset}&maxBytes=16` })
      expect(response.statusCode, response.body).toBe(200)
      const page = response.json().data
      const fragment = page.entries.map((entry: { text: string }) => entry.text).join('')
      expect(Buffer.byteLength(fragment)).toBeLessThanOrEqual(16)
      expect(fragment).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
      joined += fragment
      cursor = page.nextCursor; offset = page.nextOffset; pages++
      if (!page.hasMore) break
      expect(pages).toBeLessThan(100)
    } while (true)
    expect(pages).toBeGreaterThan(1)
    expect(joined).toBe(text)
    expect(offset).toBe(0)
  })

  it('reads one bounded tail page, then resumes from its returned cursor without replaying history', async () => {
    const text = 'earlier-output\n'.repeat(1000) + 'recent😀中文\n'.repeat(80)
    const job = await start('tail-output-http', `process.stdout.write(${JSON.stringify(text)});`)
    await commandJobs.wait({ tenantId, sessionId: job.sessionId }, job.jobId)
    const response = await request({ method: 'GET', url: `/command-jobs/${job.jobId}/output?sessionId=${job.sessionId}&tail=true&maxBytes=128` })
    expect(response.statusCode, response.body).toBe(200)
    const tail = response.json().data
    const fragment = tail.entries.map((entry: { text: string }) => entry.text).join('')
    expect(tail.tail).toBe(true)
    expect(Buffer.byteLength(fragment)).toBeLessThanOrEqual(128)
    expect(fragment.length).toBeGreaterThan(0)
    expect(text.endsWith(fragment)).toBe(true)
    expect(fragment).not.toContain('earlier-output')
    expect(fragment).not.toContain('\uFFFD')
    const next = await request({ method: 'GET', url: `/command-jobs/${job.jobId}/output?sessionId=${job.sessionId}&cursor=${tail.nextCursor}&cursorOffset=${tail.nextOffset}&maxBytes=128` })
    expect(next.statusCode, next.body).toBe(200)
    expect(next.json().data.entries).toEqual([])
    expect(next.json().data.hasMore).toBe(false)
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
  }, 15_000)

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

  it('rejects a restart requiring current approval even if the prior command was approved', async () => {
    const sessionId = 'restart-needs-new-approval'
    const scope = { tenantId, sessionId }
    const { workspaceManager } = await import('../../../../workspace/index.js')
    const { approveCommand, setSecurityMode, clearSecurityMode } = await import('../../../../security/policy-engine.js')
    const cwd = workspaceManager.getScratchDirectory(scope)
    fs.mkdirSync(cwd, { recursive: true })
    const marker = path.join(cwd, 'starts.txt')
    const original = await start(sessionId, `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'started\\n')`, { cwd })
    await commandJobs.wait(scope, original.jobId)
    approveCommand(tenantId, sessionId, original.command, original.args)
    setSecurityMode(tenantId, sessionId, 'safe')
    const launchSpy = vi.spyOn(commandJobs, 'start')
    try {
      const response = await request({ method: 'POST', url: `/command-jobs/${original.jobId}/restart`, payload: {
        sessionId, approved: true, approvedToolCallId: 'forged', currentToolCallId: 'forged',
        resumeToolCall: { decision: 'approved' }, securityMode: 'full-access',
      } })
      expect(response.statusCode, response.body).toBe(409)
      expect(response.json()).toMatchObject({ code: 40900, data: null, metadata: { code: 'COMMAND_RESTART_APPROVAL_REQUIRED' } })
      expect(response.json().message).toContain('当前会话重新执行')
      expect(launchSpy).not.toHaveBeenCalled()
      expect(fs.readFileSync(marker, 'utf8')).toBe('started\n')
    } finally { launchSpy.mockRestore(); clearSecurityMode(tenantId, sessionId) }
  })

  it('applies hard command policy to historical jobs even under full access', async () => {
    const sessionId = 'restart-hard-policy'
    const { setSecurityMode, clearSecurityMode } = await import('../../../../security/policy-engine.js')
    // The legacy low-level admission completes harmlessly, but its arguments
    // contain a deletion operation that the current tool policy forbids.
    const original = await start(sessionId, '', { args: ['-e', "if(false) require('node:fs').rmSync('unused')"] })
    await commandJobs.wait({ tenantId, sessionId }, original.jobId)
    setSecurityMode(tenantId, sessionId, 'full-access')
    const launchSpy = vi.spyOn(commandJobs, 'start')
    try {
      const response = await request({ method: 'POST', url: `/command-jobs/${original.jobId}/restart`, payload: { sessionId } })
      expect(response.statusCode, response.body).toBe(403)
      expect(response.json()).toMatchObject({ code: 40300, metadata: { code: 'COMMAND_RESTART_POLICY_DENIED' } })
      expect(response.json().message).toContain('delete_file')
      expect(launchSpy).not.toHaveBeenCalled()
    } finally { launchSpy.mockRestore(); clearSecurityMode(tenantId, sessionId) }
  })

  it('rejects a historical background build through the same source guard before launching', async () => {
    const sessionId = 'restart-source-guard', scope = { tenantId, sessionId }
    const { setSecurityMode, clearSecurityMode } = await import('../../../../security/policy-engine.js')
    const cwd = path.join(fixture, 'restart-build')
    fs.mkdirSync(path.join(cwd, 'src'), { recursive: true })
    fs.writeFileSync(path.join(cwd, 'package.json'), '{"name":"restart-source-fixture","version":"1.0.0"}')
    fs.writeFileSync(path.join(cwd, 'src', 'main.ts'), 'export const value = 1\n')
    const marker = path.join(cwd, 'starts.txt'), script = path.join(cwd, 'build.cjs')
    fs.writeFileSync(script, `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'started\\n')`)
    const original = await start(sessionId, '', { cwd, args: [script] })
    await commandJobs.wait(scope, original.jobId)
    setSecurityMode(tenantId, sessionId, 'full-access')
    const launchSpy = vi.spyOn(commandJobs, 'start')
    try {
      const response = await request({ method: 'POST', url: `/command-jobs/${original.jobId}/restart`, payload: { sessionId } })
      expect(response.statusCode, response.body).toBe(409)
      expect(response.json()).toMatchObject({ code: 40900, metadata: { code: 'SOURCE_GUARD_REQUIRES_FOREGROUND' } })
      expect(launchSpy).not.toHaveBeenCalled()
      expect(fs.readFileSync(marker, 'utf8')).toBe('started\n')
    } finally { launchSpy.mockRestore(); clearSecurityMode(tenantId, sessionId) }
  })

  it('does not restore the old working directory as a permitted root after the session becomes safe', async () => {
    const sessionId = 'restart-workspace-boundary'
    const original = await start(sessionId, "process.stdout.write('initial')")
    await commandJobs.wait({ tenantId, sessionId }, original.jobId)
    const { setSecurityMode, clearSecurityMode } = await import('../../../../security/policy-engine.js')
    setSecurityMode(tenantId, sessionId, 'safe')
    const launchSpy = vi.spyOn(commandJobs, 'start')
    try {
      const response = await request({ method: 'POST', url: `/command-jobs/${original.jobId}/restart`, payload: { sessionId } })
      expect(response.statusCode, response.body).toBe(403)
      expect(response.json()).toMatchObject({ code: 40300, metadata: { code: 'COMMAND_RESTART_WORKSPACE_FORBIDDEN' } })
      expect(launchSpy).not.toHaveBeenCalled()
    } finally { launchSpy.mockRestore(); clearSecurityMode(tenantId, sessionId) }
  })

  it('uses the current environment projection and records restart file changes under its new identity', async () => {
    const sessionId = 'restart-environment-observer', scope = { tenantId, sessionId }
    const { workspaceManager } = await import('../../../../workspace/index.js')
    const cwd = workspaceManager.getScratchDirectory(scope)
    fs.mkdirSync(cwd, { recursive: true })
    const marker = path.join(cwd, 'changes.txt')
    const original = await start(sessionId, `
      require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'executed\\n');
      console.log(JSON.stringify({ home: process.env.HOME, secret: process.env.RESTART_PRIVATE_FIXTURE ?? null,
        local: process.env.LOCALAPPDATA ?? null, automatic: process.env.PYTHON_MANAGER_AUTOMATIC_INSTALL ?? null }));
    `, { cwd })
    await commandJobs.wait(scope, original.jobId)
    const oldSecret = process.env.RESTART_PRIVATE_FIXTURE, oldAutomatic = process.env.PYTHON_MANAGER_AUTOMATIC_INSTALL
    vi.stubEnv('RESTART_PRIVATE_FIXTURE', 'private-fixture-value')
    vi.stubEnv('PYTHON_MANAGER_AUTOMATIC_INSTALL', 'true')
    try {
      const response = await request({ method: 'POST', url: `/command-jobs/${original.jobId}/restart`, payload: { sessionId } })
      expect(response.statusCode, response.body).toBe(200)
      const restarted = response.json().data as CommandJobSnapshot
      const finished = await commandJobs.wait(scope, restarted.jobId)
      expect(finished?.status).toBe('succeeded')
      expect(finished?.changes).toEqual(expect.arrayContaining([expect.objectContaining({ path: marker,
        source: 'command-observation', commandJobId: restarted.jobId, requiresExplicitRevert: true })]))
      expect(finished?.changeTracking?.status).not.toBe('unavailable')
      const output = await commandJobs.output(scope, restarted.jobId)
      const env = JSON.parse(output!.entries.map(entry => entry.text).join(''))
      expect(env).toMatchObject({ home: cwd, secret: null })
      if (process.platform === 'win32') expect(env).toMatchObject({ local: process.env.LOCALAPPDATA ?? null, automatic: 'false' })
      expect(fs.readFileSync(marker, 'utf8')).toBe('executed\nexecuted\n')
      for (const field of ['runId', 'ownerRunId', 'turnId', 'toolCallId']) expect(restarted).not.toHaveProperty(field)
    } finally { vi.stubEnv('RESTART_PRIVATE_FIXTURE', oldSecret); vi.stubEnv('PYTHON_MANAGER_AUTOMATIC_INSTALL', oldAutomatic) }
  })

  it('rejects restart with a visible conflict while the current workspace binding is held', async () => {
    const sessionId = 'restart-binding-busy', scope = { tenantId, sessionId }
    const original = await start(sessionId, "process.stdout.write('initial')")
    await commandJobs.wait(scope, original.jobId)
    const { workspaceManager } = await import('../../../../workspace/index.js')
    let enter!: () => void, release!: () => void
    const held = new Promise<void>(resolve => { enter = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const holder = workspaceManager.withBindingLease(scope, undefined, async () => { enter(); await gate })
    await held
    const launchSpy = vi.spyOn(commandJobs, 'start')
    try {
      const response = await request({ method: 'POST', url: `/command-jobs/${original.jobId}/restart`, payload: { sessionId } })
      expect(response.statusCode, response.body).toBe(409)
      expect(response.json()).toMatchObject({ code: 40900, metadata: { code: 'COMMAND_RESTART_WORKSPACE_BUSY' } })
      expect(launchSpy).not.toHaveBeenCalled()
    } finally { release(); await holder; launchSpy.mockRestore() }
  })

  it('does not launch when the configured output allowance cannot carry a job receipt', async () => {
    const sessionId = 'restart-receipt-budget', scope = { tenantId, sessionId }
    const original = await start(sessionId, "process.stdout.write('initial')")
    await commandJobs.wait(scope, original.jobId)
    const previous = process.env.CODE_TOOL_OUTPUT_MAX_CHARS
    vi.stubEnv('CODE_TOOL_OUTPUT_MAX_CHARS', '100')
    const launchSpy = vi.spyOn(commandJobs, 'start')
    try {
      const response = await request({ method: 'POST', url: `/command-jobs/${original.jobId}/restart`, payload: { sessionId } })
      expect(response.statusCode, response.body).toBe(409)
      expect(response.json()).toMatchObject({ code: 40900, metadata: { code: 'COMMAND_OUTPUT_BUDGET_TOO_SMALL' } })
      expect(launchSpy).not.toHaveBeenCalled()
    } finally { vi.stubEnv('CODE_TOOL_OUTPUT_MAX_CHARS', previous); launchSpy.mockRestore() }
  })

  it('restarts terminal background history with a new identity and deletes output and snapshot', async () => {
    const sessionId = 'restart-delete-history'
    const original = await start(sessionId, `
      process.stdout.write('historical-output');
      console.log(JSON.stringify({ cwd: process.cwd(), restartMarker: process.env.RESTART_MARKER ?? null }));
    `, { runId: 'old-run', ownerRunId: 'old-owner-run', turnId: 'old-turn', toolCallId: 'old-tool' })
    await commandJobs.wait({ tenantId, sessionId }, original.jobId)
    const ignored = { command: path.join(fixture, 'client-command'), args: ['--client'], cwd: path.dirname(fixture), env: { CLIENT_SECRET: 'ignored' } }
    const restartedResponse = await request({ method: 'POST', url: `/command-jobs/${original.jobId}/restart`, payload: { sessionId, ...ignored } })
    expect(restartedResponse.statusCode, restartedResponse.body).toBe(200)
    const restarted = restartedResponse.json().data as CommandJobSnapshot
    expect(restarted).toMatchObject({ sessionId, ownerSessionId: sessionId, command: original.command, args: original.args,
      cwd: original.cwd, background: true })
    for (const field of ['runId', 'ownerRunId', 'turnId', 'toolCallId']) expect(restarted).not.toHaveProperty(field)
    expect(restarted.jobId).not.toBe(original.jobId)
    const finished = await commandJobs.wait({ tenantId, sessionId }, restarted.jobId)
    expect(finished?.status, JSON.stringify(finished)).toBe('succeeded')
    const restartedOutput = await commandJobs.output({ tenantId, sessionId }, restarted.jobId)
    expect(restartedOutput?.entries.map(entry => entry.text).join('')).toContain(JSON.stringify({ cwd: original.cwd, restartMarker: null }))
    expect((await getJob(original)).json().data).toMatchObject({ jobId: original.jobId, status: 'succeeded' })
    const digest = (value: string) => createHash('sha256').update(value).digest('hex')
    const logPath = path.join(`${path.join(fixture, 'agent.db')}.command-output`, digest(tenantId), digest(sessionId), `${digest(original.jobId)}.log`)
    expect(fs.existsSync(logPath)).toBe(true)

    const deleted = await request({ method: 'DELETE', url: `/command-jobs/${original.jobId}?sessionId=${sessionId}` })
    expect(deleted.statusCode, deleted.body).toBe(200)
    expect(deleted.json()).toMatchObject({ code: 200, data: { deleted: true } })
    expect((await getJob(original)).statusCode).toBe(404)
    expect((await getJob(original)).json().code).toBe(40400)
    const deletedRows = await db.execute({ sql: 'SELECT COUNT(*) AS count FROM command_jobs WHERE tenant_id=? AND session_id=? AND job_id=?', args: [tenantId, sessionId, original.jobId] })
    expect(Number(deletedRows.rows[0]?.count)).toBe(0)
    expect(Number((await db.execute({ sql: 'SELECT COUNT(*) AS count FROM command_job_output WHERE job_id=?', args: [original.jobId] })).rows[0]?.count)).toBe(0)
    expect(fs.existsSync(logPath)).toBe(false)
    expect((await request({ method: 'GET', url: `/command-jobs/${original.jobId}/output?sessionId=${sessionId}` })).statusCode).toBe(404)
    const replacementRows = await db.execute({ sql: 'SELECT COUNT(*) AS count FROM command_jobs WHERE job_id=?', args: [restarted.jobId] })
    expect(Number(replacementRows.rows[0]?.count)).toBe(1)
  })

  it('conceals restart and deletion across tenant and session scopes and rejects active background jobs', async () => {
    const { job, marker } = await writingJob('restart-delete-scopes')
    for (const [selectedTenant, selectedSession] of [['foreign-tenant', job.sessionId], [tenantId, 'foreign-session']]) {
      const tenantHeaders = { 'X-Test-Tenant': selectedTenant }
      for (const result of [
        await request({ method: 'POST', url: `/command-jobs/${job.jobId}/restart`, payload: { sessionId: selectedSession }, headers: tenantHeaders }),
        await request({ method: 'DELETE', url: `/command-jobs/${job.jobId}?sessionId=${selectedSession}`, headers: tenantHeaders }),
      ]) {
        expect(result.statusCode, result.body).toBe(404)
        expect(result.json()).toMatchObject({ code: 40400, data: null })
      }
    }
    await assertStillWriting(marker)
    for (const result of [
      await request({ method: 'POST', url: `/command-jobs/${job.jobId}/restart`, payload: { sessionId: job.sessionId } }),
      await request({ method: 'DELETE', url: `/command-jobs/${job.jobId}?sessionId=${job.sessionId}` }),
    ]) {
      expect(result.statusCode, result.body).toBe(409)
      expect(result.json()).toMatchObject({ code: 40900, data: null })
    }
    expect((await getJob(job)).json().data.status).toBe('running')
    await commandJobs.cancel({ tenantId, sessionId: job.sessionId }, job.jobId, 'fixture completed')
  }, 15_000)

  it('awaits real process cancellation and returns the same terminal result on duplicate stop', async () => {
    const { job, marker } = await writingJob('cancel-handle')
    const first = await request({ method: 'POST', url: `/command-jobs/${job.jobId}/cancel`, payload: { sessionId: job.sessionId } })
    expect(first.statusCode, first.body).toBe(200)
    expect(first.json().data).toMatchObject({ jobId: job.jobId, status: 'cancelled' })
    await assertStopped(marker)
    const again = await request({ method: 'POST', url: `/command-jobs/${job.jobId}/cancel`, payload: { sessionId: job.sessionId } })
    expect(again.json().data).toEqual(first.json().data)
  // Windows process-tree discovery has its own 8s deadline before taskkill.
  }, 15_000)

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
  }, 30_000)

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
      expect(failed.json()).toMatchObject({ code: 50000, message: 'SESSION_CLEANUP_UNKNOWN' })
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
  }, 15_000)

  it('owned cancellation cannot abort a newer run or its commands in the same session', async () => {
    const sessionId = 'owned-cancel-race'
    const old = await rootRunStore.create(tenantId, sessionId, 'fixture-model', [fixture], {})
    await rootRunStore.update(tenantId, old.runId, { status: 'succeeded' })
    const newer = await rootRunStore.create(tenantId, sessionId, 'fixture-model', [fixture], {})
    const { StreamBus, activeStreams } = await import('../../../../core/stream-pipeline/stream-bus.js')
    const controller = new AbortController()
    const bus = new StreamBus(controller)
    bus.push('\x00__run__' + JSON.stringify(newer))
    const key = tenantId + ':' + sessionId
    activeStreams.set(key, bus)
    const { job, marker } = await writingJob(sessionId, { runId: newer.runId, turnId: newer.turnId })
    try {
      const stale = await request({ method: 'POST', url: '/chat/cancel', payload: { sessionId, runId: old.runId } })
      expect(stale.json().data.cancelled).toBe(false)
      expect(controller.signal.aborted).toBe(false)
      expect((await rootRunStore.get(tenantId, newer.runId))?.status).toBe('running')
      await assertStillWriting(marker)
      const owned = await request({ method: 'POST', url: '/chat/cancel', payload: { sessionId, runId: newer.runId } })
      expect(owned.json().data.cancelled).toBe(true)
      expect(controller.signal.aborted).toBe(true)
      expect((await commandJobs.get({ tenantId, sessionId }, job.jobId))?.status).toBe('cancelled')
      await assertStopped(marker)
    } finally { activeStreams.delete(key); await commandJobs.cancel({ tenantId, sessionId }, job.jobId, 'fixture cleanup') }
  }, 10_000)

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
    const originalTransaction = db.transaction.bind(db)
    let held = false
    const dbSpy = vi.spyOn(db, 'transaction').mockImplementation(async (mode?: TransactionMode) => {
      // The manager now writes the snapshot and disk-log index in a native
      // transaction. Pause its first admission before acquiring the writer,
      // so the real HTTP cancellation can still inspect and fence the owner.
      if (!held && mode === 'write') {
        held = true
        entered()
        await gate
      }
      return originalTransaction(mode)
    })
    const originalCancel = commandJobs.cancelCaptured.bind(commandJobs)
    const cancelSpy = vi.spyOn(commandJobs, 'cancelCaptured').mockImplementation(async (...args) => {
      const result = originalCancel(...args)
      // The HTTP stop fences a captured set before waiting for its held
      // admission. A broad cancelScope lookup is no longer part of that path.
      stopping()
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
      expect(outbox.filter(item => item.event.runId === runId).map(item => item.event.seq)).toEqual([3])
    }
  }, 15_000)

  it('closing the real HTTP server waits for owned background processes to stop', async () => {
    const { job, marker } = await writingJob('server-shutdown')
    await app.close()
    expect((await commandJobs.get({ tenantId, sessionId: job.sessionId }, job.jobId))?.status).toBe('cancelled')
    await assertStopped(marker)
  }, 10_000)
})
