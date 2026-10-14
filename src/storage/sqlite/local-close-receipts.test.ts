/** Real owned child processes and fault windows; a close event is not a normal close ACK. */
import fs from 'node:fs'
import path from 'node:path'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import type { Client } from '@libsql/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const injection = vi.hoisted(() => ({ source: undefined as string | undefined }))
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn(command: string, args?: readonly string[], options?: SpawnOptions) {
    const argv = args ? [...args] : []
    if (injection.source && argv[1] === '--eval') argv[2] = injection.source
    return actual.spawn(command, argv, options ?? {})
  } }
})

import { LocalSqliteProcessClient, SqliteCloseLedger, type SqliteCloseReceipt } from './local-process-client.js'
import { closeDb, getDb, getDbEpoch } from './db.js'
import { closeMemoryDb, getMemoryDb } from '../memory/db.js'
import { closeKnowledgeDb, getKnowledgeDb, knowledgeDbPath } from '../knowledge/db.js'

let root: string
const owned: LocalSqliteProcessClient[] = []
const childOf = (db: LocalSqliteProcessClient) => (db as unknown as { child: ChildProcess }).child
const track = (db: Client): LocalSqliteProcessClient => {
  if (!(db instanceof LocalSqliteProcessClient)) throw new Error('Fixture must own an actual local process client')
  owned.push(db)
  return db
}
const create = (closeTimeoutMs = 1000) => track(new LocalSqliteProcessClient({ url: `file:${path.join(root, 'local.db')}` }, { closeTimeoutMs }))
const healthy = (receipt: SqliteCloseReceipt) => {
  expect(receipt).toMatchObject({ requested: true, acknowledged: true, nativeClosed: true, exited: true,
    stdioClosed: true, exitCode: 0, signal: null, forcedKill: false, pendingOperationsAtRequest: 0,
    transactionsAtRequest: 0, healthy: true, errors: [] })
}

