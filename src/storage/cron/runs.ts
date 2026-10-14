import { randomUUID, createHash } from 'node:crypto'
import type { Client, Transaction } from '@libsql/client'
import { getDb } from '../sqlite/db.js'
import { cronJobFromRow, type CronJob, type CronThinkingMode } from './index.js'
import type { CronConfigurationV2 } from '../../scheduler/cron-schedule.js'
import type { RootRun } from '../root-runs/index.js'

export type CronRunStatus = 'claimed' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted' | 'skipped'
export interface CronRunSnapshot {
  name: string; message: string; configuration: CronConfigurationV2
  agentId?: string; thinkingMode?: CronThinkingMode; timeoutSeconds?: number | null
  effectiveAgentId?: string; effectiveAgentName?: string; effectiveModelId?: string
}
export interface CronAutomationRun {
  id: string; tenantId: string; jobId: string; jobRevision: number; scheduleRevision: number
  scheduledAt: number; status: CronRunStatus; reason?: string; sessionId: string; rootRunId?: string
  snapshot: CronRunSnapshot; startedAt?: number; finishedAt?: number; deadlineAt?: number; jobDeleted?: boolean
}
export interface CronNotification {
  id: string; tenantId: string; runId: string; eventKey: string
  payload: { jobId: string; jobName: string; status: CronRunStatus; sessionId: string; rootRunId?: string; requestId?: string }
  createdAt: number; readAt?: number
}
export interface CronPage<T> { items: T[]; nextCursor: string | null }
export interface AutomationAdmission { runId: string; effectiveAgentId?: string; effectiveAgentName?: string; dispatchRequest?: Record<string, unknown> }
type Query = Pick<Client, 'execute'> | Pick<Transaction, 'execute'>
const schemas = new WeakMap<Client, Promise<void>>()
const writes = new WeakMap<Client, Promise<unknown>>()
const terminal = (status: CronRunStatus) => !['claimed', 'running', 'waiting'].includes(status)
function conflict(message: string): never { throw Object.assign(new Error(message), { statusCode: 409 }) }

export function ensureCronRunSchema(db: Client): Promise<void> {
  let pending = schemas.get(db)
  if (!pending) {
    pending = (async () => {
      await db.execute(`CREATE TABLE IF NOT EXISTS cron_runs (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, job_id TEXT NOT NULL,
        job_revision INTEGER NOT NULL, schedule_revision INTEGER NOT NULL, scheduled_at INTEGER NOT NULL,
        status TEXT NOT NULL, reason TEXT, session_id TEXT NOT NULL, root_run_id TEXT,
        snapshot_json TEXT NOT NULL, started_at INTEGER, finished_at INTEGER, deadline_at INTEGER,
        UNIQUE(tenant_id,job_id,scheduled_at), UNIQUE(tenant_id,root_run_id))`)
      await db.execute('CREATE INDEX IF NOT EXISTS cron_runs_job ON cron_runs(tenant_id,job_id,scheduled_at DESC,id DESC)')
      await db.execute('CREATE INDEX IF NOT EXISTS cron_runs_active ON cron_runs(status,tenant_id,job_id)')
      await db.execute(`CREATE TABLE IF NOT EXISTS cron_notifications (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, run_id TEXT NOT NULL, event_key TEXT NOT NULL,
        payload_json TEXT NOT NULL, created_at INTEGER NOT NULL, read_at INTEGER,
        UNIQUE(tenant_id,run_id,event_key))`)
      await db.execute('CREATE INDEX IF NOT EXISTS cron_notifications_feed ON cron_notifications(tenant_id,created_at DESC,id DESC)')
    })().catch(error => { schemas.delete(db); throw error })
    schemas.set(db, pending)
  }
  return pending
}

export async function withCronWrite<T>(db: Client, action: (tx: Transaction) => Promise<T>): Promise<T> {
  await ensureCronRunSchema(db)
  const previous = writes.get(db) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(async () => {
    const tx = await db.transaction('write')
    try { const result = await action(tx); await tx.commit(); return result }
    catch (error) { await tx.rollback().catch(() => undefined); throw error }
    finally { tx.close() }
  })
  writes.set(db, next.catch(() => undefined))
  return next
}

