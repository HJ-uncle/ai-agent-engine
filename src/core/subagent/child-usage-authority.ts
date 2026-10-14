import { randomUUID } from 'node:crypto'
import type { Client, Transaction } from '@libsql/client'
import type { SubagentRun, SubagentRunHeader } from './types.js'

export type RecoveryQuery = Pick<Client, 'execute'> | Pick<Transaction, 'execute'>
export class ChildRecoveryRequiredError extends Error {
  readonly statusCode = 409
  readonly recoveryRequired = true
  constructor(readonly reason: string) { super(`CHILD_RECOVERY_REQUIRED: ${reason}`); this.name = 'ChildRecoveryRequiredError' }
}
export function requireChildRecovery(reason: string): never { throw new ChildRecoveryRequiredError(reason) }
export interface UsageContribution { tokens: number; unknown: boolean; finishedAt?: number }
export interface ChildUsageFence { tenantId: string; parentSessionId: string; generation: string; revision: number }
export interface ChildUsageScalar { totalTokens: number; count: number; unknown: number; finishedAt?: number }
export const recoveryVersion = (value: unknown): number => {
  const version = Number(value)
  if (!Number.isSafeInteger(version) || version < 0) requireChildRecovery('invalid_revision')
  return version
}
const safeVersion = recoveryVersion
const id = (value: unknown): string => {
  if (typeof value !== 'string' || !value) requireChildRecovery('invalid_identity')
  return value
}

/** Match the existing billing semantics: unknown still includes its known lower bound. */
export function childUsageContribution(usage: { totalTokens?: unknown; inputTokens?: unknown; outputTokens?: unknown; unknown?: unknown }, finishedAt?: unknown): UsageContribution {
  const reported = usage.totalTokens ?? (usage.inputTokens !== undefined && usage.outputTokens !== undefined
    ? typeof usage.inputTokens === 'number' && typeof usage.outputTokens === 'number' ? usage.inputTokens + usage.outputTokens : undefined : undefined)
  const known = typeof reported === 'number' && Number.isFinite(reported)
  return { tokens: known ? Math.max(0, reported) : 0, unknown: !!usage.unknown || !known,
    ...(typeof finishedAt === 'number' && Number.isFinite(finishedAt) && finishedAt !== 0 ? { finishedAt } : {}) }
}
const sameContribution = (row: Record<string, unknown>, value: UsageContribution): boolean =>
  Number(row.tokens) === value.tokens && Boolean(row.unknown) === value.unknown &&
  (row.finished_at === null ? undefined : Number(row.finished_at)) === value.finishedAt
export function sameChildUsage(a: Pick<SubagentRun, 'usage' | 'finishedAt'>, b: Pick<SubagentRun, 'usage' | 'finishedAt'>): boolean {
  const before = childUsageContribution(a.usage, a.finishedAt), after = childUsageContribution(b.usage, b.finishedAt)
  return before.tokens === after.tokens && before.unknown === after.unknown && before.finishedAt === after.finishedAt
}

