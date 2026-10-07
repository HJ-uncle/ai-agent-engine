/** Real Node children and SQLite: no mocked process lifecycle or output stream. */
import { createClient, type Client } from '@libsql/client'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CommandJobManager } from '../manager.js'
import type { CommandJobLaunch, CommandJobOutput, CommandJobScope, CommandJobSnapshot } from '../types.js'

let fixture: string
let db: Client
let manager: CommandJobManager
const managers: CommandJobManager[] = []
const fixturePids = new Set<number>()
const scope: CommandJobScope = { tenantId: 'tenant-a', sessionId: 'root-session' }
const exactScope: CommandJobScope = { ...scope, runId: 'root-run', ownerSessionId: 'child-session', ownerRunId: 'child-run' }

function launch(script: string, overrides: Partial<CommandJobLaunch> = {}): CommandJobLaunch {
  return { ...scope, ownerSessionId: 'child-session', runId: 'root-run', ownerRunId: 'child-run',
    turnId: 'turn-1', toolCallId: 'tool-1', command: process.execPath, args: ['-e', script], cwd: fixture,
    background: true, timeoutMs: 10_000, env: { ...process.env, D7_PRIVATE_SECRET: 'never-persist-environment' }, ...overrides }
}

function makeManager(options: { maxOutputBytes?: number; maxPageBytes?: number; maxConcurrentJobs?: number;
  maxRetainedJobs?: number; maxSessionJobs?: number; retentionMs?: number } = {}) {
  const instance = new CommandJobManager({ db, ...options })
  managers.push(instance)
  return instance
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function capturePid(name: string): Promise<number> {
  const file = path.join(fixture, name)
  await expect.poll(() => {
    if (!fs.existsSync(file)) return 0
    return Number(fs.readFileSync(file, 'utf8')) || 0
  }, { timeout: 5_000 }).toBeGreaterThan(0)
  const pid = Number(fs.readFileSync(file, 'utf8'))
  fixturePids.add(pid)
  return pid
}

async function output(jobId: string, options: { cursor?: number; maxBytes?: number } = {}): Promise<CommandJobOutput> {
  const result = await manager.output(scope, jobId, options)
  expect(result).not.toBeNull()
  return result!
}

function outputText(result: CommandJobOutput, stream?: 'stdout' | 'stderr'): string {
  return result.entries.filter(entry => !stream || entry.stream === stream).map(entry => entry.text).join('')
}

/** Null and a not-found exception are both safe lookup conventions; neither may return foreign data. */
async function expectInvisible(request: Promise<unknown>): Promise<void> {
  let returned: unknown
  try { returned = await request } catch (error) { expect(error).toBeInstanceOf(Error); return }
  expect(returned).toBeNull()
}

beforeEach(async () => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-d7-command-jobs-'))
  db = createClient({ url: `file:${path.join(fixture, 'jobs.db').replace(/\\/g, '/')}` })
  manager = makeManager()
  await manager.initialize()
})

afterEach(async () => {
  const shutdowns = await Promise.allSettled(managers.splice(0).map(instance => instance.shutdown('test_cleanup')))
  // Only PIDs emitted by this test's own children are eligible for emergency cleanup.
  for (const pid of fixturePids) {
    if (!alive(pid)) continue
    if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 3_000 })
    else { try { process.kill(pid, 'SIGKILL') } catch { /* already exited */ } }
  }
  fixturePids.clear()
  db.close()
  const resolved = path.resolve(fixture)
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('aether-d7-command-jobs-')) throw new Error('Unsafe fixture cleanup path')
  try { fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }) }
  catch (error) { if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error }
  const failedShutdown = shutdowns.find(result => result.status === 'rejected')
  if (failedShutdown?.status === 'rejected') throw failedShutdown.reason
})

