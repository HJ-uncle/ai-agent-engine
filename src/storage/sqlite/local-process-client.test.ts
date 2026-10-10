import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalSqliteProcessClient } from './local-process-client.js'
import { LOCAL_SQLITE_PROCESS } from './local-process-runtime.js'

const fixtures: string[] = []
const clients: LocalSqliteProcessClient[] = []
function setup(busyTimeoutMs = 1500) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-sqlite-worker-'))
  fixtures.push(root)
  const url = pathToFileURL(path.join(root, 'test.db')).href
  const db = new LocalSqliteProcessClient({ url }, { cacheKb: 3200, mmapBytes: 1048576, busyTimeoutMs })
  clients.push(db)
  return { db, url }
}
afterEach(async () => {
  for (const db of clients) db.close()
  await Promise.all(clients.splice(0).map(db => db.whenClosed()))
  for (const root of fixtures.splice(0)) {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('aether-sqlite-worker-')) throw new Error('Unsafe database fixture cleanup')
    // Every owned worker has already exited above. Windows can briefly retain
    // file handles during process teardown; retry only this contained fixture.
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function externalWriter(url: string, holdMs: number) {
  const child = spawn(process.execPath, ['--input-type=commonjs', '--eval', `
    process.once('message', async ({url, holdMs, modulePath}) => {
      const {createClient}=require(modulePath);
      const db=createClient({url});
      try {
        await db.execute('BEGIN IMMEDIATE');
        await db.execute('INSERT INTO t VALUES(100)');
        process.send('locked');
        setTimeout(async()=>{await db.execute('ROLLBACK');db.close();process.disconnect()},holdMs);
      } catch(error) {process.send({error:error.message});db.close();process.disconnect()}
    });
  `], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], serialization: 'advanced', windowsHide: true })
  const released = new Promise<void>((resolve, reject) => { child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Writer exited: ${code}`))); child.once('error', reject) })
  const locked = new Promise<void>((resolve, reject) => { child.once('message', value => value === 'locked' ? resolve() : reject(new Error((value as {error:string}).error))); child.once('error', reject) })
  child.send({ url, holdMs, modulePath: createRequire(import.meta.url).resolve('@libsql/client/sqlite3') })
  await locked
  return { released }
}
const bounded = <T>(operation: Promise<T>) => new Promise<T>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Operation deadlocked')), 3000)
  operation.then(resolve, reject).finally(() => clearTimeout(timer))
})
async function pragmas(db: { execute(sql: string): Promise<{ rows: Array<Record<string, unknown>> }> }) {
  const values: Record<string, unknown> = {}
  for (const key of ['journal_mode', 'synchronous', 'cache_size', 'temp_store', 'mmap_size', 'busy_timeout', 'foreign_keys']) {
    values[key] = Object.values((await db.execute(`PRAGMA ${key}`)).rows[0])[0]
  }
  return values
}

describe('local SQLite process', () => {
  it('restores configured connection settings after every transaction without callers reapplying them', async () => {
    const { db } = setup()
    const expected = { journal_mode: 'wal', synchronous: 1, cache_size: -3200, temp_store: 2, mmap_size: 1048576, busy_timeout: 1500, foreign_keys: 1 }
    expect(await pragmas(db)).toEqual(expected)
    await db.execute('CREATE TABLE t(id INTEGER PRIMARY KEY)')
    for (let n = 1; n <= 3; n++) {
      const tx = await db.transaction('write')
      expect(await pragmas(tx)).toEqual(expected)
      await tx.execute({ sql: 'INSERT INTO t VALUES(?)', args: [n] })
      await tx.commit() // Deliberately omit close(): existing history callers do this.
      expect(tx.closed).toBe(true)
      expect(await pragmas(db)).toEqual(expected)
    }
  })

  it('lets an owner finish while unrelated root writes and other transactions are queued', async () => {
    const { db } = setup()
    await db.execute('CREATE TABLE writes(id INTEGER PRIMARY KEY, owner TEXT)')
    const tx = await db.transaction('write')
    await tx.execute("INSERT INTO writes VALUES(1,'child')")
    let rootDone = false
    const root = db.execute("INSERT INTO writes VALUES(3,'root')").then(() => { rootDone = true })
    const next = db.transaction('write')
    await pause(20)
    expect(rootDone).toBe(false)
    await bounded(tx.execute("INSERT INTO writes VALUES(2,'child')"))
    await bounded(tx.commit())
    await bounded(root)
    const tx2 = await bounded(next)
    await tx2.execute("INSERT INTO writes VALUES(4,'child2')")
    await tx2.commit()
    expect((await db.execute('SELECT id FROM writes ORDER BY id')).rows.map(row => row.id)).toEqual([1, 2, 3, 4])
    await Promise.all(Array.from({ length: 10 }, async (_, i) => {
      if (i % 2 === 0) return db.execute('INSERT INTO writes VALUES(?,?)', [i + 10, 'root'])
      const child = await db.transaction('write')
      try { await child.execute({ sql: 'INSERT INTO writes VALUES(?,?)', args: [i + 10, 'child'] }); await child.commit() }
      finally { child.close() }
    }))
    expect((await db.execute('SELECT count(*) AS n FROM writes')).rows[0].n).toBe(14)
  })

  it('releases the queue after rollback, uncommitted close, and failed statements', async () => {
    const { db } = setup()
    await db.execute('CREATE TABLE t(id INTEGER PRIMARY KEY)')
    const rollback = await db.transaction('write')
    await rollback.execute('INSERT INTO t VALUES(1)')
    const waiting = db.execute('INSERT INTO t VALUES(2)')
    await rollback.rollback() // No close needed to release ownership.
    await bounded(waiting)
    const abandoned = await db.transaction('write')
    await abandoned.execute('INSERT INTO t VALUES(3)')
    abandoned.close()
    abandoned.close()
    await expect(abandoned.execute('SELECT 1')).rejects.toMatchObject({ code: 'TRANSACTION_CLOSED' })
    expect((await bounded(db.execute('SELECT id FROM t'))).rows.map(row => row.id)).toEqual([2])
    await expect(db.execute('INSERT INTO t VALUES(2)')).rejects.toMatchObject({ code: expect.stringContaining('SQLITE_CONSTRAINT') })
    await db.execute('INSERT INTO t VALUES(4)')
    const failed = await db.transaction('write')
    await expect(failed.execute('INSERT INTO t VALUES(4)')).rejects.toMatchObject({ code: expect.stringContaining('SQLITE_CONSTRAINT') })
    await failed.rollback()
    expect((await bounded(db.execute('SELECT count(*) AS n FROM t'))).rows[0].n).toBe(2)
  })

  it('preserves result rows, named and positional args, bigint, blobs, batch error metadata, and JSON shape', async () => {
    const { db } = setup()
    await db.executeMultiple('CREATE TABLE t(id INTEGER PRIMARY KEY,v TEXT,b BLOB); CREATE TABLE spare(id INTEGER)')
    const inserted = await db.execute({ sql: 'INSERT INTO t(v,b) VALUES($v,$b)', args: { v: 'hello', b: Uint8Array.from([1, 2, 255]) } })
    expect(inserted.lastInsertRowid).toBe(1n)
    const rows = await db.execute('SELECT id,v,b FROM t WHERE id=?', [1])
    expect(rows.rows[0][1]).toBe('hello')
    expect(rows.rows[0].v).toBe('hello')
    expect(rows.rows[0].length).toBe(3)
    expect(Object.keys(rows.rows[0])).toEqual(['id', 'v', 'b'])
    expect(rows.rows[0].b).toBeInstanceOf(ArrayBuffer)
    expect(rows.toJSON().rows[0]).toEqual([1, 'hello', 'AQL/'])
    expect(JSON.parse(JSON.stringify(inserted)).lastInsertRowid).toBe('1')
    await db.batch([['INSERT INTO spare VALUES(?)', [1]], { sql: 'INSERT INTO spare VALUES(?)', args: [2] }], 'write')
    await expect(db.batch(['INSERT INTO t(id,v) VALUES(2,\'ok\')', 'INSERT INTO t(id,v) VALUES(1,\'duplicate\')'], 'write'))
      .rejects.toMatchObject({ code: expect.stringContaining('SQLITE_CONSTRAINT'), statementIndex: 1 })
    expect((await db.execute('SELECT count(*) AS n FROM t')).rows[0].n).toBe(1)
    const tx = await db.transaction('write')
    await tx.batch([{ sql: 'INSERT INTO spare VALUES(?)', args: [3] }])
    await tx.executeMultiple('INSERT INTO spare VALUES(4); INSERT INTO spare VALUES(5);')
    await tx.commit()
    await db.migrate(['ALTER TABLE spare ADD COLUMN note TEXT'])
    expect((await db.execute('SELECT count(*) AS n FROM spare')).rows[0].n).toBe(5)
    // Native local SQLite has no replication target; preserve that rejection.
    await expect(db.sync()).rejects.toThrow('SyncNotSupported')
  })

  it('settles pending requests on close and permits an immediate reconnect with rollback', async () => {
    const { db } = setup()
    await db.execute('CREATE TABLE t(id INTEGER)')
    const tx = await db.transaction('write')
    await tx.execute('INSERT INTO t VALUES(1)')
    const waiting = db.execute('INSERT INTO t VALUES(2)')
    const rejected = expect(waiting).rejects.toMatchObject({ code: 'CLIENT_CLOSED' })
    db.close()
    expect(db.closed).toBe(true)
    await rejected
    await expect(db.execute('SELECT 1')).rejects.toMatchObject({ code: 'CLIENT_CLOSED' })
    db.reconnect()
    expect(db.closed).toBe(false)
    expect((await bounded(db.execute('SELECT count(*) AS n FROM t'))).rows[0].n).toBe(0)
    await db.execute('INSERT INTO t VALUES(3)')
    db.close()
    await db.whenClosed()
    expect(db.closed).toBe(true)
    db.reconnect()
    expect((await db.execute('SELECT id FROM t')).rows[0].id).toBe(3)
  })

  it('keeps the main thread responsive while native SQLite waits for an external writer', async () => {
    const { db, url } = setup()
    await db.execute('CREATE TABLE t(id INTEGER PRIMARY KEY)')
    const external = await externalWriter(url, 150)
    let ticks = 0
    const ticker = setInterval(() => ticks++, 10)
    try {
      await bounded(db.execute('INSERT INTO t VALUES(2)'))
      await external.released
      expect(ticks).toBeGreaterThanOrEqual(2)
      expect((await db.execute('SELECT id FROM t')).rows.map(row => row.id)).toEqual([2])
    } finally { clearInterval(ticker); await external.released }
  })

  it('recovers the request queue after an actual SQLITE_BUSY timeout', async () => {
    const { db, url } = setup(30)
    await db.execute('CREATE TABLE t(id INTEGER PRIMARY KEY)')
    const external = await externalWriter(url, 180)
    await expect(db.execute('INSERT INTO t VALUES(1)')).rejects.toMatchObject({ code: expect.stringContaining('SQLITE_BUSY') })
    await external.released
    await db.execute('INSERT INTO t VALUES(2)')
    expect((await db.execute('SELECT id FROM t')).rows.map(row => row.id)).toEqual([2])
  })

  it('carries the full generation barrier through consecutive reconnects and invalidates old transactions', async () => {
    const { db, url } = setup()
    await db.execute('CREATE TABLE t(id INTEGER PRIMARY KEY)')
    const oldWorker = (db as unknown as { child: ChildProcess }).child
    let oldExited = false
    oldWorker.once('exit', () => { oldExited = true })
    const external = await externalWriter(url, 200)
    const pending = expect(db.execute('INSERT INTO t VALUES(1)')).rejects.toMatchObject({ code: 'CLIENT_CLOSED' })
    await pause(30) // Let the old process enter its native busy wait.
    db.reconnect()
    db.reconnect()
    await pending
    await bounded(db.execute('SELECT * FROM t'))
    expect(oldExited).toBe(true)
    await external.released
    const oldTx = await db.transaction('write')
    db.reconnect()
    const fresh = await db.transaction('write')
    expect(oldTx.closed).toBe(true)
    await expect(oldTx.execute('SELECT 1')).rejects.toMatchObject({ code: 'TRANSACTION_CLOSED' })
    await fresh.rollback()
  })

  it('rejects queued work after database process termination and can reopen without retaining an uncommitted row', async () => {
    const { db } = setup()
    await db.execute('CREATE TABLE t(id INTEGER)')
    const tx = await db.transaction('write')
    await tx.execute('INSERT INTO t VALUES(1)')
    const pending = expect(db.execute('SELECT * FROM t')).rejects.toMatchObject({ code: 'CLIENT_CLOSED' })
    const child = (db as unknown as { child: ChildProcess }).child
    const exited = new Promise(resolve => child.once('exit', resolve))
    child.kill()
    await exited
    await pending
    expect(db.closed).toBe(true)
    db.reconnect()
    expect((await db.execute('SELECT * FROM t')).rows).toEqual([])
  })
})

it.each(['idle-exit', 'killed-parent'] as const)('closes the database process when its host ends (%s), rolling back abandoned work', async mode => {
  const { db, url } = setup()
  const moduleUrl = new URL('./local-process-client.ts', import.meta.url).href
  const host = spawn(process.execPath, ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href, '--input-type=module', '--eval', `
    const { LocalSqliteProcessClient } = await import(${JSON.stringify(moduleUrl)});
    const db = new LocalSqliteProcessClient({url:${JSON.stringify(url)}});
    await db.execute('CREATE TABLE t(id INTEGER)');
    const tx = await db.transaction('write');
    await tx.execute('INSERT INTO t VALUES(1)');
    process.send({databasePid:db.child.pid}, () => {
      if (${JSON.stringify(mode)} === 'idle-exit') process.disconnect();
    });
    if (${JSON.stringify(mode)} === 'killed-parent') setInterval(() => {}, 1000);
  `], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], serialization: 'advanced', windowsHide: true })
  const hostExited = new Promise<void>(resolve => host.once('exit', () => resolve()))
  let databasePid: number | undefined
  try {
    const info = await bounded(new Promise<{databasePid:number}>((resolve, reject) => {
      host.once('message', value => resolve(value as {databasePid:number}))
      host.once('error', reject)
    }))
    databasePid = info.databasePid
    expect(databasePid).not.toBe(host.pid)
    if (mode === 'killed-parent') host.kill()
    await bounded(hostExited)
    await bounded((async () => {
      for (;;) {
        try { process.kill(databasePid!, 0) } catch { break }
        await pause(20)
      }
    })())
    expect((await db.execute('SELECT count(*) AS n FROM t')).rows[0].n).toBe(0)
  } finally {
    if (host.exitCode === null && host.signalCode === null) host.kill()
    await hostExited
    if (databasePid) { try { process.kill(databasePid) } catch {} }
  }
})

it('ignores HTTP-only fetch configuration and settles synchronous initialization transport failures', async () => {
  const { url } = setup()
  const db = new LocalSqliteProcessClient({ url, fetch: () => { throw new Error('HTTP must not be used for a file database') } })
  clients.push(db)
  expect((await db.execute('SELECT 42 AS n')).rows[0].n).toBe(42)
  const failed = new LocalSqliteProcessClient({ url })
  clients.push(failed)
  const child = (failed as unknown as { child: ChildProcess }).child
  vi.spyOn(child, 'send').mockImplementationOnce(() => { throw new Error('IPC init serialization failed') })
  await expect(bounded(failed.execute('SELECT 1'))).rejects.toThrow('IPC init serialization failed')
  await bounded(failed.whenClosed())
  expect(failed.closed).toBe(true)
})

it('keeps one in-memory connection through read/deferred transactions and preserves multi-statement transaction behavior', async () => {
  const db = new LocalSqliteProcessClient({ url: 'file::memory:', intMode: 'bigint' })
  clients.push(db)
  await db.execute('CREATE TABLE t(id INTEGER PRIMARY KEY,v TEXT)')
  const deferred = await db.transaction('deferred')
  await deferred.executeMultiple("INSERT INTO t VALUES(1,'a;b'); INSERT INTO t VALUES(2,'c;d');")
  await deferred.commit()
  const read = await db.transaction('read')
  expect((await read.execute('SELECT count(*) AS n FROM t')).rows[0].n).toBe(2n)
  await read.rollback()
  const failed = await db.transaction('write')
  await expect(failed.batch(['INSERT INTO t VALUES(3,\'x\')', 'INSERT INTO t VALUES(1,\'duplicate\')']))
    .rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT', statementIndex: 1 })
  await failed.rollback()
  expect((await db.execute('SELECT id,v FROM t ORDER BY id')).rows.map(row => [row.id, row.v])).toEqual([[1n, 'a;b'], [2n, 'c;d']])
  const invalid = new LocalSqliteProcessClient({ url: 'file://unexpected-host/test.db' })
  clients.push(invalid)
  await expect(bounded(invalid.execute('SELECT 1'))).rejects.toMatchObject({ code: 'URL_INVALID' })
  await bounded(invalid.whenClosed())
})

it('survives forced native GC across 1200 interleaved transactions on one physical connection', async () => {
  const { db, url } = setup()
  db.close()
  await db.whenClosed()
  const runtime = LOCAL_SQLITE_PROCESS + '\nsetInterval(() => global.gc(), 10).unref();'
  const child = spawn(process.execPath, ['--expose-gc', '--input-type=commonjs', '--eval', runtime], {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'], serialization: 'advanced', windowsHide: true,
  })
  const requests = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  let sequence = 0
  child.on('message', value => {
    const reply = value as { id: number; value?: unknown; error?: {message:string} }
    const request = requests.get(reply.id)
    if (!request) return
    requests.delete(reply.id)
    if (reply.error) request.reject(new Error(reply.error.message))
    else request.resolve(reply.value)
  })
  const exited = new Promise<void>(resolve => child.once('exit', code => {
    for (const request of requests.values()) request.reject(new Error(`Native SQLite process exited: ${code}`))
    requests.clear()
    resolve()
  }))
  const call = (op: string, args: unknown[] = [], txId?: number) => new Promise<unknown>((resolve, reject) => {
    const id = ++sequence
    requests.set(id, { resolve, reject })
    child.send({ id, op, args, txId }, error => { if (error) { requests.delete(id); reject(error) } })
  })
  try {
    child.send({ op: 'init', args: [{ modulePath: createRequire(import.meta.url).resolve('@libsql/client/sqlite3'),
      config: { url }, pragmas: ['PRAGMA journal_mode=WAL', 'PRAGMA synchronous=NORMAL'] }] })
    await call('execute', ['CREATE TABLE t(id INTEGER PRIMARY KEY)'])
    await Promise.all(Array.from({ length: 12 }, async (_, lane) => {
      for (let iteration = 0; iteration < 100; iteration++) {
        const txId = await call('transaction', ['write']) as number
        await call('execute', [{ sql: 'INSERT INTO t VALUES(?)', args: [lane * 100 + iteration] }], txId)
        await call(iteration % 5 ? 'commit' : 'rollback', [], txId)
      }
    }))
    expect(await call('execute', ['SELECT count(*) AS n FROM t'])).toMatchObject({ rows: [[960]] })
  } finally {
    if (child.connected) child.send({ id: 0, op: 'close' })
    else child.kill()
    await bounded(exited)
  }
}, 15_000)
