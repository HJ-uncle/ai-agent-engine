import type { Client } from '@libsql/client'

/**
 * 018: skill_imports 增加 scope 列
 *
 * scope: 'project'（默认，落盘 <cwd>/.aether/skills）
 *        'global' （落盘 ~/.aether/skills，单机多项目共享 / 集群挂共享卷）
 */
export async function up(db: Client): Promise<void> {
  // initDb 每次启动都会执行迁移，必须幂等：先探测列是否已存在
  const cols = await db.execute("PRAGMA table_info('skill_imports')")
  const hasScope = cols.rows.some((r) => (r as Record<string, unknown>)['name'] === 'scope')
  if (!hasScope) {
    await db.execute(`ALTER TABLE skill_imports ADD COLUMN scope TEXT NOT NULL DEFAULT 'project'`)
  }
}

export async function down(db: Client): Promise<void> {
  // SQLite 不支持 DROP COLUMN（旧版本），重建表成本高，降级时保留列即可
  void db
}
