/** Real SQLite process coverage: legacy CHECK recovery, data preservation and atomic failure rollback. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDb, getDb, initDb } from './db.js'
import { repairLegacyCronTimeoutSchema } from './schema-compatibility.js'
import type { LocalSqliteProcessClient } from './local-process-client.js'

let root: string
let db: LocalSqliteProcessClient
const owned: LocalSqliteProcessClient[] = []
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-cron-schema-'))
  vi.stubEnv('DATA_DIR', path.join(root, 'agent.db'))
  closeDb()
  db = getDb() as LocalSqliteProcessClient
  owned.push(db)
  await initDb()
  await db.execute('ALTER TABLE conversations ADD COLUMN deleted_at INTEGER')
})
afterEach(async () => {
  vi.restoreAllMocks()
  closeDb()
  for (const client of owned) client.close()
  await Promise.all(owned.splice(0).map(client => client.whenClosed()))
  vi.unstubAllEnvs()
  if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('aether-cron-schema-')) throw new Error('Unsafe schema fixture cleanup')
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

async function cronSchema() {
  return String((await db.execute("SELECT sql FROM sqlite_schema WHERE type='table' AND name='cron_jobs'")).rows[0].sql)
}
async function legacySchema() {
  const original = await cronSchema()
  const version = Number((await db.execute('PRAGMA schema_version')).rows[0].schema_version)
  await db.execute('PRAGMA writable_schema=ON')
  await db.execute({ sql: "UPDATE sqlite_schema SET sql=? WHERE type='table' AND name='cron_jobs'", args: [original.replace("'integer'", '"integer"')] })
  await db.execute(`PRAGMA schema_version=${version + 1}`)
  await db.execute('PRAGMA writable_schema=RESET')
  return await cronSchema()
}
async function insertCron() {
  await db.execute("INSERT INTO cron_jobs(id,name,cron_expr,message,session_id,created_at,updated_at,timeout_seconds) VALUES('job-1','原始任务','* * * * *','Unicode 测试','fixture',1,1,120),('job-null','无限制','* * * * *','text','fixture',1,1,NULL)")
}
async function schemaObjects() {
  return (await db.execute("SELECT type,name,rootpage,sql FROM sqlite_schema WHERE tbl_name='cron_jobs' AND type IN ('index','trigger') ORDER BY name")).rows
}

describe('legacy cron timeout schema compatibility', () => {
  it('repairs the legacy CHECK atomically without rebuilding rows, indexes, triggers or foreign keys', async () => {
    await insertCron()
    await db.execute("INSERT INTO conversations(session_id,role,content,deleted_at) VALUES('fixture','user','保留会话',NULL)")
    await db.execute('CREATE INDEX idx_cron_timeout_fixture ON cron_jobs(timeout_seconds)')
    await db.execute('CREATE TABLE cron_refs(job_id TEXT REFERENCES cron_jobs(id),value TEXT)')
    await db.execute("INSERT INTO cron_refs VALUES('job-1','reference')")
    await db.execute('CREATE TRIGGER cron_name_audit AFTER UPDATE OF name ON cron_jobs BEGIN INSERT INTO cron_refs VALUES(new.id,new.name); END')
    const rootpage = (await db.execute("SELECT rootpage FROM sqlite_schema WHERE name='cron_jobs'")).rows[0].rootpage
    const cronRows = (await db.execute('SELECT * FROM cron_jobs ORDER BY id')).rows
    const objects = await schemaObjects()
    const original = await legacySchema()
    const version = Number((await db.execute('PRAGMA schema_version')).rows[0].schema_version)
    await expect(db.execute('ALTER TABLE conversations DROP COLUMN deleted_at')).rejects.toThrow('no such column: integer')

    await repairLegacyCronTimeoutSchema(db)

    expect(await cronSchema()).toBe(original.replace('"integer"', "'integer'"))
    expect((await db.execute('SELECT * FROM cron_jobs ORDER BY id')).rows).toEqual(cronRows)
    expect((await db.execute("SELECT rootpage FROM sqlite_schema WHERE name='cron_jobs'")).rows[0].rootpage).toBe(rootpage)
    expect(await schemaObjects()).toEqual(objects)
    expect((await db.execute('SELECT * FROM cron_refs')).rows).toMatchObject([{ job_id: 'job-1', value: 'reference' }])
    expect((await db.execute('PRAGMA foreign_key_check')).rows).toHaveLength(0)
    expect((await db.execute('PRAGMA foreign_keys')).rows[0].foreign_keys).toBe(1)
    expect((await db.execute('PRAGMA writable_schema')).rows[0].writable_schema).toBe(0)
    const backup = (await db.execute('SELECT * FROM _aether_schema_repairs')).rows
    expect(backup).toHaveLength(1)
    expect(backup[0]).toMatchObject({ repair_name: 'cron-timeout-integer-literal-v1', table_name: 'cron_jobs', original_sql: original, original_schema_version: version })
    await db.execute('ALTER TABLE conversations DROP COLUMN deleted_at')
    expect((await db.execute('SELECT content FROM conversations')).rows[0].content).toBe('保留会话')
    for (const value of [0, 86401, 1.5, 'bad']) await expect(db.execute({ sql: "UPDATE cron_jobs SET timeout_seconds=? WHERE id='job-1'", args: [value] })).rejects.toThrow('CHECK constraint failed')
    await db.execute("UPDATE cron_jobs SET name='已更新' WHERE id='job-1'")
    expect((await db.execute("SELECT value FROM cron_refs WHERE value='已更新'")).rows).toHaveLength(1)
  })

  it('runs before startup ALTER migrations and remains a no-op through repeated reopen and init', async () => {
    await insertCron()
    await legacySchema()
    closeDb()
    db = getDb() as LocalSqliteProcessClient
    owned.push(db)
    await initDb()
    expect((await db.execute('PRAGMA table_info(conversations)')).rows.some(row => row.name === 'deleted_at')).toBe(false)
    expect((await db.execute('SELECT id,timeout_seconds FROM cron_jobs ORDER BY id')).rows).toMatchObject([{ id: 'job-1', timeout_seconds: 120 }, { id: 'job-null', timeout_seconds: null }])
    const version = (await db.execute('PRAGMA schema_version')).rows[0].schema_version
    for (let index = 0; index < 2; index++) {
      closeDb()
      db = getDb() as LocalSqliteProcessClient
      owned.push(db)
      await initDb()
      expect((await db.execute('PRAGMA schema_version')).rows[0].schema_version).toBe(version)
      expect((await db.execute('SELECT count(*) AS n FROM _aether_schema_repairs')).rows[0].n).toBe(1)
    }
  })

  it.each(['validation', 'commit'] as const)('rolls back schema and backup records after %s failure and disables schema writes', async failure => {
    await insertCron()
    const original = await legacySchema()
    const version = (await db.execute('PRAGMA schema_version')).rows[0].schema_version
    const originalTransaction = db.transaction.bind(db)
    const transactionSpy = vi.spyOn(db, 'transaction').mockImplementation(async mode => {
      const transaction = await originalTransaction(mode)
      if (failure === 'commit') vi.spyOn(transaction, 'commit').mockRejectedValueOnce(new Error('forced commit failure'))
      else {
        const execute = transaction.execute.bind(transaction)
        vi.spyOn(transaction, 'execute').mockImplementation(async statement => {
          const sql = typeof statement === 'string' ? statement : statement.sql
          if (sql === 'PRAGMA integrity_check(cron_jobs)') throw new Error('forced validation failure')
          return execute(statement)
        })
      }
      return transaction
    })
    await expect(repairLegacyCronTimeoutSchema(db)).rejects.toThrow(`forced ${failure} failure`)
    transactionSpy.mockRestore()
    expect(await cronSchema()).toBe(original)
    expect((await db.execute('PRAGMA schema_version')).rows[0].schema_version).toBe(version)
    expect((await db.execute('PRAGMA writable_schema')).rows[0].writable_schema).toBe(0)
    expect((await db.execute("SELECT name FROM sqlite_schema WHERE name='_aether_schema_repairs'")).rows).toHaveLength(0)
    expect((await db.execute('SELECT count(*) AS n FROM cron_jobs')).rows[0].n).toBe(2)
    // The cached tentative schema must also be gone after rollback.
    await expect(db.execute('ALTER TABLE conversations DROP COLUMN deleted_at')).rejects.toThrow('no such column: integer')
    await repairLegacyCronTimeoutSchema(db)
    await db.execute('ALTER TABLE conversations DROP COLUMN deleted_at')
  })

  it('leaves a real integer column reference unchanged', async () => {
    await db.execute('ALTER TABLE cron_jobs ADD COLUMN integer TEXT')
    const original = await legacySchema()
    const version = (await db.execute('PRAGMA schema_version')).rows[0].schema_version
    await repairLegacyCronTimeoutSchema(db)
    expect(await cronSchema()).toBe(original)
    expect((await db.execute('PRAGMA schema_version')).rows[0].schema_version).toBe(version)
    expect((await db.execute("SELECT name FROM sqlite_schema WHERE name='_aether_schema_repairs'")).rows).toHaveLength(0)
    await db.execute('ALTER TABLE conversations DROP COLUMN deleted_at')
  })

  it('does not match CHECK-looking text inside a SQL default string', async () => {
    await db.execute('DROP TABLE cron_jobs')
    await db.execute(`CREATE TABLE cron_jobs(id TEXT PRIMARY KEY, description TEXT DEFAULT 'timeout_seconds INTEGER CHECK (timeout_seconds IS NULL OR (typeof(timeout_seconds) = "integer" AND timeout_seconds BETWEEN 1 AND 86400))', timeout_seconds INTEGER)`)
    const original = await cronSchema()
    const version = (await db.execute('PRAGMA schema_version')).rows[0].schema_version
    await repairLegacyCronTimeoutSchema(db)
    expect(await cronSchema()).toBe(original)
    expect((await db.execute('PRAGMA schema_version')).rows[0].schema_version).toBe(version)
    expect((await db.execute("SELECT name FROM sqlite_schema WHERE name='_aether_schema_repairs'")).rows).toHaveLength(0)
  })

  it('does not change the meaning of a differently cased quoted value', async () => {
    const original = (await cronSchema()).replace("'integer'", '"INTEGER"')
    const version = Number((await db.execute('PRAGMA schema_version')).rows[0].schema_version)
    await db.execute('PRAGMA writable_schema=ON')
    await db.execute({ sql: "UPDATE sqlite_schema SET sql=? WHERE name='cron_jobs'", args: [original] })
    await db.execute(`PRAGMA schema_version=${version + 1}`)
    await db.execute('PRAGMA writable_schema=RESET')
    await repairLegacyCronTimeoutSchema(db)
    expect(await cronSchema()).toBe(original)
    expect((await db.execute('PRAGMA schema_version')).rows[0].schema_version).toBe(version + 1)
    expect((await db.execute("SELECT name FROM sqlite_schema WHERE name='_aether_schema_repairs'")).rows).toHaveLength(0)
  })
})
