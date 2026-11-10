import { randomUUID } from 'node:crypto'
import type { Client, InValue, Row, Transaction } from '@libsql/client'
import type { AgentContext } from '../agent-context/types.js'
import { serviceForOwner, type ExecutionOwner } from '../collaboration/execution-owner.js'
import type { CollaborationBinding } from '../collaboration/types.js'
import { isTerminalRun, type SubagentRunView } from './types.js'

export interface WakeWhen { allSucceeded: string[] }
export type DependencyHookState = 'armed' | 'ready' | 'blocked' | 'consumed' | 'cancelled' | 'superseded'
export interface DependencyHook {
  id: string; stepId: string; label: string; revision: number; state: DependencyHookState; refs: string[]
  resolvedRunIds: string[]; unresolvedRefs: string[]
  conditionOutcome?: 'ready' | 'blocked'; issue?: { runId?: string; code: string }
  consumedRequestId?: string
}
export interface HookSnapshot {
  revision: number; hooks: DependencyHook[]; hasHooks: boolean; activeHookCount: number; managedRunIds: string[]; suppressedRunIds: string[]
}
export interface HookClaim { id: string; revision: number }
type Query = Pick<Transaction, 'execute'>
export interface DependencyHookAuthority {
  ctx: AgentContext; owner: ExecutionOwner; db: Client; service: ReturnType<typeof serviceForOwner>; binding: CollaborationBinding
}
const prepared = new WeakMap<Client, Promise<void>>()
const subscribers = new WeakMap<Client, Map<string, Set<() => void>>>()
const dependencyWaits = new WeakSet<ExecutionOwner>()
const scopeArgs = (b: CollaborationBinding): InValue[] => [b.tenantId, b.rootRunId, b.rootAttemptId]
const scopeKey = (b: CollaborationBinding) => JSON.stringify(scopeArgs(b))
const fail = (code: string): never => { throw new Error(code) }

export function ensureDependencyHookSchema(db: Client): Promise<void> {
  let ready = prepared.get(db)
  if (!ready) {
    ready = db.batch([
      `CREATE TABLE IF NOT EXISTS dependency_hook_scopes (
        tenant_id TEXT NOT NULL,root_run_id TEXT NOT NULL,root_attempt_id TEXT NOT NULL,
        session_id TEXT NOT NULL,generation TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(tenant_id,root_run_id,root_attempt_id),
        FOREIGN KEY(root_run_id) REFERENCES root_runs(run_id) ON DELETE CASCADE)`,
      `CREATE TABLE IF NOT EXISTS dependency_hooks (
        id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,root_run_id TEXT NOT NULL,root_attempt_id TEXT NOT NULL,
        session_id TEXT NOT NULL,step_id TEXT NOT NULL,label TEXT NOT NULL,revision INTEGER NOT NULL,refs_json TEXT NOT NULL,
        state TEXT NOT NULL,outcome TEXT,issue_json TEXT,consumed_request_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
        UNIQUE(tenant_id,root_run_id,root_attempt_id,step_id,revision),
        FOREIGN KEY(tenant_id,root_run_id,root_attempt_id) REFERENCES dependency_hook_scopes(tenant_id,root_run_id,root_attempt_id) ON DELETE CASCADE)`,
      'CREATE INDEX IF NOT EXISTS dependency_hooks_session_state ON dependency_hooks(tenant_id,session_id,state)',
      `CREATE TABLE IF NOT EXISTS dependency_task_bindings (
        tenant_id TEXT NOT NULL,root_run_id TEXT NOT NULL,root_attempt_id TEXT NOT NULL,task_key TEXT NOT NULL,request_key TEXT NOT NULL,request_fingerprint TEXT NOT NULL,run_id TEXT,
        PRIMARY KEY(tenant_id,root_run_id,root_attempt_id,task_key),
        FOREIGN KEY(tenant_id,root_run_id,root_attempt_id) REFERENCES dependency_hook_scopes(tenant_id,root_run_id,root_attempt_id) ON DELETE CASCADE)`,
      `CREATE TABLE IF NOT EXISTS dependency_joined_results (
        tenant_id TEXT NOT NULL,root_run_id TEXT NOT NULL,root_attempt_id TEXT NOT NULL,run_id TEXT NOT NULL,
        terminal_seq INTEGER NOT NULL,status TEXT NOT NULL,issue TEXT,projection TEXT,
        PRIMARY KEY(tenant_id,root_run_id,root_attempt_id,run_id),
        FOREIGN KEY(tenant_id,root_run_id,root_attempt_id) REFERENCES dependency_hook_scopes(tenant_id,root_run_id,root_attempt_id) ON DELETE CASCADE)`,
      `CREATE TABLE IF NOT EXISTS task_plan_wake_conditions (
        tenant_id TEXT NOT NULL,session_id TEXT NOT NULL,step_id TEXT NOT NULL,refs_json TEXT NOT NULL,hook_id TEXT NOT NULL,
        PRIMARY KEY(tenant_id,session_id,step_id),FOREIGN KEY(step_id) REFERENCES todos(id) ON DELETE CASCADE,
        FOREIGN KEY(hook_id) REFERENCES dependency_hooks(id) ON DELETE CASCADE)`,
    ], 'write').then(() => undefined).catch(error => { prepared.delete(db); throw error })
    prepared.set(db, ready)
  }
  return ready
}

