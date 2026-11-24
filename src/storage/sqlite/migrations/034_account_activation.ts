import type { Client } from '@libsql/client'

/** A primary account and its consumed activation are committed together in the business database. */
export async function up(db: Client): Promise<void> {
  await db.batch([
    `CREATE TABLE IF NOT EXISTS account_activation_codes (
      id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, issued_by TEXT NOT NULL,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL CHECK(expires_at>created_at),
      used_at INTEGER, used_by TEXT UNIQUE REFERENCES users(id), revoked_at INTEGER,
      CHECK ((used_at IS NULL) = (used_by IS NULL)), CHECK (revoked_at IS NULL OR used_at IS NULL)
    )`,
    'CREATE INDEX IF NOT EXISTS account_activation_page ON account_activation_codes(created_at DESC, id DESC)',
    // The same user cannot be both a child and an activated parent, regardless of write order.
    `CREATE TRIGGER IF NOT EXISTS activation_required_for_family BEFORE INSERT ON account_children
     WHEN NOT EXISTS (SELECT 1 FROM account_activation_codes WHERE used_by=NEW.parent_id)
       OR EXISTS (SELECT 1 FROM account_activation_codes WHERE used_by=NEW.child_id)
     BEGIN SELECT RAISE(ABORT,'invalid family activation'); END`,
    ...['INSERT', 'UPDATE OF used_by'].map((event, i) =>
      `CREATE TRIGGER IF NOT EXISTS prevent_child_activation_${i} BEFORE ${event} ON account_activation_codes
       WHEN NEW.used_by IS NOT NULL AND EXISTS (SELECT 1 FROM account_children WHERE child_id=NEW.used_by)
       BEGIN SELECT RAISE(ABORT,'child account cannot be activated'); END`),
  ], 'write')
}
