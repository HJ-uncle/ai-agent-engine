import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDb, getDb, initDb } from '../sqlite/db.js'
import type { LocalSqliteProcessClient } from '../sqlite/local-process-client.js'
import { up as initialSchema } from '../sqlite/migrations/001_initial.js'
import { up as addMessageIds, down as removeMessageIds } from '../sqlite/migrations/002_add_message_id.js'
import { up as removeDeletedAt } from '../sqlite/migrations/003_drop_deleted_at.js'

let fixture: string
let databasePath: string
const clients: LocalSqliteProcessClient[] = []

beforeEach(() => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-startup-migrations-'))
  databasePath = path.join(fixture, 'agent.db')
  vi.stubEnv('DATA_DIR', databasePath)
  closeDb()
})

afterEach(async () => {
  closeDb()
  for (const db of clients) db.close()
  await Promise.all(clients.splice(0).map(db => db.whenClosed()))
  vi.unstubAllEnvs()
  const target = path.resolve(fixture)
  if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('aether-startup-migrations-')) {
    throw new Error('Unsafe startup migration fixture cleanup')
  }
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

function connect(): LocalSqliteProcessClient {
  const db = getDb() as LocalSqliteProcessClient
  clients.push(db)
  return db
}

async function schemaVersion(db: LocalSqliteProcessClient): Promise<number> {
  const result = await db.execute('PRAGMA schema_version')
  return Number(result.rows[0].schema_version)
}

async function checkpointAndClose(db: LocalSqliteProcessClient): Promise<void> {
  const checkpoint = await db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
  expect(Number(checkpoint.rows[0].busy)).toBe(0)
  closeDb()
  await db.whenClosed()
}

function walBytes(): number {
  try { return fs.statSync(databasePath + '-wal').size }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return 0
  }
}

describe('startup conversation schema migrations', () => {
  it.each([false, true])('rolls back migration 002 while preserving content with a legacy deleted_at column: %s', async legacy => {
    const db = connect()
    await initialSchema(db)
    if (legacy) await db.execute('ALTER TABLE conversations ADD COLUMN deleted_at INTEGER')
    const content = 'rollback preserves the original conversation'
    await db.execute({
      sql: 'INSERT INTO conversations(session_id,role,content) VALUES(?,?,?)',
      args: ['rollback-session', 'user', content],
    })
    await addMessageIds(db)
    await removeMessageIds(db)
    const columns = (await db.execute('PRAGMA table_info(conversations)')).rows.map(row => row.name)
    expect(columns).not.toContain('message_id')
    expect(columns).not.toContain('deleted_at')
    expect((await db.execute('SELECT content FROM conversations')).rows[0].content).toBe(content)
    const version = await schemaVersion(db)
    await removeMessageIds(db)
    expect(await schemaVersion(db)).toBe(version)
  })

  it('does not reintroduce the retired deleted_at column on a fresh schema', async () => {
    const db = connect()
    await initialSchema(db)
    await addMessageIds(db)
    const before = await schemaVersion(db)
    await removeDeletedAt(db)
    expect(await schemaVersion(db)).toBe(before)
    const columns = (await db.execute('PRAGMA table_info(conversations)')).rows.map(row => row.name)
    expect(columns).toContain('message_id')
    expect(columns).not.toContain('deleted_at')
  })

  it('migrates a real legacy deleted_at column once and preserves its conversation content after reopening', async () => {
    const db = connect()
    await initialSchema(db)
    await db.execute('ALTER TABLE conversations ADD COLUMN deleted_at INTEGER')
    const content = 'legacy conversation \u4fdd\u7559\u539f\u6587'
    await db.execute({
      sql: 'INSERT INTO conversations(session_id,role,content,deleted_at) VALUES(?,?,?,?)',
      args: ['legacy-session', 'user', content, 123],
    })
    await initDb()
    expect((await db.execute('PRAGMA table_info(conversations)')).rows.map(row => row.name)).not.toContain('deleted_at')
    const first = (await db.execute('SELECT id,message_id,content FROM conversations')).rows[0]
    expect(first.content).toBe(content)
    expect(first.message_id).toMatch(/^legacy-sqlite-[a-f0-9]+$/)
    const version = await schemaVersion(db)
    await checkpointAndClose(db)

    const reopened = connect()
    await initDb()
    expect(await schemaVersion(reopened)).toBe(version)
    expect((await reopened.execute('SELECT id,message_id,content FROM conversations')).rows[0]).toMatchObject(first)
    expect(walBytes()).toBeLessThan(64 * 1024)
  })

  it('reopens an 8 MiB modern conversation table without changing schema or rewriting its payload into WAL', async () => {
    const db = connect()
    await initDb()
    await db.execute('PRAGMA wal_autocheckpoint=0')
    const bodies = Array.from({ length: 8 }, (_, index) => `message-${index}|${'x'.repeat(1024 * 1024)}|tail-${index}`)
    await db.batch(bodies.map((content, index) => ({
      sql: 'INSERT INTO conversations(session_id,message_id,role,content) VALUES(?,?,?,?)',
      args: ['modern-session', `stable-${index}`, 'user', content],
    })), 'write')
    const version = await schemaVersion(db)
    await checkpointAndClose(db)
    expect(fs.statSync(databasePath).size).toBeGreaterThan(8 * 1024 * 1024)

    const reopened = connect()
    await reopened.execute('PRAGMA wal_autocheckpoint=0')
    await initDb()
    expect(await schemaVersion(reopened)).toBe(version)
    expect((await reopened.execute('SELECT count(*) AS count FROM conversations')).rows[0].count).toBe(8)
    for (const [index, content] of bodies.entries()) {
      const row = (await reopened.execute({
        sql: 'SELECT content=? AS preserved FROM conversations WHERE message_id=?',
        args: [content, `stable-${index}`],
      })).rows[0]
      expect(row.preserved).toBe(1)
    }
    expect(walBytes()).toBeLessThan(64 * 1024)
  }, 30_000)

  it('reports a real legacy DROP COLUMN failure instead of swallowing a schema dependency error', async () => {
    const db = connect()
    await initialSchema(db)
    await db.execute('ALTER TABLE conversations ADD COLUMN deleted_at INTEGER')
    await db.execute('CREATE INDEX legacy_deleted_dependency ON conversations(deleted_at)')
    await expect(removeDeletedAt(db)).rejects.toThrow(/deleted_at|legacy_deleted_dependency/)
    expect((await db.execute('PRAGMA table_info(conversations)')).rows.map(row => row.name)).toContain('deleted_at')
  })
})
