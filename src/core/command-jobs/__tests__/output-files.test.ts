import fs from 'node:fs'
import path from 'node:path'
import type { TransactionMode } from '@libsql/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CommandJobManager } from '../manager.js'
import { CommandOutputFiles, getCommandOutputFiles } from '../output-files.js'
import type { CommandJobSnapshot, CommandOutputEntry } from '../types.js'
import { LocalSqliteProcessClient } from '../../../storage/sqlite/local-process-client.js'

const fixtureRoot = path.resolve('.e2e-tmp/command-output-tests')
const scope = { tenantId: 'files-tenant', sessionId: 'files-session' }
let fixture: string, db: LocalSqliteProcessClient, manager: CommandJobManager
const entriesText = (entries: CommandOutputEntry[]) => entries.map(entry => entry.text).join('')

beforeEach(async () => {
  fs.mkdirSync(fixtureRoot, { recursive: true })
  fixture = fs.mkdtempSync(path.join(fixtureRoot, 'case-'))
  db = new LocalSqliteProcessClient({ url: 'file:' + path.join(fixture, 'state.db').replaceAll('\\', '/') })
  manager = new CommandJobManager({ db })
  await manager.initialize()
})
afterEach(async () => {
  vi.restoreAllMocks()
  await manager.shutdown('fixture cleanup')
  db.close()
  await db.whenClosed()
  const target = path.resolve(fixture)
  if (path.dirname(target) !== fixtureRoot || !path.basename(target).startsWith('case-')) throw new Error('Unsafe command log fixture cleanup')
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})
afterAll(() => {
  if (fs.existsSync(fixtureRoot) && !fs.lstatSync(fixtureRoot).isSymbolicLink() && fs.readdirSync(fixtureRoot).length === 0) fs.rmdirSync(fixtureRoot)
})

async function seed(entries: CommandOutputEntry[], jobId = 'legacy-job', tailOnly = false) {
  const job: CommandJobSnapshot = { schemaVersion: 1, jobId, sessionId: scope.sessionId, ownerSessionId: scope.sessionId,
    version: 1, status: 'succeeded', command: 'node', args: [], cwd: fixture, background: true,
    createdAt: Date.now(), updatedAt: Date.now(), exitCode: 0, signal: null, cursor: entries.at(-1)?.seq ?? 0, earliestCursor: 0 }
  await db.execute({ sql: 'INSERT INTO command_jobs(tenant_id,session_id,job_id,status,version,snapshot,entries) VALUES(?,?,?,?,?,?,?)',
    args: [scope.tenantId, scope.sessionId, jobId, job.status, job.version, JSON.stringify(job), JSON.stringify(tailOnly ? entries : [])] })
  if (!tailOnly && entries.length) await db.batch(entries.map(entry => ({
    sql: 'INSERT INTO command_job_output(tenant_id,session_id,job_id,seq,stream,text) VALUES(?,?,?,?,?,?)',
    args: [scope.tenantId, scope.sessionId, jobId, entry.seq, entry.stream, entry.text],
  })), 'write')
  return job
}