beforeEach(async () => {
  await Promise.all([closeDb(), closeMemoryDb(), closeKnowledgeDb()])
  injection.source = undefined
  fs.mkdirSync(path.resolve('.e2e-tmp'), { recursive: true })
  root = fs.mkdtempSync(path.resolve('.e2e-tmp/native-close-'))
  vi.stubEnv('DATA_DIR', path.join(root, 'agent.db'))
  vi.stubEnv('KNOWLEDGE_DATA_DIR', path.join(root, 'knowledge.db'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all([closeDb(), closeMemoryDb(), closeKnowledgeDb(), ...owned.splice(0).map(db => db.closeWithReceipt())])
  injection.source = undefined
  vi.unstubAllEnvs()
  // The fixture was created under this candidate; no computed external path is removed.
  const relative = path.relative(path.resolve('.e2e-tmp'), root)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Fixture escaped owned directory')
  fs.rmSync(root, { recursive: true, force: true })
})

describe('native close receipts', () => {
  it('joins ACK, actual exit and stdio closure once, and invalidates the epoch synchronously', async () => {
    const db = create()
    await db.execute('CREATE TABLE t(v INTEGER)')
    const tx = await db.transaction('write')
    await tx.execute('INSERT INTO t VALUES(7)')
    await tx.commit()
    const epoch = getDbEpoch(db)
    const pid = childOf(db).pid
    const first = db.closeWithReceipt()
    expect(db.closeWithReceipt()).toBe(first)
    expect(db.closed).toBe(true)
    expect(getDbEpoch(db)).not.toBe(epoch)
    await expect(db.execute('SELECT 1')).rejects.toMatchObject({ code: 'CLIENT_CLOSED' })
    const receipt = await first
    healthy(receipt)
    expect(receipt.sourceEpoch).toBe(epoch)
    expect(receipt.pid).toBe(pid)
    expect(Object.isFrozen(receipt)).toBe(true)
    expect(Object.isFrozen(receipt.errors)).toBe(true)
    expect(() => process.kill(pid!, 0)).toThrow()
  })

  it('does not resolve a receipt at ACK time while the real process still holds stdio', async () => {
    injection.source = `process.on('message', m => { if(m.op==='close') process.send({id:0,closeControl:{token:m.closeToken,nativeClosed:true,errors:[]}},()=>setTimeout(()=>process.exit(0),150)); });`
    const db = create()
    const ack = new Promise<void>(resolve => childOf(db).on('message', message => {
      if (message && typeof message === 'object' && 'closeControl' in message) resolve()
    }))
    let settled = false
    const result = db.closeWithReceipt().then(receipt => { settled = true; return receipt })
    await ack
    expect(settled).toBe(false)
    expect(childOf(db).exitCode).toBe(null)
    healthy(await result)
  })

  it('rejects a wrong-token ACK even when the real native close exits zero', async () => {
    const db = create()
    await db.execute('SELECT 1')
    const child = childOf(db)
    const spy = vi.spyOn(child, 'send').mockImplementationOnce(message => {
      spy.mockRestore()
      return child.send(Object.assign({}, message, { closeToken: 'not-the-owned-token' }))
    })
    const receipt = await db.closeWithReceipt()
    expect(receipt).toMatchObject({ requested: true, acknowledged: false, exited: true, stdioClosed: true,
      exitCode: 0, forcedKill: false, healthy: false })
    await db.whenClosed()
    expect(db.getCloseReceipts()).toContain(receipt)
  })

  it('records forced termination independently when close delivery is lost', async () => {
    const db = create(80)
    await db.execute('SELECT 1')
    vi.spyOn(childOf(db), 'send').mockImplementationOnce(() => true)
    const receipt = await db.closeWithReceipt()
    expect(receipt).toMatchObject({ requested: true, acknowledged: false, exited: true,
      stdioClosed: true, forcedKill: true, healthy: false })
    expect(receipt.exitCode === 0 && receipt.signal === null).toBe(false)
  })

  it('keeps a received close ACK separate from an actual nonzero process exit', async () => {
    injection.source = `process.on('message',m=>{if(m.op==='close')process.send({id:0,closeControl:{token:m.closeToken,nativeClosed:true,errors:[]}},()=>process.exit(7));});`
    const db = create()
    const receipt = await db.closeWithReceipt()
    expect(receipt).toMatchObject({ requested: true, acknowledged: true, nativeClosed: true,
      exited: true, stdioClosed: true, exitCode: 7, signal: null, forcedKill: false, healthy: false })
  })

  it('does not crash or accept a malformed close ACK from a faulting child', async () => {
    injection.source = `process.on('message',m=>{if(m.op==='close')process.send({id:0,closeControl:{token:m.closeToken,nativeClosed:true,errors:null}},()=>process.exit(0));});`
    const db = create()
    const receipt = await db.closeWithReceipt()
    expect(receipt).toMatchObject({ requested: true, acknowledged: false, exited: true,
      stdioClosed: true, exitCode: 0, healthy: false })
    expect(receipt.errors).toEqual(['SQLite close control ACK had an invalid shape'])
  })

  it('does not call interrupted requests or abandoned transactions a clean writer join', async () => {
    const db = create()
    await db.execute('CREATE TABLE t(v INTEGER)')
    const tx = await db.transaction('write')
    await tx.execute('INSERT INTO t VALUES(1)')
    const pending = expect(db.execute('SELECT count(*) AS n FROM t')).rejects.toMatchObject({ code: 'CLIENT_CLOSED' })
    const result = db.closeWithReceipt()
    await pending
    const receipt = await result
    expect(receipt).toMatchObject({ acknowledged: true, nativeClosed: true, exited: true, exitCode: 0,
      pendingOperationsAtRequest: 1, transactionsAtRequest: 1, healthy: false })
    expect(tx.closed).toBe(true)
    const reopened = create()
    expect((await reopened.execute('SELECT count(*) AS n FROM t')).rows[0].n).toBe(0)
  })

  it('preserves native initialization failure instead of reporting its exit as successful close', async () => {
    const db = track(new LocalSqliteProcessClient({ url: 'file://unexpected-host/test.db' }))
    await expect(db.execute('SELECT 1')).rejects.toMatchObject({ code: 'URL_INVALID' })
    await db.whenClosed()
    const receipt = await db.closeWithReceipt()
    expect(receipt).toMatchObject({ acknowledged: false, exited: true, stdioClosed: true, exitCode: 1, healthy: false })
    expect(receipt.errors.join(' ')).toMatch(/Invalid host/)
  })

  it('preserves failed transport evidence after reconnect and carries consecutive predecessor joins', async () => {
    const db = create()
    const failedChild = childOf(db)
    const epoch = getDbEpoch(db)
    vi.spyOn(failedChild, 'send').mockImplementationOnce(() => { throw new Error('held init transport failure') })
    await expect(db.execute('SELECT 1')).rejects.toThrow('held init transport failure')
    await db.whenClosed()
    const failed = await db.closeWithReceipt()
    expect(failed).toMatchObject({ sourceEpoch: epoch, acknowledged: false, forcedKill: true, healthy: false })
    db.reconnect()
    const replacementEpoch = getDbEpoch(db)
    db.reconnect()
    expect(getDbEpoch(db)).not.toBe(replacementEpoch)
    expect((await db.execute('SELECT 9 AS n')).rows[0].n).toBe(9)
    const final = await db.closeWithReceipt()
    healthy(final)
    expect(db.getCloseReceipts()).toContain(failed)
    expect(db.getCloseReceipts().filter(receipt => !receipt.healthy)).toHaveLength(1)
  })

  it('does not brand a forged client prototype or facade with an execution epoch', async () => {
    const db = create()
    const forged = Object.create(LocalSqliteProcessClient.prototype) as Client
    expect(getDbEpoch(forged)).toBeUndefined()
    expect(getDbEpoch(new Proxy(db, {}))).toBeUndefined()
    expect(getDbEpoch(db)).toBeTypeOf('number')
    await db.execute('SELECT 1')
  })

  it('owns and joins distinct main, memory and knowledge database processes', async () => {
    vi.stubEnv('VITEST', 'false')
    const main = track(getDb()), memory = track(getMemoryDb()), knowledge = track(getKnowledgeDb())
    expect(new Set([main, memory, knowledge]).size).toBe(3)
    expect(new Set([childOf(main).pid, childOf(memory).pid, childOf(knowledge).pid]).size).toBe(3)
    expect(knowledgeDbPath()).toBe(path.join(root, 'knowledge.db'))
    await Promise.all([main, memory, knowledge].map((db, index) => db.execute(`CREATE TABLE probe_${index}(v INTEGER)`)))
    await knowledge.execute('CREATE VIRTUAL TABLE documents_fts USING fts5(content)')
    await knowledge.execute("INSERT INTO documents_fts(content) VALUES('isolated knowledge receipt')")
    expect((await knowledge.execute("SELECT content FROM documents_fts WHERE documents_fts MATCH 'isolated'")).rows[0].content)
      .toBe('isolated knowledge receipt')
    const a = closeDb(), b = closeMemoryDb(), c = closeKnowledgeDb()
    expect(closeDb()).toBe(a)
    expect(closeMemoryDb()).toBe(b)
    expect(closeKnowledgeDb()).toBe(c)
    const receipts = await Promise.all([a, b, c])
    for (const receipt of receipts) {
      expect(receipt).not.toBe(null)
      expect(receipt!.healthy).toBe(true)
      expect(receipt!.errors).toEqual([])
      for (const processReceipt of receipt!.receipts) healthy(processReceipt)
    }
    expect(new Set(receipts.map(receipt => receipt!.receipts.at(-1)!.sourceEpoch)).size).toBe(3)
  })

  it('does not close the main owner through the knowledge shared-test alias', async () => {
    vi.stubEnv('VITEST', 'true')
    const main = track(getDb())
    await main.execute('SELECT 1')
    expect(getKnowledgeDb()).toBe(main)
    const epoch = getDbEpoch(main)
    await closeKnowledgeDb()
    expect(main.closed).toBe(false)
    expect(getDbEpoch(main)).toBe(epoch)
    expect((await main.execute('SELECT 42 AS n')).rows[0].n).toBe(42)
  })

  it('retains failed epochs in the ledger when the same client explicitly reconnects', async () => {
    const ledger = new SqliteCloseLedger()
    const db = create()
    await db.execute('SELECT 1')
    const child = childOf(db)
    const exited = new Promise<void>(resolve => child.once('close', () => resolve()))
    child.kill()
    await exited
    db.reconnect()
    expect((await db.execute('SELECT 1 AS n')).rows[0].n).toBe(1)
    const receipt = await ledger.retire(db)
    expect(receipt.healthy).toBe(false)
    expect(receipt.receipts).toHaveLength(2)
    expect(receipt.receipts[0]).toMatchObject({ acknowledged: false, healthy: false })
    healthy(receipt.receipts[1])
    expect(receipt.errors).toHaveLength(1)
  })

  it('does not hide an abandoned writer by replacing the singleton with a healthy process', async () => {
    const first = track(getDb())
    await first.execute('CREATE TABLE t(v INTEGER)')
    const tx = await first.transaction('write')
    await tx.execute('INSERT INTO t VALUES(1)')
    const failed = await closeDb()
    expect(failed!.healthy).toBe(false)
    const unhealthy = failed!.receipts.filter(receipt => !receipt.healthy)
    expect(unhealthy).toHaveLength(1)
    const second = track(getDb())
    expect(second).not.toBe(first)
    expect((await second.execute('SELECT count(*) AS n FROM t')).rows[0].n).toBe(0)
    const replacement = closeDb()
    expect(closeDb()).toBe(replacement)
    const aggregate = await replacement
    healthy(aggregate!.receipts.at(-1)!)
    expect(aggregate!.healthy).toBe(false)
    expect(aggregate!.receipts).toContain(unhealthy[0])
    expect(aggregate!.errors.join(' ')).toContain(String(unhealthy[0].sourceEpoch))
  })
})
