import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalSqliteProcessClient } from '../../sqlite/local-process-client.js'
import * as database from '../../sqlite/db.js'
import { up as createConversations } from '../../sqlite/migrations/001_initial.js'
import { JSONLConversationHistory } from '../jsonl-history.js'
import { SQLiteConversationHistory } from '../history.js'
import type { Message } from '../../../core/agent-context/types.js'

type StoredMessage = Message & { conversationId?: string }
const append = (history: JSONLConversationHistory, message: StoredMessage, ctx: { tenantId: string; sessionId: string }) => history.append(message, ctx)

let fixture: string
let db: LocalSqliteProcessClient
beforeEach(async () => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-jsonl-usage-'))
  vi.stubEnv('DATA_DIR', path.join(fixture, 'agent.db'))
  db = new LocalSqliteProcessClient({ url: `file:${path.join(fixture, 'agent.db').replace(/\\/g, '/')}` })
  vi.spyOn(database, 'getDb').mockReturnValue(db)
  await createConversations(db)
  for (const column of ['message_id', 'model_id', 'reasoning_content', 'metadata']) {
    await db.execute(`ALTER TABLE conversations ADD COLUMN ${column} TEXT`)
  }
})
afterEach(async () => {
  db?.close()
  if (db) await db.whenClosed()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  if (path.dirname(fixture) !== path.resolve(os.tmpdir()) || !path.basename(fixture).startsWith('aether-jsonl-usage-')) {
    throw new Error('Unsafe usage fixture cleanup')
  }
  fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
})

