import { getMemoryDb, initMemoryDb, closeMemoryDb } from './db.js'
import { MEMORY_SCHEMA } from './schema.js'

async function migrate() {
  console.log('Running memory database migrations...')

  try {
    await initMemoryDb(MEMORY_SCHEMA)
  } catch (err) {
    console.error('Memory migration failed:', err)
    process.exit(1)
  }

  const db = getMemoryDb()

  try {
    await db.execute(
      `INSERT OR IGNORE INTO memory_graph_meta (key, value, updated_at)
       VALUES ('version', '1.0', unixepoch())`,
    )
    await db.execute(
      `INSERT OR IGNORE INTO memory_graph_meta (key, value, updated_at)
       VALUES ('description', 'Aether Engine 独立记忆图谱数据库', unixepoch())`,
    )
    console.log('  ✓ Default graph meta seeded')
  } catch (err) {
    console.warn('  ⚠ Seed graph meta warning:', (err as Error)?.message)
  }

  // 验证表结构
  const tables = await db.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'memory_%' ORDER BY name",
  )
  console.log('  ✓ Memory tables:', tables.rows.map((r) => r['name']).join(', '))

  console.log('Memory database migration complete!')
}

migrate().catch((err) => {
  console.error('Memory migration failed:', err)
  process.exit(1)
}).finally(() => {
  closeMemoryDb()
})
