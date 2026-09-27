import type { Client } from '@libsql/client'

/**
 * 015: 增加元数据支持
 * 
 * 为 sessions 和 conversations 表添加 metadata 字段，
 * 以便第三方业务系统在调用引擎时透传并持久化自定义业务字段。
 */
export async function up(db: Client): Promise<void> {
  // 1. 为 sessions 表添加 metadata 字段
  try {
    await db.execute(`ALTER TABLE sessions ADD COLUMN metadata TEXT`)
  } catch (err: any) {
    if (!err.message.includes('duplicate column name')) {
      throw err
    }
  }

  // 2. 为 conversations 表添加 metadata 字段
  try {
    await db.execute(`ALTER TABLE conversations ADD COLUMN metadata TEXT`)
  } catch (err: any) {
    if (!err.message.includes('duplicate column name')) {
      throw err
    }
  }
}

export async function down(db: Client): Promise<void> {
  // SQLite 不支持直接 DROP COLUMN，通常需要创建新表并迁移数据。
  // 在此开发阶段，我们可以暂时忽略 down 逻辑或仅记录。
}
