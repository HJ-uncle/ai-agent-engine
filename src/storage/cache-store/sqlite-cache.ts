import { getDb } from '../sqlite/db.js'
import type { CacheStore } from './types.js'

export class SQLiteCacheStore implements CacheStore {
  async get(key: string): Promise<string | null> {
    const db = getDb()
    const now = Math.floor(Date.now() / 1000)

    // Lazy cleanup: delete expired entry for this key
    await db.execute({
      sql: 'DELETE FROM cache WHERE key = ? AND expires_at < ?',
      args: [key, now],
    })

    const result = await db.execute({
      sql: 'SELECT value FROM cache WHERE key = ? AND expires_at >= ?',
      args: [key, now],
    })

    const row = result.rows[0]
    return row ? (row['value'] as string) : null
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    const db = getDb()
    const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds

    await db.execute({
      sql: `INSERT INTO cache (key, value, expires_at)
            VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`,
      args: [key, value, expiresAt],
    })
  }

  async delete(key: string): Promise<void> {
    const db = getDb()
    await db.execute({
      sql: 'DELETE FROM cache WHERE key = ?',
      args: [key],
    })
  }
}