function runFromRow(row: Record<string, unknown>): CronAutomationRun {
  return { id: String(row.id), tenantId: String(row.tenant_id), jobId: String(row.job_id),
    jobRevision: Number(row.job_revision), scheduleRevision: Number(row.schedule_revision), scheduledAt: Number(row.scheduled_at),
    status: String(row.status) as CronRunStatus, reason: row.reason == null ? undefined : String(row.reason),
    sessionId: String(row.session_id), rootRunId: row.root_run_id == null ? undefined : String(row.root_run_id),
    snapshot: JSON.parse(String(row.snapshot_json)) as CronRunSnapshot,
    startedAt: row.started_at == null ? undefined : Number(row.started_at), finishedAt: row.finished_at == null ? undefined : Number(row.finished_at),
    deadlineAt: row.deadline_at == null ? undefined : Number(row.deadline_at), ...(row.job_deleted === undefined ? {} : { jobDeleted: Boolean(row.job_deleted) }) }
}
function notificationFromRow(row: Record<string, unknown>): CronNotification {
  return { id: String(row.id), tenantId: String(row.tenant_id), runId: String(row.run_id), eventKey: String(row.event_key),
    payload: JSON.parse(String(row.payload_json)) as CronNotification['payload'], createdAt: Number(row.created_at),
    readAt: row.read_at == null ? undefined : Number(row.read_at) }
}
async function getRun(q: Query, tenantId: string, id: string): Promise<CronAutomationRun | null> {
  const rows = await q.execute({ sql: 'SELECT r.*,NOT EXISTS(SELECT 1 FROM cron_jobs j WHERE j.id=r.job_id AND j.tenant_id=r.tenant_id) AS job_deleted FROM cron_runs r WHERE r.tenant_id=? AND r.id=?', args: [tenantId,id] })
  return rows.rows[0] ? runFromRow(rows.rows[0]) : null
}

/** A claim is not an authorization token: recheck the live job and the exact dispatch body. */
export async function validateAutomationAdmission(q: Query, tenantId: string, sessionId: string, request: Record<string, unknown>, admission: AutomationAdmission): Promise<CronAutomationRun> {
  const run = await getRun(q,tenantId,admission.runId)
  if (!run || run.status !== 'claimed' || run.rootRunId) conflict('Automation claim is unavailable or already admitted')
  const rows = await q.execute({ sql: 'SELECT * FROM cron_jobs WHERE tenant_id=? AND id=?', args: [tenantId,run.jobId] })
  const job = rows.rows[0] ? cronJobFromRow(rows.rows[0]) : null
  if (!job || !job.enabled || job.revision !== run.jobRevision || job.scheduleRevision !== run.scheduleRevision) conflict('Automation configuration changed before admission')
  const snapshot = run.snapshot
  if (request.automationRunId !== run.id || request.cronJobId !== run.jobId || sessionId !== run.sessionId || request.sessionId !== run.sessionId ||
    request.message !== snapshot.message || request.toolProfile !== snapshot.configuration.toolProfile ||
    (request.thinkingMode ?? null) !== (snapshot.thinkingMode ?? null) || (request.cronTimeoutSeconds ?? null) !== (snapshot.timeoutSeconds ?? null)) {
    conflict('Automation request does not match its persisted claim')
  }
  // A reuse target inherits its existing binding; new targets use the saved Agent selection.
  if (snapshot.configuration.target.kind !== 'session' && (request.agentId ?? null) !== (snapshot.agentId ?? null)) conflict('Automation Agent selection changed')
  if (snapshot.configuration.target.kind === 'session') {
    const binding = await q.execute({ sql: 'SELECT agent_id FROM sessions WHERE tenant_id=? AND session_id=?', args: [tenantId,sessionId] })
    const bound = binding.rows[0]?.agent_id
    if (bound !== undefined && (request.agentId ?? null) !== (bound ?? null)) conflict('Automation must use the session Agent binding')
  }
  if(request.agentId !== undefined) {
    if(typeof request.agentId !== 'string' || !request.agentId.trim())conflict('Automation Agent selection is invalid')
    const agent=await q.execute({sql:'SELECT 1 FROM agents WHERE tenant_id=? AND id=?',args:[tenantId,request.agentId]})
    if(!agent.rows.length)conflict('Automation Agent is no longer available in this tenant')
  }
  for (const key of ['model','modelBaseUrl','modelApiKey','modelProvider','systemPrompt','inlineAgent','inlineAgents','inlineSkills','inlineKnowledgeBases','skills','mcpServers','knowledgeBases','allowedTools','memoryScope','metadata','workspacePaths','utilityModel','subagentModel','inheritContext','maxAskUserCount','ragTopK','capabilities']) {
    if (Object.hasOwn(request,key)) conflict('Automation request cannot override ' + key)
  }
  const dispatchKeys=new Set(['message','sessionId','cronJobId','automationRunId','agentId','thinkingMode','cronTimeoutSeconds','toolProfile'])
  if(Object.keys(request).some(key=>!dispatchKeys.has(key)))conflict('Automation request contains unsupported dispatch fields')
  return run
}

