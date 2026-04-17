import { vi } from 'vitest'
import { createClient } from '@libsql/client'
import type { Client } from '@libsql/client'

// ─── Setup in-memory DB ────────────────────────────────────────────────────────

let testDb: Client

vi.mock('../../sqlite/db.js', () => ({
  getDb: () => testDb,
}))

// Import after mock is set up
const { SQLiteTaskQueue } = await import('../sqlite-queue.js')

// ─── Schema ───────────────────────────────────────────────────────────────────

const CREATE_JOBS = `
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    type TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending',
    result TEXT,
    error TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    started_at INTEGER,
    completed_at INTEGER
  );
`

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SQLiteTaskQueue', () => {
  beforeEach(async () => {
    testDb = createClient({ url: ':memory:' })
    await testDb.executeMultiple(CREATE_JOBS)
  })

  afterEach(() => {
    testDb.close()
  })

  // 1. enqueue returns a valid UUID
  it('enqueue returns a valid UUID', async () => {
    const queue = new SQLiteTaskQueue()
    const id = await queue.enqueue({ type: 'email', payload: { to: 'user@example.com' } })

    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  })

  // 2. getStatus returns correct job record
  it('getStatus returns correct job record after enqueue', async () => {
    const queue = new SQLiteTaskQueue()
    const id = await queue.enqueue({
      type: 'report',
      payload: { format: 'pdf' },
      tenantId: 'tenant-42',
    })

    const record = await queue.getStatus(id)

    expect(record).not.toBeNull()
    expect(record!.id).toBe(id)
    expect(record!.type).toBe('report')
    expect(record!.tenantId).toBe('tenant-42')
    expect(record!.status).toBe('pending')
    expect(record!.payload).toMatchObject({ format: 'pdf' })
  })

  // 3. cancel pending job returns true
  it('cancel returns true for a pending job and sets status to cancelled', async () => {
    const queue = new SQLiteTaskQueue()
    const id = await queue.enqueue({ type: 'task', payload: {} })

    const result = await queue.cancel(id)
    expect(result).toBe(true)

    const record = await queue.getStatus(id)
    expect(record!.status).toBe('cancelled')
  })

  // 4. cancel non-pending (running) job returns false
  it('cancel returns false for a running job', async () => {
    const queue = new SQLiteTaskQueue()
    const id = await queue.enqueue({ type: 'task', payload: {} })

    // Manually set it to running
    await testDb.execute({ sql: `UPDATE jobs SET status = 'running' WHERE id = ?`, args: [id] })

    const result = await queue.cancel(id)
    expect(result).toBe(false)

    const record = await queue.getStatus(id)
    expect(record!.status).toBe('running')
  })

  // 5. registerHandler + start: job is executed and status becomes done
  it('handler is called and job status becomes done', async () => {
    const queue = new SQLiteTaskQueue(50)
    const handlerResult = { processed: true }
    const handler = vi.fn().mockResolvedValue(handlerResult)

    queue.registerHandler('compute', handler)
    const id = await queue.enqueue({ type: 'compute', payload: { x: 1 } })

    queue.start()
    // Wait for the poll interval to fire and job to complete
    await new Promise((resolve) => setTimeout(resolve, 300))
    queue.stop()

    expect(handler).toHaveBeenCalledTimes(1)
    const record = await queue.getStatus(id)
    expect(record!.status).toBe('done')
    expect(record!.result).toMatchObject(handlerResult)
  })

  // 6. handler throws error → status becomes failed
  it('handler throwing an error sets job status to failed', async () => {
    const queue = new SQLiteTaskQueue(50)
    const handler = vi.fn().mockRejectedValue(new Error('processing failed'))

    queue.registerHandler('broken', handler)
    const id = await queue.enqueue({ type: 'broken', payload: {} })

    queue.start()
    await new Promise((resolve) => setTimeout(resolve, 300))
    queue.stop()

    const record = await queue.getStatus(id)
    expect(record!.status).toBe('failed')
    expect(record!.error).toBe('processing failed')
  })

  // 7. constructor marks stale running jobs as failed
  it('constructor marks previously running jobs as failed (stale job recovery)', async () => {
    // Manually insert a job with status = 'running'
    const staleId = 'stale-job-id'
    await testDb.execute({
      sql: `INSERT INTO jobs (id, tenant_id, type, payload, status)
            VALUES (?, 'default', 'stale-type', '{}', 'running')`,
      args: [staleId],
    })

    // Creating a new queue should recover stale jobs (async, so wait a tick)
    const queue = new SQLiteTaskQueue()
    await new Promise((resolve) => setTimeout(resolve, 50))

    const record = await queue.getStatus(staleId)
    expect(record!.status).toBe('failed')
    expect(record!.error).toBe('Service restarted unexpectedly')
  })
})
