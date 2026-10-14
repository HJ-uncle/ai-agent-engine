import type { Client } from '@libsql/client'
import { requireChildRecovery } from './child-usage-authority.js'

/** Publication and billing fences are distinct from discovery membership. */
export async function ensureChildRecoverySchema(db: Client): Promise<void> {
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS subagent_usage_parent_state (
      tenant_id TEXT NOT NULL, parent_session_id TEXT NOT NULL, generation TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0, floor_revision INTEGER NOT NULL DEFAULT 0,
      bootstrap_complete INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(tenant_id,parent_session_id)
    );
    CREATE TABLE IF NOT EXISTS subagent_usage_contributions (
      tenant_id TEXT NOT NULL, parent_session_id TEXT NOT NULL, run_id TEXT NOT NULL,
      parent_turn_id TEXT NOT NULL, root_session_id TEXT NOT NULL,
      valid_from INTEGER NOT NULL, valid_to INTEGER, tokens REAL NOT NULL,
      unknown INTEGER NOT NULL, finished_at REAL,
      PRIMARY KEY(tenant_id,parent_session_id,run_id,valid_from)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_child_usage_current ON subagent_usage_contributions(tenant_id,parent_session_id,run_id) WHERE valid_to IS NULL;
    CREATE INDEX IF NOT EXISTS idx_child_usage_fence ON subagent_usage_contributions(tenant_id,parent_session_id,valid_from,valid_to,parent_turn_id);
    CREATE TABLE IF NOT EXISTS parent_publication_state (
      tenant_id TEXT NOT NULL, parent_session_id TEXT NOT NULL, stream_id TEXT NOT NULL,
      generation TEXT NOT NULL, root_session_id TEXT NOT NULL, parent_turn_id TEXT NOT NULL,
      root_run_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0, floor_revision INTEGER NOT NULL DEFAULT 0,
      event_sequence INTEGER NOT NULL DEFAULT 0, floor_event_sequence INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(tenant_id,parent_session_id,stream_id)
    );
    CREATE TABLE IF NOT EXISTS parent_published_child_versions (
      tenant_id TEXT NOT NULL, parent_session_id TEXT NOT NULL, stream_id TEXT NOT NULL,
      run_id TEXT NOT NULL, first_ordinal INTEGER NOT NULL, valid_from INTEGER NOT NULL, valid_to INTEGER,
      at_seq INTEGER NOT NULL, identity TEXT NOT NULL, tokens REAL NOT NULL,
      unknown INTEGER NOT NULL, finished_at REAL,
      PRIMARY KEY(tenant_id,parent_session_id,stream_id,run_id,valid_from)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_published_child_current ON parent_published_child_versions(tenant_id,parent_session_id,stream_id,run_id) WHERE valid_to IS NULL;
    CREATE INDEX IF NOT EXISTS idx_published_child_page ON parent_published_child_versions(tenant_id,parent_session_id,stream_id,first_ordinal,run_id,valid_from,valid_to);
    CREATE TABLE IF NOT EXISTS parent_publication_marks (
      tenant_id TEXT NOT NULL, parent_session_id TEXT NOT NULL, stream_id TEXT NOT NULL,
      event_sequence INTEGER NOT NULL, revision INTEGER NOT NULL,
      run_id TEXT NOT NULL, at_seq INTEGER NOT NULL,
      PRIMARY KEY(tenant_id,parent_session_id,stream_id,event_sequence)
    );

    CREATE TABLE IF NOT EXISTS parent_turn_bootstraps (
      checkpoint_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, parent_session_id TEXT NOT NULL,
      stream_id TEXT NOT NULL, generation TEXT NOT NULL, event_sequence INTEGER NOT NULL,
      revision INTEGER NOT NULL, usage_revision INTEGER NOT NULL, fence_json TEXT NOT NULL,
      snapshot_json TEXT NOT NULL, archive_digest TEXT NOT NULL, digest TEXT NOT NULL,
      original_count INTEGER NOT NULL, refs_count INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS parent_turn_bootstrap_pin ON parent_turn_bootstraps(tenant_id,parent_session_id,stream_id,generation,revision,event_sequence,usage_revision);
    CREATE TABLE IF NOT EXISTS parent_turn_bootstrap_refs (
      checkpoint_id TEXT NOT NULL, projection_index INTEGER NOT NULL, run_id TEXT NOT NULL,
      at_seq INTEGER NOT NULL, entry_json TEXT NOT NULL, entry_digest TEXT NOT NULL,
      PRIMARY KEY(checkpoint_id,projection_index),
      FOREIGN KEY(checkpoint_id) REFERENCES parent_turn_bootstraps(checkpoint_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS parent_turn_bootstrap_heads (
      tenant_id TEXT NOT NULL,parent_session_id TEXT NOT NULL,stream_id TEXT NOT NULL,generation TEXT NOT NULL,
      checkpoint_id TEXT NOT NULL,
      PRIMARY KEY(tenant_id,parent_session_id,stream_id,generation),
      FOREIGN KEY(checkpoint_id) REFERENCES parent_turn_bootstraps(checkpoint_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS parent_turn_bootstrap_run_heads (
      tenant_id TEXT NOT NULL,parent_session_id TEXT NOT NULL,root_run_id TEXT NOT NULL,attempt_id TEXT NOT NULL,
      stream_id TEXT NOT NULL,generation TEXT NOT NULL,checkpoint_id TEXT NOT NULL,
      PRIMARY KEY(tenant_id,parent_session_id,root_run_id,attempt_id),
      FOREIGN KEY(checkpoint_id) REFERENCES parent_turn_bootstraps(checkpoint_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS parent_turn_bootstrap_closures (
      checkpoint_id TEXT PRIMARY KEY,closed_at INTEGER NOT NULL,error_summary TEXT,
      FOREIGN KEY(checkpoint_id) REFERENCES parent_turn_bootstraps(checkpoint_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS parent_turn_bootstrap_body_chunks (
      checkpoint_id TEXT NOT NULL,part_index INTEGER NOT NULL,chunk TEXT NOT NULL,digest TEXT NOT NULL,
      PRIMARY KEY(checkpoint_id,part_index),
      FOREIGN KEY(checkpoint_id) REFERENCES parent_turn_bootstraps(checkpoint_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS parent_turn_bootstrap_handoffs (
      checkpoint_id TEXT PRIMARY KEY,target_stream_id TEXT NOT NULL,target_attempt_id TEXT NOT NULL,
      scope_json TEXT NOT NULL,version_count INTEGER NOT NULL,source_archive_digest TEXT NOT NULL,
      version_digest TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS parent_turn_bootstrap_one_attempt ON parent_turn_bootstrap_handoffs(
      json_extract(scope_json,'$.tenantId'),json_extract(scope_json,'$.parentSessionId'),json_extract(scope_json,'$.rootRunId'),target_attempt_id
    );
  `)
  // A prototype checkpoint-cascaded handoff table must never be mistaken for
  // the durable activation ledger. Its data needs a deliberate future migration.
  const foreignKeys = (await db.execute('PRAGMA foreign_key_list(parent_turn_bootstrap_handoffs)')).rows
  const columns = (await db.execute('PRAGMA table_info(parent_turn_bootstrap_handoffs)')).rows
  if (foreignKeys.length || !columns.some(row => row.name === 'version_digest' && Number(row.notnull) === 1))
    requireChildRecovery('bootstrap_schema_upgrade_required')
}