describe('file-backed command output', () => {
  it('bounds writev batches and resumes partial writes across buffer boundaries without concatenating the flush', async () => {
    const files = await getCommandOutputFiles(db), identity = { ...scope, jobId: 'partial-writev' }
    const open = fs.promises.open.bind(fs.promises), batchSizes: number[] = []
    const spy = vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args)
      if (String(args[0]).endsWith('.log') && typeof args[1] === 'number' && (args[1] & fs.constants.O_RDWR)) {
        const writev = handle.writev.bind(handle)
        vi.spyOn(handle, 'writev').mockImplementation(async (buffers, position) => {
          batchSizes.push(buffers.length)
          // Real writes, deliberately limited to seven bytes: this splits UTF-8
          // sequences and crosses input-buffer boundaries at the storage layer.
          let left = 7
          const prefix: Buffer[] = []
          for (const buffer of buffers as readonly Buffer[]) {
            const part = buffer.subarray(0, left)
            if (part.length) prefix.push(part)
            left -= part.length
            if (!left) break
          }
          return writev(prefix, position)
        })
      }
      return handle
    })
    const chunks = Array.from({ length: 130 }, (_, index) => index % 9 === 0 ? Buffer.alloc(0) : Buffer.from(`${index}:🙂\0中\n`))
    const expected = Buffer.concat(chunks)
    expect(await files.append(identity, 0, chunks)).toBe(expected.length)
    expect(batchSizes.length).toBeGreaterThan(130)
    expect(Math.max(...batchSizes)).toBe(64)
    spy.mockRestore()
    expect(await files.read(identity, 0, expected.length)).toEqual(expected)
  })

  it('fails a zero-progress writev and can retry from the committed offset', async () => {
    const files = await getCommandOutputFiles(db), identity = { ...scope, jobId: 'zero-writev' }
    const open = fs.promises.open.bind(fs.promises)
    const spy = vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args)
      if (String(args[0]).endsWith('.log') && typeof args[1] === 'number' && (args[1] & fs.constants.O_RDWR))
        vi.spyOn(handle, 'writev').mockImplementationOnce(async buffers => ({ bytesWritten: 0, buffers }))
      return handle
    })
    await expect(files.append(identity, 0, [Buffer.from('complete')])).rejects.toMatchObject({ code: 'COMMAND_OUTPUT_IO' })
    spy.mockRestore()
    expect(await files.append(identity, 0, [Buffer.from('complete')])).toBe(8)
    expect((await files.read(identity, 0, 8)).toString()).toBe('complete')
  })

  it('repairs an uncommitted tail without duplicating bytes and refuses a short committed file', async () => {
    const files = await getCommandOutputFiles(db), identity = { ...scope, jobId: 'append' }
    const first = Buffer.from('first\0🙂'), next = Buffer.from('next\n中')
    expect(await files.append(identity, 0, [first])).toBe(first.length)
    await files.append(identity, first.length, [Buffer.from('uncommitted junk')])
    await files.append(identity, first.length, [next])
    expect(await files.read(identity, 0, first.length + next.length)).toEqual(Buffer.concat([first, next]))
    await expect(files.append(identity, first.length + next.length + 1, [])).rejects.toMatchObject({ code: 'COMMAND_OUTPUT_CORRUPT' })
  })

  it('binds to the actual database and refuses symlinked roots without writing outside its store', async () => {
    const first = await getCommandOutputFiles(db)
    expect(first.root).toBe(path.join(fixture, 'state.db.command-output'))
    const other = new LocalSqliteProcessClient({ url: 'file:' + path.join(fixture, 'other.db').replaceAll('\\', '/') })
    try { expect((await getCommandOutputFiles(other)).root).not.toBe(first.root) } finally { other.close(); await other.whenClosed() }
    const destination = path.join(fixture, 'outside'), link = path.join(fixture, 'link')
    fs.mkdirSync(destination)
    fs.symlinkSync(destination, link, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(new CommandOutputFiles(link).append({ ...scope, jobId: '../escape' }, 0, [Buffer.from('x')]))
      .rejects.toMatchObject({ code: 'COMMAND_OUTPUT_UNSAFE_PATH' })
    expect(fs.readdirSync(destination)).toEqual([])
  })

  it('migrates bounded legacy bodies, keeps only indexes in SQLite and leases one file per page', async () => {
    const entries = Array.from({ length: 100 }, (_, index): CommandOutputEntry => ({ seq: index + 1,
      stream: index % 2 ? 'stderr' : 'stdout', text: String(index).padStart(4, '0') + 'x'.repeat(4092) }))
    const job = await seed(entries), files = await getCommandOutputFiles(db)
    const open = vi.spyOn(files, 'openReader')
    const page = (await manager.output(scope, job.jobId))!
    expect(page.entries).toEqual(entries.slice(0, 16))
    expect(open).toHaveBeenCalledTimes(1)
    expect(Number((await db.execute('SELECT COUNT(*) AS n FROM command_job_output WHERE storage_version=1 AND text=\'\'')).rows[0].n)).toBe(64)
    const second = (await manager.output(scope, job.jobId, { cursor: page.nextCursor }))!
    expect(second.entries).toEqual(entries.slice(16, 32))
    expect(Number((await db.execute('SELECT SUM(length(CAST(text AS BLOB))) AS n FROM command_job_output')).rows[0].n)).toBe(0)
    const stored = (await db.execute('SELECT entries,output_bytes,storage_version,tail_migrated FROM command_jobs')).rows[0]
    expect(stored).toMatchObject({ entries: '[]', output_bytes: 409600, storage_version: 1, tail_migrated: 1 })
  })

  it('imports a finite legacy JSON tail once without dropping unread entries', async () => {
    const entries = Array.from({ length: 150 }, (_, index): CommandOutputEntry => ({ seq: index + 1, stream: 'stdout', text: `${index}\0🙂\n` }))
    const job = await seed(entries, 'tail-only', true)
    const page = (await manager.output(scope, job.jobId))!
    expect(page.entries).toEqual(entries)
    expect(page.hasMore).toBe(false)
    expect((await db.execute('SELECT entries,tail_migrated FROM command_jobs')).rows[0]).toMatchObject({ entries: '[]', tail_migrated: 1 })
    expect((await manager.output(scope, job.jobId, { cursor: page.nextCursor }))!.entries).toEqual([])
    expect(Number((await db.execute('SELECT COUNT(*) AS n FROM command_job_output')).rows[0].n)).toBe(150)
  })

  it('retains old SQL bodies after a file-write failure and retries an orphan tail without duplication', async () => {
    const text = 'complete\0🙂\n'.repeat(20), job = await seed([{ seq: 1, stream: 'stdout', text }])
    const files = await getCommandOutputFiles(db), append = files.append.bind(files)
    const failure = vi.spyOn(files, 'append').mockImplementationOnce(async (...args) => { await append(...args); throw new Error('fixture after fsync') })
    await expect(manager.output(scope, job.jobId)).rejects.toThrow('fixture after fsync')
    const retained = (await db.execute('SELECT storage_version,CAST(text AS BLOB) AS body FROM command_job_output')).rows[0]
    expect(retained.storage_version).toBe(0)
    expect(Buffer.from(new Uint8Array(retained.body as ArrayBuffer)).toString()).toBe(text)
    failure.mockRestore()
    expect(entriesText((await manager.output(scope, job.jobId))!.entries)).toBe(text)
    expect(Number((await db.execute('SELECT output_bytes FROM command_jobs')).rows[0].output_bytes)).toBe(Buffer.byteLength(text))
    const read = await files.read({ ...scope, jobId: job.jobId }, 0, Buffer.byteLength(text))
    expect(read.toString()).toBe(text)
  })

  it('recovers a committed-but-unacknowledged migration without appending the same body twice', async () => {
    const text = 'already committed\0🙂', job = await seed([{ seq: 1, stream: 'stdout', text }])
    const transaction = db.transaction.bind(db)
    let fail = true
    const spy = vi.spyOn(db, 'transaction').mockImplementation(async (mode?: TransactionMode) => {
      const tx = await transaction(mode), commit = tx.commit.bind(tx)
      tx.commit = async () => { await commit(); if (fail) { fail = false; throw new Error('lost commit acknowledgement') } }
      return tx
    })
    await expect(manager.output(scope, job.jobId)).rejects.toThrow('lost commit acknowledgement')
    spy.mockRestore()
    expect(entriesText((await manager.output(scope, job.jobId))!.entries)).toBe(text)
    expect(Number((await db.execute('SELECT output_bytes FROM command_jobs')).rows[0].output_bytes)).toBe(Buffer.byteLength(text))
  })

  it('reads recent output with UTF-8 aligned tail semantics while preserving older pages', async () => {
    const entries: CommandOutputEntry[] = [{ seq: 1, stream: 'stdout', text: 'old'.repeat(100) },
      { seq: 2, stream: 'stderr', text: '头🙂中\0tail-end' }]
    const job = await seed(entries)
    const tail = (await manager.output(scope, job.jobId, { tail: true, maxBytes: 15 }))!
    expect(tail).toMatchObject({ tail: true, truncated: false, hasMore: false, nextCursor: 2, nextOffset: 0, earliestCursor: 0 })
    expect(Buffer.byteLength(entriesText(tail.entries))).toBeLessThanOrEqual(15)
    expect(entriesText(tail.entries)).toBe('中\0tail-end')
    expect(entriesText((await manager.output(scope, job.jobId))!.entries)).toBe(entriesText(entries))
    for (const options of [{ tail: true, cursor: 0 }, { tail: true, cursorOffset: 0 }]) await expect(manager.output(scope, job.jobId, options)).rejects.toThrow(/tail cannot/)
  })

  it('keeps oversized old rows readable through bounded SQL ranges, including tail offsets', async () => {
    const text = '🙂\0'.repeat(70_000) + 'END', job = await seed([{ seq: 1, stream: 'stdout', text }])
    const page = (await manager.output(scope, job.jobId, { cursorOffset: 0, maxChars: 8 }))!
    expect(entriesText(page.entries).length).toBeLessThanOrEqual(8)
    expect(page).toMatchObject({ nextCursor: 0, hasMore: true })
    expect((await db.execute('SELECT storage_version FROM command_job_output')).rows[0].storage_version).toBe(0)
    const tail = (await manager.output(scope, job.jobId, { tail: true, maxBytes: 9 }))!
    expect(entriesText(tail.entries)).toBe('\0🙂\0END')
    expect(tail).toMatchObject({ tail: true, hasMore: false, truncated: false, nextCursor: 1 })
  })

  it('queues failed file removal durably and retries it on the next bounded cleanup', async () => {
    const job = await seed([{ seq: 1, stream: 'stdout', text: 'remove this' }])
    await manager.output(scope, job.jobId)
    const files = await getCommandOutputFiles(db), removal = vi.spyOn(files, 'remove').mockRejectedValueOnce(new Error('fixture file in use'))
    expect(await manager.delete(scope, job.jobId)).toBe(true)
    expect(await manager.output(scope, job.jobId)).toBeNull()
    expect(Number((await db.execute('SELECT COUNT(*) AS n FROM command_output_gc')).rows[0].n)).toBe(1)
    removal.mockRestore()
    await seed([], 'next-cleanup')
    await manager.delete(scope, 'next-cleanup')
    expect(Number((await db.execute('SELECT COUNT(*) AS n FROM command_output_gc')).rows[0].n)).toBe(0)
    await expect(files.read({ ...scope, jobId: job.jobId }, 0, 1)).rejects.toMatchObject({ code: 'COMMAND_OUTPUT_MISSING' })
  })

  it('does not let 64 oversized rows block smaller legacy rows or repeatedly write on later reads', async () => {
    const job = await seed([], 'oversized-prefix')
    await db.execute({ sql: `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<65)
      INSERT INTO command_job_output(tenant_id,session_id,job_id,seq,stream,text)
      SELECT ?,?,?,x,'stdout',printf('%0262145d',0) FROM n`, args: [scope.tenantId, scope.sessionId, job.jobId] })
    await db.execute({ sql: "INSERT INTO command_job_output(tenant_id,session_id,job_id,seq,stream,text) VALUES(?,?,?,66,'stdout','END')",
      args: [scope.tenantId, scope.sessionId, job.jobId] })
    await db.execute({ sql: "UPDATE command_jobs SET snapshot=json_set(snapshot,'$.cursor',66) WHERE job_id=?", args: [job.jobId] })
    expect(entriesText((await manager.output(scope, job.jobId, { cursor: 65 }))!.entries)).toBe('END')
    expect((await db.execute('SELECT storage_version FROM command_jobs')).rows[0].storage_version).toBe(2)
    expect(Number((await db.execute('SELECT COUNT(*) AS n FROM command_job_output WHERE storage_version=1')).rows[0].n)).toBe(1)
    const transactions = vi.spyOn(db, 'transaction')
    for (let index = 0; index < 4; index++) expect(entriesText((await manager.output(scope, job.jobId, { cursor: 65 }))!.entries)).toBe('END')
    expect(transactions).not.toHaveBeenCalled()
    transactions.mockRestore()
  })

  it('does not write snapshots or files when repeatedly polling a quiet running command', async () => {
    const job = await manager.start({ ...scope, ownerSessionId: scope.sessionId, command: process.execPath,
      args: ['-e', 'setInterval(()=>{},1000)'], cwd: fixture, background: true, env: process.env })
    const transaction = vi.spyOn(db, 'transaction'), files = await getCommandOutputFiles(db), append = vi.spyOn(files, 'append')
    for (let index = 0; index < 5; index++) expect((await manager.output(scope, job.jobId))!.entries).toEqual([])
    expect(transaction).not.toHaveBeenCalled()
    expect(append).not.toHaveBeenCalled()
    transaction.mockRestore(); append.mockRestore()
    await manager.cancel(scope, job.jobId)
  }, 15_000)
})
