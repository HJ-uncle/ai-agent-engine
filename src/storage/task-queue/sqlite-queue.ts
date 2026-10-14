import { randomUUID } from 'node:crypto'
import { getDb } from '../sqlite/db.js'
import { logger } from '../../observability/index.js'
import type { Row, Transaction } from '@libsql/client'
import type { Job, JobRecord, JobStatus, JobHandler, TaskQueue } from './types.js'
import { ensureTaskClaimSchema } from './claim-schema.js'

function isJobsTableNotReadyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /no such table:\s*jobs\b/i.test(message)
}

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
  private processing: Promise<void> | null = null
  private generation = 0
  private controller: AbortController | null = null
  private schema: Promise<void> | null = null
  private readonly pollIntervalMs: number

  constructor(pollIntervalMs = 1000) {
    this.pollIntervalMs = pollIntervalMs
    // A management queue is not proof that another producer has died. Recovery
    // needs an authoritative owner/lease, so construction must never alter jobs.
  }

  async enqueue(job: Job): Promise<string> {
    if (!this.handlers.has(job.type)) throw new Error(`Unsupported background task type: ${job.type}`)
    const id = randomUUID()
    const db = getDb()
    await db.execute({
      sql: `INSERT INTO jobs (id, tenant_id, type, payload, status)
            VALUES (?, ?, ?, ?, 'pending')`,
      args: [id, job.tenantId ?? 'default', job.type, JSON.stringify(job.payload)],
    })
    return id
  }

  async getStatus(jobId: string, tenantId: string): Promise<JobRecord | null> {
    if (!tenantId) throw new Error('Task tenant is required')
    const db = getDb()
    const result = await db.execute({
      sql: 'SELECT * FROM jobs WHERE id = ? AND tenant_id = ?',
      args: [jobId, tenantId],
    })
    const row = result.rows[0]
    return row ? rowToRecord(row) : null
  }

  async list(tenantId: string): Promise<JobRecord[]> {
    const db = getDb()
    const result = await db.execute({
      sql: 'SELECT * FROM jobs WHERE tenant_id = ? ORDER BY created_at DESC',
      args: [tenantId],
    })
    return result.rows.map(rowToRecord)
  }

  async cancel(jobId: string, tenantId: string): Promise<boolean> {
    if (!tenantId) throw new Error('Task tenant is required')
    const db = getDb()
    const result = await db.execute({
      sql: `UPDATE jobs SET status = 'cancelled', updated_at = unixepoch()
            WHERE id = ? AND tenant_id = ? AND status = 'pending'`,
      args: [jobId, tenantId],
    })
    return (result.rowsAffected ?? 0) > 0
  }

  registerHandler(type: string, handler: JobHandler): void {
    this.handlers.set(type, handler)
  }

  supportedTypes(): string[] { return [...this.handlers.keys()].sort() }

  start(): void {
    if (this.running) return
    if (this.processing) throw new Error('Previous task execution is still draining')
    this.running = true
    this.generation++
    this.timer = setInterval(() => {
      // Polling runs in the background, so always observe its rejection.  The
      // jobs table is created by initDb during application startup and may not
      // exist yet when a queue is constructed from an ESM module initializer.
      void this.processPending().catch((error: unknown) => {
        if (isJobsTableNotReadyError(error)) return
        logger.warn({ err: error }, 'SQLiteTaskQueue polling failed')
      })
    }, this.pollIntervalMs)
  }

  async stop(): Promise<void> {
    this.running = false
    this.generation++
    this.controller?.abort()
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (!this.processing) return
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([this.processing, new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Background task producer did not acknowledge stop; external effects remain unknown')), 3000)
      })])
    } finally { clearTimeout(timeout) }
  }

  private async processPending(): Promise<void> {
    if (!this.running || this.processing || !this.handlers.size) return
    const generation = this.generation, controller = new AbortController()
    this.controller = controller
    const task = this.processOne(generation, controller.signal)
    this.processing = task
    try { await task } finally {
      if (this.processing === task) { this.processing = null; this.controller = null }
    }
  }

  private async write<T>(operation: (tx: Transaction) => Promise<T>): Promise<T> {
    const tx = await getDb().transaction('write')
    try {
      const result = await operation(tx)
      await tx.commit()
      return result
    } catch (error) {
      try { await tx.rollback() } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'Task claim transaction failed; rollback is unconfirmed', { cause: error })
      }
      throw error
    } finally { tx.close() }
  }

  private async processOne(generation: number, signal: AbortSignal): Promise<void> {
    const db = getDb()
    const current = (): boolean => this.running && generation === this.generation && !signal.aborted
    // Initialization can retry after a missing-table startup, without rewriting jobs.
    this.schema ??= ensureTaskClaimSchema(db).catch(error => { this.schema = null; throw error })
    await this.schema
    if (!current()) return
    const types = this.supportedTypes()
    // An unsupported old job must not starve every supported task behind it.
    const result = await db.execute({
      sql: `SELECT * FROM jobs WHERE status = 'pending' AND type IN (${types.map(() => '?').join(',')}) ORDER BY created_at ASC, id ASC LIMIT 1`,
      args: types,
    })

    const row = result.rows[0]
    if (!row || !current()) return

    const job = rowToRecord(row)
    const handler = this.handlers.get(job.type)

    if (!handler) {
      // No handler registered — leave in pending or skip
      return
    }

    // Only the winner of the persisted pending→running claim may perform effects.
    const claimId = randomUUID()
    const claimed = await this.write(async tx => {
      if (!current()) return false
      const result = await tx.execute({
        sql: `UPDATE jobs SET status = 'running', started_at = unixepoch(), updated_at = unixepoch()
              WHERE id = ? AND tenant_id = ? AND status = 'pending'`,
        args: [job.id, job.tenantId],
      })
      if (result.rowsAffected !== 1) return false
      await tx.execute({ sql: 'INSERT INTO job_execution_claims(job_id,claim_id) VALUES(?,?)', args: [job.id, claimId] })
      return true
    })
    if (!claimed) return
    if (!current()) {
      await this.finish(job, claimId, 'cancelled', undefined, 'Stopped before handler admission; no handler effects were performed')
      return
    }

    let jobResult: unknown
    try { jobResult = await handler(job, signal) } catch (err) {
      await this.finish(job, claimId, 'failed', undefined,
        `${signal.aborted ? 'Execution interrupted; external effects may have occurred. ' : ''}${err instanceof Error ? err.message : String(err)}`)
      return
    }
    // A failed completion ACK is not proof that the handler failed; never
    // overwrite or replay its effects based on a transport exception here.
    await this.finish(job, claimId, 'done', jobResult)
  }

  private async finish(job: JobRecord, claimId: string, status: JobStatus, result?: unknown, error?: string): Promise<void> {
    await this.write(async tx => {
      const updated = await tx.execute({
        sql: `UPDATE jobs SET status=?,result=?,error=?,completed_at=unixepoch(),updated_at=unixepoch()
          WHERE id=? AND tenant_id=? AND status='running'
          AND EXISTS(SELECT 1 FROM job_execution_claims c WHERE c.job_id=jobs.id AND c.claim_id=?)`,
        args: [status, result === undefined ? null : JSON.stringify(result), error ?? null, job.id, job.tenantId, claimId],
      })
      if (updated.rowsAffected !== 1) throw new Error('Task execution claim changed; completion was not committed')
      await tx.execute({ sql: 'DELETE FROM job_execution_claims WHERE job_id=? AND claim_id=?', args: [job.id, claimId] })
    })
  }
}
