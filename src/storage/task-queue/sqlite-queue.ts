import { randomUUID } from 'node:crypto'
import { getDb } from '../sqlite/db.js'
import type { Row } from '@libsql/client'
import type { Job, JobRecord, JobStatus, JobHandler, TaskQueue } from './types.js'

function rowToRecord(row: Row): JobRecord {
  const started_at = row['started_at']
  const completed_at = row['completed_at']
  const result = row['result'] as string | null
  const error = row['error'] as string | null

  return {
    id: row['id'] as string,
    tenantId: row['tenant_id'] as string,
    type: row['type'] as string,
    payload: JSON.parse(row['payload'] as string) as Record<string, unknown>,
    status: row['status'] as JobStatus,
    result: result ? JSON.parse(result) : undefined,
    error: error ?? undefined,
    createdAt: Number(row['created_at']) * 1000,
    updatedAt: Number(row['updated_at']) * 1000,
    startedAt: started_at != null ? Number(started_at) * 1000 : undefined,
    completedAt: completed_at != null ? Number(completed_at) * 1000 : undefined,
  }
}

export class SQLiteTaskQueue implements TaskQueue {
  private handlers = new Map<string, JobHandler>()
  private timer: NodeJS.Timeout | null = null
  private running = false
  private readonly pollIntervalMs: number

  constructor(pollIntervalMs = 1000) {
    this.pollIntervalMs = pollIntervalMs
    // Recover stale jobs asynchronously on startup
    void this.recoverStaleJobs()
  }

  private async recoverStaleJobs(): Promise<void> {
    const db = getDb()
    // Mark any running jobs as failed (service was restarted)
    await db.execute({
      sql: `UPDATE jobs 
            SET status = 'failed', error = 'Service restarted unexpectedly', updated_at = unixepoch()
            WHERE status = 'running'`,
      args: [],
    })
  }

  async enqueue(job: Job): Promise<string> {
    const id = randomUUID()
    const db = getDb()
    await db.execute({
      sql: `INSERT INTO jobs (id, tenant_id, type, payload, status)
            VALUES (?, ?, ?, ?, 'pending')`,
      args: [id, job.tenantId ?? 'default', job.type, JSON.stringify(job.payload)],
    })
    return id
  }

  async getStatus(jobId: string): Promise<JobRecord | null> {
    const db = getDb()
    const result = await db.execute({
      sql: 'SELECT * FROM jobs WHERE id = ?',
      args: [jobId],
    })
    const row = result.rows[0]
    return row ? rowToRecord(row) : null
  }

  async cancel(jobId: string): Promise<boolean> {
    const db = getDb()
    const result = await db.execute({
      sql: `UPDATE jobs SET status = 'cancelled', updated_at = unixepoch()
            WHERE id = ? AND status = 'pending'`,
      args: [jobId],
    })
    return (result.rowsAffected ?? 0) > 0
  }

  registerHandler(type: string, handler: JobHandler): void {
    this.handlers.set(type, handler)
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.timer = setInterval(() => { void this.processPending() }, this.pollIntervalMs)
  }

  stop(): void {
    this.running = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private async processPending(): Promise<void> {
    const db = getDb()
    // Fetch one pending job
    const result = await db.execute({
      sql: `SELECT * FROM jobs WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1`,
      args: [],
    })

    const row = result.rows[0]
    if (!row) return

    const job = rowToRecord(row)
    const handler = this.handlers.get(job.type)

    if (!handler) {
      // No handler registered — leave in pending or skip
      return
    }

    // Mark as running
    await db.execute({
      sql: `UPDATE jobs SET status = 'running', started_at = unixepoch(), updated_at = unixepoch()
            WHERE id = ? AND status = 'pending'`,
      args: [job.id],
    })

    try {
      const jobResult = await handler(job)
      await db.execute({
        sql: `UPDATE jobs 
              SET status = 'done', result = ?, completed_at = unixepoch(), updated_at = unixepoch()
              WHERE id = ?`,
        args: [JSON.stringify(jobResult), job.id],
      })
    } catch (err) {
      await db.execute({
        sql: `UPDATE jobs 
              SET status = 'failed', error = ?, completed_at = unixepoch(), updated_at = unixepoch()
              WHERE id = ?`,
        args: [err instanceof Error ? err.message : String(err), job.id],
      })
    }
  }
}
