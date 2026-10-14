import type { Client } from '@libsql/client'

/** Additive indexes leave every legacy event and failed-run archive untouched. */
export async function ensureSubagentDeltaSchema(db: Client): Promise<void> {
  await db.execute('SELECT json_valid(\'{}\') AS json1_available')
  await db.execute('CREATE TABLE IF NOT EXISTS subagent_records (tenant_id TEXT NOT NULL,run_id TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(tenant_id,run_id))')
  await db.execute('CREATE TABLE IF NOT EXISTS subagent_checkpoints (tenant_id TEXT NOT NULL,run_id TEXT NOT NULL,seq INTEGER NOT NULL,header TEXT NOT NULL,PRIMARY KEY(tenant_id,run_id,seq))')
  await db.execute('CREATE TABLE IF NOT EXISTS subagent_tools (tenant_id TEXT NOT NULL,run_id TEXT NOT NULL,tool_id TEXT NOT NULL,ordinal INTEGER NOT NULL,revision_seq INTEGER NOT NULL,status TEXT NOT NULL,summary TEXT NOT NULL,PRIMARY KEY(tenant_id,run_id,tool_id))')
  await db.execute('CREATE INDEX IF NOT EXISTS idx_subagent_tools_recent ON subagent_tools(tenant_id,run_id,revision_seq DESC,tool_id)')
  await db.execute('CREATE INDEX IF NOT EXISTS idx_subagent_tools_active ON subagent_tools(tenant_id,run_id,status,revision_seq DESC,tool_id)')
  await db.execute('CREATE INDEX IF NOT EXISTS idx_subagent_tools_window ON subagent_tools(tenant_id,run_id,revision_seq DESC,ordinal DESC,tool_id)')
  await db.execute('CREATE INDEX IF NOT EXISTS idx_subagent_tools_active_window ON subagent_tools(tenant_id,run_id,status,revision_seq DESC,ordinal DESC,tool_id)')
  await db.execute('CREATE INDEX IF NOT EXISTS idx_subagent_tools_ordinal ON subagent_tools(tenant_id,run_id,ordinal,tool_id)')
  await db.execute('CREATE TABLE IF NOT EXISTS subagent_tool_versions (tenant_id TEXT NOT NULL,run_id TEXT NOT NULL,tool_id TEXT NOT NULL,seq INTEGER NOT NULL,ordinal INTEGER NOT NULL,status TEXT NOT NULL,summary TEXT NOT NULL,detail TEXT NOT NULL,PRIMARY KEY(tenant_id,run_id,tool_id,seq))')
  await db.execute('CREATE INDEX IF NOT EXISTS idx_subagent_tool_versions_page ON subagent_tool_versions(tenant_id,run_id,ordinal,tool_id,seq DESC)')
  await db.execute("CREATE INDEX IF NOT EXISTS idx_subagent_delta_tool_revision ON subagent_events(tenant_id,run_id,json_extract(event,'$.toolUpsert.id'),seq) WHERE json_extract(event,'$.schemaVersion')=2 AND kind IN ('tool.started','tool.completed')")
}
