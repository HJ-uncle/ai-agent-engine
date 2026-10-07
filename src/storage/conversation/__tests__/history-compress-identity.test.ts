import { createClient, type Client } from '@libsql/client'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as database from '../../sqlite/db.js'
import { up as initialSchema } from '../../sqlite/migrations/001_initial.js'
import { up as messageIds } from '../../sqlite/migrations/002_add_message_id.js'
import { up as sessionSchema } from '../../sqlite/migrations/009_add_sessions.js'
import { up as modelIds } from '../../sqlite/migrations/012_add_message_model_id.js'
import { up as metadataSchema } from '../../sqlite/migrations/015_add_metadata.js'
import { SQLiteConversationHistory } from '../history.js'
import type { Message } from '../../../core/agent-context/types.js'

let db: Client
let fixture: string
let history: SQLiteConversationHistory
const ctx = { tenantId: 'compress-tenant', sessionId: 'compress-session' }

beforeEach(async () => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-compress-identity-'))
  db = createClient({ url: `file:${path.join(fixture, 'agent.db').replace(/\\/g, '/')}` })
  vi.spyOn(database, 'getDb').mockReturnValue(db)
  await initialSchema(db)
  await messageIds(db)
  await sessionSchema(db)
  await modelIds(db)
  await metadataSchema(db)
  // This column is added by initDb after migrations in the application too.
  await db.execute('ALTER TABLE conversations ADD COLUMN reasoning_content TEXT')
  history = new SQLiteConversationHistory(1_000_000)
})

afterEach(() => {
  db.close(); vi.restoreAllMocks()
  if (path.dirname(fixture) !== path.resolve(os.tmpdir()) || !path.basename(fixture).startsWith('aether-compress-identity-')) throw new Error('Unsafe fixture cleanup')
  try { fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }) }
  catch (error) { if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error }
})

describe('SQLite compaction preserves retained message identity', () => {
  it.each([4, { keepRecentTokens: 40 }])('preserves current turn metadata, model, tool state and chronological order (retention: %j)', async retention => {
    const recent: Array<Message & { conversationId: string }> = [
      { id: 'current-user', role: 'user', content: 'Continue this precise turn', tokens: 10,
        conversationId: 'current-turn', metadata: { rootRunId: 'current-run', turnId: 'current-turn', attachments: [{ name: '设计.md', type: 'text/markdown' }] } },
      { id: 'current-tool-call', role: 'assistant', content: 'Editing the file.', reasoningContent: 'Keep the specified target.',
        toolCall: { id: 'edit-1', name: 'write_file', args: { path: 'file.txt', data: 'updated' } }, toolCallId: 'edit-1',
        modelId: 'actual-fallback-model', usage: { promptTokens: 9, completionTokens: 1, totalTokens: 10 }, tokens: 10,
        conversationId: 'current-turn', metadata: { rootRunId: 'current-run', turnId: 'current-turn' } },
      { id: 'current-tool-result', role: 'tool', content: 'File updated', toolCallId: 'edit-1', toolName: 'write_file', tokens: 10,
        conversationId: 'current-turn', metadata: { status: 'succeeded', success: true, rootRunId: 'current-run', turnId: 'current-turn',
          change: { id: 'change-1', path: 'file.txt', oldContent: 'old', newContent: 'updated', status: 'pending' } } },
      { id: 'current-answer', role: 'assistant', content: 'The change is ready.', reasoningContent: 'The request is complete.',
        modelId: 'actual-fallback-model', tokens: 10, usage: { promptTokens: 15, completionTokens: 3, totalTokens: 18 },
        conversationId: 'current-turn', metadata: { rootRunId: 'current-run', turnId: 'current-turn' } },
    ]
    const older: Array<Message & { conversationId: string }> = Array.from({ length: 4 }, (_, index) => ({
      id: `old-${index}`, role: index % 2 ? 'assistant' : 'user', content: `Older context ${index}`, tokens: 100,
      conversationId: 'previous-turn', modelId: index % 2 ? 'previous-model' : undefined,
      metadata: { rootRunId: 'previous-run', turnId: 'previous-turn' },
    }))
    const originals = [...older, ...recent]
    for (const [index, message] of originals.entries()) {
      await history.append(message, ctx)
      // append uses SQLite's server timestamp; make its persisted values distinct and
      // historical so reset-to-now bugs and summary ordering cannot hide behind ties.
      await db.execute({ sql: 'UPDATE conversations SET created_at=? WHERE message_id=?', args: [1_700_000_000 + index, message.id!] })
    }
    await history.append({ id: 'other-session', role: 'user', content: 'Unrelated session', tokens: 1 }, { ...ctx, sessionId: 'other-session' })
    const before = await history.getFullHistory(ctx)
    const summarize = vi.fn(async () => 'Summary retaining the previous request constraints.')

    const stats = await history.compress(ctx, summarize, retention)
    const after = await history.getFullHistory(ctx)

    expect(summarize).toHaveBeenCalledWith(before.slice(0, 4))
    expect(after).toHaveLength(5)
    expect(after[0]).toMatchObject({ role: 'system', content: 'Summary retaining the previous request constraints.' })
    expect(after[0].createdAt).toBeLessThanOrEqual(after[1].createdAt!)
    expect(after.slice(1)).toEqual(before.slice(4))
    expect(after.slice(1).map(message => message.id)).toEqual(recent.map(message => message.id))
    expect(after.slice(1).map(message => (message as Message & { conversationId?: string }).conversationId)).toEqual(Array(4).fill('current-turn'))
    expect(after[2]).toMatchObject({ modelId: 'actual-fallback-model', reasoningContent: 'Keep the specified target.', toolCall: recent[1].toolCall, usage: recent[1].usage })
    expect(after[3].metadata.change.id).toBe('change-1')
    expect(after[1].metadata.attachments).toEqual([{ name: '设计.md', type: 'text/markdown' }])
    expect(stats.preTokens).toBe(440)
    expect(stats.postTokens).toBeLessThan(stats.preTokens)
    expect((await history.getFullHistory({ ...ctx, sessionId: 'other-session' })).map(message => message.id)).toEqual(['other-session'])
  })
})
