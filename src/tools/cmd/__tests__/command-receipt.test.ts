import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CommandJobManager, commandJobs, type CommandJobSnapshot, type CommandOutputEntry } from '../../../core/command-jobs/index.js'
import type { AgentContext } from '../../../core/agent-context/index.js'
import { boundedToolContext } from '../../../core/agent-loop/tool-output-limit.js'
import { formatCommandReceipt, readCommandReceipt } from '../command-receipt.js'
import { commandOutputTool } from '../job-tools.js'

let db: Client
let manager: CommandJobManager
const scope = { tenantId: 'receipt-test', sessionId: 'receipt-session' }

beforeEach(async () => {
  db = createClient({ url: 'file::memory:' })
  manager = new CommandJobManager({ db })
  await manager.initialize()
})
afterEach(async () => {
  vi.restoreAllMocks()
  await manager.shutdown('test_cleanup')
  db.close()
})

async function seed(entries: CommandOutputEntry[], overrides: Partial<CommandJobSnapshot> = {}) {
  const job: CommandJobSnapshot = { schemaVersion: 1, jobId: 'receipt-job', ...scope,
    ownerSessionId: scope.sessionId, version: 1, status: 'succeeded', command: 'private-executable',
    args: ['private-argument'.repeat(1000)], cwd: '/isolated-fixture', background: true,
    createdAt: Date.now(), updatedAt: Date.now(), exitCode: 0, signal: null,
    cursor: entries.at(-1)?.seq ?? 0, earliestCursor: 0, ...overrides }
  await db.execute({ sql: 'INSERT INTO command_jobs(tenant_id,session_id,job_id,status,version,snapshot,entries) VALUES(?,?,?,?,?,?,?)',
    args: [scope.tenantId, scope.sessionId, job.jobId, job.status, job.version, JSON.stringify(job), '[]'] })
  if (entries.length) await db.batch(entries.map(entry => ({
    sql: 'INSERT INTO command_job_output(tenant_id,session_id,job_id,seq,stream,text) VALUES(?,?,?,?,?,?)',
    args: [scope.tenantId, scope.sessionId, job.jobId, entry.seq, entry.stream, entry.text],
  })), 'write')
  return job
}