/** Scalar-only bootstrap runs inside the caller's write transaction, never transports tool arrays. */
export async function ensureParentChildUsage(tx: Transaction, tenantId: string, parentSessionId: string): Promise<ChildUsageFence> {
  id(tenantId); id(parentSessionId)
  let state = await tx.execute({ sql: 'SELECT * FROM subagent_usage_parent_state WHERE tenant_id=? AND parent_session_id=?', args: [tenantId, parentSessionId] })
  if (state.rows[0]) {
    if (Number(state.rows[0].bootstrap_complete) !== 1) requireChildRecovery('bootstrap_incomplete')
    return { tenantId, parentSessionId, generation: String(state.rows[0].generation), revision: safeVersion(state.rows[0].revision) }
  }
  const generation = randomUUID()
  await tx.execute({ sql: 'INSERT INTO subagent_usage_parent_state(tenant_id,parent_session_id,generation) VALUES (?,?,?)', args: [tenantId, parentSessionId, generation] })
  let after = ''
  for (;;) {
    const rows = await tx.execute({ sql: `SELECT r.run_id,
      coalesce(json_extract(a.record,'$.parentConversationId'),json_extract(r.snapshot,'$.parentConversationId')) AS turn_id,
      coalesce(json_extract(a.record,'$.rootSessionId'),json_extract(r.snapshot,'$.rootSessionId')) AS root_id,
      json_extract(coalesce(c.header,r.snapshot),'$.usage.totalTokens') AS tokens,
      json_extract(coalesce(c.header,r.snapshot),'$.usage.inputTokens') AS input_tokens,
      json_extract(coalesce(c.header,r.snapshot),'$.usage.outputTokens') AS output_tokens,
      json_extract(coalesce(c.header,r.snapshot),'$.usage.unknown') AS unknown,
      json_extract(coalesce(c.header,r.snapshot),'$.finishedAt') AS finished_at,
      CASE WHEN a.record IS NOT NULL AND c.header IS NULL THEN 1 ELSE 0 END AS missing_checkpoint
      FROM subagent_runs r LEFT JOIN subagent_records a ON a.tenant_id=r.tenant_id AND a.run_id=r.run_id
      LEFT JOIN subagent_checkpoints c ON c.tenant_id=r.tenant_id AND c.run_id=r.run_id AND c.seq=r.seq
      WHERE r.tenant_id=? AND r.parent_session_id=? AND r.run_id>? ORDER BY r.run_id LIMIT 256`, args: [tenantId, parentSessionId, after] })
    for (const row of rows.rows) {
      if (Number(row.missing_checkpoint)) requireChildRecovery('missing_checkpoint')
      const value = childUsageContribution({ totalTokens: row.tokens ?? undefined, inputTokens: row.input_tokens ?? undefined,
        outputTokens: row.output_tokens ?? undefined, unknown: row.unknown }, row.finished_at)
      await tx.execute({ sql: 'INSERT INTO subagent_usage_contributions(tenant_id,parent_session_id,run_id,parent_turn_id,root_session_id,valid_from,tokens,unknown,finished_at) VALUES (?,?,?,?,?,0,?,?,?)',
        args: [tenantId, parentSessionId, id(row.run_id), id(row.turn_id), id(row.root_id), value.tokens, Number(value.unknown), value.finishedAt ?? null] })
    }
    if (rows.rows.length < 256) break
    after = String(rows.rows.at(-1)!.run_id)
  }
  await tx.execute({ sql: 'UPDATE subagent_usage_parent_state SET bootstrap_complete=1 WHERE tenant_id=? AND parent_session_id=?', args: [tenantId, parentSessionId] })
  return { tenantId, parentSessionId, generation, revision: 0 }
}

