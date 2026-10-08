import type { Client } from '@libsql/client'

export async function up(db: Client): Promise<void> {
  // Rotating refresh credentials must not invalidate requests already using an unexpired access token.
  await db.batch([
    `CREATE TABLE IF NOT EXISTS account_access_tokens (
      token_hash TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES account_sessions(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_account_access_session_expiry ON account_access_tokens(session_id, expires_at)',
  ], 'write')
}