describe('retained provider billing usage', () => {
  it('matches SQLite without mixing message estimates or current context into billing', async () => {
    const jsonl = new JSONLConversationHistory(), sqlite = new SQLiteConversationHistory()
    const ctx = { tenantId: 'usage-tenant', sessionId: 'usage-session' }
    const messages: StoredMessage[] = [
      { id: 'unmetered', role: 'user' as const, content: 'estimate only', tokens: 9_000, conversationId: 'turn-1' },
      { id: 'first', role: 'assistant' as const, content: 'first response', tokens: 7, conversationId: 'turn-1',
        usage: { promptTokens: 30, completionTokens: 7, totalTokens: 37, currentPromptTokens: 30_000,
          contextWindow: 100_000, systemPromptTokens: 10, skillTokens: 2, toolResultsTokens: 8, cacheHitTokens: 4 } },
      { id: 'second', role: 'assistant' as const, content: 'second response', tokens: 3, conversationId: 'turn-2',
        usage: { promptTokens: 40, completionTokens: 3, totalTokens: 43, currentPromptTokens: 10_000,
          contextWindow: 100_000, systemPromptTokens: 10, skillTokens: 2, toolResultsTokens: 18, reasoningTokens: 2 } },
    ]
    for (const message of messages) { await jsonl.append(message, ctx); await sqlite.append(message, ctx) }
    const usage = await jsonl.getSessionUsage(ctx)
    expect(usage).toEqual(await sqlite.getSessionUsage(ctx))
    expect(usage).toMatchObject({ promptTokens: 70, completionTokens: 10, totalTokens: 80, cacheHitTokens: 4, reasoningTokens: 2 })
    expect(usage.currentPromptTokens).toBeUndefined()
    expect(usage.contextWindow).toBeUndefined()
    expect(await jsonl.getSessionUsage(ctx, 'turn-1')).toEqual(await sqlite.getSessionUsage(ctx, 'turn-1'))
    expect(await jsonl.getSessionUsage(ctx, 'turn-1')).toMatchObject({ promptTokens: 30, totalTokens: 37 })
  })

  it('preserves all call increments across repeated compression, micro-compaction and restart', async () => {
    const history = new JSONLConversationHistory()
    const ctx = { tenantId: 'usage-tenant', sessionId: 'compressed-usage' }
    for (let index = 0; index < 12; index++) {
      await history.append({ id: `question-${index}`, role: 'user', content: `question ${index}`, tokens: 2 }, ctx)
      await append(history, { id: `answer-${index}`, role: 'assistant', content: `answer ${index}`, tokens: 3,
        conversationId: index < 6 ? 'turn-old' : 'turn-new', usage: { promptTokens: 10, completionTokens: 3, totalTokens: 13 } }, ctx)
      await history.append({ id: `tool-${index}`, role: 'tool', content: 'large tool output '.repeat(200), tokens: 700 }, ctx)
    }
    const before = await history.getSessionUsage(ctx)
    expect(before).toMatchObject({ promptTokens: 120, completionTokens: 36, totalTokens: 156 })
    await history.microCompactToolResults(ctx, { keepRecent: 1, maxChars: 1 })
    await history.compress(ctx, async () => 'completed earlier steps', 4)
    await history.compress(ctx, async () => 'completed earlier steps again', 2)
    expect((await history.getFullHistory(ctx)).length).toBeLessThan(36)
    expect(await history.getSessionUsage(ctx)).toEqual(before)
    const restarted = new JSONLConversationHistory()
    expect(await restarted.getSessionUsage(ctx)).toEqual(before)
    expect(await restarted.getSessionUsage(ctx, 'turn-old')).toMatchObject({ promptTokens: 60, totalTokens: 78 })
    expect((await restarted.listSessions(ctx.tenantId))[0].totalUsage).toEqual(before)
  })

  it('honors deletions and isolates same turn IDs across sessions and tenants', async () => {
    const history = new JSONLConversationHistory()
    const ctx = { tenantId: 'usage-tenant', sessionId: 'isolated' }
    for (const target of [ctx, { ...ctx, sessionId: 'other' }, { ...ctx, tenantId: 'other-tenant' }]) {
      await append(history, { id: `answer-${target.tenantId}-${target.sessionId}`, role: 'assistant', content: 'metered', tokens: 5,
        conversationId: 'same-turn', usage: { promptTokens: 25, completionTokens: 5, totalTokens: 30 } }, target)
    }
    await history.append({ id: 'unmetered', role: 'user', content: 'legacy row', tokens: 999 }, ctx)
    await history.compress(ctx, async () => 'summary', 1)
    expect(await history.getSessionUsage(ctx, 'same-turn')).toMatchObject({ totalTokens: 30 })
    await history.deleteMessage('answer-usage-tenant-isolated', ctx.tenantId)
    expect(await history.getSessionUsage(ctx)).toMatchObject({ promptTokens: 0, completionTokens: 0, totalTokens: 0 })
    expect(await history.getSessionUsage({ ...ctx, sessionId: 'other' })).toMatchObject({ totalTokens: 30 })
    await history.clear(ctx)
    expect(await new JSONLConversationHistory().getSessionUsage(ctx)).toMatchObject({ totalTokens: 0 })
  })

  it('reuses stable archive totals, advances normal appends and refreshes external writes', async () => {
    const history = new JSONLConversationHistory()
    const ctx = { tenantId: 'usage-tenant', sessionId: 'usage-cache' }
    await append(history, { id: 'first', role: 'assistant', content: 'first', conversationId: 'turn-a',
      usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 } }, ctx)
    const reads = vi.spyOn(fs, 'createReadStream')
    const initial = await history.getSessionUsage(ctx)
    expect(initial.totalTokens).toBe(12)
    await history.getSessionUsage(ctx, 'turn-a')
    const initialReads = reads.mock.calls.length
    expect(initialReads).toBeGreaterThan(0)
    // A UI cannot mutate the shared billing cache through a returned object.
    initial.totalTokens = 999
    expect((await history.getSessionUsage(ctx)).totalTokens).toBe(12)
    await append(history, { id: 'second', role: 'assistant', content: 'second', conversationId: 'turn-b',
      usage: { promptTokens: 20, completionTokens: 4, totalTokens: 24 } }, ctx)
    expect((await history.getSessionUsage(ctx)).totalTokens).toBe(36)
    expect((await history.getSessionUsage(ctx, 'turn-a')).totalTokens).toBe(12)
    expect(reads.mock.calls.length).toBe(initialReads)
    const otherWriter = new JSONLConversationHistory()
    await append(otherWriter, { id: 'third', role: 'assistant', content: 'external append', conversationId: 'turn-a',
      usage: { promptTokens: 30, completionTokens: 6, totalTokens: 36 } }, ctx)
    expect((await history.getSessionUsage(ctx)).totalTokens).toBe(72)
    expect(reads.mock.calls.length).toBeGreaterThan(initialReads)
    expect((await history.getSessionUsage(ctx, 'turn-a')).totalTokens).toBe(48)
    await otherWriter.deleteMessage('first', ctx.tenantId)
    expect((await history.getSessionUsage(ctx)).totalTokens).toBe(60)
  })

  it('retains older provider counters without a total field while leaving unmetered rows at zero', async () => {
    const history = new JSONLConversationHistory()
    const ctx = { tenantId: 'usage-tenant', sessionId: 'legacy-provider-usage' }
    await history.append({ id: 'legacy-full', role: 'assistant', content: 'legacy response', tokens: 1000,
      usage: { promptTokens: 20, completionTokens: 5 } }, ctx)
    await history.append({ id: 'legacy-input', role: 'assistant', content: 'partial meter', tokens: 1000,
      usage: { promptTokens: 7 } }, ctx)
    await history.append({ id: 'unmetered', role: 'assistant', content: 'no provider evidence', tokens: 5000 }, ctx)
    expect(await history.getSessionUsage(ctx)).toMatchObject({ promptTokens: 27, completionTokens: 5, totalTokens: 32 })
    await history.compress(ctx, async () => 'older calls summarized', 1)
    expect(await new JSONLConversationHistory().getSessionUsage(ctx)).toMatchObject({ totalTokens: 32 })
  })

  it('migrates SQLite compaction billing receipts without inventing transcript or model messages', async () => {
    const sqlite = new SQLiteConversationHistory()
    const ctx = { tenantId: 'usage-tenant', sessionId: 'usage-migration' }
    for (let index = 0; index < 8; index++) {
      await sqlite.append({ id: `question-${index}`, role: 'user', content: `question ${index}`, conversationId: `turn-${index}` }, ctx)
      await sqlite.append({ id: `answer-${index}`, role: 'assistant', content: `answer ${index}`, conversationId: `turn-${index}`,
        usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 } }, ctx)
    }
    const expected = await sqlite.getSessionUsage(ctx)
    await sqlite.compress(ctx, async () => 'retained work summary', 4)
    const compact = await sqlite.getFullHistory(ctx)
    expect(compact.length).toBeLessThan(16)
    expect(await sqlite.getSessionUsage(ctx)).toEqual(expected)
    const migrated = new JSONLConversationHistory()
    const model = await migrated.getFullHistory(ctx)
    expect(model.map(message => message.id)).toEqual(compact.map(message => message.id))
    expect(await migrated.getSessionUsage(ctx)).toEqual(expected)
    const archive = await migrated.getArchive(ctx)
    expect(archive.messages.map(message => message.id)).toEqual(compact.map(message => message.id))
    expect((await migrated.searchArchive(ctx, { messageId: 'answer-0', limit: 1 })).messages).toEqual([])
    expect(await migrated.getSessionUsage(ctx, 'turn-0')).toMatchObject({ totalTokens: 25 })
    await migrated.deleteMessage('answer-0', ctx.tenantId)
    expect(await migrated.getSessionUsage(ctx)).toMatchObject({ totalTokens: 175 })
    expect(await migrated.deleteByConversationId('turn-1', ctx.tenantId)).toBeGreaterThan(0)
    expect(await migrated.getSessionUsage(ctx)).toMatchObject({ totalTokens: 150 })
    const restarted = new JSONLConversationHistory()
    expect(await restarted.getSessionUsage(ctx)).toMatchObject({ totalTokens: 150 })
    await restarted.clear(ctx)
    expect(await new JSONLConversationHistory().getSessionUsage(ctx)).toMatchObject({ totalTokens: 0 })
  })
})
