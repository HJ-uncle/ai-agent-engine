import type { Client } from '@libsql/client'

export async function up(db: Client): Promise<void> {
  await db.batch([
    `CREATE TABLE IF NOT EXISTS account_external_flows (
      id TEXT PRIMARY KEY, state_hash TEXT NOT NULL UNIQUE, poll_hash TEXT NOT NULL,
      provider_id TEXT NOT NULL, payload TEXT NOT NULL, identity TEXT,
      status TEXT NOT NULL DEFAULT 'pending', expires_at INTEGER NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS account_external_flows_expiry ON account_external_flows(expires_at)',
    `CREATE TABLE IF NOT EXISTS account_external_limits (
      scope TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS account_external_limits_expiry ON account_external_limits(reset_at)',
  ], 'write')
}
