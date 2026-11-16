import type { Client, Transaction } from '@libsql/client'
import { isTerminalRun, type RunStatus } from './types.js'

/** Recheck a user's exact child selection in the root-admission transaction.
 * Rich permission/workspace checks run before admission; the immutable profile
 * and latest execution identity must still be the same here. */
export async function assertChildContinuationSelection(query: Pick<Client | Transaction, 'execute'>,
  input: { tenantId: string; parentSessionId: string; parentTurnId: string; runId: string }): Promise<void> {
  const rows = await query.execute({ sql: `SELECT r.child_session_id,r.status,
    json_extract(coalesce(m.record,r.snapshot),'$.rootSessionId') AS root_session,
    json_extract(coalesce(m.record,r.snapshot),'$.parentConversationId') AS parent_turn,
    json_type(coalesce(m.record,r.snapshot),'$.continuation') AS profile_type,
    (SELECT n.run_id FROM subagent_runs n WHERE n.tenant_id=r.tenant_id AND n.parent_session_id=r.parent_session_id
      AND n.child_session_id=r.child_session_id ORDER BY n.rowid DESC LIMIT 1) AS latest_run,
    (SELECT count(*) FROM subagent_runs n WHERE n.tenant_id=r.tenant_id AND n.child_session_id=r.child_session_id
      AND n.status IN ('queued','running','cancelling')) AS active_count
    FROM subagent_runs r LEFT JOIN subagent_records m ON m.tenant_id=r.tenant_id AND m.run_id=r.run_id
    WHERE r.tenant_id=? AND r.parent_session_id=? AND r.run_id=?`, args: [input.tenantId, input.parentSessionId, input.runId] })
  const row = rows.rows[0]
  if (!row || row.root_session !== input.parentSessionId || row.parent_turn !== input.parentTurnId)
    throw new Error('SUBAGENT_RESUME_NOT_OWNED: 子代理不属于选中的父任务轮次。')
  if (!isTerminalRun(row.status as RunStatus) || Number(row.active_count)) throw new Error('SUBAGENT_RESUME_BUSY: 子代理尚未结束。')
  if (row.latest_run !== input.runId) throw new Error('SUBAGENT_RESUME_STALE: 子代理已有更新的执行。')
  if (row.profile_type !== 'object') throw new Error('SUBAGENT_RESUME_UNAVAILABLE: 子代理缺少冻结权限。')
}
