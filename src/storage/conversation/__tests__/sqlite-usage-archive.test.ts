import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Client } from '@libsql/client'
import { LocalSqliteProcessClient } from '../../sqlite/local-process-client.js'
import * as database from '../../sqlite/db.js'
import { up as createConversations } from '../../sqlite/migrations/001_initial.js'
import { up as createSessions } from '../../sqlite/migrations/009_add_sessions.js'
import { SQLiteConversationHistory } from '../history.js'
import { JSONLConversationHistory } from '../jsonl-history.js'
import type { Message } from '../../../core/agent-context/types.js'

vi.mock('../../../core/subagent/store.js', () => ({ getSubagentStore: () => ({ listChildSessionIds: async () => [] }) }))
let db: Client, fixture: string
const ctx = { tenantId: 'billing-tenant', sessionId: 'billing-session' }
const call = (id: string, turn: string, tokens: number): Message & { conversationId: string } => ({
  id, conversationId: turn, role: 'assistant', content: 'verified ' + id,
  usage: { promptTokens: tokens, completionTokens: 2, totalTokens: tokens + 2, currentPromptTokens: 90_000, contextWindow: 100_000 },
})
beforeEach(async () => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-sqlite-usage-'))
  vi.stubEnv('DATA_DIR', path.join(fixture, 'agent.db'))
  db = new LocalSqliteProcessClient({ url: `file:${path.join(fixture, 'agent.db')}` })
  vi.spyOn(database, 'getDb').mockReturnValue(db)
  await createConversations(db)
  await createSessions(db)
  await db.execute('ALTER TABLE sessions ADD COLUMN metadata TEXT')
  for (const column of ['message_id', 'model_id', 'reasoning_content', 'metadata']) await db.execute(`ALTER TABLE conversations ADD COLUMN ${column} TEXT`)
})
afterEach(async () => {
  db?.close(); await (db as LocalSqliteProcessClient).whenClosed(); vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (path.dirname(fixture) !== path.resolve(os.tmpdir()) || !path.basename(fixture).startsWith('aether-sqlite-usage-')) throw new Error('Unsafe usage cleanup')
  fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
})
async function seed(history: SQLiteConversationHistory) {
  await history.append({ id: 'u-old', role: 'user', content: 'old task', conversationId: 'old' }, ctx)
  await history.append(call('old-call', 'old', 10), ctx)
  await history.append({ id: 'u-new', role: 'user', content: 'new task', conversationId: 'new' }, ctx)
  await history.append(call('new-call', 'new', 20), ctx)
}

