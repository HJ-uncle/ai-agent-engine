import { getDb } from './db.js'

export interface TenantConfig {
  tenantId: string
  key: string
  value: string
  updatedAt: number
}

export class TenantConfigStore {
  /** 获取租户特定的配置值 */
  async get(tenantId: string, key: string): Promise<string | null> {
    const db = getDb()
    const result = await db.execute({
      sql: 'SELECT value FROM tenant_configs WHERE tenant_id = ? AND key = ? LIMIT 1',
      args: [tenantId, key],
    })
    if (result.rows.length === 0) return null
    return result.rows[0]['value'] as string
  }

  /** 获取租户的所有配置 */
  async list(tenantId: string): Promise<Record<string, string>> {
    const db = getDb()
    const result = await db.execute({
      sql: 'SELECT key, value FROM tenant_configs WHERE tenant_id = ?',
      args: [tenantId],
    })
    const configs: Record<string, string> = {}
    for (const row of result.rows) {
      configs[String(row['key'])] = String(row['value'])
    }
    return configs
  }

  /** 设置或更新租户配置 */
  async set(tenantId: string, key: string, value: string): Promise<void> {
    const db = getDb()
    await db.execute({
      sql: `INSERT INTO tenant_configs (tenant_id, key, value, updated_at)
            VALUES (?, ?, ?, unixepoch())
            ON CONFLICT(tenant_id, key) DO UPDATE SET
              value = excluded.value,
              updated_at = excluded.updated_at`,
      args: [tenantId, key, value],
    })
  }

  /** 删除租户配置 */
  async delete(tenantId: string, key: string): Promise<void> {
    const db = getDb()
    await db.execute({
      sql: 'DELETE FROM tenant_configs WHERE tenant_id = ? AND key = ?',
      args: [tenantId, key],
    })
  }
}

export const tenantConfigStore = new TenantConfigStore()
