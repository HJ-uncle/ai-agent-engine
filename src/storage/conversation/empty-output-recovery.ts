import type { Client } from '@libsql/client'
import type { AgentContext } from '../../core/agent-context/types.js'
import { jsonlHistoryIdentity } from './jsonl-origin.js'
import { sqliteHistoryIdentity } from './sqlite-origin.js'

type Scope = Pick<AgentContext, 'history' | 'tenantId' | 'sessionId' | 'rootRunId' | 'turnId'>
const schemas = new WeakMap<Client, Promise<void>>()

function database(ctx: Scope): Client | undefined {
  return sqliteHistoryIdentity(ctx.history)?.db ?? jsonlHistoryIdentity(ctx.history)?.db()
}

/** One small receipt per invocation survives history compaction and process restart.
 * Only the real history's private datasource identity selects the database. No
 * transcript metadata, copied wrapper shape, or full archive scan grants a retry.
 */
export async function consumeEmptyOutputRecovery(ctx: Scope): Promise<boolean> {
  const db = database(ctx)
  // Legacy/in-memory strategies have no durable root identity. Their existing
  // local allowance and visible segment still bound the current invocation.
  if (!db || !ctx.rootRunId || !ctx.turnId) return true
  let ready = schemas.get(db)
  if (!ready) {
    ready = db.execute(`CREATE TABLE IF NOT EXISTS conversation_empty_output_recovery (
      tenant_id TEXT NOT NULL, session_id TEXT NOT NULL, root_run_id TEXT NOT NULL,
      turn_id TEXT NOT NULL, consumed_at INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, session_id, root_run_id, turn_id))`).then(() => undefined)
      .catch(error => { schemas.delete(db); throw error })
    schemas.set(db, ready)
  }
  await ready
  if (database(ctx) !== db) throw new Error('Empty-output recovery datasource changed')
  // Claim before persisting the diagnostic or issuing another model request.
  // A crash/failure between these steps may forgo a retry, never create a second.
  const claimed = await db.execute({ sql: `INSERT OR IGNORE INTO conversation_empty_output_recovery
    (tenant_id, session_id, root_run_id, turn_id, consumed_at) VALUES (?, ?, ?, ?, ?)`,
    args: [ctx.tenantId, ctx.sessionId, ctx.rootRunId, ctx.turnId, Date.now()] })
  if (database(ctx) !== db) throw new Error('Empty-output recovery datasource changed')
  return claimed.rowsAffected === 1
}
