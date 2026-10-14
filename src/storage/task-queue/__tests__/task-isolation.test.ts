// Two real SQLite connections, HTTP inject and model-tool calls, synthetic files only.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Client, InArgs, InStatement, TransactionMode } from '@libsql/client'
import type { AgentContext } from '../../../core/agent-context/index.js'
import Fastify, { type FastifyRequest } from 'fastify'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LocalSqliteProcessClient } from '../../sqlite/local-process-client.js'
import { up as migrate } from '../../sqlite/migrations/001_initial.js'
import { SQLiteTaskQueue } from '../sqlite-queue.js'
import { taskRoutes } from '../../../api/http/routes/tasks.js'

const choice = vi.hoisted(() => ({ getDb: vi.fn<() => Client>() }))
vi.mock('../../sqlite/db.js', () => ({ getDb: choice.getDb }))
const scope = new AsyncLocalStorage<Client>()
let primary: Client, a: LocalSqliteProcessClient, b: LocalSqliteProcessClient, root: string
const fixtureParent = path.resolve('.e2e-tmp', 'task-isolation')
const queues: SQLiteTaskQueue[] = [], apps: ReturnType<typeof Fastify>[] = []
const operations: Promise<unknown>[] = [], releases: Array<() => void> = []

function run<T>(db: Client, operation: () => Promise<T>): Promise<T> {
  const result = scope.run(db, operation)
  operations.push(result.then(() => undefined, () => undefined))
  return result
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  releases.push(resolve)
  return { promise, resolve }
}
function proxy(db: Client, before: (sql: string) => Promise<void>, after?: (sql: string) => Promise<void>): Client {
  function sqlProxy<T extends Pick<Client, 'execute'>>(db: T): T { return new Proxy(db, { get(owner, property) {
    if (property === 'execute') return async (statement: InStatement, args?: InArgs) => {
      const sql = typeof statement === 'string' ? statement : statement.sql
      await before(sql)
      const result = typeof statement === 'string' ? await owner.execute(statement, args) : await owner.execute(statement)
      await after?.(sql)
      return result
    }
    if (property === 'transaction') return async (mode?: TransactionMode) => sqlProxy(await dbClient.transaction(mode))
    const value = Reflect.get(owner, property, owner)
    return typeof value === 'function' ? value.bind(owner) : value
  } }) }
  const dbClient = db
  return sqlProxy(db)
}
function queue() { const value = new SQLiteTaskQueue(1_000_000); queues.push(value); return value }
function tick(value: SQLiteTaskQueue, db: Client = a) {
  return run(db, () => (value as unknown as { processPending(): Promise<void> }).processPending())
}
async function insert(id: string, tenant = 'A', type = 'copy', status = 'pending') {
  await a.execute({ sql: 'INSERT INTO jobs(id,tenant_id,type,payload,status) VALUES(?,?,?,?,?)', args: [id, tenant, type, '{"test":"only"}', status] })
}
async function status(id: string) {
  const result = await a.execute({ sql: 'SELECT status FROM jobs WHERE id=?', args: [id] })
  return result.rows[0]?.status
}