export async function bindAutomationRoot(tx: Transaction, run: CronAutomationRun, root: RootRun, admission: AutomationAdmission): Promise<void> {
  const now = root.createdAt
  const timeout = run.snapshot.timeoutSeconds
  const deadline = timeout && timeout > 0 ? now + timeout * 1000 : null
  if (deadline !== null && !Number.isSafeInteger(deadline)) conflict('Automation deadline exceeds the supported timestamp range')
  run.snapshot = { ...run.snapshot, effectiveAgentId: admission.effectiveAgentId, effectiveAgentName: admission.effectiveAgentName, effectiveModelId: root.modelId }
  await tx.execute({ sql: "UPDATE cron_runs SET root_run_id=?,status='running',started_at=?,deadline_at=?,snapshot_json=? WHERE tenant_id=? AND id=? AND status='claimed' AND root_run_id IS NULL", args: [root.runId,now,deadline,JSON.stringify(run.snapshot),run.tenantId,run.id] })
}

async function notify(q: Query, run: CronAutomationRun, eventKey: string, requestId?: string): Promise<void> {
  if (run.snapshot.configuration.notificationPolicy !== 'all_runs' || run.status === 'skipped') return
  const payload: CronNotification['payload'] = { jobId:run.jobId,jobName:run.snapshot.name,status:run.status,sessionId:run.sessionId,rootRunId:run.rootRunId,requestId }
  await q.execute({ sql:'INSERT OR IGNORE INTO cron_notifications(id,tenant_id,run_id,event_key,payload_json,created_at) VALUES(?,?,?,?,?,?)', args:[randomUUID(),run.tenantId,run.id,eventKey,JSON.stringify(payload),Date.now()] })
}

/** Root state and the durable inbox are committed together, including resumed waiting turns. */
export async function projectAutomationRoot(q: Query, tenantId: string, root: RootRun): Promise<void> {
  const rows = await q.execute({ sql:'SELECT * FROM cron_runs WHERE tenant_id=? AND root_run_id=?',args:[tenantId,root.runId] })
  if (!rows.rows[0]) return
  const run = runFromRow(rows.rows[0])
  if (run.sessionId !== root.sessionId) return
  if (terminal(run.status)) {if(run.status===root.status)await notify(q,run,'terminal');return}
  run.status = root.status; run.reason = root.stopReason ?? root.error?.message
  run.finishedAt = root.finishedAt
  run.snapshot={...run.snapshot,effectiveModelId:root.actualModelId ?? root.modelId}
  await q.execute({ sql:'UPDATE cron_runs SET status=?,reason=?,finished_at=?,snapshot_json=? WHERE tenant_id=? AND id=?',args:[run.status,run.reason ?? null,run.finishedAt ?? null,JSON.stringify(run.snapshot),tenantId,run.id] })
  if (terminal(run.status)) await notify(q,run,'terminal')
  else if (run.status === 'waiting') for (const pending of root.pending.filter(value => value.status === 'pending')) await notify(q,run,'pending:'+pending.requestId,pending.requestId)
}

const scopeOf = (...values: unknown[]) => createHash('sha256').update(JSON.stringify(values)).digest('hex')
function limitOf(value=30): number { if (!Number.isSafeInteger(value) || value < 1 || value > 100) throw new RangeError('Invalid automation page size'); return value }
function decodeCursor(cursor: string | undefined, scope: string): {time:number;id:string} | undefined {
  if (cursor === undefined) return undefined
  if (!cursor || cursor.length > 1024 || !/^[\w-]+$/.test(cursor)) throw new RangeError('Invalid automation cursor')
  let value: {scope?:string;time?:number;id?:string}
  try { value=JSON.parse(Buffer.from(cursor,'base64url').toString()) } catch { throw new RangeError('Invalid automation cursor') }
  if (!value || value.scope !== scope || !Number.isSafeInteger(value.time) || typeof value.id !== 'string' || !value.id) throw new RangeError('Automation cursor scope mismatch')
  return {time:value.time!,id:value.id}
}
const encodeCursor = (scope:string,time:number,id:string) => Buffer.from(JSON.stringify({scope,time,id})).toString('base64url')

