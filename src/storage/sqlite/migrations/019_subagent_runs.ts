import type { Client } from '@libsql/client'

export async function up(db: Client): Promise<void> {
  await db.execute(`CREATE TABLE IF NOT EXISTS subagent_runs (
    tenant_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    parent_session_id TEXT NOT NULL,
    parent_tool_call_id TEXT NOT NULL,
    child_session_id TEXT NOT NULL,
    status TEXT NOT NULL,
    seq INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    snapshot TEXT NOT NULL,
    PRIMARY KEY (tenant_id, run_id),
    UNIQUE (tenant_id, parent_session_id, parent_tool_call_id)
  )`)
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_subagent_runs_parent ON subagent_runs(tenant_id, parent_session_id, created_at)`)
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_subagent_runs_child ON subagent_runs(tenant_id, child_session_id)`)
  await db.execute(`CREATE TABLE IF NOT EXISTS subagent_events (
    tenant_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL,
    event TEXT NOT NULL,
    PRIMARY KEY (tenant_id, run_id, seq)
  )`)
  await db.execute(`CREATE TABLE IF NOT EXISTS subagent_outbox (
    id TEXT NOT NULL PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    event TEXT NOT NULL,
    acknowledged INTEGER NOT NULL DEFAULT 0
  )`)
  await db.execute(`CREATE TABLE IF NOT EXISTS subagent_usage_invocations (
    tenant_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    invocation_id TEXT NOT NULL,
    PRIMARY KEY (tenant_id, run_id, invocation_id)
  )`)
}

export async function down(db: Client): Promise<void> {
  await db.execute('DROP TABLE IF EXISTS subagent_usage_invocations')
  await db.execute('DROP TABLE IF EXISTS subagent_outbox')
  await db.execute('DROP TABLE IF EXISTS subagent_events')
  await db.execute('DROP TABLE IF EXISTS subagent_runs')
}
