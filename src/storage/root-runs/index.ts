import { randomUUID } from 'node:crypto'
import type { Client } from '@libsql/client'
import { getDb } from '../sqlite/db.js'
import { withHistoryLock, isSessionHistoryMutating } from '../conversation/serialization.js'

export type RootRunStatus = 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'
export interface RootPending {
  requestId: string
  kind: 'ask' | 'permission'
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
  messageId?: string
  pendingAction?: Record<string, unknown>
  question?: string
  description?: string
  options?: unknown[]
  status: 'pending' | 'answered'
  output?: string
}
/** Public composer settings only; inline definitions and connection secrets stay private. */
export interface RootRunRequestConfig {
  agentId?: string
  thinkingMode?: boolean | 'low' | 'medium' | 'high'
  subagentModel?: string
  utilityModel?: string
  skills?: string[]
  mcpServers?: string[]
  knowledgeBases?: string[]
  memoryScope?: 'off' | 'global' | 'session'
}
export interface RootRun {
  schemaVersion: 1
  runId: string
  sessionId: string
  turnId: string
  userMessageId: string
  assistantMessageId: string
  seq: number
  version: number
  status: RootRunStatus
  modelId: string
  /** Last model that actually delivered output; modelId remains the requested resume configuration. */
  actualModelId?: string
  /** Presence matters: omitted resources inherit from the agent, [] explicitly disables them. */
  requestConfig?: RootRunRequestConfig
  workspacePaths: string[]
  createdAt: number
  updatedAt: number
  finishedAt?: number
  stopReason?: string
  error?: { code: string; message: string; retryable: boolean }
  pending: RootPending[]
}
interface StoredRun extends RootRun { request: Record<string, unknown>; attemptId: string }
const schemas = new WeakMap<Client, Promise<void>>()

/** Deliberately omit credentials; resume resolves the same model's stored connection. */
export function resumableRequest(request: Record<string, unknown>): Record<string, unknown> {
  const allowed = ['agentId', 'systemPrompt', 'maxAskUserCount', 'thinkingMode', 'inheritContext', 'workspacePaths',
    'model', 'subagentModel', 'utilityModel', 'modelBaseUrl', 'modelProvider', 'capabilities', 'skills', 'mcpServers',
    'knowledgeBases', 'memoryScope', 'allowedTools', 'inlineSkills', 'inlineAgents', 'inlineAgent', 'inlineKnowledgeBases', 'ragTopK', 'metadata', 'toolProfile']
  const clean = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(clean)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) =>
      !/api.?key|secret|password|authorization|token|headers|^env$/i.test(key)).map(([key, entry]) => [key, clean(entry)]))
    return value
  }
  return Object.fromEntries(allowed.filter(key => request[key] !== undefined).map(key => [key, clean(request[key])]))
}

export function publicRequestConfig(request: Record<string, unknown>): RootRunRequestConfig {
  const config: RootRunRequestConfig = {}
  for (const key of ['agentId', 'subagentModel', 'utilityModel'] as const) {
    if (typeof request[key] === 'string') config[key] = request[key]
  }
  for (const key of ['skills', 'mcpServers', 'knowledgeBases'] as const) {
    const value = request[key]
    if (Array.isArray(value) && value.every(id => typeof id === 'string')) config[key] = [...value]
  }
  const thinking = request.thinkingMode
  if (typeof thinking === 'boolean' || thinking === 'low' || thinking === 'medium' || thinking === 'high') config.thinkingMode = thinking
  const scope = request.memoryScope
  if (scope === 'off' || scope === 'global' || scope === 'session') config.memoryScope = scope
  return config
}

export class RootRunStore {
  async initialize(): Promise<void> { await this.ready() }
  private async ready(): Promise<Client> {
    const db = getDb()
    let promise = schemas.get(db)
    if (!promise) {
      promise = (async () => {
        await db.execute(`CREATE TABLE IF NOT EXISTS root_runs (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, session_id TEXT NOT NULL,
          run_id TEXT NOT NULL UNIQUE, turn_id TEXT NOT NULL, state TEXT NOT NULL)`)
        await db.execute('CREATE INDEX IF NOT EXISTS root_runs_session ON root_runs(tenant_id, session_id, seq)')
        // First access in a new process: execution cannot be resumed automatically.
        const rows = await db.execute('SELECT run_id,state FROM root_runs')
        for (const row of rows.rows) {
          const run = JSON.parse(String(row.state)) as StoredRun
          if (run.status !== 'running') continue
          run.status = 'interrupted'; run.stopReason = 'Engine restarted; execution was not resumed'
          run.error = { code: 'ENGINE_RESTARTED', message: run.stopReason, retryable: false }
          run.updatedAt = run.finishedAt = Date.now(); run.version++
          await db.execute({ sql: 'UPDATE root_runs SET state=? WHERE run_id=?', args: [JSON.stringify(run), String(row.run_id)] })
        }
      })()
      schemas.set(db, promise)
    }
    await promise
    return db
  }

  public(run: StoredRun): RootRun {
    const { request, attemptId: _attemptId, requestConfig: _storedConfig, ...result } = run
    // Reproject the private request on every read, including old database rows.
    return { ...result, requestConfig: publicRequestConfig(request) }
  }

  async list(tenantId: string, sessionId: string): Promise<RootRun[]> {
    const db = await this.ready()
    const rows = await db.execute({ sql: 'SELECT seq,state FROM root_runs WHERE tenant_id=? AND session_id=? ORDER BY seq', args: [tenantId, sessionId] })
    return rows.rows.map(row => this.public({ ...JSON.parse(String(row.state)), seq: Number(row.seq) }))
  }

