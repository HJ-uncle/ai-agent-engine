import type { Client } from '@libsql/client'

/**
 * 014: 给 models 表增加 capabilities 列（JSON 字符串）
 *
 * 用于持久化存储每个模型的能力配置（vision / thinking / toolCalling 等），
 * 供 model-capabilities 注册表的"db override"层使用。
 */
export async function up(client: Client): Promise<void> {
  await client.execute('ALTER TABLE models ADD COLUMN capabilities TEXT').catch(() => {})
}
