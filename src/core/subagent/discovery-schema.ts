import type { Client } from '@libsql/client'

/** Additive metadata never rewrites archived snapshots, usage, or parent events. */
export async function ensureDiscoverySchema(db: Client): Promise<void> {
  await db.execute(`CREATE TABLE IF NOT EXISTS subagent_discovery_state (
    tenant_id TEXT NOT NULL, parent_session_id TEXT NOT NULL,
    generation TEXT NOT NULL, secret TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0, floor_revision INTEGER NOT NULL DEFAULT 0,
    bootstrap_complete INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id,parent_session_id))`)
  await db.execute(`CREATE TABLE IF NOT EXISTS subagent_discovery_versions (
    tenant_id TEXT NOT NULL, parent_session_id TEXT NOT NULL, generation TEXT NOT NULL,
    revision INTEGER NOT NULL, run_id TEXT NOT NULL, created_revision INTEGER NOT NULL,
    run_seq INTEGER NOT NULL, status TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
    root_session_id TEXT NOT NULL, parent_conversation_id TEXT NOT NULL, identity TEXT NOT NULL,
    PRIMARY KEY(tenant_id,parent_session_id,generation,revision))`)
  await db.execute('CREATE INDEX IF NOT EXISTS idx_subagent_discovery_run ON subagent_discovery_versions(tenant_id,parent_session_id,generation,run_id,revision DESC)')
  await db.execute('CREATE INDEX IF NOT EXISTS idx_subagent_discovery_creation ON subagent_discovery_versions(tenant_id,parent_session_id,generation,created_revision,revision)')
}
