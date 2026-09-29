import { randomUUID } from 'node:crypto'
import type { Client, Transaction } from '@libsql/client'
import { getDb } from '../../storage/sqlite/db.js'
import { up } from '../../storage/sqlite/migrations/019_subagent_runs.js'
import { isTerminalRun, type CreateSubagentRun, type RunInvocationUsage, type RunStatus, type SubagentEvent, type SubagentRun } from './types.js'

type RunPatch = Partial<Pick<SubagentRun, 'status' | 'startedAt' | 'finishedAt' | 'durationMs' | 'stopReason' | 'error' | 'resultSummary' | 'partialOutput' | 'usage' | 'toolCalls' | 'modelId' | 'externalEffectStatus'>>
type PatchSource = RunPatch | ((current: SubagentRun) => RunPatch)
const writes = new WeakMap<Client, Promise<unknown>>()

export interface ParentProjection {
  id: string
  tenantId: string
  event: SubagentEvent
}

/** SQLite is authoritative; the outbox lets parent JSONL projection recover independently after a crash. */
export class SubagentStore {
  private initialized?: Promise<void>

  constructor(private readonly db: Client = getDb()) {}

  private ready(): Promise<void> {
    return this.initialized ??= up(this.db)
  }

  private async write<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    await this.ready()
    const previous = writes.get(this.db) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(async () => {
      const tx = await this.db.transaction('write')
      try {
        const result = await fn(tx)
        await tx.commit()
        return result
      } catch (error) {
        await tx.rollback().catch(() => undefined)
        throw error
      } finally { tx.close() }
    })
    writes.set(this.db, next.catch(() => undefined))
    return next
  }

  private async persist(tx: Transaction, kind: SubagentEvent['kind'], run: SubagentRun): Promise<SubagentEvent> {
    const event: SubagentEvent = { schemaVersion: 1, kind, runId: run.runId, seq: run.lastSeq, snapshot: run }
    const encoded = JSON.stringify(event)
    await tx.execute({
      sql: `UPDATE subagent_runs SET status=?, seq=?, updated_at=?, snapshot=? WHERE tenant_id=? AND run_id=?`,
      args: [run.status, run.lastSeq, run.updatedAt, JSON.stringify(run), run.tenantId, run.runId],
    })
    await tx.execute({
      sql: 'INSERT INTO subagent_events (tenant_id,run_id,seq,kind,event) VALUES (?,?,?,?,?)',
      args: [run.tenantId, run.runId, run.lastSeq, kind, encoded],
    })
    await tx.execute({
      sql: 'INSERT INTO subagent_outbox (id,tenant_id,run_id,seq,event) VALUES (?,?,?,?,?)',
      args: [`${run.tenantId}:${run.runId}:${run.lastSeq}`, run.tenantId, run.runId, run.lastSeq, encoded],
    })
    return event
  }

  async createRun(input: CreateSubagentRun): Promise<SubagentEvent> {
    return this.write(async (tx) => {
      const existing = await tx.execute({
        sql: 'SELECT snapshot FROM subagent_runs WHERE tenant_id=? AND parent_session_id=? AND parent_tool_call_id=?',
        args: [input.tenantId, input.parentSessionId, input.parentToolCallId],
      })
      if (existing.rows[0]) {
        const run = JSON.parse(String(existing.rows[0].snapshot)) as SubagentRun
        return { schemaVersion: 1, kind: 'created', runId: run.runId, seq: run.lastSeq, snapshot: run }
      }
      const now = Date.now()
      const childSessionId = input.childSessionId ?? `subagent-${randomUUID()}`
      const run: SubagentRun = {
        ...input, schemaVersion: 1, runId: input.runId ?? randomUUID(), childSessionId,
        status: 'queued', lastSeq: 1, createdAt: now, updatedAt: now,
        usage: {}, toolCalls: [], transcriptRef: `session:${childSessionId}`,
      }
      await tx.execute({
        sql: `INSERT INTO subagent_runs (tenant_id,run_id,parent_session_id,parent_tool_call_id,child_session_id,status,seq,created_at,updated_at,snapshot) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        args: [run.tenantId, run.runId, run.parentSessionId, run.parentToolCallId, run.childSessionId, run.status, run.lastSeq, now, now, JSON.stringify(run)],
      })
      return this.persist(tx, 'created', run)
    })
  }

  async getRun(tenantId: string, runId: string): Promise<SubagentRun | null> {
    await this.ready()
    const result = await this.db.execute({ sql: 'SELECT snapshot FROM subagent_runs WHERE tenant_id=? AND run_id=?', args: [tenantId, runId] })
    return result.rows[0] ? JSON.parse(String(result.rows[0].snapshot)) as SubagentRun : null
  }

  async findByParentTool(tenantId: string, parentSessionId: string, parentToolCallId: string): Promise<SubagentRun | null> {
    await this.ready()
    const result = await this.db.execute({ sql: 'SELECT snapshot FROM subagent_runs WHERE tenant_id=? AND parent_session_id=? AND parent_tool_call_id=?', args: [tenantId, parentSessionId, parentToolCallId] })
    return result.rows[0] ? JSON.parse(String(result.rows[0].snapshot)) as SubagentRun : null
  }

  async listRunsForParent(tenantId: string, parentSessionId: string): Promise<SubagentRun[]> {
    await this.ready()
    const result = await this.db.execute({ sql: 'SELECT snapshot FROM subagent_runs WHERE tenant_id=? AND parent_session_id=? ORDER BY created_at,run_id', args: [tenantId, parentSessionId] })
    return result.rows.map((row) => JSON.parse(String(row.snapshot)) as SubagentRun)
  }

  async listChildSessionIds(tenantId: string): Promise<string[]> {
    await this.ready()
    const result = await this.db.execute({ sql: 'SELECT DISTINCT child_session_id FROM subagent_runs WHERE tenant_id=?', args: [tenantId] })
    return result.rows.map((row) => String(row.child_session_id))
  }

  async appendSnapshot(tenantId: string, runId: string, kind: SubagentEvent['kind'], patch: PatchSource, options: { allowedStatuses?: readonly RunStatus[] } = {}): Promise<SubagentEvent | null> {
    return this.write(async (tx) => {
      const result = await tx.execute({ sql: 'SELECT snapshot FROM subagent_runs WHERE tenant_id=? AND run_id=?', args: [tenantId, runId] })
      if (!result.rows[0]) return null
      const current = JSON.parse(String(result.rows[0].snapshot)) as SubagentRun
      if (options.allowedStatuses && !options.allowedStatuses.includes(current.status)) return null
      const update = typeof patch === 'function' ? patch(current) : patch
      // Late usage/detail may supplement a terminal snapshot, but never replace its outcome.
      if (isTerminalRun(current.status) && update.status !== undefined) return null
      if (current.status === 'cancelling' && (update.status === 'running' || update.status === 'succeeded')) return null
      const next = { ...current, ...update, lastSeq: current.lastSeq + 1, updatedAt: Date.now() }
      return this.persist(tx, kind, next)
    })
  }

  async recordUsage(tenantId: string, runId: string, usage: RunInvocationUsage): Promise<SubagentEvent | null> {
    return this.write(async (tx) => {
      const result = await tx.execute({ sql: 'SELECT snapshot FROM subagent_runs WHERE tenant_id=? AND run_id=?', args: [tenantId, runId] })
      if (!result.rows[0]) return null
      const inserted = await tx.execute({ sql: 'INSERT OR IGNORE INTO subagent_usage_invocations (tenant_id,run_id,invocation_id) VALUES (?,?,?)', args: [tenantId, runId, usage.invocationId] })
      if (inserted.rowsAffected === 0) return null
      const current = JSON.parse(String(result.rows[0].snapshot)) as SubagentRun
      const prior = current.usage
      const prompt = Math.max(0, usage.promptTokens)
      const completion = Math.max(0, usage.completionTokens)
      const next: SubagentRun = {
        ...current, lastSeq: current.lastSeq + 1, updatedAt: Date.now(),
        usage: {
          inputTokens: (prior.inputTokens ?? 0) + prompt,
          outputTokens: (prior.outputTokens ?? 0) + completion,
          totalTokens: (prior.totalTokens ?? 0) + prompt + completion,
          cacheReadTokens: (prior.cacheReadTokens ?? 0) + (usage.cacheHitTokens ?? 0),
          cacheWriteTokens: (prior.cacheWriteTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
          ...(prior.estimated || usage.estimated ? { estimated: true } : {}),
          ...(prior.unknown || usage.unknown ? { unknown: true } : {}),
        },
      }
      return this.persist(tx, 'usage.updated', next)
    })
  }

  async listEvents(tenantId: string, runId: string, afterSeq = 0): Promise<SubagentEvent[]> {
    await this.ready()
    const result = await this.db.execute({ sql: 'SELECT event FROM subagent_events WHERE tenant_id=? AND run_id=? AND seq>? ORDER BY seq', args: [tenantId, runId, afterSeq] })
    return result.rows.map((row) => JSON.parse(String(row.event)) as SubagentEvent)
  }

  async listPendingParentProjections(tenantId?: string): Promise<ParentProjection[]> {
    await this.ready()
    const result = await this.db.execute({
      sql: `SELECT id,tenant_id,event FROM subagent_outbox WHERE acknowledged=0${tenantId ? ' AND tenant_id=?' : ''} ORDER BY run_id,seq`,
      args: tenantId ? [tenantId] : [],
    })
    return result.rows.map((row) => ({ id: String(row.id), tenantId: String(row.tenant_id), event: JSON.parse(String(row.event)) as SubagentEvent }))
  }

  async ackProjection(id: string, tenantId: string): Promise<void> {
    await this.ready()
    await this.db.execute({ sql: 'UPDATE subagent_outbox SET acknowledged=1 WHERE id=? AND tenant_id=?', args: [id, tenantId] })
  }

  async deleteRunsForParent(tenantId: string, parentSessionId: string): Promise<void> {
    await this.write(async (tx) => {
      // The caller cancels and joins active runners first, so no late terminal write can resurrect this tree.
      for (const table of ['subagent_usage_invocations', 'subagent_outbox', 'subagent_events']) {
        await tx.execute({ sql: `DELETE FROM ${table} WHERE tenant_id=? AND run_id IN (SELECT run_id FROM subagent_runs WHERE tenant_id=? AND parent_session_id=?)`, args: [tenantId, tenantId, parentSessionId] })
      }
      await tx.execute({ sql: 'DELETE FROM subagent_runs WHERE tenant_id=? AND parent_session_id=?', args: [tenantId, parentSessionId] })
    })
  }

  async deleteRuns(tenantId: string, runIds: string[]): Promise<void> {
    if (runIds.length === 0) return
    await this.write(async (tx) => {
      for (const runId of new Set(runIds)) {
        for (const table of ['subagent_usage_invocations', 'subagent_outbox', 'subagent_events', 'subagent_runs']) {
          await tx.execute({ sql: `DELETE FROM ${table} WHERE tenant_id=? AND run_id=?`, args: [tenantId, runId] })
        }
      }
    })
  }

  /** Call once before accepting requests; never restart potentially side-effecting tools automatically. */
  async recoverInterrupted(): Promise<SubagentEvent[]> {
    await this.ready()
    const result = await this.db.execute("SELECT tenant_id,run_id FROM subagent_runs WHERE status IN ('queued','running','cancelling')")
    const events: SubagentEvent[] = []
    for (const row of result.rows) {
      const event = await this.appendSnapshot(String(row.tenant_id), String(row.run_id), 'finished', (current) => ({
        status: 'interrupted', stopReason: 'engine_restarted', finishedAt: Date.now(),
        durationMs: current.startedAt ? Date.now() - current.startedAt : 0,
        error: { code: 'ENGINE_RESTARTED', message: '引擎重启，任务执行状态未知，未自动重跑。', retryable: false },
        toolCalls: current.toolCalls.map((tool) => tool.status === 'running' ? { ...tool, status: 'cancelled', finishedAt: Date.now() } : tool),
        usage: { ...current.usage, unknown: true },
      }), { allowedStatuses: ['queued', 'running', 'cancelling'] })
      if (event) events.push(event)
    }
    return events
  }
}

let singleton: SubagentStore | undefined
export function getSubagentStore(): SubagentStore { return singleton ??= new SubagentStore() }
