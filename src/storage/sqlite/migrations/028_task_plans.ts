import type { Client } from '@libsql/client'

export async function up(db: Client): Promise<void> {
  await db.execute(`CREATE TABLE IF NOT EXISTS task_plans (
    tenant_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    explanation TEXT,
    revision INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, session_id)
  )`)
  // Order belongs to the persisted plan, so a reconnect never reverses its steps.
  await db.execute(`CREATE TABLE IF NOT EXISTS task_plan_items (
    tenant_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    todo_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, session_id, todo_id),
    UNIQUE (tenant_id, session_id, position),
    FOREIGN KEY (todo_id) REFERENCES todos(id) ON DELETE CASCADE
  )`)
}
