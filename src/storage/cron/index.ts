import { v4 as uuidv4 } from 'uuid'
import { getDb } from '../sqlite/db.js'

export const DEFAULT_CRON_TIMEOUT_SECONDS = 120
export function validCronTimeoutSeconds(value: unknown): value is number | null | undefined {
  return value == null || (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 86400)
}
export type CronThinkingMode = boolean | 'low' | 'medium' | 'high' | null
export function validCronThinkingMode(value: unknown): value is CronThinkingMode | undefined {
  return value === undefined || value === null || typeof value === 'boolean' || value === 'low' || value === 'medium' || value === 'high'
}
export interface CronJob {
  id: string
  tenantId: string
  name: string
  description?: string
  cronExpr: string
  message: string
  sessionId: string
  agentId?: string
  thinkingMode?: CronThinkingMode
  timeoutSeconds?: number | null
  enabled: boolean
  lastRunAt?: number
  nextRunAt?: number
  createdAt: number
  updatedAt: number
}

export interface CreateCronJobInput {
  name: string
  description?: string
  cronExpr: string
  message: string
  sessionId: string
  agentId?: string
  thinkingMode?: CronThinkingMode
  timeoutSeconds?: number | null
  enabled?: boolean
}

export interface UpdateCronJobInput {
  name?: string
  description?: string
  cronExpr?: string
  message?: string
  sessionId?: string
  agentId?: string
  thinkingMode?: CronThinkingMode
  timeoutSeconds?: number | null
  enabled?: boolean
}

function rowToCronJob(row: Record<string, any>): CronJob {
  return {
    id: row['id'],
    tenantId: row['tenant_id'],
    name: row['name'],
    description: row['description'] ?? undefined,
    cronExpr: row['cron_expr'],
    message: row['message'],
    sessionId: row['session_id'],
    agentId: row['agent_id'] ?? undefined,
    thinkingMode: row['thinking_mode'] == null ? undefined : JSON.parse(row['thinking_mode']),
    timeoutSeconds: row['timeout_seconds'] == null ? null : Number(row['timeout_seconds']),
    enabled: Boolean(row['enabled']),
    lastRunAt: row['last_run_at'] ?? undefined,
    nextRunAt: row['next_run_at'] ?? undefined,
    createdAt: row['created_at'],
    updatedAt: row['updated_at'],
  }
}

export class CronStore {
  private get db() { return getDb() }

  async create(tenantId: string, input: CreateCronJobInput): Promise<CronJob> {
    if (!validCronTimeoutSeconds(input.timeoutSeconds)) throw new Error('Invalid timeoutSeconds: expected integer 1..86400 or null')
    const id = uuidv4()
    const now = Date.now()
    await this.db.execute({
      sql: `INSERT INTO cron_jobs (id, tenant_id, name, description, cron_expr, message, session_id, agent_id, thinking_mode, timeout_seconds, enabled, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [id, tenantId, input.name, input.description ?? null, input.cronExpr,
             input.message, input.sessionId, input.agentId ?? null, input.thinkingMode == null ? null : JSON.stringify(input.thinkingMode),
             input.timeoutSeconds ?? null, input.enabled !== false ? 1 : 0, now, now],
    })
    return (await this.getById(id, tenantId))!
  }

  async getById(id: string, tenantId: string): Promise<CronJob | null> {
    const res = await this.db.execute({ sql: 'SELECT * FROM cron_jobs WHERE id=? AND tenant_id=?', args: [id, tenantId] })
    if (!res.rows[0]) return null
    return rowToCronJob(res.rows[0] as any)
  }

  async list(tenantId: string): Promise<CronJob[]> {
    const res = await this.db.execute({ sql: 'SELECT * FROM cron_jobs WHERE tenant_id=? ORDER BY created_at DESC', args: [tenantId] })
    return res.rows.map(r => rowToCronJob(r as any))
  }

  async listEnabled(): Promise<CronJob[]> {
    const res = await this.db.execute({ sql: 'SELECT * FROM cron_jobs WHERE enabled=1', args: [] })
    return res.rows.map(r => rowToCronJob(r as any))
  }

  async update(id: string, tenantId: string, input: UpdateCronJobInput): Promise<CronJob | null> {
    if (!validCronTimeoutSeconds(input.timeoutSeconds)) throw new Error('Invalid timeoutSeconds: expected integer 1..86400 or null')
    const job = await this.getById(id, tenantId)
    if (!job) return null
    const now = Date.now()
    await this.db.execute({
      sql: `UPDATE cron_jobs SET name=?, description=?, cron_expr=?, message=?, session_id=?, agent_id=?, thinking_mode=?, timeout_seconds=?, enabled=?, updated_at=? WHERE id=? AND tenant_id=?`,
      args: [
        input.name ?? job.name,
        input.description !== undefined ? input.description : job.description ?? null,
        input.cronExpr ?? job.cronExpr,
        input.message ?? job.message,
        input.sessionId ?? job.sessionId,
        input.agentId !== undefined ? input.agentId : job.agentId ?? null,
        (input.thinkingMode !== undefined ? input.thinkingMode : job.thinkingMode) == null ? null : JSON.stringify(input.thinkingMode !== undefined ? input.thinkingMode : job.thinkingMode),
        input.timeoutSeconds !== undefined ? input.timeoutSeconds : job.timeoutSeconds ?? null,
        input.enabled !== undefined ? (input.enabled ? 1 : 0) : (job.enabled ? 1 : 0),
        now, id, tenantId,
      ],
    })
    return this.getById(id, tenantId)
  }

  async updateRuntime(id: string, lastRunAt: number, nextRunAt?: number): Promise<void> {
    await this.db.execute({
      sql: 'UPDATE cron_jobs SET last_run_at=?, next_run_at=?, updated_at=? WHERE id=?',
      args: [lastRunAt, nextRunAt ?? null, Date.now(), id],
    })
  }

  async delete(id: string, tenantId: string): Promise<boolean> {
    const res = await this.db.execute({ sql: 'DELETE FROM cron_jobs WHERE id=? AND tenant_id=?', args: [id, tenantId] })
    return (res.rowsAffected ?? 0) > 0
  }
}