describe('D7 durable command job lifecycle', () => {
  it('returns a running snapshot before completion and persists success without PID or environment', async () => {
    const job = await manager.start(launch(`
      const fs = require('node:fs');
      fs.writeFileSync('leader.pid', String(process.pid));
      const timer = setInterval(() => {
        if (fs.existsSync('release')) { clearInterval(timer); process.stdout.write('released'); }
      }, 10);
    `))
    expect(job).toMatchObject({ status: 'running', sessionId: scope.sessionId, ownerSessionId: 'child-session',
      runId: 'root-run', ownerRunId: 'child-run', exitCode: null })
    const pid = await capturePid('leader.pid')
    expect(alive(pid)).toBe(true)
    expect((await manager.get(exactScope, job.jobId))?.status).toBe('running')
    fs.writeFileSync(path.join(fixture, 'release'), 'go')
    const finished = await manager.wait(exactScope, job.jobId)
    expect(finished).toMatchObject({ jobId: job.jobId, status: 'succeeded', exitCode: 0 })
    expect(finished!.version).toBeGreaterThan(job.version)
    expect(finished!.finishedAt).toBeGreaterThanOrEqual(job.createdAt)
    expect(alive(pid)).toBe(false)
    expect(outputText(await output(job.jobId))).toBe('released')
    const stored = JSON.stringify((await db.execute('SELECT snapshot, entries FROM command_jobs')).rows)
    expect(stored).not.toContain('never-persist-environment')
    expect(finished).not.toHaveProperty('pid')
    expect(finished).not.toHaveProperty('env')
    expect(await manager.list(exactScope)).toEqual([finished])
  }, 15_000)

  it('preserves stderr and a nonzero exit as failed', async () => {
    const job = await manager.start(launch("process.stdout.write('partial work'); process.stderr.write('bad config'); process.exitCode = 7"))
    expect(await manager.wait(scope, job.jobId)).toMatchObject({ status: 'failed', exitCode: 7 })
    const page = await output(job.jobId)
    expect(outputText(page, 'stdout')).toBe('partial work')
    expect(outputText(page, 'stderr')).toBe('bad config')
  })

  it('records a spawn failure as a durable failed job', async () => {
    const job = await manager.start(launch('', { command: path.join(fixture, 'missing-command'), args: [] }))
    const finished = await manager.wait(scope, job.jobId)
    expect(finished).toMatchObject({ status: 'failed' })
    expect(finished?.error?.message).toMatch(/ENOENT|not found|spawn/i)
    expect(await manager.get(scope, job.jobId)).toEqual(finished)
  })

  it('reconstructs UTF-8 split across real stdout and stderr buffers without replacement characters', async () => {
    const job = await manager.start(launch(`
      const out = Buffer.from('中🙂文', 'utf8');
      const err = Buffer.from('错🧪误', 'utf8');
      let index = 0;
      const write = () => {
        if (index === out.length) return;
        process.stdout.write(out.subarray(index, index + 1));
        process.stderr.write(err.subarray(index, index + 1));
        index++; setTimeout(write, 15);
      };
      write();
    `))
    expect((await manager.wait(scope, job.jobId))?.status).toBe('succeeded')
    const page = await output(job.jobId)
    expect(outputText(page, 'stdout')).toBe('中🙂文')
    expect(outputText(page, 'stderr')).toBe('错🧪误')
    expect(outputText(page)).not.toContain('\uFFFD')
  })

  it('keeps memory bounded while persisting the complete output for paging', async () => {
    manager = makeManager({ maxOutputBytes: 96, maxPageBytes: 24 })
    await manager.initialize()
    const expected = Array.from({ length: 40 }, (_, index) => `${index.toString().padStart(2, '0')}:中🙂\n`).join('')
    const job = await manager.start(launch(`process.stdout.write(${JSON.stringify(expected)})`))
    await manager.wait(scope, job.jobId)
    const durable = await db.execute({ sql: 'SELECT COUNT(*) AS count FROM command_job_output WHERE job_id=?', args: [job.jobId] })
    expect(Number(durable.rows[0]?.count)).toBeGreaterThan(1)
    let page = await output(job.jobId, { cursor: 0, maxBytes: 24 })
    expect(page.truncated).toBe(false)
    expect(page.earliestCursor).toBe(0)
    expect(Buffer.byteLength(outputText(page), 'utf8')).toBeLessThanOrEqual(24)
    const entries = [...page.entries]
    let count = 0
    while (page.hasMore) {
      expect(++count).toBeLessThan(100)
      const cursor = page.nextCursor
      page = await output(job.jobId, { cursor, maxBytes: 24 })
      expect(page.nextCursor).toBeGreaterThan(cursor)
      expect(page.truncated).toBe(false)
      expect(Buffer.byteLength(outputText(page), 'utf8')).toBeLessThanOrEqual(24)
      entries.push(...page.entries)
    }
    const retained = entries.map(entry => entry.text).join('')
    expect(Buffer.byteLength(retained, 'utf8')).toBe(Buffer.byteLength(expected, 'utf8'))
    expect(retained).toBe(expected)
    expect(retained).not.toContain('\uFFFD')
    expect(entries.every((entry, index) => index === 0 || entry.seq > entries[index - 1].seq)).toBe(true)
    const empty = await output(job.jobId, { cursor: page.nextCursor })
    expect(empty.entries).toEqual([])
    expect(empty.nextCursor).toBe(page.nextCursor)
    expect(empty.hasMore).toBe(false)
    await expect(manager.output(scope, job.jobId, { cursor: page.nextCursor + 1 })).rejects.toThrow()
  })

  it.each([
    { label: 'tenant', selector: { tenantId: 'other-tenant' } },
    { label: 'session', selector: { sessionId: 'other-session' } },
    { label: 'root run', selector: { runId: 'other-root-run' } },
    { label: 'owner session', selector: { ownerSessionId: 'other-child-session' } },
    { label: 'owner run', selector: { ownerRunId: 'other-child-run' } },
  ])('denies foreign $label reads and cancellation without disturbing the real owner', async ({ selector }) => {
    const job = await manager.start(launch("require('node:fs').writeFileSync('leader.pid', String(process.pid)); process.stdout.write('private-output'); setInterval(() => {}, 1000)"))
    await capturePid('leader.pid')
    const foreign: CommandJobScope = { ...exactScope, ...selector }
    expect(await manager.list(foreign)).toEqual([])
    expect(await manager.get(foreign, job.jobId)).toBeNull()
    expect(await manager.wait(foreign, job.jobId)).toBeNull()
    await expectInvisible(manager.output(foreign, job.jobId))
    await expectInvisible(manager.cancel(foreign, job.jobId, 'foreign_cancel'))
    await manager.cancelScope(foreign, 'foreign_scope_cancel')
    expect((await manager.get(exactScope, job.jobId))?.status).toBe('running')
    await manager.cancel(exactScope, job.jobId, 'owner_cancel')
    expect((await manager.wait(scope, job.jobId))?.status).toBe('cancelled')
  })

  it.each(['cancel', 'timeout'] as const)('settles %s only after the leader and its real descendant have exited', async operation => {
    const childCode = "require('node:fs').writeFileSync('descendant.pid', String(process.pid)); setInterval(() => {}, 1000)"
    const script = `
      const fs = require('node:fs');
      fs.writeFileSync('leader.pid', String(process.pid));
      require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], { stdio: 'inherit', windowsHide: true });
      process.stdout.write('before stop');
      setInterval(() => {}, 1000);
    `
    const job = await manager.start(launch(script, { timeoutMs: operation === 'timeout' ? 2_000 : 10_000 }))
    const leader = await capturePid('leader.pid')
    const descendant = await capturePid('descendant.pid')
    expect(alive(leader)).toBe(true)
    expect(alive(descendant)).toBe(true)
    if (operation === 'cancel') await manager.cancel(exactScope, job.jobId, 'test_cancel')
    const finished = await manager.wait(scope, job.jobId)
    expect(finished?.status).toBe(operation === 'timeout' ? 'timed_out' : 'cancelled')
    expect(alive(leader)).toBe(false)
    expect(alive(descendant)).toBe(false)
    expect(outputText(await output(job.jobId))).toBe('before stop')
    const stable = await manager.cancel(exactScope, job.jobId, 'duplicate_cancel')
    expect(stable).toEqual(finished)
  }, 15_000)

  it('accepts an explicit deadline beyond Node timer range without overflowing or ending early', async () => {
    const job = await manager.start(launch('setInterval(() => {}, 1000)', { timeoutMs: 2_147_483_648 }))
    expect(job.status).toBe('running')
    await manager.cancel(exactScope, job.jobId, 'long_deadline_test')
    expect((await manager.wait(scope, job.jobId))?.status).toBe('cancelled')
  })

  it('cancels a live descendant after its leader has exited and prevents further marker writes', async () => {
    const descendantCode = `
      const fs = require('node:fs');
      fs.writeFileSync('descendant.pid', String(process.pid));
      fs.appendFileSync('descendant-marker', 'started\\n');
      setInterval(() => { fs.appendFileSync('descendant-marker', 'tick\\n'); }, 20);
    `
    const job = await manager.start(launch(`
      const fs = require('node:fs');
      fs.writeFileSync('leader.pid', String(process.pid));
      require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendantCode)}], {
        stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true, detached: process.platform === 'win32',
      });
      const ready = setInterval(() => {
        if (fs.existsSync('descendant-marker')) { clearInterval(ready); process.exit(0); }
      }, 10);
    `))
    const leader = await capturePid('leader.pid')
    const descendant = await capturePid('descendant.pid')
    await expect.poll(() => alive(leader), { timeout: 5_000 }).toBe(false)
    expect(alive(descendant)).toBe(true)
    const marker = path.join(fixture, 'descendant-marker')
    await expect.poll(() => fs.existsSync(marker), { timeout: 5_000 }).toBe(true)
    const initialSize = fs.statSync(marker).size
    await expect.poll(() => fs.statSync(marker).size, { timeout: 5_000 }).toBeGreaterThan(initialSize)
    expect((await manager.get(exactScope, job.jobId))?.status).toBe('running')

    const cancelled = await manager.cancel(exactScope, job.jobId, 'cancel_after_leader_exit')
    expect(cancelled?.status).toBe('cancelled')
    expect(alive(descendant)).toBe(false)
    const stoppedMarker = fs.readFileSync(marker, 'utf8')
    await new Promise(resolve => setTimeout(resolve, 160))
    expect(fs.readFileSync(marker, 'utf8')).toBe(stoppedMarker)
    expect((await manager.wait(exactScope, job.jobId))?.status).toBe('cancelled')
  }, 15_000)

  it('marks persisted running work interrupted on reopen without executing the saved command', async () => {
    const marker = path.join(fixture, 'must-not-replay')
    const now = Date.now()
    const stale: CommandJobSnapshot = {
      schemaVersion: 1, jobId: 'stale-job', sessionId: scope.sessionId, ownerSessionId: 'child-session',
      runId: 'root-run', ownerRunId: 'child-run', version: 3, status: 'running',
      command: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'replayed')`],
      cwd: fixture, background: true, createdAt: now, updatedAt: now, exitCode: null, signal: null, cursor: 1, earliestCursor: 0,
    }
    await db.execute({ sql: 'INSERT INTO command_jobs (tenant_id, session_id, job_id, status, version, snapshot, entries) VALUES (?, ?, ?, ?, ?, ?, ?)',
      args: [scope.tenantId, scope.sessionId, stale.jobId, stale.status, stale.version, JSON.stringify(stale), JSON.stringify([{ seq: 1, stream: 'stdout', text: 'before restart' }])] })
    await manager.shutdown('reopen_test')
    db.close()
    db = createClient({ url: `file:${path.join(fixture, 'jobs.db').replace(/\\/g, '/')}` })
    manager = makeManager()
    await manager.initialize()
    const interrupted = await manager.get(exactScope, stale.jobId)
    expect(interrupted).toMatchObject({ jobId: stale.jobId, status: 'interrupted', exitCode: null })
    expect(interrupted!.version).toBeGreaterThan(stale.version)
    expect(await manager.wait(exactScope, stale.jobId)).toEqual(interrupted)
    expect(outputText(await output(stale.jobId))).toBe('before restart')
    expect(fs.existsSync(marker)).toBe(false)
    expect(interrupted).not.toHaveProperty('pid')
    expect(interrupted).not.toHaveProperty('env')
  })

  it('bounds terminal history per session and globally while retaining active work and isolating other sessions', async () => {
    manager = makeManager({ maxSessionJobs: 2, maxRetainedJobs: 3, retentionMs: 60_000 })
    await manager.initialize()
    const active = await manager.start(launch("require('node:fs').writeFileSync('leader.pid', String(process.pid)); setInterval(() => {}, 1000)"))
    const pid = await capturePid('leader.pid')
    const otherScope = { ...scope, sessionId: 'other-session' }
    const other = await manager.start(launch("process.stdout.write('other-session retained')", { sessionId: otherScope.sessionId }))
    await manager.wait(otherScope, other.jobId)
    const completed: CommandJobSnapshot[] = []
    for (let index = 0; index < 3; index++) {
      const started = await manager.start(launch(`process.stdout.write('completed-${index}')`))
      completed.push((await manager.wait(scope, started.jobId))!)
    }
    expect((await manager.list(scope)).map(job => job.jobId)).toEqual([
      active.jobId, completed[1].jobId, completed[2].jobId,
    ])
    expect(await manager.get(scope, completed[0].jobId)).toBeNull()
    expect((await manager.list(otherScope)).map(job => job.jobId)).toEqual([other.jobId])
    expect((await manager.output(otherScope, other.jobId))?.entries.map(entry => entry.text).join('')).toBe('other-session retained')
    expect(await manager.get(scope, other.jobId)).toBeNull()
    expect(alive(pid)).toBe(true)

    const newestScope = { ...scope, sessionId: 'newest-session' }
    const newest = await manager.start(launch("process.stdout.write('newest')", { sessionId: newestScope.sessionId }))
    await manager.wait(newestScope, newest.jobId)
    expect(await manager.get(otherScope, other.jobId)).toBeNull()
    expect((await manager.get(scope, active.jobId))?.status).toBe('running')
    expect(alive(pid)).toBe(true)
    const rows = (await db.execute('SELECT status FROM command_jobs')).rows
    expect(rows.filter(row => row.status !== 'running' && row.status !== 'cancelling')).toHaveLength(3)
    expect(rows.filter(row => row.status === 'running')).toHaveLength(1)
    await manager.cancel(exactScope, active.jobId, 'retention_test_cleanup')
    expect(alive(pid)).toBe(false)
  }, 15_000)
})