export class CronRunStore {
  constructor(private readonly client?: Client) {}
  private get db(): Client { return this.client ?? getDb() }
  async get(tenantId:string,id:string):Promise<CronAutomationRun|null> { await ensureCronRunSchema(this.db); return getRun(this.db,tenantId,id) }

  async claimDue(job:CronJob,scheduledAt:number,nextRunAt:number|null,now=Date.now()):Promise<CronAutomationRun|null> {
    return withCronWrite(this.db,async tx => {
      const rows=await tx.execute({sql:'SELECT * FROM cron_jobs WHERE tenant_id=? AND id=?',args:[job.tenantId,job.id]})
      const current=rows.rows[0] ? cronJobFromRow(rows.rows[0]) : null
      if (!current || !current.enabled || current.revision !== job.revision || current.scheduleRevision !== job.scheduleRevision || current.nextRunAt !== scheduledAt || scheduledAt > now) return null
      const existing=await tx.execute({sql:'SELECT 1 FROM cron_runs WHERE tenant_id=? AND job_id=? AND scheduled_at=?',args:[job.tenantId,job.id,scheduledAt]})
      if (existing.rows.length) {
        await tx.execute({sql:'UPDATE cron_jobs SET next_run_at=? WHERE tenant_id=? AND id=?',args:[nextRunAt,job.tenantId,job.id]})
        return null
      }
      const target=current.configuration.target
      const sessionId=target.kind === 'session' ? target.sessionId : randomUUID()
      const busy=await tx.execute({sql:"SELECT 1 FROM cron_runs WHERE tenant_id=? AND job_id=? AND status IN ('claimed','running','waiting') LIMIT 1",args:[job.tenantId,job.id]})
      const sessionBusy=target.kind !== 'session' ? false : (await tx.execute({sql:"SELECT 1 FROM root_runs WHERE tenant_id=? AND session_id=? AND json_extract(state,'$.status') IN ('running','waiting') LIMIT 1",args:[job.tenantId,sessionId]})).rows.length > 0
      const missed=scheduledAt < Math.floor(now/60000)*60000
      const reason=missed ? 'missed_occurrence' : busy.rows.length || sessionBusy ? 'overlap_skipped' : undefined
      const run:CronAutomationRun={id:randomUUID(),tenantId:job.tenantId,jobId:job.id,jobRevision:current.revision,scheduleRevision:current.scheduleRevision,scheduledAt,status:reason ? 'skipped' : 'claimed',reason,sessionId,
        snapshot:{name:current.name,message:current.message,configuration:current.configuration,agentId:current.agentId,thinkingMode:current.thinkingMode,timeoutSeconds:current.timeoutSeconds},finishedAt:reason ? now : undefined}
      await tx.execute({sql:'INSERT INTO cron_runs(id,tenant_id,job_id,job_revision,schedule_revision,scheduled_at,status,reason,session_id,snapshot_json,finished_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',args:[run.id,run.tenantId,run.jobId,run.jobRevision,run.scheduleRevision,scheduledAt,run.status,reason ?? null,sessionId,JSON.stringify(run.snapshot),run.finishedAt ?? null]})
      await tx.execute({sql:'UPDATE cron_jobs SET last_run_at=?,next_run_at=? WHERE tenant_id=? AND id=?',args:[scheduledAt,nextRunAt,job.tenantId,job.id]})
      return run
    })
  }

