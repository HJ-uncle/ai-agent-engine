import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDb, getDb, initDb } from './db.js'
import type { LocalSqliteProcessClient } from './local-process-client.js'

let root: string
const owned: LocalSqliteProcessClient[] = []
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-db-lifecycle-'))
  vi.stubEnv('DATA_DIR', path.join(root, 'agent.db'))
  closeDb()
})
afterEach(async () => {
  closeDb()
  for (const db of owned) db.close()
  await Promise.all(owned.splice(0).map(db => db.whenClosed()))
  vi.unstubAllEnvs()
  fs.rmSync(root, { recursive: true, force: true })
})
const track = () => { const db = getDb() as LocalSqliteProcessClient; owned.push(db); return db }

describe('main SQLite process lifecycle', () => {
  it('shares concurrent initialization and reinitializes a reopened database', async () => {
    const first = track()
    const a = initDb(), b = initDb()
    expect(a).toBe(b)
    await Promise.all([a, b])
    expect((await first.execute("SELECT name FROM sqlite_schema WHERE name='models'")).rows).toHaveLength(1)
    closeDb()
    const second = track()
    expect(second).not.toBe(first)
    await initDb()
    expect((await second.execute('SELECT count(*) AS n FROM models')).rows[0].n).toBe(0)
  })

  it('retries initialization after a real schema error has been repaired', async () => {
    const db = track()
    await db.execute('CREATE TABLE conversations(id INTEGER)')
    const failed = initDb()
    await expect(failed).rejects.toThrow()
    await db.execute('DROP TABLE conversations')
    const retried = initDb()
    expect(retried).not.toBe(failed)
    await retried
    expect((await db.execute('PRAGMA table_info(conversations)')).rows.some(row => row.name === 'tenant_id')).toBe(true)
  })

  it('does not let an old rejected initialization clear a replacement generation', async () => {
    track()
    const old = initDb()
    const rejected = expect(old).rejects.toMatchObject({ code: 'CLIENT_CLOSED' })
    closeDb()
    vi.stubEnv('DATA_DIR', path.join(root, 'replacement.db'))
    const replacement = track()
    const current = initDb()
    await rejected
    expect(initDb()).toBe(current)
    await current
    expect((await replacement.execute("SELECT name FROM sqlite_schema WHERE name='sessions'")).rows).toHaveLength(1)
  })

  it('detects direct Client.close before reusing an initialization promise', async () => {
    const first = track()
    const initial = initDb()
    await initial
    first.close()
    vi.stubEnv('DATA_DIR', path.join(root, 'direct-close-replacement.db'))
    const replacement = initDb()
    expect(replacement).not.toBe(initial)
    const second = track()
    await replacement
    expect((await second.execute("SELECT name FROM sqlite_schema WHERE name='models'")).rows).toHaveLength(1)
  })
})
