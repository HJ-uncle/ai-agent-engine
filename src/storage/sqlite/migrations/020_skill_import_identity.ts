import type { Client } from '@libsql/client'

/** 020: make resumable skill uploads workspace/scope/content specific. */
export async function up(db: Client): Promise<void> {
  const columns = await db.execute("PRAGMA table_info('skill_imports')")
  const names = new Set(columns.rows.map((row) => String((row as Record<string, unknown>).name)))
  if (!names.has('project_root')) await db.execute("ALTER TABLE skill_imports ADD COLUMN project_root TEXT NOT NULL DEFAULT ''")
  // file_sha256 already existed in 017 and is used as the content identity.
  await db.execute('CREATE INDEX IF NOT EXISTS idx_skill_imports_resume ON skill_imports(tenant_id, filename, file_size, file_sha256, scope, project_root, created_at)')
}

export async function down(db: Client): Promise<void> {
  void db
}
