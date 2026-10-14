// Real SQLite, two independent worker/connection owners, deterministic SQL barriers.
// getDb is confined to synthetic fixtures; no engine, model, or operator database starts.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Client, InArgs, InStatement, ResultSet, TransactionMode } from '@libsql/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalSqliteProcessClient } from '../../sqlite/local-process-client.js'
import { up as migrateAgents } from '../../sqlite/migrations/004_add_agents.js'
import { up as migrateTools } from '../../sqlite/migrations/008_add_agent_allowed_tools.js'
import { SQLiteAgentStore, type Agent, type CreateAgentInput } from '../index.js'

const selection = vi.hoisted(() => ({ getDb: vi.fn<() => Client>() }))
vi.mock('../../sqlite/db.js', () => ({ getDb: selection.getDb }))
const scope = new AsyncLocalStorage<Client>()
const store = new SQLiteAgentStore()
const clients: LocalSqliteProcessClient[] = []
const fixtures: string[] = []
interface Gate { entered: Promise<void>; release(): void; hold(): Promise<void> }
const gates: Gate[] = []
const operations: Promise<unknown>[] = []
const fixtureParent = path.resolve('.e2e-tmp', 'agent-atomic')

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
function gate(): Gate {
  const entered = deferred(), released = deferred()
  let used = false
  const value = {
    entered: entered.promise,
    release: released.resolve,
    async hold() {
      if (used) return
      used = true
      entered.resolve()
      await released.promise
    },
  }
  gates.push(value)
  return value
}
function run<T>(db: Client, operation: () => Promise<T>): Promise<T> {
  const promise = scope.run(db, operation)
  // Keep a rejection handler even if an assertion fails before the operation settles.
  operations.push(promise.then(() => undefined, () => undefined))
  return promise
}
interface Hook {
  before?(sql: string): Promise<void>
  after?(sql: string, result: ResultSet): Promise<void>
  begin?(mode: TransactionMode | undefined): Promise<void>
  rollback?(): Promise<void>
}
function sqlProxy<T extends Pick<Client, 'execute'>>(target: T, hook: Hook): T {
  return new Proxy(target, {
    get(owner, property) {
      if (property === 'execute') return async (statement: InStatement, args?: InArgs) => {
        const sql = typeof statement === 'string' ? statement : statement.sql
        await hook.before?.(sql)
        const result = typeof statement === 'string'
          ? await owner.execute(statement, args)
          : await owner.execute(statement)
        await hook.after?.(sql, result)
        return result
      }
      const value: unknown = Reflect.get(owner, property, owner)
      return typeof value === 'function' ? value.bind(owner) : value
    },
  })
}
function hookClient(db: Client, hook: Hook): Client {
  return new Proxy(sqlProxy(db, hook), {
    get(owner, property) {
      if (property === 'transaction') return async (mode?: TransactionMode) => {
        await hook.begin?.(mode)
        const tx = await db.transaction(mode)
        return new Proxy(sqlProxy(tx, hook), {
          get(transaction, key) {
            if (key === 'rollback' && hook.rollback) return async () => {
              await hook.rollback?.()
              return tx.rollback()
            }
            return Reflect.get(transaction, key, transaction)
          },
        })
      }
      return Reflect.get(owner, property, owner)
    },
  })
}
async function setup() {
  fs.mkdirSync(fixtureParent, { recursive: true })
  const root = fs.mkdtempSync(path.join(fixtureParent, 'fixture-'))
  fixtures.push(root)
  const url = pathToFileURL(path.join(root, 'agent.db')).href
  const a = new LocalSqliteProcessClient({ url }, { busyTimeoutMs: 1500 })
  clients.push(a)
  await a.execute('CREATE TABLE conversations(id TEXT PRIMARY KEY)')
  await migrateAgents(a)
  await migrateTools(a)
  const b = new LocalSqliteProcessClient({ url }, { busyTimeoutMs: 1500 })
  clients.push(b)
  await b.execute('SELECT 1')
  return { a, b }
}
const input = (tag: string): CreateAgentInput => ({
  name: tag, description: `description-${tag}`, systemPrompt: `prompt-${tag}`,
  model: `model-${tag}`, temperature: tag === 'A' ? 0 : 0.75,
  skills: [`skill-${tag}`], mcpServers: [`mcp-${tag}`],
  knowledgeBases: [`knowledge-${tag}`], allowedTools: [`tool-${tag}`],
})
function profile(agent: Agent | null): CreateAgentInput | null {
  if (!agent) return null
  const { id: _id, tenantId: _tenant, createdAt: _created, updatedAt: _updated, ...value } = agent
  return value
}
const byId = (db: Client, id: string, tenant = 'tenant') => run(db, () => store.getById(id, tenant))
const relationTables = ['agent_skills', 'agent_mcp', 'agent_knowledge', 'agent_allowed_tools']

