import type { Client } from '@libsql/client'

export async function up(db: Client): Promise<void> {
  await db.batch([
    `CREATE TABLE IF NOT EXISTS account_children (
      child_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
      parent_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      created_at INTEGER NOT NULL, disabled_at INTEGER, CHECK(child_id<>parent_id)
    )`,
    'CREATE INDEX IF NOT EXISTS idx_account_children_parent ON account_children(parent_id, created_at, child_id)',
    `CREATE TABLE IF NOT EXISTS account_child_quotas (
      parent_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
      child_limit INTEGER NOT NULL CHECK(typeof(child_limit)='integer' AND child_limit BETWEEN 0 AND 100)
    )`,
    `CREATE TABLE IF NOT EXISTS account_child_sessions (
      session_id TEXT PRIMARY KEY REFERENCES account_sessions(id) ON DELETE CASCADE,
      parent_session_id TEXT NOT NULL REFERENCES account_sessions(id) ON DELETE CASCADE,
      CHECK(session_id<>parent_session_id)
    )`,
    'CREATE INDEX IF NOT EXISTS idx_account_child_sessions_parent ON account_child_sessions(parent_session_id)',
    `CREATE TRIGGER IF NOT EXISTS guard_account_child_insert BEFORE INSERT ON account_children
      WHEN EXISTS (SELECT 1 FROM account_children WHERE child_id=NEW.parent_id OR parent_id=NEW.child_id)
      OR EXISTS (SELECT 1 FROM account_child_quotas WHERE parent_id=NEW.child_id)
      BEGIN SELECT RAISE(ABORT,'invalid account family'); END`,
    `CREATE TRIGGER IF NOT EXISTS guard_account_child_reparent BEFORE UPDATE OF parent_id,child_id ON account_children
      BEGIN SELECT RAISE(ABORT,'immutable account family'); END`,
    `CREATE TRIGGER IF NOT EXISTS guard_account_child_capacity BEFORE INSERT ON account_children
      WHEN (SELECT count(*) FROM account_children WHERE parent_id=NEW.parent_id) >=
        COALESCE((SELECT child_limit FROM account_child_quotas WHERE parent_id=NEW.parent_id),3)
      BEGIN SELECT RAISE(ABORT,'account child limit reached'); END`,
    `CREATE TRIGGER IF NOT EXISTS guard_delegated_account_session BEFORE INSERT ON account_child_sessions
      WHEN NOT EXISTS(SELECT 1 FROM account_sessions c JOIN account_children f ON f.child_id=c.user_id
        JOIN account_sessions p ON p.user_id=f.parent_id WHERE c.id=NEW.session_id AND p.id=NEW.parent_session_id
        AND f.disabled_at IS NULL AND p.revoked_at IS NULL AND c.revoked_at IS NULL AND c.expires_at<=p.expires_at)
      BEGIN SELECT RAISE(ABORT,'invalid delegated account session'); END`,
    `CREATE TRIGGER IF NOT EXISTS revoke_disabled_account_sessions AFTER UPDATE OF disabled_at ON account_children
      WHEN NEW.disabled_at IS NOT NULL AND OLD.disabled_at IS NULL BEGIN
      UPDATE account_sessions SET revoked_at=NEW.disabled_at WHERE user_id=NEW.child_id AND revoked_at IS NULL; END`,
    `CREATE TRIGGER IF NOT EXISTS revoke_removed_parent_sessions BEFORE DELETE ON account_sessions BEGIN
      UPDATE account_sessions SET revoked_at=unixepoch()*1000 WHERE revoked_at IS NULL AND id IN
        (SELECT session_id FROM account_child_sessions WHERE parent_session_id=OLD.id); END`,
    `CREATE TRIGGER IF NOT EXISTS revoke_delegated_sessions AFTER UPDATE OF revoked_at ON account_sessions
      WHEN NEW.revoked_at IS NOT NULL AND OLD.revoked_at IS NULL BEGIN
      UPDATE account_sessions SET revoked_at=NEW.revoked_at WHERE revoked_at IS NULL AND id IN
        (SELECT session_id FROM account_child_sessions WHERE parent_session_id=NEW.id); END`,
  ], 'write')
}