describe('budget-safe command model receipts', () => {
  it('round-trips escaped output and oversized entries in stream order with exact continuation', async () => {
    const source: CommandOutputEntry[] = [
      { seq: 1, stream: 'stdout', text: '中🙂\0\n"\\\u0001'.repeat(180) },
      { seq: 2, stream: 'stderr', text: 'stderr\0🧪\r\n'.repeat(30) },
      { seq: 3, stream: 'stdout', text: 'done' },
    ]
    const job = await seed(source)
    const restored = new Map<number, string>()
    let cursor = 0, cursorOffset = 0, pages = 0
    for (;;) {
      const result = await readCommandReceipt(scope, job.jobId, { cursor, cursorOffset, maxChars: 480, manager })
      expect(result?.error).toBeUndefined()
      expect(result!.output.length).toBeLessThanOrEqual(480)
      expect(result!.output).not.toContain('private-argument')
      expect(result!.job.args).toEqual(job.args)
      const receipt = JSON.parse(result!.output)
      expect(receipt).toEqual(result!.receipt)
      expect(receipt).toMatchObject({ type: 'command_result', version: 1, jobId: job.jobId })
      for (const entry of receipt.entries as CommandOutputEntry[]) {
        expect(entry.stream).toBe(source.find(original => original.seq === entry.seq)!.stream)
        expect(entry.text).not.toContain('\uFFFD')
        restored.set(entry.seq, (restored.get(entry.seq) ?? '') + entry.text)
      }
      expect(receipt.nextCursor > cursor || (receipt.nextCursor === cursor && receipt.nextOffset > cursorOffset)).toBe(true)
      cursor = receipt.nextCursor; cursorOffset = receipt.nextOffset
      expect(++pages).toBeLessThan(200)
      if (!receipt.hasMore) break
    }
    expect(pages).toBeGreaterThan(10)
    expect([...restored]).toEqual(source.map(entry => [entry.seq, entry.text]))
    expect({ cursor, cursorOffset }).toEqual({ cursor: 3, cursorOffset: 0 })
    expect((await readCommandReceipt(scope, job.jobId, { cursor, cursorOffset, maxChars: 480, manager }))!.receipt)
      .toMatchObject({ entries: [], nextCursor: 3, nextOffset: 0, hasMore: false })
  })

  it('uses the invocation budget, not the larger Code/global cap, and retains metadata identity', async () => {
    const job = await seed([{ seq: 1, stream: 'stdout', text: '"\\\0'.repeat(1000) }])
    vi.spyOn(commandJobs, 'output').mockImplementation((...args) => manager.output(...args))
    const ctx = boundedToolContext({ ...scope, toolProfile: 'code' } as AgentContext, 420)
    const result = await commandOutputTool.execute({ jobId: job.jobId }, ctx)
    expect(result.success).toBe(true)
    expect(result.output.length).toBeLessThanOrEqual(420)
    expect(JSON.parse(result.output)).toMatchObject({ hasMore: true, nextCursor: 0, nextOffset: expect.any(Number) })
    expect(result.metadata?.commandJob).toEqual(job)
  })

  it('returns an actionable budget failure without a pretend page or cursor advancement', async () => {
    const job = await seed([{ seq: 1, stream: 'stdout', text: 'first output' }])
    const tiny = await readCommandReceipt(scope, job.jobId, { maxChars: 120, manager })
    expect(tiny).toMatchObject({ error: 'COMMAND_OUTPUT_BUDGET_TOO_SMALL' })
    expect(tiny!.output).toContain('Retry command_output')
    expect(tiny!.output.length).toBeLessThanOrEqual(120)
    expect(tiny!.receipt).toBeUndefined()
    expect((await readCommandReceipt(scope, job.jobId, { maxChars: 500, manager }))!.receipt)
      .toMatchObject({ entries: [{ text: 'first output' }], nextCursor: 1, nextOffset: 0 })
  })

  it('keeps failure codes and genuine terminal state when diagnostic text exceeds the allowance', async () => {
    const job = await seed([], { status: 'failed', exitCode: null, error: { code: 'COMMAND_SPAWN_FAILED', message: 'long diagnostic '.repeat(1000) } })
    const result = formatCommandReceipt(job, { maxChars: 350 })
    expect(result.output.length).toBeLessThanOrEqual(350)
    expect(result.receipt).toMatchObject({ status: 'failed', exitCode: null, error: { code: 'COMMAND_SPAWN_FAILED' } })
  })

  it('budgets whole file versions with honest omitted counts and coverage warnings', async () => {
    const changes = Array.from({ length: 20 }, (_, index) => ({ id: `change-${index}`, path: `files/output-${index}.txt`, kind: 'write',
      oldHash: 'sha256:' + 'a'.repeat(64), newHash: 'sha256:' + 'b'.repeat(64), status: 'pending', secretExtra: 'do-not-project' }))
    const job = await seed([{ seq: 1, stream: 'stdout', text: 'command log '.repeat(1000) }], { changes,
      changeTracking: { status: 'partial', root: '/isolated-fixture', note: 'bounded', skippedCount: 2, skippedReasons: { 'file-size-limit': 2 }, recordedCount: 20 } })
    const result = await readCommandReceipt(scope, job.jobId, { maxChars: 2400, manager })
    expect(result?.error).toBeUndefined()
    expect(result!.output.length).toBeLessThanOrEqual(2400)
    const files = result!.receipt!.fileChanges!
    expect(JSON.stringify(files).length + '"fileChanges":,'.length).toBeLessThanOrEqual(800)
    expect(files).toMatchObject({ count: 20, omittedCount: 20 - files.changes.length,
      coverage: { status: 'partial', warning: expect.stringContaining('覆盖不完整'), rollback: expect.stringContaining('明确选择变更 ID') },
      details: expect.stringContaining('界面查看') })
    expect(files.changes.length).toBeGreaterThan(0)
    for (const change of files.changes) {
      expect(change).toMatchObject({ oldHash: changes[0].oldHash, newHash: changes[0].newHash })
      expect(change).not.toHaveProperty('secretExtra')
    }
    expect(result!.receipt!.entries.length).toBeGreaterThan(0)
    expect(result!.job.changes).toEqual(changes)
    const tiny = await readCommandReceipt(scope, job.jobId, { maxChars: 300, manager })
    expect(tiny!.error).toBe('COMMAND_OUTPUT_BUDGET_TOO_SMALL')
    expect(tiny!.receipt).toBeUndefined()
  })

  it('formats launch/cancel without pretending to consume output and rejects foreign access', async () => {
    const job = await seed([{ seq: 1, stream: 'stdout', text: 'still unread' }], { status: 'cancelled', exitCode: null })
    expect(formatCommandReceipt(job, { maxChars: 500 }).receipt)
      .toMatchObject({ status: 'cancelled', entries: [], nextCursor: 0, nextOffset: 0, hasMore: true })
    expect(await readCommandReceipt({ ...scope, sessionId: 'foreign' }, job.jobId, { maxChars: 500, manager })).toBeNull()
  })
})
