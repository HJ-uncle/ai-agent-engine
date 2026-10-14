import { randomUUID } from 'node:crypto'
import type { Client } from '@libsql/client'
import { getDb, getDbEpoch } from '../sqlite/db.js'
import { withHistoryLock, isSessionHistoryMutating, isSessionHistoryCompressing, waitForSessionHistoryCompression } from '../conversation/serialization.js'
import type { CompactionState } from '../../core/subagent/types.js'
import { ensureCronRunSchema, withCronWrite, validateAutomationAdmission, bindAutomationRoot, projectAutomationRoot, type AutomationAdmission } from '../cron/runs.js'
import { getExecutionOwners, serviceForOwner, type DrainEvidence, type ExecutionOwner } from '../../core/collaboration/execution-owner.js'
import type { CollaborationBinding } from '../../core/collaboration/types.js'
import { ensureUserAdmissionSchema, readDatabaseNamespace, lookupUserAdmission, assertAdmissionPredecessor, bindUserAdmission, type PreparedUserAdmission, type UserAdmissionReceipt, type UserAdmissionSelector } from '../root-admission/index.js'
import { bindServerAdmissionSeed, ensureServerAdmissionSchema, prepareServerAdmissionInput, readServerAdmissionSeed, type ServerAdmissionReceipt } from '../root-admission/server-seed.js'
import { canonicalAdmissionBody } from '../root-admission/index.js'

export type { CompactionState } from '../../core/subagent/types.js'

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
  automationRunId?: string
  cronJobId?: string
  cronTimeoutSeconds?: number
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
  compaction?: CompactionState
  /** Presence matters: omitted resources inherit from the agent, [] explicitly disables them. */
  requestConfig?: RootRunRequestConfig
  workspacePaths: string[]
  createdAt: number
  updatedAt: number
  finishedAt?: number
  stopReason?: string
  error?: { code: string; message: string; retryable: boolean }
  pending: RootPending[]
  admissionReceipt?: UserAdmissionReceipt
  serverAdmissionReceipt?: ServerAdmissionReceipt
}
interface StoredRun extends RootRun { request: Record<string, unknown>; attemptId: string }
const schemas = new WeakMap<Client, Promise<void>>()
const recovered = new WeakMap<Client, Promise<void>>()

