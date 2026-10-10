import { getDb } from './db.js'
import { encrypt, decrypt } from '../../utils/encryption.js'

/** 需要加密存储的敏感配置 key（供 settings route 等外部模块共享，避免重复定义） */
export const SECRET_KEYS = new Set(['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY', 'EMBEDDING_API_KEY'])

/**
 * 启动期路径类配置 key：决定 skills/MCP/workspace 的根目录解析。
 * 只在进程启动时生效（registry/config 解析依赖启动顺序），禁止运行时热写入
 * process.env —— 否则会与已初始化的 SkillsRegistry/MCP 双层状态分裂
 * （例如把全局 skill 导入静默劫持到错误目录）。
 */
export const BOOT_PATH_KEYS = new Set(['SKILLS_ROOT', 'MCP_CONFIG_PATH', 'WORKSPACE_ROOT', 'BASH_PATH', 'DATA_DIR'])

/** Trust-boundary settings are process-start configuration, never business DB state. */
export const TRUSTED_STARTUP_KEYS = new Set(['AUTH_ENABLED', 'AETHER_INSTANCE_TOKEN', 'JWT_SECRET', 'AETHER_ACCOUNT_REGISTRATION', 'AETHER_ACCOUNT_PROVIDERS_JSON', 'AETHER_ACCOUNT_PUBLIC_URL', 'ENCRYPTION_KEY'])

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
   * 删除配置项（key 不存在时静默成功）。
   * 用于「恢复自动探测」：路径类配置清空即回到 .aether/ 约定目录。
   */
  async delete(key: string): Promise<void> {
    const db = getDb()
    await db.execute({
      sql: 'DELETE FROM system_config WHERE key = ?',
      args: [key],
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
