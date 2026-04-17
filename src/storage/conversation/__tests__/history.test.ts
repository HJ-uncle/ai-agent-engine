import { vi } from 'vitest'
import { createClient } from '@libsql/client'
import type { Client } from '@libsql/client'

// ─── Setup in-memory DB ────────────────────────────────────────────────────────

let testDb: Client

vi.mock('../../sqlite/db.js', () => ({
  getDb: () => testDb,
}))

// Import after mock is set up
const { SQLiteConversationHistory } = await import('../history.js')

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeCtx(tenantId = 'tenant-1', sessionId = 'session-1') {
  return {
    tenantId,
    sessionId,
    workspaceDir: '/tmp',
    tokenBudget: 100_000,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    tools: {} as never,
    memory: {} as never,
    history: {} as never,
  }
}

const CREATE_CONVERSATIONS = `
  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    tool_call_id TEXT,
    tool_name TEXT,
    tool_args TEXT,
    tokens INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_conversations_session
    ON conversations(tenant_id, session_id, created_at);
`

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SQLiteConversationHistory', () => {
  beforeEach(async () => {
    testDb = createClient({ url: ':memory:' })
    await testDb.executeMultiple(CREATE_CONVERSATIONS)
  })

  afterEach(() => {
    testDb.close()
  })

  // 1. append → getHistory returns messages in order
  it('append stores messages and getHistory returns them in insertion order', async () => {
    const history = new SQLiteConversationHistory()
    const ctx = makeCtx()

    await history.append({ role: 'user', content: 'Hello', tokens: 1 }, ctx)
    await history.append({ role: 'assistant', content: 'Hi there!', tokens: 2 }, ctx)

    const messages = await history.getHistory(ctx)

    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({ role: 'user', content: 'Hello' })
    expect(messages[1]).toMatchObject({ role: 'assistant', content: 'Hi there!' })
  })

  // 2. clear → getHistory returns empty array
  it('clear removes all messages so getHistory returns an empty array', async () => {
    const history = new SQLiteConversationHistory()
    const ctx = makeCtx()

    await history.append({ role: 'user', content: 'First message', tokens: 2 }, ctx)
    await history.clear(ctx)

    const messages = await history.getHistory(ctx)
    expect(messages).toHaveLength(0)
  })

  // 3. getTokenCount returns sum of tokens
  it('getTokenCount returns the sum of tokens across all messages', async () => {
    const history = new SQLiteConversationHistory()
    const ctx = makeCtx()

    await history.append({ role: 'user', content: 'Hello', tokens: 10 }, ctx)
    await history.append({ role: 'assistant', content: 'World', tokens: 25 }, ctx)
    await history.append({ role: 'user', content: 'Again', tokens: 5 }, ctx)

    const total = await history.getTokenCount(ctx)
    expect(total).toBe(40)
  })

  // 4. getTokenCount returns 0 when no messages
  it('getTokenCount returns 0 when there are no messages', async () => {
    const history = new SQLiteConversationHistory()
    const ctx = makeCtx()

    const total = await history.getTokenCount(ctx)
    expect(total).toBe(0)
  })

  // 5. different sessions don't interfere
  it('messages from different sessions are isolated', async () => {
    const history = new SQLiteConversationHistory()
    const ctxA = makeCtx('tenant-1', 'session-A')
    const ctxB = makeCtx('tenant-1', 'session-B')

    await history.append({ role: 'user', content: 'Session A message', tokens: 3 }, ctxA)
    await history.append({ role: 'user', content: 'Session B message', tokens: 4 }, ctxB)

    const messagesA = await history.getHistory(ctxA)
    const messagesB = await history.getHistory(ctxB)

    expect(messagesA).toHaveLength(1)
    expect(messagesA[0].content).toBe('Session A message')
    expect(messagesB).toHaveLength(1)
    expect(messagesB[0].content).toBe('Session B message')
  })

  // 6. different tenants don't interfere
  it('messages from different tenants are isolated', async () => {
    const history = new SQLiteConversationHistory()
    const ctxX = makeCtx('tenant-X', 'session-1')
    const ctxY = makeCtx('tenant-Y', 'session-1')

    await history.append({ role: 'user', content: 'Tenant X message', tokens: 5 }, ctxX)
    await history.append({ role: 'user', content: 'Tenant Y message', tokens: 6 }, ctxY)

    const messagesX = await history.getHistory(ctxX)
    const messagesY = await history.getHistory(ctxY)

    expect(messagesX).toHaveLength(1)
    expect(messagesX[0].content).toBe('Tenant X message')
    expect(messagesY).toHaveLength(1)
    expect(messagesY[0].content).toBe('Tenant Y message')

    expect(await history.getTokenCount(ctxX)).toBe(5)
    expect(await history.getTokenCount(ctxY)).toBe(6)
  })

  // 7. append tool message with toolCallId serializes correctly
  it('appends a tool result message with toolCallId and toolName correctly', async () => {
    const history = new SQLiteConversationHistory()
    const ctx = makeCtx()

    await history.append({
      role: 'tool',
      content: 'The result is 42',
      toolCallId: 'call-abc-123',
      toolName: 'calculator',
      tokens: 8,
    }, ctx)

    const messages = await history.getHistory(ctx)

    expect(messages).toHaveLength(1)
    const msg = messages[0]
    expect(msg.role).toBe('tool')
    expect(msg.content).toBe('The result is 42')
    expect(msg.toolCallId).toBe('call-abc-123')
    expect(msg.toolName).toBe('calculator')
  })

  // 8. append assistant message with toolCall args serializes and deserializes
  it('serializes and deserializes toolCall args for assistant messages', async () => {
    const history = new SQLiteConversationHistory()
    const ctx = makeCtx()

    await history.append({
      role: 'assistant',
      content: '',
      toolCall: {
        id: 'call-xyz',
        name: 'search',
        args: { query: 'vitest testing', limit: 5 },
      },
      toolCallId: 'call-xyz',
      toolName: 'search',
      tokens: 12,
    }, ctx)

    const messages = await history.getHistory(ctx)
    expect(messages).toHaveLength(1)
    const msg = messages[0]
    expect(msg.toolCall).toBeDefined()
    expect(msg.toolCall!.id).toBe('call-xyz')
    expect(msg.toolCall!.name).toBe('search')
    expect(msg.toolCall!.args).toMatchObject({ query: 'vitest testing', limit: 5 })
  })

  // 9. summarize collapses old messages and keeps last 4
  it('summarize replaces old messages with a summary and keeps last 4 messages', async () => {
    const history = new SQLiteConversationHistory()
    const ctx = makeCtx()

    // Insert 6 messages — first 2 should be summarized, last 4 kept
    for (let i = 1; i <= 6; i++) {
      await history.append({ role: 'user', content: `Message ${i}`, tokens: 5 }, ctx)
    }

    await history.summarize(ctx)

    const messages = await history.getHistory(ctx)

    // 1 summary message + 4 kept messages
    expect(messages).toHaveLength(5)
    expect(messages[0].role).toBe('system')
    expect(messages[0].content).toContain('Previous conversation summary')
    expect(messages[1].content).toBe('Message 3')
    expect(messages[4].content).toBe('Message 6')
  })

  // 10. summarize does nothing when <= 4 messages
  it('summarize is a no-op when 4 or fewer messages exist', async () => {
    const history = new SQLiteConversationHistory()
    const ctx = makeCtx()

    await history.append({ role: 'user', content: 'A', tokens: 1 }, ctx)
    await history.append({ role: 'assistant', content: 'B', tokens: 2 }, ctx)

    await history.summarize(ctx)

    const messages = await history.getHistory(ctx)
    expect(messages).toHaveLength(2)
  })
})