/** Deliberately omit credentials; resume resolves the same model's stored connection. */
export function resumableRequest(request: Record<string, unknown>): Record<string, unknown> {
  const allowed = ['automationRunId', 'cronJobId', 'cronTimeoutSeconds', 'agentId', 'systemPrompt', 'maxAskUserCount', 'thinkingMode', 'inheritContext', 'workspacePaths',
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
  for (const key of ['automationRunId', 'cronJobId', 'agentId', 'subagentModel', 'utilityModel'] as const) {
    if (typeof request[key] === 'string') config[key] = request[key]
  }
  for (const key of ['skills', 'mcpServers', 'knowledgeBases'] as const) {
    const value = request[key]
    if (Array.isArray(value) && value.every(id => typeof id === 'string')) config[key] = [...value]
  }
  const timeout = request.cronTimeoutSeconds
  if (typeof timeout === 'number' && Number.isSafeInteger(timeout) && timeout > 0) config.cronTimeoutSeconds = timeout
  const thinking = request.thinkingMode
  if (typeof thinking === 'boolean' || thinking === 'low' || thinking === 'medium' || thinking === 'high') config.thinkingMode = thinking
  const scope = request.memoryScope
  if (scope === 'off' || scope === 'global' || scope === 'session') config.memoryScope = scope
  return config
}

export class RootRunStore {
  constructor(private readonly database?: () => Client) {}
  async initialize(): Promise<void> {
    const db = await this.ready()
    let recovery = recovered.get(db)
    if (!recovery) {
      recovery = this.recoverAtStartup(db)
      recovered.set(db, recovery)
    }
    await recovery
  }
  private async recoverAtStartup(db: Client): Promise<void> {
    const rows = await db.execute("SELECT run_id,tenant_id,state FROM root_runs WHERE json_extract(state,'$.status')='running' OR json_extract(state,'$.compaction.phase')='running'")
    for (const row of rows.rows) {
      const run = JSON.parse(String(row.state)) as StoredRun
      if (run.status !== 'running' && run.compaction?.phase !== 'running') continue
      const now = Date.now()
      if (run.compaction?.phase === 'running') run.compaction = { ...run.compaction, phase: 'failed', finishedAt: now,
        error: 'Engine restarted before automatic compaction completed; original history was preserved' }
      if (run.status === 'running') {
        run.status = 'interrupted'; run.stopReason = 'Engine restarted; execution was not resumed'
        run.error = { code: 'ENGINE_RESTARTED', message: run.stopReason, retryable: false }; run.finishedAt = now
      }
      run.updatedAt = now; run.version++
      await withCronWrite(db, async tx => {
        await tx.execute({ sql: 'UPDATE root_runs SET state=? WHERE run_id=?', args: [JSON.stringify(run), String(row.run_id)] })
        await projectAutomationRoot(tx, String(row.tenant_id), run)
      })
    }
  }
  private async ready(): Promise<Client> {
    const db = this.database?.() ?? getDb()
    let promise = schemas.get(db)
    if (!promise) {
      promise = (async () => {
        await ensureCronRunSchema(db)
        await db.execute(`CREATE TABLE IF NOT EXISTS root_runs (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, session_id TEXT NOT NULL,
          run_id TEXT NOT NULL UNIQUE, turn_id TEXT NOT NULL, state TEXT NOT NULL)`)
        await db.execute('CREATE INDEX IF NOT EXISTS root_runs_session ON root_runs(tenant_id, session_id, seq)')
        await ensureUserAdmissionSchema(db)
        await ensureServerAdmissionSchema(db)
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

  /** The session index can answer status without decoding every archived turn. */
  async latest(tenantId: string, sessionId: string): Promise<RootRun | null> {
    const db = await this.ready()
    const rows = await db.execute({ sql: 'SELECT seq,state FROM root_runs WHERE tenant_id=? AND session_id=? ORDER BY seq DESC LIMIT 1', args: [tenantId, sessionId] })
    const row = rows.rows[0]
    return row ? this.public({ ...JSON.parse(String(row.state)), seq: Number(row.seq) }) : null
  }

  async get(tenantId: string, runId: string): Promise<StoredRun | null> {
    const db = await this.ready()
    const rows = await db.execute({ sql: 'SELECT seq,state FROM root_runs WHERE tenant_id=? AND run_id=?', args: [tenantId, runId] })
    const row = rows.rows[0]
    return row ? { ...JSON.parse(String(row.state)), seq: Number(row.seq) } : null
  }

  async create(tenantId: string, sessionId: string, modelId: string, workspacePaths: string[], request: Record<string, unknown>, automation?: AutomationAdmission, signal?: AbortSignal, onPrepared?: (runId: string, attemptId: string) => void): Promise<RootRun> {
    const serverInput = prepareServerAdmissionInput(request)
    while (true) {
    await waitForSessionHistoryCompression(tenantId, sessionId, signal)
    const admitted = await withHistoryLock(tenantId, async () => {
      signal?.throwIfAborted()
      // Maintenance can register between the lock-free wait and this lease.
      if (isSessionHistoryCompressing(tenantId, sessionId)) return null
      if (isSessionHistoryMutating(tenantId, sessionId)) throw Object.assign(new Error('Session history is being changed'), { statusCode: 409 })
      const now = Date.now()
      const run: StoredRun = { schemaVersion: 1, runId: randomUUID(), turnId: randomUUID(), sessionId,
        userMessageId: randomUUID(), assistantMessageId: randomUUID(), seq: 0, version: 1, status: 'running',
        modelId, workspacePaths, createdAt: now, updatedAt: now, pending: [], attemptId: randomUUID(), request: resumableRequest(request) }
      onPrepared?.(run.runId, run.attemptId)
      const db = await this.ready()
      if (request.automationRunId !== undefined && (!automation || request.automationRunId !== automation.runId)) {
        throw Object.assign(new Error('Automation admission context is required'), { statusCode: 409 })
      }
      try { await withCronWrite(db, async tx => {
        const claim = automation ? await validateAutomationAdmission(tx, tenantId, sessionId, automation.dispatchRequest ?? request, automation) : null
        const active = await tx.execute({ sql: "SELECT 1 FROM root_runs WHERE tenant_id=? AND session_id=? AND json_extract(state,'$.status') IN ('running','waiting') LIMIT 1", args: [tenantId,sessionId] })
        if (active.rows.length) throw Object.assign(new Error('This session already has a running or waiting turn'), { statusCode: 409 })
        const result = await tx.execute({ sql: 'INSERT INTO root_runs(tenant_id,session_id,run_id,turn_id,state) VALUES(?,?,?,?,?) RETURNING seq',
          args: [tenantId, sessionId, run.runId, run.turnId, JSON.stringify(run)] })
        run.seq = Number(result.rows[0].seq)
        if (claim && automation) await bindAutomationRoot(tx, claim, run, automation)
        if (serverInput) {
          run.serverAdmissionReceipt = await bindServerAdmissionSeed(tx, tenantId, serverInput, run, claim)
          await tx.execute({ sql: 'UPDATE root_runs SET state=? WHERE tenant_id=? AND run_id=?', args: [JSON.stringify(run), tenantId, run.runId] })
        }
      }) } catch (error) {
        const committed = await db.execute({ sql: 'SELECT seq,state FROM root_runs WHERE tenant_id=? AND run_id=?', args: [tenantId, run.runId] })
        if (!committed.rows[0]) throw error
        const persisted = JSON.parse(String(committed.rows[0].state)) as StoredRun
        if (persisted.attemptId !== run.attemptId || persisted.sessionId !== sessionId || persisted.turnId !== run.turnId) throw new Error('ROOT_ADMISSION_ACK_IDENTITY_CONFLICT')
        if (serverInput) {
          if (!run.serverAdmissionReceipt || canonicalAdmissionBody(persisted.serverAdmissionReceipt) !== canonicalAdmissionBody(run.serverAdmissionReceipt)) throw new Error('ROOT_ADMISSION_ACK_IDENTITY_CONFLICT')
          await readServerAdmissionSeed(db, { tenantId, sessionId }, run.runId)
        }
        return this.public({ ...persisted, seq: Number(committed.rows[0].seq) })
      }
      return this.public(run)
    })
    if (admitted) return admitted
    }
  }

  admissionDatabase(): Promise<Client> { return this.ready() }

  async userAdmissionContext(tenantId: string, sessionId: string) {
    const db = await this.ready(), tx = await db.transaction('read')
    try {
      const namespace = await readDatabaseNamespace(tx)
      const row = (await tx.execute({ sql: 'SELECT state FROM root_runs WHERE tenant_id=? AND session_id=? ORDER BY seq DESC LIMIT 1', args: [tenantId, sessionId] })).rows[0]
      const run = row ? JSON.parse(String(row.state)) as StoredRun : null
      await tx.commit()
      return { namespace, predecessor: run ? { runId: run.runId, attemptId: run.attemptId, version: run.version } : null,
        root: run ? { runId: run.runId, attemptId: run.attemptId, version: run.version, status: run.status,
          workspacePaths: run.workspacePaths, modelId: run.modelId,
          ...(typeof run.request.agentId === 'string' ? { agentId: run.request.agentId } : {}) } : null }
    } catch (error) { if (!tx.closed) await tx.rollback(); throw error }
    finally { tx.close() }
  }

  async findUserAdmission(tenantId: string, sessionId: string, selector: Pick<UserAdmissionSelector, 'namespace' | 'requestKey' | 'bodyDigest'>) {
    const db = await this.ready(), tx = await db.transaction('read')
    try { const receipt = await lookupUserAdmission(tx, tenantId, sessionId, selector); await tx.commit(); return receipt }
    catch (error) { if (!tx.closed) await tx.rollback(); throw error }
    finally { tx.close() }
  }

  /** SQLite owns admission facts; transcript projection uses a retained outbox. */
  async createUserAdmission(tenantId: string, modelId: string, workspacePaths: string[], request: Record<string, unknown>,
    admission: PreparedUserAdmission, signal?: AbortSignal, onPrepared?: (runId: string, attemptId: string) => void): Promise<{ run: RootRun; receipt: UserAdmissionReceipt; duplicate: boolean }> {
    const db = await this.ready()
    // Exact replay never waits for compression or prepares a producer.
    const known = await this.findUserAdmission(tenantId, admission.sessionId, admission)
    if (known) return { run: this.public(known.run), receipt: known.receipt, duplicate: true }
    while (true) {
      await waitForSessionHistoryCompression(tenantId, admission.sessionId, signal)
      const accepted = await withHistoryLock(tenantId, async () => {
        signal?.throwIfAborted()
        if (isSessionHistoryCompressing(tenantId, admission.sessionId)) return null
        if (isSessionHistoryMutating(tenantId, admission.sessionId)) throw Object.assign(new Error('Session history is being changed'), { statusCode: 409 })
        let prepared: StoredRun | undefined
        try {
          return await withCronWrite(db, async tx => {
            const previous = await lookupUserAdmission(tx, tenantId, admission.sessionId, admission)
            if (previous) return { run: this.public(previous.run), receipt: previous.receipt, duplicate: true }
            await assertAdmissionPredecessor(tx, tenantId, admission)
            const active = await tx.execute({ sql: "SELECT 1 FROM root_runs WHERE tenant_id=? AND session_id=? AND json_extract(state,'$.status') IN ('running','waiting') LIMIT 1", args: [tenantId, admission.sessionId] })
            if (active.rows.length) throw Object.assign(new Error('This session already has a running or waiting turn'), { statusCode: 409 })
            signal?.throwIfAborted()
            const now = Date.now()
            const run: StoredRun = { schemaVersion: 1, runId: randomUUID(), turnId: randomUUID(), sessionId: admission.sessionId,
              userMessageId: randomUUID(), assistantMessageId: randomUUID(), seq: 0, version: 1, status: 'running', modelId, workspacePaths,
              createdAt: now, updatedAt: now, pending: [], attemptId: randomUUID(), request: resumableRequest(request) }
            prepared = run
            onPrepared?.(run.runId, run.attemptId)
            const row = await tx.execute({ sql: 'INSERT INTO root_runs(tenant_id,session_id,run_id,turn_id,state) VALUES(?,?,?,?,?) RETURNING seq', args: [tenantId, admission.sessionId, run.runId, run.turnId, JSON.stringify(run)] })
            run.seq = Number(row.rows[0].seq)
            const receipt = await bindUserAdmission(tx, tenantId, admission, run)
            run.admissionReceipt = receipt
            await tx.execute({ sql: 'UPDATE root_runs SET state=? WHERE tenant_id=? AND run_id=?', args: [JSON.stringify(run), tenantId, run.runId] })
            return { run: this.public(run), receipt, duplicate: false }
          })
        } catch (error) {
          // Query the exact key once; an unavailable result is never permission
          // to create another root or rerun a model after an uncertain commit.
          if (!prepared) throw error
          let committed: Awaited<ReturnType<RootRunStore['findUserAdmission']>>
          try { committed = await this.findUserAdmission(tenantId, admission.sessionId, admission) }
          catch (lookupError) { throw new AggregateError([error, lookupError], 'USER_ADMISSION_ACK_UNKNOWN') }
          if (!committed) throw error
          if (committed.run.runId !== prepared.runId || committed.attemptId !== prepared.attemptId) throw new Error('USER_ADMISSION_ACK_IDENTITY_CONFLICT')
          return { run: this.public(committed.run), receipt: committed.receipt, duplicate: false }
        }
      })
      if (accepted) return accepted
    }
  }

  async update(tenantId: string, runId: string, change: Partial<Omit<RootRun, 'runId' | 'sessionId' | 'turnId' | 'seq' | 'version'>>, expectedAttemptId?: string): Promise<RootRun | null> {
    return withHistoryLock(tenantId, async () => {
      const run = await this.get(tenantId, runId)
      if (!run) return null
      if (expectedAttemptId && run.attemptId !== expectedAttemptId) return null
      if (change.status && change.status !== run.status && getExecutionOwners().find(tenantId, runId, run.attemptId))
        throw new Error('ROOT_TERMINAL_REQUIRES_OWNED_DRAIN')
      if (change.status && !['running', 'waiting'].includes(run.status) && change.status !== run.status) return null
      const wasActive = ['running', 'waiting'].includes(run.status)
      const previousFinishedAt = run.finishedAt
      const now = Date.now()
      Object.assign(run, change, { updatedAt: now, version: run.version + 1 })
      // Post-turn maintenance has its own completion time. Keep the execution
      // outcome's timestamp stable across later compaction/result updates.
      if (!['running', 'waiting'].includes(run.status)) {
        run.finishedAt = wasActive || previousFinishedAt === undefined ? now : previousFinishedAt
      }
      const db = await this.ready()
      await withCronWrite(db, async tx => {
        await tx.execute({ sql: 'UPDATE root_runs SET state=? WHERE tenant_id=? AND run_id=?', args: [JSON.stringify(run), tenantId, runId] })
        await projectAutomationRoot(tx, tenantId, run)
      })
      return this.public(run)
    })
  }

  /** Drain proof and the exact private attempt are rechecked inside one physical write transaction. */
  async settleOwned(tenantId: string, runId: string, owner: ExecutionOwner, proof: DrainEvidence,
    change: Partial<Pick<RootRun, 'status' | 'error' | 'stopReason'>>, pending?: Omit<RootPending, 'status'>): Promise<RootRun> {
    const service = serviceForOwner(owner)
    const db = await this.ready()
    const scope = service.assertSettlement(owner, proof, db)
    if (scope.binding.tenantId !== tenantId || scope.binding.rootRunId !== runId) throw new Error('ROOT_SETTLEMENT_IDENTITY_MISMATCH')
    return withHistoryLock(tenantId, () => withCronWrite(db, async tx => {
      // A previous commit can be known even when its transport ACK was lost.
      const result = await tx.execute({ sql: 'SELECT seq,state FROM root_runs WHERE tenant_id=? AND run_id=?', args: [tenantId, runId] })
      if (!result.rows[0]) throw new Error('ROOT_SETTLEMENT_MISSING')
      const run: StoredRun = { ...JSON.parse(String(result.rows[0].state)), seq: Number(result.rows[0].seq) }
      if (run.attemptId !== scope.binding.rootAttemptId || run.sessionId !== scope.binding.rootSessionId || run.turnId !== scope.binding.turnId) throw new Error('ROOT_SETTLEMENT_STALE_ATTEMPT')
      const closure = await tx.execute({ sql: 'SELECT generation,phase FROM collaboration_roots WHERE tenant_id=? AND root_run_id=? AND root_attempt_id=?', args: [tenantId, runId, run.attemptId] })
      if (closure.rows[0]?.generation !== scope.binding.generation) throw new Error('ROOT_SETTLEMENT_STALE_GENERATION')
      if (closure.rows[0].phase === 'closed' && run.status !== 'running') return this.public(run)
      if (run.status !== 'running') throw new Error('ROOT_SETTLEMENT_NOT_RUNNING')
      await service.collaboration.store.closeSettledRoot(tx, scope.binding)
      const settlement = service.assertSettlement(owner, proof, db)
      const intent = settlement.intent
      const status = settlement.cancellationRequested ? 'cancelled' : intent === 'park' ? 'waiting' : change.status
      if (!status || status === 'running' || status === 'waiting' && (!pending || intent !== 'park')) throw new Error('ROOT_SETTLEMENT_INVALID_OUTCOME')
      Object.assign(run, change, { status, version: run.version + 1, updatedAt: Date.now() })
      if (status === 'waiting') run.pending = [...run.pending.filter(item => item.requestId !== pending!.requestId), { ...pending!, status: 'pending' }]
      else run.finishedAt = run.updatedAt
      await tx.execute({ sql: 'UPDATE root_runs SET state=? WHERE tenant_id=? AND run_id=?', args: [JSON.stringify(run), tenantId, runId] })
      await projectAutomationRoot(tx, tenantId, run)
      return this.public(run)
    }))
  }

  finishOwned(owner: ExecutionOwner, change: Partial<Pick<RootRun, 'status' | 'error' | 'stopReason'>>, pending?: Omit<RootPending, 'status'>): Promise<RootRun> {
    const service = serviceForOwner(owner)
    const binding = service.record(owner).binding
    const intent = pending ? 'park' : change.status === 'succeeded' ? 'finish' : 'cancel'
    return service.settle(owner, intent, async proof => {
      try { return await this.settleOwned(binding.tenantId, binding.rootRunId, owner, proof, change, pending) }
      catch (error) {
        // The second exact query/transaction only reconciles the committed
        // attempt; it never recreates execution or emits another side effect.
        try { return await this.settleOwned(binding.tenantId, binding.rootRunId, owner, proof, change, pending) }
        catch (reconcileError) { throw new AggregateError([error, reconcileError], 'ROOT_SETTLEMENT_ACK_UNKNOWN') }
      }
    }).then(async run => run.status === 'waiting' && service.record(owner).cancellationRequested
      ? this.cancelParked(owner, change.stopReason ?? 'Cancelled during park commit') : run)
  }

  /** A released capability cannot dispatch again; its exact committed close may still acknowledge an earlier stop. */
  async terminalReceipt(binding: CollaborationBinding, db: Client, epoch: number): Promise<RootRun> {
    if (getDb() !== db || db.closed || getDbEpoch(db) !== epoch) throw new Error('ROOT_RECEIPT_DATASOURCE_MISMATCH')
    const result = await db.execute({
      sql: `SELECT r.seq,r.state,c.phase,c.generation FROM root_runs r JOIN collaboration_roots c
        ON c.tenant_id=r.tenant_id AND c.root_run_id=r.run_id AND c.root_attempt_id=?
        WHERE r.tenant_id=? AND r.run_id=?`,
      args: [binding.rootAttemptId, binding.tenantId, binding.rootRunId],
    })
    const row = result.rows[0]
    if (!row) throw new Error('ROOT_TERMINAL_RECEIPT_MISSING')
    const run: StoredRun = { ...JSON.parse(String(row.state)), seq: Number(row.seq) }
    if (run.sessionId !== binding.rootSessionId || run.attemptId !== binding.rootAttemptId || row.generation !== binding.generation
      || row.phase !== 'closed' || ['running','waiting'].includes(run.status)) throw new Error('ROOT_TERMINAL_RECEIPT_UNKNOWN')
    return this.public(run)
  }

  async cancelParked(owner: ExecutionOwner, reason: string): Promise<RootRun> {
    const service = serviceForOwner(owner), record = service.record(owner)
    if (!['parked','closed'].includes(record.phase)) throw new Error('ROOT_CANCEL_NOT_PARKED')
    service.fence(owner, 'cancel', reason)
    const db = await this.ready()
    if (service.db !== db) throw new Error('ROOT_CANCEL_DATASOURCE_MISMATCH')
    const cancelled = await withHistoryLock(record.binding.tenantId, () => withCronWrite(db, async tx => {
      const result = await tx.execute({ sql: 'SELECT seq,state FROM root_runs WHERE tenant_id=? AND run_id=?', args: [record.binding.tenantId, record.binding.rootRunId] })
      if (!result.rows[0]) throw new Error('ROOT_CANCEL_MISSING')
      const run: StoredRun = { ...JSON.parse(String(result.rows[0].state)), seq: Number(result.rows[0].seq) }
      if (run.attemptId !== record.binding.rootAttemptId || !['waiting','cancelled'].includes(run.status)) throw new Error('ROOT_CANCEL_STALE_PARK')
      const closure = await tx.execute({ sql: 'SELECT phase,generation FROM collaboration_roots WHERE tenant_id=? AND root_run_id=? AND root_attempt_id=?', args: [record.binding.tenantId, run.runId, run.attemptId] })
      if (closure.rows[0]?.phase !== 'closed' || closure.rows[0].generation !== record.binding.generation) throw new Error('ROOT_CANCEL_PARK_RECEIPT_UNKNOWN')
      if (run.status === 'cancelled') return this.public(run)
      Object.assign(run, { status: 'cancelled', stopReason: reason, version: run.version + 1, updatedAt: Date.now(), finishedAt: Date.now() })
      await tx.execute({ sql: 'UPDATE root_runs SET state=? WHERE tenant_id=? AND run_id=?', args: [JSON.stringify(run), record.binding.tenantId, run.runId] })
      await projectAutomationRoot(tx, record.binding.tenantId, run)
      return this.public(run)
    }))
    service.completeParkCancellation(owner)
    return cancelled
  }

  async pending(tenantId: string, runId: string, pending: Omit<RootPending, 'status'>, expectedAttemptId?: string): Promise<RootRun | null> {
    return withHistoryLock(tenantId, async () => {
      const run = await this.get(tenantId, runId)
      if (!run) return null
      return this.update(tenantId, runId, { status: 'waiting', pending: [...run.pending.filter(p => p.requestId !== pending.requestId), { ...pending, status: 'pending' }] }, expectedAttemptId)
    })
  }

  async answer(tenantId: string, sessionId: string, runId: string, requestId: string, toolCallId: string, toolName: string, output: string, signal?: AbortSignal, onPrepared?: (runId: string, attemptId: string) => void): Promise<{ run: RootRun; pending: RootPending; duplicate: boolean }> {
    return withHistoryLock(tenantId, async () => {
      signal?.throwIfAborted()
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
      const owner = getExecutionOwners().find(tenantId, runId, stored.attemptId)
      if (owner && serviceForOwner(owner).record(owner).cancellationRequested)
        throw Object.assign(new Error('Waiting execution has been cancelled'), { statusCode: 409 })
      if (pending.kind === 'permission' && output !== 'approved' && output !== 'rejected') throw Object.assign(new Error('Approval answer must be approved or rejected'), { statusCode: 400 })
      pending.status = 'answered'; pending.output = output
      Object.assign(stored, { status: 'running', attemptId: randomUUID(), error: undefined, stopReason: undefined,
        updatedAt: Date.now(), version: stored.version + 1 })
      onPrepared?.(stored.runId, stored.attemptId)
      const db = await this.ready()
      await withCronWrite(db, async tx => {
        await tx.execute({ sql: 'UPDATE root_runs SET state=? WHERE tenant_id=? AND run_id=?', args: [JSON.stringify(stored), tenantId, runId] })
        await projectAutomationRoot(tx, tenantId, stored)
      })
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
