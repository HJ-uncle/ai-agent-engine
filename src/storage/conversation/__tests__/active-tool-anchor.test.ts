/** Real SQLite/JSONL active anchors: scoped identity, compaction and deletion without whole-session reads. */
import { createClient, type Client } from '@libsql/client'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversationHistory, ConversationToolCallAnchor, Message } from '../../../core/agent-context/types.js'
import * as database from '../../sqlite/db.js'
import { SQLiteConversationHistory } from '../history.js'
import { JSONLConversationHistory } from '../jsonl-history.js'

let db: Client, fixture: string
const ctx = { tenantId: 'anchor-tenant', sessionId: 'anchor-session' }
const key: ConversationToolCallAnchor = { messageId: 'dispatch', toolCallId: 'spawn', conversationId: 'turn' }
const dispatch: Message & { conversationId: string } = { id: key.messageId, role: 'assistant', content: '巨大正文'.repeat(20000),
  toolCall: { id: key.toolCallId, name: 'subagent', args: { task: '大参数'.repeat(20000) } }, conversationId: key.conversationId }
const file = () => path.join(fixture, 'sessions', ctx.tenantId, ctx.sessionId + '.jsonl')
const row = (sequence: number, message: Message & { conversationId?: string }, scope = ctx) => ({ uuid: message.id, parentUuid: null, type: message.role,
  timestamp: '2026-10-13T00:00:00Z', ...scope, isSidechain: false, dbSeq: sequence, conversationId: message.conversationId, payload: message })
const marker = (type: string, extra: Record<string, unknown> = {}) => ({ uuid: `marker-${Math.random()}`, parentUuid: null, type,
  timestamp: '2026-10-13T00:00:00Z', ...ctx, isSidechain: false, dbSeq: 0, ...extra })

beforeEach(async () => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-active-anchor-'))
  vi.stubEnv('DATA_DIR', path.join(fixture, 'agent.db'))
  db = createClient({ url: `file:${path.join(fixture, 'agent.db').replace(/\\/g, '/')}` })
  vi.spyOn(database, 'getDb').mockReturnValue(db)
  await db.execute(`CREATE TABLE conversations (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT, session_id TEXT, conversation_id TEXT,
    message_id TEXT, role TEXT, content TEXT, reasoning_content TEXT, tool_call_id TEXT, tool_call_name TEXT, tool_name TEXT, tool_args TEXT,
    tokens INTEGER, token_usage TEXT, model_id TEXT, metadata TEXT, created_at INTEGER DEFAULT (unixepoch()))`)
})
afterEach(() => {
  db.close(); vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (path.dirname(fixture) !== path.resolve(os.tmpdir()) || !path.basename(fixture).startsWith('aether-active-anchor-')) throw new Error('Unsafe fixture cleanup')
  try { fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }) }
  catch (error) { if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error }
})

describe.each(['sqlite', 'jsonl'] as const)('scoped active anchor on %s', backend => {
  const history = (): ConversationHistory => backend === 'sqlite' ? new SQLiteConversationHistory() : new JSONLConversationHistory()
  async function seed() {
    const store = history()
    await store.append({ id: 'user', role: 'user', content: 'Delegate', ...{ conversationId: key.conversationId } }, ctx)
    await store.append(dispatch, ctx)
    return store
  }
  it('returns only three identity fields and rejects every incorrect boundary', async () => {
    const store = await seed()
    const full = vi.spyOn(store, 'getFullHistory').mockRejectedValue(new Error('must not load the session'))
    expect(await store.getActiveToolCallAnchor!(ctx, key)).toEqual(key)
    for (const wrong of [{ ...ctx, tenantId: 'other' }, { ...ctx, sessionId: 'other' }]) expect(await store.getActiveToolCallAnchor!(wrong, key)).toBeNull()
    for (const wrong of [{ ...key, messageId: 'other' }, { ...key, toolCallId: 'other' }, { ...key, conversationId: 'other' }]) expect(await store.getActiveToolCallAnchor!(ctx, wrong)).toBeNull()
    expect(full).not.toHaveBeenCalled()
  })
  it.each(['message', 'turn', 'clear', 'truncate'] as const)('does not resurrect a %s deletion on a cold reader', async deletion => {
    const store = await seed()
    if (deletion === 'message') await store.deleteMessage(key.messageId, ctx.tenantId)
    if (deletion === 'turn') await store.deleteByConversationId(key.conversationId, ctx.tenantId)
    if (deletion === 'clear') await store.clear(ctx, { tombstone: false })
    if (deletion === 'truncate') {
      const first = await store.getMessageById('user', ctx.tenantId)
      await store.deleteMessagesAfterId(first!.dbId, ctx.sessionId, ctx.tenantId)
    }
    expect(await history().getActiveToolCallAnchor!(ctx, key)).toBeNull()
  })
  it('does not use a summarized dispatch retained only in the archive', async () => {
    const store = await seed()
    await store.append({ id: 'answer', role: 'assistant', content: 'Old answer' }, ctx)
    await store.append({ id: 'new-user', role: 'user', content: 'New task' }, ctx)
    await store.compress(ctx, async () => 'Old task summary', 1)
    expect(await history().getActiveToolCallAnchor!(ctx, key)).toBeNull()
  })
})