export async function dependencyHookAuthority(ctx: AgentContext, db?: Client, query?: Query): Promise<DependencyHookAuthority> {
  ctx.signal?.throwIfAborted()
  if (!ctx.executionOwner) fail('DEPENDENCY_HOOK_CANONICAL_OWNER_REQUIRED')
  const owner = ctx.executionOwner!, service = serviceForOwner(owner)
  const binding = service.collaboration.executionBinding(service.producerForExecution(owner))
  if (db && db !== service.db || binding.kind !== 'root' || binding.tenantId !== ctx.tenantId
    || binding.sessionId !== ctx.sessionId || binding.rootSessionId !== (ctx.rootSessionId ?? ctx.sessionId)
    || binding.rootRunId !== ctx.rootRunId || binding.turnId !== ctx.turnId) fail('DEPENDENCY_HOOK_AUTHORITY_MISMATCH')
  await ensureDependencyHookSchema(service.db)
  const authority = { ctx, owner, db: service.db, service, binding }
  await assertAuthority(authority, query ?? service.db)
  return authority
}
async function assertAuthority(a: DependencyHookAuthority, q: Query): Promise<void> {
  assertContext(a)
  await a.service.collaboration.store.assertProducer(q, a.binding, true)
  assertContext(a)
}
function assertContext(a: DependencyHookAuthority): void {
  const { ctx, binding: b } = a
  if (ctx.executionOwner !== a.owner || b.tenantId !== ctx.tenantId || b.sessionId !== ctx.sessionId
    || b.rootSessionId !== (ctx.rootSessionId ?? ctx.sessionId) || b.rootRunId !== ctx.rootRunId || b.turnId !== ctx.turnId)
    fail('DEPENDENCY_HOOK_AUTHORITY_MISMATCH')
  a.service.producerForExecution(a.owner)
  a.ctx.signal?.throwIfAborted()
}
async function ensureScope(q: Query, a: DependencyHookAuthority): Promise<void> {
  const b = a.binding
  await q.execute({ sql: 'INSERT OR IGNORE INTO dependency_hook_scopes VALUES(?,?,?,?,?,0)', args: [...scopeArgs(b), b.sessionId, b.generation] })
  const row = (await q.execute({ sql: 'SELECT session_id,generation FROM dependency_hook_scopes WHERE tenant_id=? AND root_run_id=? AND root_attempt_id=?', args: scopeArgs(b) })).rows[0]
  if (row?.session_id !== b.sessionId || row.generation !== b.generation) fail('DEPENDENCY_HOOK_STALE_GENERATION')
}
async function bump(q: Query, a: DependencyHookAuthority): Promise<void> {
  await q.execute({ sql: 'UPDATE dependency_hook_scopes SET revision=revision+1 WHERE tenant_id=? AND root_run_id=? AND root_attempt_id=?', args: scopeArgs(a.binding) })
}
export function publishHookChanges(a: DependencyHookAuthority): void {
  for (const listener of subscribers.get(a.db)?.get(scopeKey(a.binding)) ?? []) {
    // Notification is a hint after commit; observers must read a fresh durable snapshot.
    try { listener() } catch { /* A detached observer cannot roll back committed state. */ }
  }
}
export function subscribeHookChanges(ctx: AgentContext, listener: () => void): () => void {
  if (!ctx.executionOwner) fail('DEPENDENCY_HOOK_CANONICAL_OWNER_REQUIRED')
  const service = serviceForOwner(ctx.executionOwner!)
  const b = service.collaboration.executionBinding(service.producerForExecution(ctx.executionOwner!))
  if (b.kind !== 'root' || b.tenantId !== ctx.tenantId || b.sessionId !== ctx.sessionId || b.rootSessionId !== (ctx.rootSessionId ?? ctx.sessionId) || b.rootRunId !== ctx.rootRunId || b.turnId !== ctx.turnId)
    fail('DEPENDENCY_HOOK_AUTHORITY_MISMATCH')
  let scopes = subscribers.get(service.db)
  if (!scopes) { scopes = new Map(); subscribers.set(service.db, scopes) }
  const key = scopeKey(b), listeners = scopes.get(key) ?? new Set<() => void>()
  scopes.set(key, listeners); listeners.add(listener)
  return () => { listeners.delete(listener); if (!listeners.size) scopes!.delete(key) }
}
/** The plan transaction validates durable conditions first; this marker never changes root lifecycle status. */
export function requestDependencyWait(ctx: AgentContext): void {
  if (!ctx.executionOwner) fail('DEPENDENCY_HOOK_CANONICAL_OWNER_REQUIRED')
  const service = serviceForOwner(ctx.executionOwner!)
  const b = service.collaboration.executionBinding(service.producerForExecution(ctx.executionOwner!))
  if (b.kind !== 'root' || b.tenantId !== ctx.tenantId || b.sessionId !== ctx.sessionId || b.rootSessionId !== (ctx.rootSessionId ?? ctx.sessionId) || b.rootRunId !== ctx.rootRunId || b.turnId !== ctx.turnId)
    fail('DEPENDENCY_HOOK_AUTHORITY_MISMATCH')
  dependencyWaits.add(ctx.executionOwner!)
}
export function takeDependencyWait(ctx: AgentContext): boolean {
  return ctx.executionOwner ? dependencyWaits.delete(ctx.executionOwner) : false
}
async function inScope<T>(ctx: AgentContext, write: boolean, action: (q: Transaction, a: DependencyHookAuthority) => Promise<T>): Promise<T> {
  const a = await dependencyHookAuthority(ctx), tx = await a.db.transaction(write ? 'write' : 'read')
  try {
    await assertAuthority(a, tx)
    if (write) await ensureScope(tx, a)
    const beforeRevision = write ? Number((await tx.execute({ sql: 'SELECT revision FROM dependency_hook_scopes WHERE tenant_id=? AND root_run_id=? AND root_attempt_id=?', args: scopeArgs(a.binding) })).rows[0]?.revision ?? 0) : 0
    const result = await action(tx, a)
    const afterRevision = write ? Number((await tx.execute({ sql: 'SELECT revision FROM dependency_hook_scopes WHERE tenant_id=? AND root_run_id=? AND root_attempt_id=?', args: scopeArgs(a.binding) })).rows[0]?.revision ?? 0) : 0
    await assertAuthority(a, tx); await tx.commit()
    if (write && afterRevision !== beforeRevision) publishHookChanges(a)
    return result
  } catch (error) { await tx.rollback(); throw error }
}
async function ownedInvocation(q: Query, a: DependencyHookAuthority, runId: string): Promise<Row> {
  const row = (await q.execute({ sql: `SELECT r.status,r.seq AS last_seq,r.parent_session_id,r.parent_tool_call_id FROM collaboration_invocations i
    JOIN subagent_runs r ON r.tenant_id=i.tenant_id AND r.run_id=i.invocation_run_id
    WHERE i.tenant_id=? AND i.root_run_id=? AND i.root_attempt_id=? AND i.invocation_run_id=? AND i.participant_id<>?`,
    args: [...scopeArgs(a.binding), runId, a.binding.participantId] })).rows[0]
  if (!row || row.parent_session_id !== a.binding.sessionId) fail('DEPENDENCY_HOOK_RUN_NOT_OWNED')
  return row
}
async function bindings(q: Query, a: DependencyHookAuthority): Promise<Map<string, string>> {
  const rows = (await q.execute({ sql: 'SELECT task_key,run_id FROM dependency_task_bindings WHERE tenant_id=? AND root_run_id=? AND root_attempt_id=? AND run_id IS NOT NULL', args: scopeArgs(a.binding) })).rows
  return new Map(rows.map(row => [String(row.task_key), String(row.run_id)]))
}
function resolveRefs(refs: string[], keys: Map<string, string>) {
  return { resolvedRunIds: [...new Set(refs.flatMap(ref => ref.startsWith('task:') ? keys.has(ref.slice(5)) ? [keys.get(ref.slice(5))!] : [] : [ref]))],
    unresolvedRefs: refs.filter(ref => ref.startsWith('task:') && !keys.has(ref.slice(5))) }
}
async function snapshot(q: Query, a: DependencyHookAuthority): Promise<HookSnapshot> {
  const keys = await bindings(q, a)
  const rows = (await q.execute({ sql: 'SELECT * FROM dependency_hooks WHERE tenant_id=? AND root_run_id=? AND root_attempt_id=? ORDER BY rowid', args: scopeArgs(a.binding) })).rows
  const state = (await q.execute({ sql: 'SELECT revision FROM dependency_hook_scopes WHERE tenant_id=? AND root_run_id=? AND root_attempt_id=?', args: scopeArgs(a.binding) })).rows[0]
  const suppressed = (await q.execute({ sql: "SELECT run_id FROM dependency_joined_results WHERE tenant_id=? AND root_run_id=? AND root_attempt_id=? AND projection='suppressed' ORDER BY rowid", args: scopeArgs(a.binding) })).rows
  const hooks = rows.map(row => {
    const refs = JSON.parse(String(row.refs_json)) as string[]
    return { id: String(row.id), stepId: String(row.step_id), label: String(row.label), revision: Number(row.revision), state: String(row.state) as DependencyHookState,
      refs, ...resolveRefs(refs, keys), ...(row.outcome ? { conditionOutcome: String(row.outcome) as 'ready' | 'blocked' } : {}),
      ...(row.issue_json ? { issue: JSON.parse(String(row.issue_json)) } : {}),
      ...(row.consumed_request_id ? { consumedRequestId: String(row.consumed_request_id) } : {}) }
  })
  return { revision: Number(state?.revision ?? 0), hooks, hasHooks: hooks.length > 0,
    activeHookCount: hooks.filter(hook => ['armed','ready','blocked'].includes(hook.state)).length,
    managedRunIds: [...new Set(hooks.flatMap(hook => hook.resolvedRunIds))], suppressedRunIds: suppressed.map(row => String(row.run_id)) }
}
async function reevaluate(q: Query, a: DependencyHookAuthority): Promise<void> {
  const current = await snapshot(q, a)
  const joined = new Map((await q.execute({ sql: 'SELECT * FROM dependency_joined_results WHERE tenant_id=? AND root_run_id=? AND root_attempt_id=?', args: scopeArgs(a.binding) })).rows.map(row => [String(row.run_id), row]))
  for (const hook of current.hooks) {
    if (hook.state !== 'armed') continue
    const failed = hook.resolvedRunIds.map(runId => joined.get(runId)).find(row => row && (row.status !== 'succeeded' || row.issue))
    const ready = !hook.unresolvedRefs.length && hook.resolvedRunIds.length > 0 && hook.resolvedRunIds.every(runId => joined.get(runId)?.status === 'succeeded' && !joined.get(runId)?.issue)
    if (!failed && !ready) continue
    const state = failed ? 'blocked' : 'ready'
    const issue = failed ? JSON.stringify({ runId: String(failed.run_id), code: String(failed.issue ?? `DEPENDENCY_${String(failed.status).toUpperCase()}`) }) : null
    await q.execute({ sql: 'UPDATE dependency_hooks SET state=?,outcome=?,issue_json=?,updated_at=? WHERE id=? AND state=\'armed\'', args: [state, state, issue, Date.now(), hook.id] })
    await bump(q, a)
  }
}

