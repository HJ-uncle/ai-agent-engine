import { vi } from 'vitest'
import { createClient } from '@libsql/client'
import type { Client } from '@libsql/client'

// ─── Setup in-memory DB ────────────────────────────────────────────────────────

let testDb: Client

vi.mock('../../sqlite/db.js', () => ({
  getDb: () => testDb,
}))

// Import after mock is set up
const { SQLiteCacheStore } = await import('../sqlite-cache.js')
const { generateCacheKey } = await import('../types.js')

// ─── Schema ───────────────────────────────────────────────────────────────────

const CREATE_CACHE = `
  CREATE TABLE IF NOT EXISTS cache (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
`

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SQLiteCacheStore', () => {
  beforeEach(async () => {
    testDb = createClient({ url: ':memory:' })
    await testDb.executeMultiple(CREATE_CACHE)
  })

  afterEach(() => {
    vi.useRealTimers()
    testDb.close()
  })

  // 1. set then get returns correct value
  it('set followed by get returns the stored value', async () => {
    const store = new SQLiteCacheStore()
    await store.set('foo', 'bar', 60)
    const value = await store.get('foo')
    expect(value).toBe('bar')
  })

  // 2. TTL expiry: get returns null after TTL elapses
  it('get returns null after TTL has expired', async () => {
    vi.useFakeTimers()
    const store = new SQLiteCacheStore()

    // Set with 30-second TTL
    await store.set('expiring-key', 'some-value', 30)

    // Advance time by 31 seconds
    vi.advanceTimersByTime(31_000)

    const value = await store.get('expiring-key')
    expect(value).toBeNull()
  })

  // 3. set same key twice → get returns latest value
  it('setting the same key twice returns the latest value', async () => {
    const store = new SQLiteCacheStore()
    await store.set('key', 'first', 60)
    await store.set('key', 'second', 60)
    const value = await store.get('key')
    expect(value).toBe('second')
  })

  // 4. delete → get returns null
  it('delete removes the key so get returns null', async () => {
    const store = new SQLiteCacheStore()
    await store.set('to-delete', 'hello', 60)
    await store.delete('to-delete')
    const value = await store.get('to-delete')
    expect(value).toBeNull()
  })

  // 5. generateCacheKey returns same hash for same inputs
  it('generateCacheKey returns the same hash for identical inputs', () => {
    const key1 = generateCacheKey('openai', 'gpt-4', 'Hello world')
    const key2 = generateCacheKey('openai', 'gpt-4', 'Hello world')
    expect(key1).toBe(key2)
    expect(key1).toHaveLength(64) // SHA-256 hex = 64 chars
  })

  // 6. generateCacheKey returns different hashes for different inputs
  it('generateCacheKey returns different hashes for different inputs', () => {
    const key1 = generateCacheKey('openai', 'gpt-4', 'Hello world')
    const key2 = generateCacheKey('openai', 'gpt-4o', 'Hello world')
    const key3 = generateCacheKey('anthropic', 'claude-3', 'Hello world')
    const key4 = generateCacheKey('openai', 'gpt-4', 'Different prompt')
    expect(key1).not.toBe(key2)
    expect(key1).not.toBe(key3)
    expect(key1).not.toBe(key4)
  })
})