it('SQLite matches the first-user orphan filter and never selects payload columns', async () => {
  const store = new SQLiteConversationHistory()
  await store.append(dispatch, ctx)
  expect(await store.getActiveToolCallAnchor(ctx, key)).toEqual(key)
  await store.append({ id: 'later-user', role: 'user', content: 'New request' }, ctx)
  const execute = vi.spyOn(db, 'execute')
  expect(await store.getActiveToolCallAnchor(ctx, key)).toBeNull()
  const statement: unknown = execute.mock.calls[0][0]
  expect(typeof statement).toBe('object')
  if (!statement || typeof statement !== 'object' || !('sql' in statement)) throw new Error('Expected a narrow SQL statement')
  expect(String(statement.sql).split('FROM conversations')[0]).not.toMatch(/content|tool_args|metadata/)
  await db.execute({ sql: 'UPDATE conversations SET created_at=0 WHERE message_id=?', args: ['later-user'] })
  expect(await store.getActiveToolCallAnchor(ctx, key)).toEqual(key)
})

it('JSONL streams 10000 rows without populating the session cache or reading the whole file', async () => {
  fs.mkdirSync(path.dirname(file()), { recursive: true })
  const originals = Array.from({ length: 10000 }, (_, index) => row(index + 1, index === 9988 ? dispatch : { id: `record-${index}`, role: index % 2 ? 'assistant' : 'user', content: '正文'.repeat(64) }))
  fs.writeFileSync(file(), originals.map(value => JSON.stringify(value)).join('\n') + '\n')
  const read = vi.spyOn(fs.promises, 'readFile').mockRejectedValue(new Error('must stream'))
  const store = new JSONLConversationHistory()
  const full = vi.spyOn(store, 'getFullHistory').mockRejectedValue(new Error('must not load active projection'))
  expect(await store.getActiveToolCallAnchor(ctx, key)).toEqual(key)
  expect(read).not.toHaveBeenCalled()
  expect(full).not.toHaveBeenCalled()
  expect(Reflect.get(store, 'states').size).toBe(0)
})

it('JSONL folds legacy summary boundaries, repeated truncations, clears and later appends', async () => {
  fs.mkdirSync(path.dirname(file()), { recursive: true })
  const original = [row(1, { id: 'first', role: 'user', content: 'Start' }), row(2, dispatch), row(3, { id: 'tail', role: 'user', content: 'Next' })]
  const compare = async (controls: ReturnType<typeof marker>[], expected: boolean) => {
    fs.writeFileSync(file(), [...original, ...controls].map(value => JSON.stringify(value)).join('\r\n') + '\r\n')
    const store = new JSONLConversationHistory()
    expect(Boolean(await store.getActiveToolCallAnchor(ctx, key))).toBe(expected)
    expect((await store.getFullHistory(ctx)).some(message => message.id === key.messageId && message.toolCall?.id === key.toolCallId)).toBe(expected)
  }
  const earlier = marker('summary', { uuid: 'early-summary', dbSeq: 4, summary: 'Earlier', leafUuid: 'first' })
  const later = marker('summary', { uuid: 'late-summary', dbSeq: 5, summary: 'Later', leafUuid: 'tail' })
  await compare([earlier], true)
  await compare([earlier, later], false)
  await compare([earlier, later, marker('tombstone', { scope: 'truncate', afterSeq: 4 })], true)
  await compare([marker('summary', { dbSeq: 4, summary: 'Legacy fallback without leaf' })], false)
  await compare([marker('tombstone', { scope: 'clear', dbSeq: 0 })], false)
  const replacement = row(2, dispatch)
  fs.writeFileSync(file(), [...original, marker('tombstone', { scope: 'truncate', afterSeq: 1 }), replacement].map(value => JSON.stringify(value)).join('\n') + '\n')
  expect(await new JSONLConversationHistory().getActiveToolCallAnchor(ctx, key)).toEqual(key)
})

it('a cleared JSONL migration marker blocks legacy SQLite anchors without importing the session', async () => {
  const legacy = new SQLiteConversationHistory()
  await legacy.append(dispatch, ctx)
  expect(await new JSONLConversationHistory().getActiveToolCallAnchor(ctx, key)).toEqual(key)
  expect(fs.existsSync(file())).toBe(false)
  fs.mkdirSync(path.dirname(file()), { recursive: true })
  fs.writeFileSync(file().replace(/\.jsonl$/, '.migrated'), 'cleared')
  expect(await new JSONLConversationHistory().getActiveToolCallAnchor(ctx, key)).toBeNull()
})