export function readHookSnapshot(ctx: AgentContext): Promise<HookSnapshot> { return inScope(ctx, false, snapshot) }
/** Call only after the whole dispatch batch, when the model has explicitly yielded all runnable work. */
export function blockUnresolvedHooks(ctx: AgentContext): Promise<HookSnapshot> {
  return inScope(ctx, true, async (q, a) => {
    for (const hook of (await snapshot(q, a)).hooks) {
      if (hook.state !== 'armed' || !hook.unresolvedRefs.length) continue
      await q.execute({ sql: "UPDATE dependency_hooks SET state='blocked',outcome='blocked',issue_json=?,updated_at=? WHERE id=? AND state='armed'",
        args: [JSON.stringify({ code: 'DEPENDENCY_TASK_NOT_STARTED' }),Date.now(),hook.id] })
      await bump(q, a)
    }
    return snapshot(q, a)
  })
}
export function claimTaskKey(ctx: AgentContext, key: string, toolCallId: string, fingerprint = toolCallId): Promise<{ runId?: string }> {
  if (typeof key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(key)) return Promise.reject(new Error('DEPENDENCY_TASK_KEY_INVALID'))
  if (!toolCallId?.trim() || toolCallId.length > 200) return Promise.reject(new Error('DEPENDENCY_TASK_REQUEST_KEY_INVALID'))
  if (!fingerprint?.trim() || fingerprint.length > 256) return Promise.reject(new Error('DEPENDENCY_TASK_FINGERPRINT_INVALID'))
  return inScope(ctx, true, async (q, a) => {
    const prior = (await q.execute({ sql: 'SELECT request_key,request_fingerprint,run_id FROM dependency_task_bindings WHERE tenant_id=? AND root_run_id=? AND root_attempt_id=? AND task_key=?', args: [...scopeArgs(a.binding), key] })).rows[0]
    if (prior) {
      if (prior.request_key !== toolCallId) fail('DEPENDENCY_TASK_KEY_ALREADY_RESERVED')
      if (prior.request_fingerprint !== fingerprint) fail('DEPENDENCY_TASK_KEY_PAYLOAD_CONFLICT')
      return prior.run_id == null ? {} : { runId: String(prior.run_id) }
    }
    await q.execute({ sql: 'INSERT INTO dependency_task_bindings VALUES(?,?,?,?,?,?,NULL)', args: [...scopeArgs(a.binding), key, toolCallId, fingerprint] })
    await bump(q, a)
    return {}
  })
}
export function bindTaskKey(ctx: AgentContext, key: string, runId: string): Promise<HookSnapshot> {
  if (typeof key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(key)) return Promise.reject(new Error('DEPENDENCY_TASK_KEY_INVALID'))
  return inScope(ctx, true, async (q, a) => {
    const run = await ownedInvocation(q, a, runId)
    const prior = (await q.execute({ sql: 'SELECT request_key,run_id FROM dependency_task_bindings WHERE tenant_id=? AND root_run_id=? AND root_attempt_id=? AND task_key=?', args: [...scopeArgs(a.binding), key] })).rows[0]
    if (!prior) fail('DEPENDENCY_TASK_KEY_NOT_RESERVED')
    if (prior.request_key !== run.parent_tool_call_id) fail('DEPENDENCY_TASK_KEY_REQUEST_MISMATCH')
    if (prior.run_id != null && prior.run_id !== runId) fail('DEPENDENCY_TASK_KEY_ALREADY_BOUND')
    if (prior.run_id == null) {
      await q.execute({ sql: 'UPDATE dependency_task_bindings SET run_id=? WHERE tenant_id=? AND root_run_id=? AND root_attempt_id=? AND task_key=?', args: [runId,...scopeArgs(a.binding),key] })
      await bump(q, a)
    }
    await reevaluate(q, a); return snapshot(q, a)
  })
}
/** Only the runner passes views after its actual executor, projection and ticket join. A terminal DB row alone is never evaluated. */
export function evaluateDependencyHooks(ctx: AgentContext, joined: readonly SubagentRunView[]): Promise<HookSnapshot> {
  return inScope(ctx, true, async (q, a) => {
    for (const run of joined) {
      const row = await ownedInvocation(q, a, run.runId)
      const ticket = [...a.service.record(a.owner).tickets].find(ticket => ticket.runId === run.runId)
      if (!ticket?.done || ticket.error || ticket.terminalSeq !== run.lastSeq || !ticket.projection) fail('DEPENDENCY_JOIN_EXECUTOR_UNSETTLED')
      if (run.tenantId !== a.binding.tenantId || run.parentSessionId !== a.binding.sessionId || !isTerminalRun(run.status)
        || row.status !== run.status || Number(row.last_seq) !== run.lastSeq) fail('DEPENDENCY_JOIN_RECEIPT_MISMATCH')
      const projection = (await q.execute({ sql: `SELECT o.acknowledged,p.disposition FROM subagent_outbox o
        JOIN subagent_projection_receipts p ON p.tenant_id=o.tenant_id AND p.run_id=o.run_id AND p.seq=o.seq
        WHERE o.tenant_id=? AND o.run_id=? AND o.seq=?`, args: [run.tenantId, run.runId, run.lastSeq] })).rows[0]
      if (!projection?.acknowledged || !projection.disposition || projection.disposition !== ticket!.projection) fail('DEPENDENCY_JOIN_PROJECTION_UNKNOWN')
      const issue = projection.disposition === 'suppressed' ? 'DEPENDENCY_RESULT_SUPPRESSED' : run.status === 'succeeded' ? null : run.error?.code ?? `DEPENDENCY_${run.status.toUpperCase()}`
      await recordJoined(q, a, run.runId, run.lastSeq, run.status, issue, String(projection.disposition))
    }
    await reevaluate(q, a); return snapshot(q, a)
  })
}
async function recordJoined(q: Query, a: DependencyHookAuthority, runId: string, seq: number, status: string, issue: string | null, projection: string | null) {
  const prior = (await q.execute({ sql: 'SELECT * FROM dependency_joined_results WHERE tenant_id=? AND root_run_id=? AND root_attempt_id=? AND run_id=?', args: [...scopeArgs(a.binding), runId] })).rows[0]
  if (prior) {
    if (Number(prior.terminal_seq) !== seq || prior.status !== status || prior.issue !== issue || prior.projection !== projection) fail('DEPENDENCY_JOIN_RECEIPT_CONFLICT')
    return
  }
  await q.execute({ sql: 'INSERT INTO dependency_joined_results VALUES(?,?,?,?,?,?,?,?)', args: [...scopeArgs(a.binding), runId, seq, status, issue, projection] })
  await bump(q, a)
}
export function recordDependencyJoinFailure(ctx: AgentContext, runId: string, errorCode = 'DEPENDENCY_JOIN_FAILED'): Promise<HookSnapshot> {
  return inScope(ctx, true, async (q, a) => {
    const row = await ownedInvocation(q, a, runId)
    const ticket = [...a.service.record(a.owner).tickets].find(ticket => ticket.runId === runId)
    if (!ticket?.done || !ticket.error) fail('DEPENDENCY_JOIN_FAILURE_UNPROVEN')
    await recordJoined(q, a, runId, Number(row.last_seq), 'join_failed', errorCode.slice(0,240), null)
    await reevaluate(q, a); return snapshot(q, a)
  })
}
export function consumeHooks(ctx: AgentContext, claims: readonly HookClaim[], requestId: string): Promise<HookSnapshot> {
  if (!requestId?.trim() || requestId.length > 200 || claims.length > 100 || new Set(claims.map(claim => claim.id)).size !== claims.length)
    return Promise.reject(new Error('DEPENDENCY_HOOK_CONSUMPTION_INVALID'))
  return inScope(ctx, true, async (q, a) => {
    const current = await snapshot(q, a)
    for (const claim of claims) {
      const hook = current.hooks.find(item => item.id === claim.id && item.revision === claim.revision)
      if (!hook || !['ready', 'blocked'].includes(hook.state) && !(hook.state === 'consumed' && hook.consumedRequestId === requestId))
        fail('DEPENDENCY_HOOK_CONSUMPTION_STALE')
    }
    for (const claim of claims) {
      const updated = await q.execute({ sql: "UPDATE dependency_hooks SET state='consumed',consumed_request_id=?,updated_at=? WHERE id=? AND revision=? AND state IN ('ready','blocked')",
        args: [requestId, Date.now(), claim.id, claim.revision] })
      if (updated.rowsAffected) await bump(q, a)
    }
    return snapshot(q, a)
  })
}