describe('SQLite retained billing archive', () => {
  it('keeps billed orphan prefixes through history cleanup and JSONL migration', async () => {
    const history = new SQLiteConversationHistory()
    await history.append(call('orphan', 'orphan-turn', 10), ctx)
    await history.append({ id: 'first-user', role: 'user', content: 'new task', conversationId: 'new' }, ctx)
    await history.append(call('new-call', 'new', 20), ctx)
    const before = await history.getSessionUsage(ctx)
    expect((await history.getFullHistory(ctx)).map(item => item.id)).toEqual(['first-user', 'new-call'])
    expect(await history.getSessionUsage(ctx)).toEqual(before)
    expect(await history.getSessionUsage(ctx, 'orphan-turn')).toMatchObject({ totalTokens: 12 })
    const jsonl = new JSONLConversationHistory()
    expect(await jsonl.getSessionUsage(ctx)).toEqual(before)
    expect((await jsonl.getArchive(ctx)).messages.map(item => item.id)).toEqual(['first-user', 'new-call'])
  })

  it('assigns stable legacy IDs before retaining and archiving the same call', async () => {
    await db.execute({ sql: `INSERT INTO conversations (tenant_id, session_id, conversation_id, role, content, token_usage)
      VALUES (?, ?, 'old', 'assistant', 'legacy answer', '{"promptTokens":10,"completionTokens":2}')`, args: [ctx.tenantId, ctx.sessionId] })
    const history = new SQLiteConversationHistory()
    const before = await history.getSessionUsage(ctx)
    await history.append({ id: 'user-new', role: 'user', content: 'follow up', conversationId: 'new' }, ctx)
    await history.append(call('new-call', 'new', 20), ctx)
    await history.compress(ctx, async () => 'summary', 1)
    await history.compress(ctx, async () => 'summary again', 1)
    expect(before).toMatchObject({ totalTokens: 12 })
    expect(await history.getSessionUsage(ctx)).toMatchObject({ totalTokens: 34 })
    expect((await history.getArchivedUsage(ctx))[0].messageId).toMatch(/^legacy-sqlite-[a-f0-9]+$/)
  })

  it('derives legacy missing totals only from stored input and output usage', async () => {
    const history = new SQLiteConversationHistory()
    await history.append({ id: 'legacy', role: 'assistant', content: 'old answer', tokens: 10_000,
      conversationId: 'legacy-turn', usage: { promptTokens: 10, completionTokens: 2 } }, ctx)
    expect(await history.getSessionUsage(ctx)).toMatchObject({ promptTokens: 10, completionTokens: 2, totalTokens: 12 })
    expect(await history.getSessionUsage(ctx, 'legacy-turn')).toMatchObject({ totalTokens: 12 })
  })

  it('preserves total and per-turn usage across repeated compaction, list views and restart', async () => {
    const history = new SQLiteConversationHistory()
    await seed(history)
    await history.append(call('foreign', 'old', 100), { ...ctx, tenantId: 'other-tenant' })
    await history.append(call('other-session', 'old', 200), { ...ctx, sessionId: 'other-session' })
    const before = await history.getSessionUsage(ctx)
    await history.compress(ctx, async () => 'old work retained', 2)
    await history.compress(ctx, async () => 'new compact summary', 1)
    const restarted = new SQLiteConversationHistory()
    expect(await restarted.getSessionUsage(ctx)).toEqual(before)
    expect(await restarted.getUsageTotals(ctx, 'old')).toMatchObject({
      sessionUsage: { promptTokens: 30, completionTokens: 4, totalTokens: 34 },
      turnUsage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
    })
    expect((await restarted.listSessions(ctx.tenantId)).find(item => item.sessionId === ctx.sessionId)?.totalUsage).toEqual(before)
    expect(before.currentPromptTokens).toBeUndefined()
    await restarted.append(call('old-call', 'old', 1000), ctx)
    expect(await restarted.getSessionUsage(ctx)).toEqual(before)
  })

  it('clears deleted archived calls and turns without touching another tenant', async () => {
    const history = new SQLiteConversationHistory()
    await seed(history)
    await history.append(call('old-call', 'old', 100), { ...ctx, tenantId: 'other-tenant' })
    await history.compress(ctx, async () => 'summary', 1)
    await history.deleteMessage('old-call', ctx.tenantId)
    expect(await history.getSessionUsage(ctx)).toMatchObject({ totalTokens: 22 })
    expect(await history.getSessionUsage({ ...ctx, tenantId: 'other-tenant' })).toMatchObject({ totalTokens: 102 })
    await history.deleteByConversationId('new', ctx.tenantId)
    expect(await history.getSessionUsage(ctx)).toMatchObject({ totalTokens: 0 })
    await history.clear(ctx, { tombstone: false })
    expect(await history.getArchivedUsage(ctx)).toEqual([])
  })

  it('does not resurrect a truncated retained call from its compaction receipt', async () => {
    const history = new SQLiteConversationHistory()
    await seed(history)
    await history.compress(ctx, async () => 'summary', 2)
    const anchor = await history.getMessageById('u-new', ctx.tenantId)
    await history.deleteMessagesAfterId(anchor!.dbId, ctx.sessionId, ctx.tenantId)
    expect(await history.getSessionUsage(ctx)).toMatchObject({ totalTokens: 12 })
    expect(await history.getSessionUsage(ctx, 'new')).toMatchObject({ totalTokens: 0 })
  })

  it('rolls back both archive and context when the summary write fails', async () => {
    const history = new SQLiteConversationHistory()
    await seed(history)
    const before = await history.getSessionUsage(ctx)
    await db.execute(`CREATE TRIGGER reject_summary BEFORE INSERT ON conversations WHEN NEW.role='system'
      BEGIN SELECT RAISE(ABORT, 'summary failure'); END`)
    await expect(history.compress(ctx, async () => 'summary', 1)).rejects.toThrow('summary failure')
    expect((await history.getFullHistory(ctx)).map(item => item.id)).toEqual(['u-old', 'old-call', 'u-new', 'new-call'])
    expect(await history.getSessionUsage(ctx)).toEqual(before)
    expect(await history.getArchivedUsage(ctx)).toEqual([])
  })

  it('migrates compacted call receipts to JSONL billing without adding them to context or user history', async () => {
    const history = new SQLiteConversationHistory()
    await seed(history)
    const before = await history.getSessionUsage(ctx)
    await history.compress(ctx, async () => 'summary', 1)
    const jsonl = new JSONLConversationHistory()
    expect(await jsonl.getSessionUsage(ctx)).toEqual(before)
    expect(await jsonl.getSessionUsage(ctx, 'old')).toMatchObject({ totalTokens: 12 })
    expect((await jsonl.getFullHistory(ctx)).some(item => item.id === 'old-call')).toBe(false)
    expect((await jsonl.getArchive(ctx)).messages.some(item => item.id === 'old-call')).toBe(false)
    await jsonl.deleteByConversationId('old', ctx.tenantId)
    expect(await jsonl.getSessionUsage(ctx)).toMatchObject({ totalTokens: 22 })
  })
})
