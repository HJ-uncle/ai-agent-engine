import type { Client } from '@libsql/client'

/**
 * 016: 增加租户级配置支持
 * 
 * 创建 tenant_configs 表，允许每个租户定义自己的专属配置，
 * 如“专属默认身份”（default_system_prompt）。
 */
export async function up(db: Client): Promise<void> {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS tenant_configs (
      tenant_id  TEXT NOT NULL,
      key        TEXT NOT NULL,
      value      TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (tenant_id, key)
    )
  `)
}

export async function down(db: Client): Promise<void> {
  await db.execute(`DROP TABLE IF EXISTS tenant_configs`)
}
