import type { Client } from '@libsql/client'

export async function up(db: Client): Promise<void> {
  await db.batch([
    `CREATE TABLE IF NOT EXISTS account_profiles (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      recovery_hash TEXT UNIQUE, avatar_url TEXT, bio TEXT,
      user_data TEXT NOT NULL DEFAULT '{}', roles TEXT NOT NULL DEFAULT '["tenant-admin"]',
      updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS account_sessions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      access_hash TEXT NOT NULL UNIQUE, access_expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL, authenticated_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, revoked_at INTEGER
    )`,
    `CREATE INDEX IF NOT EXISTS idx_account_sessions_user ON account_sessions(user_id, revoked_at)`,
    `CREATE TABLE IF NOT EXISTS account_refresh_tokens (
      token_hash TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES account_sessions(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL, consumed_at INTEGER, request_hash TEXT, retry_result TEXT, retry_expires_at INTEGER
    )`,
    `CREATE INDEX IF NOT EXISTS idx_account_refresh_session ON account_refresh_tokens(session_id)`,
    `CREATE TABLE IF NOT EXISTS account_identities (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider_id TEXT NOT NULL, issuer TEXT NOT NULL, subject TEXT NOT NULL,
      user_data TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(provider_id, issuer, subject)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_account_identities_user ON account_identities(user_id)`,
    `CREATE TABLE IF NOT EXISTS account_auth_attempts (
      bucket TEXT PRIMARY KEY, window_start INTEGER NOT NULL, attempts INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS account_audit (
      id TEXT PRIMARY KEY, user_id TEXT, event TEXT NOT NULL, created_at INTEGER NOT NULL
    )`,
  ].map(sql => ({ sql })), 'write')
  const columns = await db.execute('PRAGMA table_info(account_refresh_tokens)')
  const names = new Set(columns.rows.map(row => String(row.name)))
  for (const [name, type] of [['request_hash', 'TEXT'], ['retry_result', 'TEXT'], ['retry_expires_at', 'INTEGER']]) {
    if (!names.has(name)) await db.execute('ALTER TABLE account_refresh_tokens ADD COLUMN ' + name + ' ' + type)
  }
}
