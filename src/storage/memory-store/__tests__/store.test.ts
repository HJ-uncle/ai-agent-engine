import { vi } from 'vitest'
import { createClient } from '@libsql/client'
import type { Client } from '@libsql/client'

// ─── Setup in-memory DB ────────────────────────────────────────────────────────

let testDb: Client

vi.mock('../../sqlite/db.js', () => ({
  getDb: () => testDb,
}))

// Import after mock is set up
const { SQLiteMemoryStore } = await import('../store.js')

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeCtx(tenantId = 'tenant-1', sessionId = 'session-1') {
  return { tenantId, sessionId }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SQLiteMemoryStore', () => {
  beforeEach(async () => {
    testDb = createClient({ url: ':memory:' })
    await testDb.executeMultiple(`
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL DEFAULT 'default',
        session_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE(tenant_id, session_id, key)
      );
      CREATE INDEX IF NOT EXISTS idx_memories_session
        ON memories(tenant_id, session_id);
    `)
  })

  afterEach(() => {
    testDb.close()
  })

  // 1. remember → recall returns correct value
  it('remember stores a value that recall can retrieve', async () => {
    const store = new SQLiteMemoryStore()
    const ctx = makeCtx()

    await store.remember('username', 'alice', ctx)
    const result = await store.recall('username', ctx)

    expect(result).toBe('alice')
  })

  // 2. recall of non-existent key returns null
  it('recall returns null for an unknown key', async () => {
    const store = new SQLiteMemoryStore()
    const ctx = makeCtx()

    const result = await store.recall('nonexistent', ctx)

    expect(result).toBeNull()
  })

  // 3. list returns all keys
  it('list returns all stored keys', async () => {
    const store = new SQLiteMemoryStore()
    const ctx = makeCtx()

    await store.remember('key-a', 'value-a', ctx)
    await store.remember('key-b', 'value-b', ctx)
    await store.remember('key-c', 'value-c', ctx)

    const keys = await store.list(ctx)

    expect(keys).toHaveLength(3)
    expect(keys).toEqual(expect.arrayContaining(['key-a', 'key-b', 'key-c']))
  })

  // 4. forget → recall returns null
  it('forget removes the key so recall returns null', async () => {
    const store = new SQLiteMemoryStore()
    const ctx = makeCtx()

    await store.remember('temp', 'ephemeral', ctx)
    await store.forget('temp', ctx)
    const result = await store.recall('temp', ctx)

    expect(result).toBeNull()
  })

  // 5. remember same key twice → recall returns latest value
  it('remember with same key twice updates to the latest value', async () => {
    const store = new SQLiteMemoryStore()
    const ctx = makeCtx()

    await store.remember('counter', '1', ctx)
    await store.remember('counter', '42', ctx)
    const result = await store.recall('counter', ctx)

    expect(result).toBe('42')
  })

  // 6. different session_id memories don't interfere
  it('memories from different sessions are isolated', async () => {
    const store = new SQLiteMemoryStore()
    const ctxA = makeCtx('tenant-1', 'session-A')
    const ctxB = makeCtx('tenant-1', 'session-B')

    await store.remember('shared-key', 'session-A-value', ctxA)
    await store.remember('shared-key', 'session-B-value', ctxB)

    expect(await store.recall('shared-key', ctxA)).toBe('session-A-value')
    expect(await store.recall('shared-key', ctxB)).toBe('session-B-value')
  })

  // 7. different tenant_id memories don't interfere
  it('memories from different tenants are isolated', async () => {
    const store = new SQLiteMemoryStore()
    const ctxX = makeCtx('tenant-X', 'session-1')
    const ctxY = makeCtx('tenant-Y', 'session-1')

    await store.remember('shared-key', 'tenant-X-value', ctxX)
    await store.remember('shared-key', 'tenant-Y-value', ctxY)

    expect(await store.recall('shared-key', ctxX)).toBe('tenant-X-value')
    expect(await store.recall('shared-key', ctxY)).toBe('tenant-Y-value')

    const keysX = await store.list(ctxX)
    const keysY = await store.list(ctxY)
    expect(keysX).toHaveLength(1)
    expect(keysY).toHaveLength(1)
  })
})
