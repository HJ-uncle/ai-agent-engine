import type { Client } from '@libsql/client'

/**
 * 012: 消息模型持久化
 * 
 * 为 conversations 表添加 model_id 字段，以便持久化每一轮对话所使用的具体模型。
 */
export async function up(db: Client): Promise<void> {
  // SQLite 增加列，如果列不存在则添加
  try {
    await db.execute(`ALTER TABLE conversations ADD COLUMN model_id TEXT`)
  } catch (err: any) {
    // 忽略“列已存在”的错误，确保迁移幂等
    if (!err.message.includes('duplicate column name')) {
      throw err
    }
  }
}