/** Every mutator uses the same transaction as its checkpoint and invocation dedup. */
export async function recordDurableChildUsage(tx: Transaction, run: SubagentRun | SubagentRunHeader): Promise<void> {
  const state = await ensureParentChildUsage(tx, run.tenantId, run.parentSessionId)
  const previous = (await tx.execute({ sql: 'SELECT * FROM subagent_usage_contributions WHERE tenant_id=? AND parent_session_id=? AND run_id=? AND valid_to IS NULL',
    args: [run.tenantId, run.parentSessionId, run.runId] })).rows[0]
  const value = childUsageContribution(run.usage ?? {}, run.finishedAt)
  if (previous && (previous.parent_turn_id !== run.parentConversationId || previous.root_session_id !== run.rootSessionId)) requireChildRecovery('identity_changed')
  if (previous && sameContribution(previous, value)) return
  const revision = safeVersion(state.revision + 1)
  await tx.execute({ sql: 'UPDATE subagent_usage_parent_state SET revision=? WHERE tenant_id=? AND parent_session_id=? AND revision=? AND generation=?',
    args: [revision, run.tenantId, run.parentSessionId, state.revision, state.generation] }).then(result => {
      if (result.rowsAffected !== 1) requireChildRecovery('usage_write_race')
    })
  if (previous) await tx.execute({ sql: 'UPDATE subagent_usage_contributions SET valid_to=? WHERE tenant_id=? AND parent_session_id=? AND run_id=? AND valid_to IS NULL', args: [revision, run.tenantId, run.parentSessionId, run.runId] })
  await tx.execute({ sql: 'INSERT INTO subagent_usage_contributions(tenant_id,parent_session_id,run_id,parent_turn_id,root_session_id,valid_from,tokens,unknown,finished_at) VALUES (?,?,?,?,?,?,?,?,?)',
    args: [run.tenantId, run.parentSessionId, run.runId, run.parentConversationId, run.rootSessionId, revision, value.tokens, Number(value.unknown), value.finishedAt ?? null] })
}
export async function readChildUsageFence(q: RecoveryQuery, tenantId: string, parentSessionId: string): Promise<ChildUsageFence> {
  const row = (await q.execute({ sql: 'SELECT * FROM subagent_usage_parent_state WHERE tenant_id=? AND parent_session_id=?', args: [id(tenantId), id(parentSessionId)] })).rows[0]
  if (!row || Number(row.bootstrap_complete) !== 1) requireChildRecovery('bootstrap_incomplete')
  return { tenantId, parentSessionId, generation: String(row.generation), revision: safeVersion(row.revision) }
}
export async function assertChildUsageFence(q: Transaction, fence: ChildUsageFence): Promise<void> {
  const row = (await q.execute({ sql: 'SELECT * FROM subagent_usage_parent_state WHERE tenant_id=? AND parent_session_id=?', args: [id(fence.tenantId), id(fence.parentSessionId)] })).rows[0]
  if (!row || Number(row.bootstrap_complete) !== 1) requireChildRecovery('bootstrap_incomplete')
  if (row.generation !== fence.generation) requireChildRecovery('generation_changed')
  const revision = safeVersion(fence.revision)
  if (revision < Number(row.floor_revision) || revision > Number(row.revision)) requireChildRecovery('retention_gap')
}
export function scalarFromRow(row: Record<string, unknown>): ChildUsageScalar {
  const totalTokens = Number(row.tokens ?? 0), count = Number(row.count ?? 0), unknown = Number(row.unknown ?? 0)
  if (!Number.isFinite(totalTokens) || totalTokens < 0 || !Number.isSafeInteger(count) || count < 0 ||
    !Number.isSafeInteger(unknown) || unknown < 0 || unknown > count) requireChildRecovery('invalid_aggregate')
  const finishedAt = row.finished_at === null || row.finished_at === undefined ? undefined : Number(row.finished_at)
  if (finishedAt !== undefined && !Number.isFinite(finishedAt)) requireChildRecovery('invalid_aggregate')
  return { totalTokens, count, unknown, ...(finishedAt === undefined ? {} : { finishedAt }) }
}
export async function readDurableChildUsage(q: Transaction, fence: ChildUsageFence, excludeTurnId?: string): Promise<ChildUsageScalar> {
  await assertChildUsageFence(q, fence)
  const result = await q.execute({ sql: `SELECT coalesce(sum(tokens),0) AS tokens,count(*) AS count,coalesce(sum(unknown),0) AS unknown,max(finished_at) AS finished_at
    FROM subagent_usage_contributions WHERE tenant_id=? AND parent_session_id=? AND valid_from<=? AND (valid_to IS NULL OR valid_to>?) ${excludeTurnId === undefined ? '' : 'AND parent_turn_id<>?'}`,
    args: [fence.tenantId, fence.parentSessionId, fence.revision, fence.revision, ...(excludeTurnId === undefined ? [] : [id(excludeTurnId)])] })
  return scalarFromRow(result.rows[0])
}
/** Clear changes the identity first; outstanding exact fences can never sample a reused ID. */
export async function resetParentChildRecovery(tx: Transaction, tenantId: string, parentSessionId: string): Promise<void> {
  await tx.execute({ sql: 'UPDATE subagent_usage_parent_state SET generation=?,revision=0,floor_revision=0,bootstrap_complete=0 WHERE tenant_id=? AND parent_session_id=?', args: [randomUUID(), tenantId, parentSessionId] })
  for (const table of ['parent_publication_marks', 'parent_published_child_versions', 'parent_publication_state', 'subagent_usage_contributions'])
    await tx.execute({ sql: `DELETE FROM ${table} WHERE tenant_id=? AND parent_session_id=?`, args: [tenantId, parentSessionId] })
  await tx.execute({ sql: 'DELETE FROM subagent_usage_parent_state WHERE tenant_id=? AND parent_session_id=?', args: [tenantId, parentSessionId] })
}