export async function readPlanWakeConditions(q: Query, tenantId: string, sessionId: string): Promise<Map<string, WakeWhen>> {
  try {
    const rows = (await q.execute({ sql: 'SELECT step_id,refs_json FROM task_plan_wake_conditions WHERE tenant_id=? AND session_id=?', args: [tenantId, sessionId] })).rows
    return new Map(rows.map(row => [String(row.step_id), { allSucceeded: JSON.parse(String(row.refs_json)) as string[] }]))
  } catch (error) {
    if (/no such table:\s*task_plan_wake_conditions/i.test(String(error))) return new Map()
    throw error
  }
}
/** Runs inside the same transaction as the complete plan replacement. */
export async function syncPlanDependencyHooks(q: Query, a: DependencyHookAuthority,
  plan: ReadonlyArray<{ id: string; step: string; status: string; wakeWhen?: WakeWhen | null }>, explicit: ReadonlySet<string>): Promise<HookSnapshot> {
  await assertAuthority(a, q); await ensureScope(q, a)
  const current = await snapshot(q, a), keep = new Set(plan.map(step => step.id))
  // Old attempt records remain auditable, but cannot authorize work in this root.
  const stale = await q.execute({ sql: `UPDATE dependency_hooks SET state='superseded',updated_at=? WHERE tenant_id=? AND session_id=?
    AND (root_run_id<>? OR root_attempt_id<>?) AND state IN ('armed','ready','blocked')`,
    args: [Date.now(), a.binding.tenantId, a.binding.sessionId, a.binding.rootRunId, a.binding.rootAttemptId] })
  if (stale.rowsAffected) await bump(q, a)
  for (const hook of current.hooks) {
    if (keep.has(hook.stepId) || ['cancelled', 'superseded'].includes(hook.state)) continue
    await q.execute({ sql: "UPDATE dependency_hooks SET state='cancelled',updated_at=? WHERE id=?", args: [Date.now(), hook.id] }); await bump(q, a)
  }
  const keys = await bindings(q, a)
  for (const step of plan) {
    const prior = [...current.hooks].reverse().find(hook => hook.stepId === step.id && !['superseded','cancelled'].includes(hook.state))
    const refs = step.wakeWhen?.allSucceeded
    if (!refs || step.status === 'cancelled') {
      if (prior) {
        await q.execute({ sql: "UPDATE dependency_hooks SET state='cancelled',updated_at=? WHERE id=?", args: [Date.now(), prior.id] }); await bump(q, a)
      }
      await q.execute({ sql: 'DELETE FROM task_plan_wake_conditions WHERE tenant_id=? AND session_id=? AND step_id=?', args: [a.binding.tenantId,a.binding.sessionId,step.id] })
      continue
    }
    if (prior && prior.refs.length === refs.length && prior.refs.every(ref => refs.includes(ref))) {
      if (prior.label !== step.step) {
        await q.execute({ sql: 'UPDATE dependency_hooks SET label=?,updated_at=? WHERE id=?', args: [step.step,Date.now(),prior.id] }); await bump(q, a)
      }
      continue
    }
    // Carrying a saved plan into a new attempt never silently arms old dependencies.
    if (!explicit.has(step.id)) continue
    for (const ref of refs) {
      if (!ref.startsWith('task:')) await ownedInvocation(q, a, ref)
      else if (keys.has(ref.slice(5))) await ownedInvocation(q, a, keys.get(ref.slice(5))!)
    }
    if (prior) await q.execute({ sql: "UPDATE dependency_hooks SET state='superseded',updated_at=? WHERE id=?", args: [Date.now(), prior.id] })
    const id = randomUUID(), revision = Math.max(0,...current.hooks.filter(hook => hook.stepId === step.id).map(hook => hook.revision)) + 1, now = Date.now()
    await q.execute({ sql: `INSERT INTO dependency_hooks(id,tenant_id,root_run_id,root_attempt_id,session_id,step_id,label,revision,refs_json,state,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,'armed',?,?)`, args: [id,...scopeArgs(a.binding),a.binding.sessionId,step.id,step.step,revision,JSON.stringify(refs),now,now] })
    await q.execute({ sql: `INSERT INTO task_plan_wake_conditions VALUES(?,?,?,?,?) ON CONFLICT(tenant_id,session_id,step_id)
      DO UPDATE SET refs_json=excluded.refs_json,hook_id=excluded.hook_id`, args: [a.binding.tenantId,a.binding.sessionId,step.id,JSON.stringify(refs),id] })
    await bump(q, a)
  }
  await reevaluate(q, a); await assertAuthority(a, q)
  const result = await snapshot(q, a)
  if (result.activeHookCount > 32) fail('DEPENDENCY_HOOK_ACTIVE_LIMIT')
  return result
}
