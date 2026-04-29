import { getDb } from './db.js'
import { encrypt, decrypt } from '../../utils/encryption.js'

/** 需要加密存储的敏感配置 key（供 settings route 等外部模块共享，避免重复定义） */
export const SECRET_KEYS = new Set(['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'])

export class SystemConfigStore {
  /**
   * 读取单个配置项。
   * - 敏感字段自动解密
   * - key 不存在或解密失败均返回 null（不抛出异常）
   */
  async get(key: string): Promise<string | null> {
    try {
      const db = getDb()
      const result = await db.execute({
        sql: 'SELECT value, is_secret FROM system_config WHERE key = ?',
        args: [key],
      })
      if (result.rows.length === 0) return null

      const row = result.rows[0]
      const isSecret = Boolean(row['is_secret'])
      const raw = row['value'] as string

      if (isSecret) {
        try {
          return decrypt(raw)
        } catch {
          return null
        }
      }
      return raw
    } catch {
      return null
    }
  }

  /**
   * 写入/更新配置项（UPSERT）。
   * @param isSecret 为 true 时加密存储，并将 is_secret 置为 1
   */
  async set(key: string, value: string, isSecret: boolean): Promise<void> {
    const db = getDb()
    const stored = isSecret ? encrypt(value) : value
    await db.execute({
      sql: `INSERT INTO system_config (key, value, is_secret, updated_at)
            VALUES (?, ?, ?, unixepoch())
            ON CONFLICT(key) DO UPDATE SET
              value      = excluded.value,
              is_secret  = excluded.is_secret,
              updated_at = unixepoch()`,
      args: [key, stored, isSecret ? 1 : 0],
    })
  }

  /**
   * 读取所有配置项，返回 key → 解密后明文 的 map。
   * 解密失败的条目值为 null。
   */
  async getAll(): Promise<Record<string, string | null>> {
    try {
      const db = getDb()
      const result = await db.execute('SELECT key, value, is_secret FROM system_config')
      const out: Record<string, string | null> = {}
      for (const row of result.rows) {
        const key = row['key'] as string
        const isSecret = Boolean(row['is_secret'])
        const raw = row['value'] as string
        if (isSecret) {
          try {
            out[key] = decrypt(raw)
          } catch {
            out[key] = null
          }
        } else {
          out[key] = raw
        }
      }
      return out
    } catch {
      return {}
    }
  }
}

/** 全局单例 */
export const systemConfigStore = new SystemConfigStore()