  async active():Promise<CronAutomationRun[]> {
    await ensureCronRunSchema(this.db)
    const rows=await this.db.execute("SELECT * FROM cron_runs WHERE status IN ('claimed','running','waiting')")
    return rows.rows.map(runFromRow)
  }
  async project(tenantId:string,root:RootRun):Promise<CronAutomationRun|null> {
    await withCronWrite(this.db,tx=>projectAutomationRoot(tx,tenantId,root))
    const rows=await this.db.execute({sql:'SELECT id FROM cron_runs WHERE tenant_id=? AND root_run_id=?',args:[tenantId,root.runId]})
    return rows.rows[0] ? this.get(tenantId,String(rows.rows[0].id)) : null
  }
  async finishUnadmitted(tenantId:string,id:string,status:'failed'|'interrupted'|'cancelled',reason:string):Promise<CronAutomationRun|null> {
    return withCronWrite(this.db,async tx=>{
      const run=await getRun(tx,tenantId,id)
      if (!run || run.status !== 'claimed' || run.rootRunId) return run
      run.status=status;run.reason=reason;run.finishedAt=Date.now()
      await tx.execute({sql:'UPDATE cron_runs SET status=?,reason=?,finished_at=? WHERE tenant_id=? AND id=? AND root_run_id IS NULL',args:[status,reason,run.finishedAt,tenantId,id]})
      await notify(tx,run,'terminal');return run
    })
  }
  async interruptMissingRoot(tenantId:string,id:string):Promise<CronAutomationRun|null> {
    return withCronWrite(this.db,async tx=>{
      const run=await getRun(tx,tenantId,id)
      if (!run || terminal(run.status)) return run
      const root=run.rootRunId ? await tx.execute({sql:'SELECT 1 FROM root_runs WHERE tenant_id=? AND run_id=?',args:[tenantId,run.rootRunId]}) : null
      if (root?.rows.length) return run
      run.status='interrupted';run.reason='Execution identity is no longer available';run.finishedAt=Date.now()
      await tx.execute({sql:"UPDATE cron_runs SET status='interrupted',reason=?,finished_at=? WHERE tenant_id=? AND id=?",args:[run.reason,run.finishedAt,tenantId,id]})
      await notify(tx,run,'terminal');return run
    })
  }
  async listByJob(tenantId:string,jobId:string,options:{cursor?:string;limit?:number}={}):Promise<CronPage<CronAutomationRun>> {
    await ensureCronRunSchema(this.db)
    const limit=limitOf(options.limit);const scope=scopeOf('runs',tenantId,jobId);const after=decodeCursor(options.cursor,scope)
    const rows=await this.db.execute({sql:`SELECT r.*,NOT EXISTS(SELECT 1 FROM cron_jobs j WHERE j.id=r.job_id AND j.tenant_id=r.tenant_id) AS job_deleted FROM cron_runs r WHERE tenant_id=? AND job_id=? ${after ? 'AND (scheduled_at<? OR (scheduled_at=? AND id<?))' : ''} ORDER BY scheduled_at DESC,id DESC LIMIT ?`,args:[tenantId,jobId,...(after ? [after.time,after.time,after.id] : []),limit+1]})
    const items=rows.rows.slice(0,limit).map(runFromRow);const last=items.at(-1)
    return {items,nextCursor:rows.rows.length>limit && last ? encodeCursor(scope,last.scheduledAt,last.id) : null}
  }
  async listNotifications(tenantId:string,options:{cursor?:string;limit?:number;unreadOnly?:boolean}={}):Promise<CronPage<CronNotification>&{unreadCount:number}> {
    await ensureCronRunSchema(this.db)
    const limit=limitOf(options.limit);const scope=scopeOf('notifications',tenantId,!!options.unreadOnly);const after=decodeCursor(options.cursor,scope)
    const rows=await this.db.execute({sql:`SELECT * FROM cron_notifications WHERE tenant_id=? ${options.unreadOnly ? 'AND read_at IS NULL' : ''} ${after ? 'AND (created_at<? OR (created_at=? AND id<?))' : ''} ORDER BY created_at DESC,id DESC LIMIT ?`,args:[tenantId,...(after ? [after.time,after.time,after.id] : []),limit+1]})
    const items=rows.rows.slice(0,limit).map(notificationFromRow);const last=items.at(-1)
    const count=await this.db.execute({sql:'SELECT count(*) AS count FROM cron_notifications WHERE tenant_id=? AND read_at IS NULL',args:[tenantId]})
    return {items,nextCursor:rows.rows.length>limit && last ? encodeCursor(scope,last.createdAt,last.id) : null,unreadCount:Number(count.rows[0].count)}
  }
  async readNotification(tenantId:string,id:string):Promise<CronNotification|null> {
    return withCronWrite(this.db,async tx=>{
      await tx.execute({sql:'UPDATE cron_notifications SET read_at=COALESCE(read_at,?) WHERE tenant_id=? AND id=?',args:[Date.now(),tenantId,id]})
      const rows=await tx.execute({sql:'SELECT * FROM cron_notifications WHERE tenant_id=? AND id=?',args:[tenantId,id]})
      return rows.rows[0] ? notificationFromRow(rows.rows[0]) : null
    })
  }
}
