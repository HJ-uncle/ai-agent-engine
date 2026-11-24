import type { Client } from '@libsql/client'

/** Existing and recovery-only accounts keep their login methods until an owner configures a child login. */
export async function up(db: Client): Promise<void> {
  await db.batch([
    'CREATE TABLE IF NOT EXISTS account_child_passwords (' +
    'user_id TEXT PRIMARY KEY REFERENCES account_children(child_id) ON DELETE CASCADE, ' +
    'login_name TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL)',
    'CREATE TABLE IF NOT EXISTS account_child_reset_codes (' +
    'user_id TEXT PRIMARY KEY REFERENCES account_child_passwords(user_id) ON DELETE CASCADE, code_hash TEXT NOT NULL UNIQUE)',
  ], 'write')
}