  async get(tenantId: string, runId: string): Promise<StoredRun | null> {
    const db = await this.ready()
    const rows = await db.execute({ sql: 'SELECT seq,state FROM root_runs WHERE tenant_id=? AND run_id=?', args: [tenantId, runId] })
    const row = rows.rows[0]
    return row ? { ...JSON.parse(String(row.state)), seq: Number(row.seq) } : null
  }

  async create(tenantId: string, sessionId: string, modelId: string, workspacePaths: string[], request: Record<string, unknown>): Promise<RootRun> {
    return withHistoryLock(tenantId, async () => {
      if (isSessionHistoryMutating(tenantId, sessionId)) throw Object.assign(new Error('Session history is being changed'), { statusCode: 409 })
      const active = (await this.list(tenantId, sessionId)).find(run => run.status === 'running' || run.status === 'waiting')
      if (active) throw Object.assign(new Error('This session already has a running or waiting turn'), { statusCode: 409 })
      const now = Date.now()
      const run: StoredRun = { schemaVersion: 1, runId: randomUUID(), turnId: randomUUID(), sessionId,
        userMessageId: randomUUID(), assistantMessageId: randomUUID(), seq: 0, version: 1, status: 'running',
        modelId, workspacePaths, createdAt: now, updatedAt: now, pending: [], attemptId: randomUUID(), request: resumableRequest(request) }
      const db = await this.ready()
      const result = await db.execute({ sql: 'INSERT INTO root_runs(tenant_id,session_id,run_id,turn_id,state) VALUES(?,?,?,?,?) RETURNING seq',
        args: [tenantId, sessionId, run.runId, run.turnId, JSON.stringify(run)] })
      run.seq = Number(result.rows[0].seq)
      return this.public(run)
    })
  }

  async update(tenantId: string, runId: string, change: Partial<Omit<RootRun, 'runId' | 'sessionId' | 'turnId' | 'seq' | 'version'>>, expectedAttemptId?: string): Promise<RootRun | null> {
    return withHistoryLock(tenantId, async () => {
      const run = await this.get(tenantId, runId)
      if (!run) return null
      if (expectedAttemptId && run.attemptId !== expectedAttemptId) return null
      if (change.status && !['running', 'waiting'].includes(run.status) && change.status !== run.status) return null
      Object.assign(run, change, { updatedAt: Date.now(), version: run.version + 1 })
      if (!['running', 'waiting'].includes(run.status)) run.finishedAt = Date.now()
      const db = await this.ready()
      await db.execute({ sql: 'UPDATE root_runs SET state=? WHERE tenant_id=? AND run_id=?', args: [JSON.stringify(run), tenantId, runId] })
      return this.public(run)
    })
  }

  async pending(tenantId: string, runId: string, pending: Omit<RootPending, 'status'>, expectedAttemptId?: string): Promise<RootRun | null> {
    return withHistoryLock(tenantId, async () => {
      const run = await this.get(tenantId, runId)
      if (!run) return null
      return this.update(tenantId, runId, { status: 'waiting', pending: [...run.pending.filter(p => p.requestId !== pending.requestId), { ...pending, status: 'pending' }] }, expectedAttemptId)
    })
  }

  async answer(tenantId: string, sessionId: string, runId: string, requestId: string, toolCallId: string, toolName: string, output: string): Promise<{ run: RootRun; pending: RootPending; duplicate: boolean }> {
    return withHistoryLock(tenantId, async () => {
      if (isSessionHistoryMutating(tenantId, sessionId)) throw Object.assign(new Error('Session history is being changed'), { statusCode: 409 })
      const stored = await this.get(tenantId, runId)
      const pending = stored?.pending.find(item => item.requestId === requestId)
      if (!stored || stored.sessionId !== sessionId || !pending || pending.toolCallId !== toolCallId || pending.toolName !== toolName) {
        throw Object.assign(new Error('Pending request not found for this run and session'), { statusCode: 404 })
      }
      if (pending.status === 'answered') {
        if (pending.output !== output) throw Object.assign(new Error('Request already answered differently'), { statusCode: 409 })
        return { run: this.public(stored), pending, duplicate: true }
      }
      if (stored.status !== 'waiting') throw Object.assign(new Error('Run is no longer waiting'), { statusCode: 409 })
      if (pending.kind === 'permission' && output !== 'approved' && output !== 'rejected') throw Object.assign(new Error('Approval answer must be approved or rejected'), { statusCode: 400 })
      pending.status = 'answered'; pending.output = output
      Object.assign(stored, { status: 'running', attemptId: randomUUID(), error: undefined, stopReason: undefined,
        updatedAt: Date.now(), version: stored.version + 1 })
      const db = await this.ready()
      await db.execute({ sql: 'UPDATE root_runs SET state=? WHERE tenant_id=? AND run_id=?', args: [JSON.stringify(stored), tenantId, runId] })
      return { run: this.public(stored), pending, duplicate: false }
    })
  }

  async deleteTurns(tenantId: string, sessionId: string, turnIds?: string[]): Promise<void> {
    const db = await this.ready()
    if (turnIds?.length === 0) return
    await db.execute({ sql: `DELETE FROM root_runs WHERE tenant_id=? AND session_id=?${turnIds ? ` AND turn_id IN (${turnIds.map(() => '?').join(',')})` : ''}`,
      args: [tenantId, sessionId, ...(turnIds ?? [])] })
  }
}
export const rootRunStore = new RootRunStore()
