import type { Client } from '@libsql/client'

/**
 * 017: Skill 压缩包导入记录表
 *
 * 记录每次 skill zip 导入的审计信息与处理状态（文件系统仍是 skills 的真源，
 * 本表仅作导入历史/版本追溯/断点续传位图存储）。
 */
export async function up(db: Client): Promise<void> {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS skill_imports (
      id                TEXT PRIMARY KEY,
      tenant_id         TEXT NOT NULL,
      user_id           TEXT,
      filename          TEXT NOT NULL,
      file_size         INTEGER NOT NULL DEFAULT 0,
      file_sha256       TEXT,
      status            TEXT NOT NULL DEFAULT 'pending',
      progress          INTEGER NOT NULL DEFAULT 0,
      stage             TEXT,
      skill_names       TEXT,
      conflict_strategy TEXT NOT NULL DEFAULT 'versioned',
      imported_count    INTEGER NOT NULL DEFAULT 0,
      skipped_count     INTEGER NOT NULL DEFAULT 0,
      error_code        TEXT,
      error_message     TEXT,
      uploaded_chunks   TEXT,
      created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at        INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `)
  await db.execute(
    `CREATE INDEX IF NOT EXISTS idx_skill_imports_tenant ON skill_imports(tenant_id, created_at)`,
  )
}

export async function down(db: Client): Promise<void> {
  await db.execute(`DROP TABLE IF EXISTS skill_imports`)
}