beforeEach(async () => {
  fs.mkdirSync(fixtureParent, { recursive: true })
  root = fs.mkdtempSync(path.join(fixtureParent, 'fixture-'))
  const url = pathToFileURL(path.join(root, 'test.db')).href
  a = new LocalSqliteProcessClient({ url }, { busyTimeoutMs: 1500 }); primary = a
  b = new LocalSqliteProcessClient({ url }, { busyTimeoutMs: 1500 })
  await migrate(a); await b.execute('SELECT 1')
  choice.getDb.mockImplementation(() => scope.getStore() ?? primary)
})
afterEach(async () => {
  const drains = queues.splice(0).map(value => value.stop())
  for (const release of releases.splice(0)) release()
  await Promise.all(operations.splice(0))
  await Promise.all(drains)
  await Promise.all(apps.splice(0).map(app => app.close()))
  a.close(); b.close(); await Promise.all([a.whenClosed(), b.whenClosed()])
  if (path.dirname(root) !== fixtureParent || !path.basename(root).startsWith('fixture-')) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

it('constructing a management queue preserves another producer running in the same database', async () => {
  await insert('active', 'A', 'copy', 'running')
  queue(); await a.execute('SELECT 1')
  expect(await status('active')).toBe('running')
})

it('tenant-scoped exact reads and atomic pending cancellation hide foreign jobs', async () => {
  await insert('private', 'B')
  const value = queue()
  expect(await value.getStatus('private', 'A')).toBeNull()
  expect(await value.cancel('private', 'A')).toBe(false)
  expect(await status('private')).toBe('pending')
  expect(await value.getStatus('private', 'B')).toMatchObject({ tenantId: 'B', id: 'private' })
  expect(await value.cancel('private', 'B')).toBe(true)
  expect(await value.cancel('private', 'B')).toBe(false)
})

it('a missing tenant fails before executing SQL rather than becoming a global lookup', async () => {
  await insert('private', 'B')
  const value = queue()
  await expect(value.getStatus('private', '')).rejects.toThrow('tenant')
  await expect(value.cancel('private', '')).rejects.toThrow('tenant')
  expect(await status('private')).toBe('pending')
})

it('two connections selecting the same pending job perform the filesystem effect once', async () => {
  await insert('once')
  const selected = deferred(), release = deferred()
  let arrivals = 0, calls = 0
  const barrier = (db: Client) => proxy(db, async () => {}, async sql => {
    if (sql.startsWith('SELECT * FROM jobs WHERE status')) {
      if (++arrivals === 2) selected.resolve()
      await release.promise
    }
  })
  const left = queue(), right = queue()
  for (const value of [left, right]) value.registerHandler('copy', async () => {
    calls++; fs.appendFileSync(path.join(root, 'effects.txt'), 'effect\n'); return 'saved'
  })
  left.start(); right.start()
  const first = tick(left, barrier(a)), second = tick(right, barrier(b))
  await selected.promise; release.resolve(); await Promise.all([first, second])
  expect(calls).toBe(1)
  expect(fs.readFileSync(path.join(root, 'effects.txt'), 'utf8')).toBe('effect\n')
  expect(await status('once')).toBe('done')
})

it('cancellation winning immediately before the claim prevents handler effects', async () => {
  await insert('cancel')
  const reached = deferred(), release = deferred(), value = queue()
  const handler = vi.fn(async () => { fs.writeFileSync(path.join(root, 'forbidden.txt'), 'bad') })
  value.registerHandler('copy', handler); value.start()
  const pending = tick(value, proxy(a, async () => {}, async sql => {
    if (sql.startsWith('SELECT * FROM jobs WHERE status')) { reached.resolve(); await release.promise }
  }))
  await reached.promise
  expect(await run(b, () => value.cancel('cancel', 'A'))).toBe(true)
  release.resolve(); await pending
  expect(handler).not.toHaveBeenCalled()
  expect(fs.existsSync(path.join(root, 'forbidden.txt'))).toBe(false)
  expect(await status('cancel')).toBe('cancelled')
})

it('stop while the claim is awaiting SQL acknowledgement cannot launch a new handler', async () => {
  await insert('stopped-claim')
  const value = queue(), claimed = deferred(), release = deferred()
  const handler = vi.fn(async () => { fs.writeFileSync(path.join(root, 'forbidden.txt'), 'bad') })
  value.registerHandler('copy', handler); value.start()
  const pending = tick(value, proxy(a, async () => {}, async sql => {
    if (sql.startsWith('UPDATE jobs SET status = \'running\'')) { claimed.resolve(); await release.promise }
  }))
  await claimed.promise
  const stopped = value.stop(); release.resolve()
  await Promise.all([pending, stopped])
  expect(handler).not.toHaveBeenCalled()
  expect(fs.existsSync(path.join(root, 'forbidden.txt'))).toBe(false)
  expect(await status('stopped-claim')).toBe('cancelled')
  const claims = await a.execute('SELECT count(*) AS n FROM job_execution_claims')
  expect(Number(claims.rows[0].n)).toBe(0)
})

it('stop aborts the owned handler and waits for its real completion acknowledgement', async () => {
  await insert('active')
  const value = queue(), entered = deferred(), release = deferred()
  let signal: AbortSignal | undefined, joined = false
  value.registerHandler('copy', async (_job, received) => {
    signal = received; entered.resolve(); await release.promise
    fs.writeFileSync(path.join(root, 'completion.txt'), 'actual completion')
    return 'done'
  })
  value.start(); const pending = tick(value); await entered.promise
  const stopped = value.stop().then(() => { joined = true })
  expect(signal?.aborted).toBe(true)
  await Promise.resolve(); expect(joined).toBe(false)
  release.resolve(); await Promise.all([pending, stopped])
  expect(joined).toBe(true)
  expect(fs.readFileSync(path.join(root, 'completion.txt'), 'utf8')).toBe('actual completion')
  expect(await status('active')).toBe('done')
})

it('a stop timeout reports unknown effects and cannot admit another generation before join', async () => {
  await insert('slow')
  const value = queue(), entered = deferred(), release = deferred()
  let signal: AbortSignal | undefined, calls = 0
  value.registerHandler('copy', async (_job, received) => {
    signal = received; calls++; entered.resolve(); await release.promise
    fs.appendFileSync(path.join(root, 'late-effects.txt'), 'joined\n'); return 'done'
  })
  value.start(); const pending = tick(value); await entered.promise
  await expect(value.stop()).rejects.toThrow('external effects remain unknown')
  expect(signal?.aborted).toBe(true)
  expect(await status('slow')).toBe('running')
  expect(() => value.start()).toThrow('still draining')
  await tick(value); expect(calls).toBe(1)
  release.resolve(); await pending
  expect(fs.readFileSync(path.join(root, 'late-effects.txt'), 'utf8')).toBe('joined\n')
  expect(await status('slow')).toBe('done')
})

it('late completion cannot overwrite a replacement producer claim', async () => {
  await insert('fenced')
  const value = queue(), entered = deferred(), release = deferred()
  value.registerHandler('copy', async () => { entered.resolve(); await release.promise; return 'old-result' })
  value.start(); const pending = tick(value); await entered.promise
  await b.execute({ sql: 'UPDATE job_execution_claims SET claim_id=? WHERE job_id=?', args: ['replacement-owner', 'fenced'] })
  release.resolve()
  await expect(pending).rejects.toThrow('claim changed')
  expect(await status('fenced')).toBe('running')
  const record = await b.execute({ sql: 'SELECT result,error FROM jobs WHERE id=?', args: ['fenced'] })
  expect(record.rows[0]).toMatchObject({ result: null, error: null })
  const claim = await b.execute({ sql: 'SELECT claim_id FROM job_execution_claims WHERE job_id=?', args: ['fenced'] })
  expect(claim.rows[0].claim_id).toBe('replacement-owner')
})

it('lost completion acknowledgement preserves committed success without rerunning effects', async () => {
  await insert('ack-lost')
  let commits = 0, calls = 0
  const db = new Proxy(a, { get(owner, key) {
    if (key === 'transaction') return async (mode?: TransactionMode) => {
      const tx = await owner.transaction(mode)
      return new Proxy(tx, { get(transaction, property) {
        if (property === 'commit') return async () => {
          await transaction.commit()
          if (++commits === 2) throw new Error('Injected lost completion ACK')
        }
        const value = Reflect.get(transaction, property, transaction)
        return typeof value === 'function' ? value.bind(transaction) : value
      } })
    }
    const value = Reflect.get(owner, key, owner)
    return typeof value === 'function' ? value.bind(owner) : value
  } })
  const value = queue()
  value.registerHandler('copy', async () => { calls++; fs.appendFileSync(path.join(root, 'effects.txt'), 'effect\n'); return 'durable-result' })
  value.start()
  await expect(tick(value, db)).rejects.toThrow()
  expect(await status('ack-lost')).toBe('done')
  const record = await b.execute({ sql: 'SELECT result,error FROM jobs WHERE id=?', args: ['ack-lost'] })
  expect(record.rows[0]).toMatchObject({ result: '"durable-result"', error: null })
  await tick(value, db)
  expect(calls).toBe(1)
  expect(fs.readFileSync(path.join(root, 'effects.txt'), 'utf8')).toBe('effect\n')
})

it('an instance does not overlap its own poll calls while a handler is active', async () => {
  await insert('a'); await insert('b')
  const value = queue(), entered = deferred(), release = deferred()
  let calls = 0
  value.registerHandler('copy', async () => { calls++; entered.resolve(); await release.promise; return 'ok' })
  value.start()
  const first = tick(value); await entered.promise
  await tick(value); expect(calls).toBe(1)
  expect(await status('b')).toBe('pending')
  release.resolve(); await first; await tick(value)
  expect(calls).toBe(2); expect(await status('b')).toBe('done')
})

it('unknown types cannot be admitted and legacy unknown jobs do not block supported jobs', async () => {
  await insert('legacy-unknown', 'A', 'no-executor')
  const value = queue()
  await expect(value.enqueue({ type: 'no-executor', payload: {}, tenantId: 'A' })).rejects.toThrow('Unsupported')
  expect((await value.list('A')).map(job => job.id)).toEqual(['legacy-unknown'])
  value.registerHandler('copy', async () => 'real-handler')
  const id = await value.enqueue({ type: 'copy', payload: {}, tenantId: 'A' })
  value.start(); await tick(value)
  expect(await status(id)).toBe('done')
  expect(await status('legacy-unknown')).toBe('pending')
})

async function server() {
  const app = Fastify(); apps.push(app)
  app.addHook('preHandler', async request => {
    const authenticated = request as FastifyRequest & { authContext?: { tenantId: string } }
    authenticated.authContext = { tenantId: String(request.headers['x-test-tenant'] ?? 'A') }
  })
  await app.register(taskRoutes); await app.ready(); return app
}

it('HTTP exact get/delete cannot inspect or cancel another authenticated tenant job', async () => {
  await insert('other', 'B')
  const app = await server()
  const denied = await app.inject({ method: 'GET', url: '/tasks/other', headers: { 'x-test-tenant': 'A' } })
  expect(denied.json()).toMatchObject({ code: 40400, data: null })
  const stopped = await app.inject({ method: 'DELETE', url: '/tasks/other', headers: { 'x-test-tenant': 'A' } })
  expect(stopped.json().data.cancelled).toBe(false)
  expect(await status('other')).toBe('pending')
  const own = await app.inject({ method: 'GET', url: '/tasks/other', headers: { 'x-test-tenant': 'B' } })
  expect(own.json().data).toMatchObject({ id: 'other', tenantId: 'B' })
})

it('HTTP rejects an unregistered type without creating a permanently pending record', async () => {
  const app = await server()
  const response = await app.inject({ method: 'POST', url: '/tasks', payload: { type: 'made-up', payload: {} } })
  expect(response.statusCode).toBe(501)
  expect(response.json().code).toBe(50100)
  expect(await queue().list('A')).toEqual([])
})

it('model tools cannot use exact fallback or an ambiguous prefix to reach foreign jobs', async () => {
  await insert('private', 'B'); await insert('shared-a'); await insert('shared-b')
  const { taskControlTools } = await import('../../../tools/task/task-tool.js')
  const context = { tenantId: 'A' } as AgentContext
  const read = taskControlTools.find(tool => tool.name === 'task_status')!
  const cancel = taskControlTools.find(tool => tool.name === 'task_cancel')!
  expect(await read.execute({ id: 'private' }, context)).toMatchObject({ success: false })
  expect(await cancel.execute({ id: 'private' }, context)).toMatchObject({ success: false })
  expect(await cancel.execute({ id: 'shared-' }, context)).toMatchObject({ success: false })
  expect(await status('shared-a')).toBe('pending'); expect(await status('shared-b')).toBe('pending')
  expect(await cancel.execute({ id: 'shared-a' }, context)).toMatchObject({ success: true })
  expect(await status('shared-a')).toBe('cancelled')
  expect(await status('private')).toBe('pending')
})
