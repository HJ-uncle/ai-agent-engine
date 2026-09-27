import type { Client } from '@libsql/client'

export async function up(db: Client) {
  // 待办任务表
  await db.execute(`
    CREATE TABLE IF NOT EXISTS todos (
      id          TEXT PRIMARY KEY,
      tenant_id   TEXT NOT NULL DEFAULT 'default',
      session_id  TEXT,
      title       TEXT NOT NULL,
      description TEXT,
      status      TEXT NOT NULL DEFAULT 'pending',
      priority    TEXT NOT NULL DEFAULT 'medium',
      due_at      INTEGER,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    )
  `)
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_todos_tenant ON todos(tenant_id)`)
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_todos_session ON todos(session_id)`)

  // 定时任务表
  await db.execute(`
    CREATE TABLE IF NOT EXISTS cron_jobs (
      id           TEXT PRIMARY KEY,
      tenant_id    TEXT NOT NULL DEFAULT 'default',
      name         TEXT NOT NULL,
      description  TEXT,
      cron_expr    TEXT NOT NULL,
      message      TEXT NOT NULL,
      session_id   TEXT NOT NULL,
      agent_id     TEXT,
      enabled      INTEGER NOT NULL DEFAULT 1,
      last_run_at  INTEGER,
      next_run_at  INTEGER,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    )
  `)
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_cron_tenant ON cron_jobs(tenant_id)`)
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_cron_enabled ON cron_jobs(enabled)`)
}