beforeEach(() => {
  selection.getDb.mockImplementation(() => {
    const db = scope.getStore()
    if (!db) throw new Error('Agent test attempted to access an unowned database')
    return db
  })
})
afterEach(async () => {
  for (const barrier of gates.splice(0)) barrier.release()
  await Promise.all(operations.splice(0))
  for (const db of clients) db.close()
  await Promise.all(clients.splice(0).map(db => db.whenClosed()))
  for (const root of fixtures.splice(0)) {
    if (path.dirname(root) !== fixtureParent || !path.basename(root).startsWith('fixture-')) {
      throw new Error('Unsafe agent fixture cleanup')
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

describe('atomic Agent configuration', () => {
  it('updates second-resolution updatedAt for each explicit resource-only change, including empty arrays', async () => {
    const { a } = await setup()
    const old = await run(a, () => store.create('tenant', input('A')))
    for (const field of ['skills', 'mcpServers', 'knowledgeBases', 'allowedTools'] as const) {
      await a.execute('UPDATE agents SET updated_at = 1 WHERE id = ?', [old.id])
      const changed = await run(a, () => store.update(old.id, 'tenant', { [field]: [] }))
      expect(changed?.updatedAt).toBeGreaterThan(1000)
      expect((changed?.updatedAt ?? 1) % 1000).toBe(0)
      expect(changed?.[field]).toEqual([])
      expect(changed?.name).toBe('A')
    }
    await a.execute('UPDATE agents SET updated_at = 1 WHERE id = ?', [old.id])
    expect((await run(a, () => store.update(old.id, 'tenant', {})))?.updatedAt).toBe(1000)
  })

  it('keeps public fields, zero temperature, empty resource arrays, and tenant-scoped list', async () => {
    const { a } = await setup()
    const first = await run(a, () => store.create('tenant', input('A')))
    expect(profile(first)).toEqual(input('A'))
    expect(first.createdAt).toBeGreaterThan(0)
    expect(first.updatedAt).toBeGreaterThan(0)
    await run(a, () => store.create('other', input('other')))
    const changed = await run(a, () => store.update(first.id, 'tenant', { name: 'renamed', skills: [], temperature: 0 }))
    expect(profile(changed)).toEqual({ ...input('A'), name: 'renamed', skills: [] })
    expect((await run(a, () => store.list('tenant'))).map(agent => agent.id)).toEqual([first.id])
  })

  it('does not expose a half-created profile from another connection', async () => {
    const { a, b } = await setup()
    const barrier = gate()
    const writer = hookClient(a, { after: async sql => { if (sql.startsWith('INSERT INTO agents ')) await barrier.hold() } })
    const pending = run(writer, () => store.create('tenant', input('A')))
    await barrier.entered
    expect(await run(b, () => store.list('tenant'))).toEqual([])
    barrier.release()
    const created = await pending
    expect(profile(await byId(b, created.id))).toEqual(input('A'))
  })

  it('does not expose new main fields with old resource bindings during update', async () => {
    const { a, b } = await setup()
    const old = await run(a, () => store.create('tenant', input('A')))
    const barrier = gate()
    const writer = hookClient(a, { after: async sql => { if (sql.startsWith('UPDATE agents SET')) await barrier.hold() } })
    const pending = run(writer, () => store.update(old.id, 'tenant', input('B')))
    await barrier.entered
    expect(profile(await byId(b, old.id))).toEqual(input('A'))
    barrier.release()
    expect(profile(await pending)).toEqual(input('B'))
    expect(profile(await byId(b, old.id))).toEqual(input('B'))
  })

  it('reads main fields and all four bindings from the same getById snapshot', async () => {
    const { a, b } = await setup()
    const old = await run(a, () => store.create('tenant', input('A')))
    const barrier = gate()
    const reader = hookClient(a, { after: async sql => { if (sql.startsWith('SELECT * FROM agents WHERE id')) await barrier.hold() } })
    const pending = byId(reader, old.id)
    await barrier.entered
    expect(profile(await run(b, () => store.update(old.id, 'tenant', input('B'))))).toEqual(input('B'))
    barrier.release()
    expect(profile(await pending)).toEqual(input('A'))
    expect(profile(await byId(a, old.id))).toEqual(input('B'))
  })

  it('reads list main fields and bulk bindings from one snapshot', async () => {
    const { a, b } = await setup()
    const old = await run(a, () => store.create('tenant', input('A')))
    const barrier = gate()
    const reader = hookClient(a, { after: async sql => { if (sql.startsWith('SELECT * FROM agents WHERE tenant_id')) await barrier.hold() } })
    const pending = run(reader, () => store.list('tenant'))
    await barrier.entered
    await run(b, () => store.update(old.id, 'tenant', input('B')))
    barrier.release()
    expect((await pending).map(profile)).toEqual([input('A')])
  })

  it('rolls back creation if the second resource group rejects its insert', async () => {
    const { a, b } = await setup()
    await expect(run(a, () => store.create('tenant', { ...input('A'), mcpServers: ['duplicate', 'duplicate'] })))
      .rejects.toMatchObject({ code: expect.stringContaining('SQLITE_CONSTRAINT') })
    expect(await run(b, () => store.list('tenant'))).toEqual([])
    for (const table of relationTables) expect((await b.execute(`SELECT count(*) AS n FROM ${table}`)).rows[0].n).toBe(0)
    expect(profile(await run(a, () => store.create('tenant', input('B'))))).toEqual(input('B'))
  })

  it('rolls back scalar and first resource group changes when a later group fails', async () => {
    const { a, b } = await setup()
    const old = await run(a, () => store.create('tenant', input('A')))
    await expect(run(a, () => store.update(old.id, 'tenant', { ...input('B'), mcpServers: ['duplicate', 'duplicate'] })))
      .rejects.toMatchObject({ code: expect.stringContaining('SQLITE_CONSTRAINT') })
    expect(profile(await byId(b, old.id))).toEqual(input('A'))
    expect(profile(await run(a, () => store.update(old.id, 'tenant', input('B'))))).toEqual(input('B'))
  })

  it('rolls back a failure at the last resource group too', async () => {
    const { a, b } = await setup()
    const old = await run(a, () => store.create('tenant', input('A')))
    await a.execute("CREATE TRIGGER reject_tool BEFORE INSERT ON agent_allowed_tools WHEN NEW.tool_name = 'reject' BEGIN SELECT RAISE(ABORT, 'injected final binding failure'); END")
    await expect(run(a, () => store.update(old.id, 'tenant', { ...input('B'), allowedTools: ['reject'] })))
      .rejects.toThrow('injected final binding failure')
    expect(profile(await byId(b, old.id))).toEqual(input('A'))
    await a.execute('DROP TRIGGER reject_tool')
    expect(profile(await run(a, () => store.update(old.id, 'tenant', { allowedTools: ['after-rollback'] })))).toEqual({ ...input('A'), allowedTools: ['after-rollback'] })
  })

  it('preserves concurrent partial scalar and binding updates from two connections', async () => {
    const { a, b } = await setup()
    const old = await run(a, () => store.create('tenant', input('A')))
    const barrier = gate(), requested = deferred()
    const writerA = hookClient(a, { after: async sql => { if (sql.startsWith('SELECT * FROM agents WHERE id')) await barrier.hold() } })
    const writerB = hookClient(b, { begin: async () => { requested.resolve() }, before: async sql => { if (sql.startsWith('SELECT * FROM agents WHERE id')) requested.resolve() } })
    const first = run(writerA, () => store.update(old.id, 'tenant', { name: 'writer-A', skills: ['skills-A'] }))
    await barrier.entered
    const second = run(writerB, () => store.update(old.id, 'tenant', { description: 'writer-B', mcpServers: ['mcp-B'] }))
    await requested.promise
    barrier.release()
    await Promise.all([first, second])
    expect(profile(await byId(a, old.id))).toEqual({ ...input('A'), name: 'writer-A', description: 'writer-B', skills: ['skills-A'], mcpServers: ['mcp-B'] })
  })

  it('serializes simultaneous writers while keeping each full replacement coherent', async () => {
    const { a, b } = await setup()
    const old = await run(a, () => store.create('tenant', input('A')))
    const returned = await Promise.all([
      run(a, () => store.update(old.id, 'tenant', input('B'))),
      run(b, () => store.update(old.id, 'tenant', input('C'))),
    ])
    expect(returned.map(profile)).toEqual([input('B'), input('C')])
    expect([input('B'), input('C')]).toContainEqual(profile(await byId(a, old.id)))
  })

  it('uses ordered last-writer-wins for an explicitly supplied same field, without revision/CAS', async () => {
    const { a, b } = await setup()
    const old = await run(a, () => store.create('tenant', input('A')))
    const barrier = gate(), requested = deferred()
    const writerA = hookClient(a, { after: async sql => { if (sql.startsWith('SELECT * FROM agents WHERE id')) await barrier.hold() } })
    const writerB = hookClient(b, { begin: async () => { requested.resolve() }, before: async sql => { if (sql.startsWith('SELECT * FROM agents WHERE id')) requested.resolve() } })
    const first = run(writerA, () => store.update(old.id, 'tenant', { name: 'first' }))
    await barrier.entered
    const second = run(writerB, () => store.update(old.id, 'tenant', { name: 'second' }))
    await requested.promise
    barrier.release()
    expect((await first)?.name).toBe('first')
    expect((await second)?.name).toBe('second')
    expect((await byId(a, old.id))?.name).toBe('second')
    // A UI sending all fields from an older snapshot explicitly replaces them.
    // Preventing this requires a future public expectedRevision/CAS contract.
    expect(profile(await run(a, () => store.update(old.id, 'tenant', input('A'))))).toEqual(input('A'))
  })

  it('preserves the primary failure and secondary rollback diagnostic when rollback cannot be confirmed', async () => {
    const { a, b } = await setup()
    const old = await run(a, () => store.create('tenant', input('A')))
    const secondary = new Error('injected rollback transport failure')
    const writer = hookClient(a, { rollback: async () => { throw secondary } })
    await expect(run(writer, () => store.update(old.id, 'tenant', { ...input('B'), mcpServers: ['duplicate', 'duplicate'] })))
      .rejects.toMatchObject({
        message: 'Agent configuration transaction failed; rollback was not confirmed',
        cause: { code: expect.stringContaining('SQLITE_CONSTRAINT') },
        errors: [expect.objectContaining({ code: expect.stringContaining('SQLITE_CONSTRAINT') }), secondary],
      })
    // The finally-close release is separately observed by a subsequent query.
    expect(profile(await byId(a, old.id))).toEqual(input('A'))
    expect(profile(await byId(b, old.id))).toEqual(input('A'))
  })

  it('returns its own committed configuration even if another writer immediately follows', async () => {
    const { a, b } = await setup()
    const old = await run(a, () => store.create('tenant', input('A')))
    const barrier = gate(), requested = deferred()
    const writerA = hookClient(a, { after: async sql => { if (sql.startsWith('INSERT INTO agent_allowed_tools ')) await barrier.hold() } })
    const writerB = hookClient(b, { begin: async () => { requested.resolve() }, before: async sql => { if (sql.startsWith('SELECT * FROM agents WHERE id')) requested.resolve() } })
    const first = run(writerA, () => store.update(old.id, 'tenant', input('B')))
    await barrier.entered
    const second = run(writerB, () => store.update(old.id, 'tenant', input('C')))
    await requested.promise
    barrier.release()
    expect(profile(await first)).toEqual(input('B'))
    expect(profile(await second)).toEqual(input('C'))
    expect(profile(await byId(a, old.id))).toEqual(input('C'))
  })

  it('makes wrong-tenant and missing updates/deletes inert, and deletes all bindings by cascade', async () => {
    const { a, b } = await setup()
    const old = await run(a, () => store.create('tenant', input('A')))
    expect(await byId(b, old.id, 'other')).toBeNull()
    expect(await run(b, () => store.update(old.id, 'other', input('B')))).toBeNull()
    expect(await run(b, () => store.delete(old.id, 'other'))).toBe(false)
    expect(await run(b, () => store.update('absent', 'tenant', input('B')))).toBeNull()
    expect(await run(b, () => store.delete('absent', 'tenant'))).toBe(false)
    expect(profile(await byId(a, old.id))).toEqual(input('A'))
    expect(await run(b, () => store.delete(old.id, 'tenant'))).toBe(true)
    expect(await byId(a, old.id)).toBeNull()
    for (const table of relationTables) expect((await a.execute(`SELECT count(*) AS n FROM ${table} WHERE agent_id = ?`, [old.id])).rows[0].n).toBe(0)
  })

  it('keeps an in-flight read coherent when another connection deletes the agent', async () => {
    const { a, b } = await setup()
    const old = await run(a, () => store.create('tenant', input('A')))
    const barrier = gate()
    const reader = hookClient(a, { after: async sql => { if (sql.startsWith('SELECT * FROM agents WHERE id')) await barrier.hold() } })
    const pending = byId(reader, old.id)
    await barrier.entered
    expect(await run(b, () => store.delete(old.id, 'tenant'))).toBe(true)
    barrier.release()
    expect(profile(await pending)).toEqual(input('A'))
    expect(await byId(a, old.id)).toBeNull()
  })

  it('orders delete after an in-flight update without resurrecting orphan bindings', async () => {
    const { a, b } = await setup()
    const old = await run(a, () => store.create('tenant', input('A')))
    const barrier = gate(), requested = deferred()
    const writer = hookClient(a, { after: async sql => { if (sql.startsWith('SELECT * FROM agents WHERE id')) await barrier.hold() } })
    const remover = hookClient(b, { begin: async () => { requested.resolve() }, before: async sql => { if (sql.startsWith('DELETE FROM agents ')) requested.resolve() } })
    const update = run(writer, () => store.update(old.id, 'tenant', input('B')))
    await barrier.entered
    const removal = run(remover, () => store.delete(old.id, 'tenant'))
    await requested.promise
    barrier.release()
    expect(profile(await update)).toEqual(input('B'))
    expect(await removal).toBe(true)
    expect(await byId(a, old.id)).toBeNull()
    for (const table of relationTables) expect((await a.execute(`SELECT count(*) AS n FROM ${table}`)).rows[0].n).toBe(0)
  })
})
